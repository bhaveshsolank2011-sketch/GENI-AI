const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_BODY_SIZE = 1024 * 1024;

const PROVIDERS = [
  {
    name: "OpenAI",
    key: process.env.OPENAI_API_KEY,
    url: "https://api.openai.com/v1/chat/completions",
    model: process.env.OPENAI_MODEL || "gpt-4.1-mini"
  },
  {
    name: "Gemini",
    key: process.env.GEMINI_API_KEY,
    url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
    gemini: true
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

const SYSTEM_PROMPT = `
You are GENI AI, an AI assistant project created by its developer.

IDENTITY:
- Your name is GENI AI.
- You are not ChatGPT.
- Do not claim OpenAI created GENI AI.
- GENI AI may use language models from external AI providers through APIs.
- If asked who created GENI AI, explain that GENI AI is a separate project developed by its developer.
- Do not invent personal details about your developer.

BEHAVIOUR:
- Be friendly, helpful, honest, and clear.
- Match the user's language. If the user writes in Hindi or Hinglish, reply naturally in Hindi or Hinglish.
- Follow the user's request and answer the actual question.
- Never claim a tool, feature, or action succeeded unless it actually did.
- If you do not know something, say so honestly.
`;

function readMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(MEMORY_FILE, "[]", "utf8");
    }

    const parsed = JSON.parse(
      fs.readFileSync(MEMORY_FILE, "utf8")
    );

    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error("Memory read error:", error.message);
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

      if (size > MAX_BODY_SIZE) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }

      body += chunk.toString("utf8");
    });

    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON request"));
      }
    });

    req.on("error", reject);
  });
}

async function callProvider(provider, messages) {
  const controller = new AbortController();

  const timeout = setTimeout(() => {
    controller.abort();
  }, 20000);

  try {
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.key}`
    };

    if (provider.name === "OpenRouter") {
      headers["HTTP-Referer"] =
        "https://geni-ai-2.onrender.com";
      headers["X-Title"] = "GENI AI";
    }

    const response = await fetch(provider.url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(
        data.error?.message ||
        `Provider returned HTTP ${response.status}`
      );
    }

    const answer = data.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("Provider returned an empty answer");
    }

    return answer.trim();
  } finally {
    clearTimeout(timeout);
  }
}

async function generateAnswer(messages) {
  const configured = PROVIDERS.filter(
    provider => provider.key
  );

  if (configured.length === 0) {
    throw new Error(
      "No AI API key configured. Add a provider key in Render Environment."
    );
  }

  const errors = [];

  for (const provider of configured) {
    try {
      console.log(
        `Trying ${provider.name} with model ${provider.model}`
      );

      const answer = await callProvider(provider, messages);

      console.log(`${provider.name} responded successfully`);

      return {
        answer,
        provider: provider.name
      };
    } catch (error) {
      console.error(
        `${provider.name} failed:`,
        error.message
      );

      errors.push(
        `${provider.name}: ${error.message}`
      );
    }
  }

  throw new Error(
    "All configured providers failed. Check API keys, model names, quota and provider status."
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

  let url;

  try {
    url = new URL(
      req.url,
      `http://${req.headers.host || "localhost"}`
    );
  } catch {
    return sendJSON(res, 400, {
      error: "Invalid URL"
    });
  }

  if (req.method === "GET" && url.pathname === "/") {
    return sendJSON(res, 200, {
      status: "ok",
      service: "GENI AI",
      version: "2.0",
      configuredProviders: PROVIDERS
        .filter(provider => provider.key)
        .map(provider => provider.name)
    });
  }

  if (req.method !== "POST" || url.pathname !== "/chat") {
    return sendJSON(res, 404, {
      error: "Route not found"
    });
  }

  try {
    const body = await readBody(req);

    let messages = [];

    if (Array.isArray(body.messages)) {
      messages = body.messages
        .filter(message =>
          message &&
          ["user", "assistant"].includes(message.role) &&
          typeof message.content === "string"
        )
        .slice(-30);
    } else {
      const message =
        typeof body.message === "string"
          ? body.message
          : typeof body.prompt === "string"
            ? body.prompt
            : typeof body.text === "string"
              ? body.text
              : null;

      if (message !== null) {
        messages = [{
          role: "user",
          content: message
        }];
      }
    }

    if (messages.length === 0) {
      return sendJSON(res, 400, {
        success: false,
        error: "Send a message, prompt, text, or messages array."
      });
    }

    const lastUserMessage = [...messages]
      .reverse()
      .find(message => message.role === "user")?.content;

    if (!lastUserMessage || !lastUserMessage.trim()) {
      return sendJSON(res, 400, {
        success: false,
        error: "Your message is empty."
      });
    }

    const memory = readMemory();

    const recentContext = memory
      .slice(-10)
      .map(item =>
        `User: ${item.user}\nGENI AI: ${item.assistant}`
      )
      .join("\n\n");

    const systemMessage = {
      role: "system",
      content: SYSTEM_PROMPT +
        (recentContext
          ? "\n\nRecent conversation context:\n" +
            recentContext
          : "")
    };

    const finalMessages = [
      systemMessage,
      ...messages.filter(
        message => message.role !== "system"
      )
    ];

    const result = await generateAnswer(finalMessages);

    memory.push({
      user: lastUserMessage.slice(0, 3000),
      assistant: result.answer.slice(0, 5000),
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
    console.error("GENI AI request error:", error.message);

    const status = error.message === "Invalid JSON request"
      ? 400
      : 500;

    return sendJSON(res, status, {
      success: false,
      error: error.message || "GENI AI encountered an error."
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GENI AI listening on port ${PORT}`);
});
