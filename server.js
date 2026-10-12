const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MEMORY_FILE = path.join(__dirname, "memory.json");
const TIMEOUT_MS = 25000;

const PROVIDERS = [
  {
    name: "OpenAI",
    key: process.env.OPENAI_API_KEY,
    url: "https://api.openai.com/v1/responses",
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
    type: "openai"
  },
  {
    name: "Gemini",
    key: process.env.GEMINI_API_KEY,
    url: "https://generativelanguage.googleapis.com/v1beta/models/",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    type: "gemini"
  },
  {
    name: "Groq",
    key: process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    type: "openai-compatible"
  },
  {
    name: "Mistral",
    key: process.env.MISTRAL_API_KEY,
    url: "https://api.mistral.ai/v1/chat/completions",
    model: process.env.MISTRAL_MODEL || "mistral-small-latest",
    type: "openai-compatible"
  },
  {
    name: "OpenRouter",
    key: process.env.OPENROUTER_API_KEY,
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.OPENROUTER_MODEL || "openrouter/auto",
    type: "openai-compatible"
  }
];

function readMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(MEMORY_FILE, "[]");
    }

    const data = JSON.parse(
      fs.readFileSync(MEMORY_FILE, "utf8") || "[]"
    );

    return Array.isArray(data) ? data.slice(0, 100) : [];
  } catch (error) {
    console.error("Memory read failed:", error.message);
    return [];
  }
}

function saveMemory(memory) {
  const tempFile = MEMORY_FILE + ".tmp";

  fs.writeFileSync(
    tempFile,
    JSON.stringify(memory.slice(0, 100), null, 2),
    "utf8"
  );

  fs.renameSync(tempFile, MEMORY_FILE);
}

function normalizeMessages(input) {
  return input.map(item => ({
    role: item.role === "assistant" ? "assistant" :
          item.role === "system" ? "system" : "user",
    content: typeof item.content === "string"
      ? item.content
      : JSON.stringify(item.content)
  }));
}

