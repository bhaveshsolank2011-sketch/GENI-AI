const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MEMORY_FILE = path.join(__dirname, "memory.json");

const PROVIDERS = [
  {
    name: "OpenAI",
    key: process.env.OPENAI_API_KEY,
    url: "https://api.openai.com/v1/chat/completions",
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini"
  },
  {
    name: "Groq",
    key: process.env.GROQ_API_KEY,
    url: "https://api.groq.com/openai/v1/chat/completions",
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile"
  },
  {
    name: "Mistral",
    key: process.env.MISTRAL_API_KEY,
    url: "https://api.mistral.ai/v1/chat/completions",
    model: process.env.MISTRAL_MODEL || "mistral-small-latest"
  },
  {
    name: "OpenRouter",
    key: process.env.OPENROUTER_API_KEY,
    url: "https://openrouter.ai/api/v1/chat/completions",
    model: process.env.OPENROUTER_MODEL || "openai/gpt-4.1-mini"
  }
];

function readMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(MEMORY_FILE, "[]", "utf8");
    }

    const data = JSON.parse(
      fs.readFileSync(MEMORY_FILE, "utf8")
    );

    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveMemory(memory) {
  try {
    fs.writeFileSync(
      MEMORY_FILE,
      JSON.stringify(memory.slice(-100), null, 2),
      "utf8"
    );
  } catch (error) {
    console.error("Memory save error:", error.message);
  }
}

function sendJSON(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization"
  });

  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > 1024 * 1024) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });

    req.on("error", reject);
  });
}

async function callOpenAICompatible(provider, messages) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(provider.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${provider.key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error?.message || `HTTP ${response.status}`
      );
    }

    const answer = result.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("Empty AI response");
    }

    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function callGemini(messages) {
  const key = process.env.GEMINI_API_KEY;

  if (!key) {
    throw new Error("Gemini API key not configured");
  }

  const model =
    process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const contents = messages
    .filter(m => ["user", "assistant"].includes(m.role))
    .map(m => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content) }]
    }));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": key
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{
              text: "You are GENI AI, a helpful, friendly assistant. Reply clearly in the user's language."
            }]
          },
          contents,
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 2048
          }
        })
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(
        result.error?.message || `HTTP ${response.status}`
      );
    }

    const answer = result.candidates?.[0]
      ?.content?.parts
      ?.map(part => part.text || "")
      .join("");

    if (!answer || !answer.trim()) {
      throw new Error("Empty Gemini response");
    }

    return answer.trim();
  } finally {
    clearTimeout(timer);
  }
}

async function generateAnswer(messages) {
  const errors = [];

  // Gemini is included in the automatic fallback chain.
  const providers = [
    ...PROVIDERS.filter(p => p.key),
    ...(process.env.GEMINI_API_KEY ? [{
      name: "Gemini",
      run: () => callGemini(messages)
    }] : [])
  ];

  for (const provider of providers) {
    try {
      console.log("Trying provider:", provider.name);

      const answer = provider.run
        ? await provider.run()
        : await callOpenAICompatible(provider, messages);

      console.log("Successful provider:", provider.name);

      return {
        answer,
        provider: provider.name
      };
    } catch (error) {
      console.error(
        provider.name,
        "failed:",
        error.message
      );

      errors.push(`${provider.name}: ${error.message}`);
    }
  }

  throw new Error(
    errors.length
      ? "All configured AI providers failed. Check API keys, model names, quota and provider status."
      : "No AI provider is configured. Add at least one API key in Render Environment."
  );
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    });

    return res.end();
  }

  const url = new URL(
    req.url,
    `http://${req.headers.host || "localhost"}`
  );

  if (req.method === "GET" && url.pathname === "/") {
    return sendJSON(res, 200, {
      status: "ok",
      service: "GENI AI",
      configuredProviders: [
        ...PROVIDERS.filter(p => p.key).map(p => p.name),
        ...(process.env.GEMINI_API_KEY ? ["Gemini"] : [])
      ]
    });
  }

  if (req.method === "POST" && url.pathname === "/chat") {
    try {
      const body = await readBody(req);

      const memory = readMemory();

      let messages = [];

      if (Array.isArray(body.messages)) {
        messages = body.messages
          .filter(m =>
            m &&
            ["user", "assistant"].includes(m.role) &&
            typeof m.content === "string"
          )
          .slice(-30);
      } else if (typeof body.message === "string") {
        messages = [{
          role: "user",
          content: body.message
        }];
      } else if (typeof body.prompt === "string") {
        messages = [{
          role: "user",
          content: body.prompt
        }];
      } else {
        return sendJSON(res, 400, {
          error: "Send a message or messages array."
        });
      }

      if (!messages.length) {
        return sendJSON(res, 400, {
          error: "No valid messages provided."
        });
      }

      const recentMemory = memory
        .slice(-15)
        .map(item =>
          `User: ${item.user}\nGENI: ${item.assistant}`
        )
        .join("\n\n");

      const systemPrompt = {
        role: "system",
        content:
          "You are GENI AI, a friendly and helpful AI assistant. " +
          "Answer clearly and accurately. Match the user's language. " +
          "Never claim you remember something unless it appears in the supplied context." +
          (recentMemory
            ? "\n\nRecent conversation context:\n" + recentMemory
            : "")
      };

      // Avoid sending duplicate system prompts from the client.
      const finalMessages = [
        systemPrompt,
        ...messages.filter(m => m.role !== "system")
      ];

      const result = await generateAnswer(finalMessages);

      const lastUserMessage = [...messages]
        .reverse()
        .find(m => m.role === "user")?.content || "";

      memory.push({
        user: lastUserMessage.slice(0, 4000),
        assistant: result.answer.slice(0, 6000),
        timestamp: new Date().toISOString()
      });

      saveMemory(memory);

      return sendJSON(res, 200, {
        success: true,
        reply: result.answer,
        answer: result.answer,
        response: result.answer,
        provider: result.provider
      });
    } catch (error) {
      console.error("Chat error:", error.message);

      return sendJSON(res, 500, {
        success: false,
        error: error.message || "Something went wrong."
      });
    }
  }

  return sendJSON(res, 404, {
    error: "Route not found"
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GENI AI server running on port ${PORT}`);
});