async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function askProvider(provider, messages) {
  const normalized = normalizeMessages(messages);

  let url = provider.url;
  let headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${provider.key}`
  };
  let payload;

  if (provider.type === "gemini") {
    const systemText = normalized
      .filter(m => m.role === "system")
      .map(m => m.content)
      .join("\n\n");

    const contents = normalized
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }]
      }));

    if (!contents.length) {
      throw new Error("Gemini requires a user message");
    }

    url = `${provider.url}${provider.model}:generateContent`;

    headers = {
      "Content-Type": "application/json",
      "x-goog-api-key": provider.key
    };

    payload = {
      contents,
      generationConfig: { temperature: 0.7 }
    };

    if (systemText) {
      payload.systemInstruction = {
        parts: [{ text: systemText }]
      };
    }
  } else if (provider.type === "openai") {
    payload = {
      model: provider.model,
      input: normalized.map(m => ({
        role: m.role,
        content: m.content
      }))
    };
  } else {
    payload = {
      model: provider.model,
      messages: normalized,
      temperature: 0.7
    };
  }

  if (provider.name === "OpenRouter") {
    headers["HTTP-Referer"] =
      process.env.APP_URL || "https://geni-ai-2.onrender.com";
    headers["X-Title"] = "GENI AI";
  }

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.error?.message ||
      data.error ||
      `${provider.name} returned HTTP ${response.status}`
    );

    error.status = response.status;
    throw error;
  }

  let reply = "";

  if (provider.type === "gemini") {
    reply = data.candidates?.[0]?.content?.parts
      ?.map(part => part.text || "")
      .join("")
      .trim();
  } else if (provider.type === "openai") {
    reply = data.output
      ?.filter(item => item.type === "message")
      .flatMap(item => item.content || [])
      .filter(item => item.type === "output_text")
      .map(item => item.text || "")
      .join("")
      .trim();
  } else {
    reply = data.choices?.[0]?.message?.content;

    if (Array.isArray(reply)) {
      reply = reply
        .map(part => part.text || "")
        .join("");
    }
  }

  if (typeof reply !== "string" || !reply.trim()) {
    throw new Error(`${provider.name} returned an empty response`);
  }

  return reply.trim();
}

async function askAI(messages) {
  const configured = PROVIDERS.filter(p => p.key);

  if (!configured.length) {
    throw new Error("No API keys configured in Render");
  }

  const errors = [];

  for (const provider of configured) {
    try {
      console.log(`Trying provider: ${provider.name}`);

      const reply = await askProvider(provider, messages);

      console.log(`Provider succeeded: ${provider.name}`);

      return {
        reply,
        provider: provider.name
      };
    } catch (error) {
      console.error(
        `${provider.name} failed:`,
        error.status || "",
        error.message
      );

      errors.push(`${provider.name}: ${error.message}`);

      // Try the next provider if this one fails.
    }
  }

  throw new Error(
    "All configured AI providers failed. " +
    errors.join(" | ").slice(0, 1500)
  );
}

async function updateMemory(message) {
  const oldMemory = readMemory();

  const result = await askAI([
    {
      role: "system",
      content: `You manage GENI AI's long-term memory.
Return ONLY a valid JSON array of short strings.
Preserve useful existing memories.
Add stable preferences, goals and ongoing projects.
Never store API keys, passwords, tokens or sensitive personal information.
Do not store ordinary questions or temporary details.
Remove duplicates and outdated facts.
Keep at most 100 memories.
If nothing useful is learned, preserve existing memories.
Output JSON only, without Markdown.`
    },
    {
      role: "user",
      content: JSON.stringify({
        existing_memories: oldMemory,
        latest_message: message
      })
    }
  ]);

  const cleaned = result.reply
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  const updated = JSON.parse(cleaned);

  if (
    !Array.isArray(updated) ||
    !updated.every(item => typeof item === "string")
  ) {
    throw new Error("Invalid memory format");
  }

  saveMemory(updated);
  console.log("GENI memory updated");
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8"
    });

    return res.end(JSON.stringify({
      status: "ok",
      service: "GENI AI",
      configuredProviders: PROVIDERS
        .filter(p => p.key)
        .map(p => p.name)
    }));
  }

  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404);
    return res.end("Not found");
  }

  let body = "";
  let tooLarge = false;

  req.on("data", chunk => {
    if (tooLarge) return;

    body += chunk.toString();

    if (body.length > 1000000) {
      tooLarge = true;
      res.writeHead(413, {
        "Content-Type": "application/json; charset=utf-8"
      });
      res.end(JSON.stringify({ error: "Message too large" }));
    }
  });

  req.on("end", async () => {
    if (tooLarge) return;

    try {
      let requestData;

      try {
        requestData = JSON.parse(body);
      } catch {
        throw new Error("Invalid JSON request");
      }

      const message = requestData.message;

      if (typeof message !== "string" || !message.trim()) {
        throw new Error("Please enter a message");
      }

      const memories = readMemory();

      const memoryText = memories.length
        ? memories.map(item => "- " + item).join("\n")
        : "No saved memories yet.";

      const result = await askAI([
        {
          role: "system",
          content: `Your name is GENI AI.
You are a helpful, friendly assistant created and configured by Bhavesh.
If asked your name, say you are GENI AI.
Be honest about which underlying AI provider is answering.
Never claim Bhavesh trained the underlying AI models.
Reply in the user's language and tone.
Use saved memories when relevant.

Saved memories:
${memoryText}`
        },
        {
          role: "user",
          content: message.trim()
        }
      ]);

      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8"
      });

      res.end(JSON.stringify({
        reply: result.reply,
        provider: result.provider
      }));

      updateMemory(message.trim()).catch(error => {
        console.error("Memory update failed:", error.message);
      });
    } catch (error) {
      console.error("GENI request failed:", error.message);

      if (!res.headersSent) {
        res.writeHead(500, {
          "Content-Type": "application/json; charset=utf-8"
        });

        res.end(JSON.stringify({
          error: error.message
        }));
      }
    }
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GENI AI running on port ${PORT}`);
});
