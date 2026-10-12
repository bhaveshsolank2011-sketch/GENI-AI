const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MAX_BODY_SIZE = 1024 * 1024;

const SYSTEM_PROMPT = `
You are GENI AI, an AI assistant developed by Bhavesh.

IDENTITY RULES:
- Your name is GENI AI.
- Your developer is Bhavesh.
- If asked your name, say: "Mera naam GENI AI hai!"
- If asked who created you, say: "Mujhe Bhavesh ne banaya hai!"
- If asked both, say: "Mera naam GENI AI hai aur mujhe Bhavesh ne banaya hai!"
- Do not unnecessarily compare yourself with other AI assistants.
- Never claim that OpenAI created GENI AI.
- GENI AI is a separate project that can use external AI models through APIs.
- Do not claim to have a different underlying model if you do not know which model is running.

PERSONALITY:
- Be friendly, helpful, honest, and clear.
- Reply in the language the user uses.
- Use natural Hindi and Hinglish when appropriate.
- Answer the user's actual question directly.
- Never invent facts or claim an action succeeded if it did not.
`;

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
    model: process.env.GEMINI_MODEL || "gemini-2.5-flash"
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
  const timeout = setTimeout(
    () => controller.abort(),
    20000
  );

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
        `HTTP ${response.status}`
      );
    }

    const answer =
      data.choices?.[0]?.message?.content;

    if (typeof answer !== "string" || !answer.trim()) {
      throw new Error("Empty AI response");
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
      "No AI provider configured. Add an API key in Render Environment."
    );
  }

  const errors = [];

  for (const provider of configured) {
    try {
      console.log(
        `Trying ${provider.name}: ${provider.model}`
      );

      const answer = await callProvider(
        provider,
        messages
      );

      console.log(
        `${provider.name} responded successfully`
      );

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
    "All configured AI providers failed. Check API keys, model names, quotas and provider status."
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
      success: false,
      error: "Invalid URL"
    });
  }

  if (req.method === "GET" && url.pathname === "/") {
    return sendJSON(res, 200, {
      status: "ok",
      service: "GENI AI",
      version: "2.1",
      developer: "Bhavesh",
      configuredProviders: PROVIDERS
        .filter(provider => provider.key)
        .map(provider => provider.name)
    });
  }

  if (req.method !== "POST" || url.pathname !== "/chat") {
    return sendJSON(res, 404, {
      success: false,
      error: "Route not found"
    });
  }

  try {
    const body = await readBody(req);
    const memory = readMemory();

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
        error: "Send a message or messages array."
      });
    }

    const lastUserMessage = [...messages]
      .reverse()
      .find(message => message.role === "user");

    if (!lastUserMessage || !lastUserMessage.content.trim()) {
      return sendJSON(res, 400, {
        success: false,
        error: "Your message is empty."
      });
    }

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
      user: lastUserMessage.content.slice(0, 3000),
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
    console.error(
      "GENI AI request error:",
      error.message
    );

    return sendJSON(res, 500, {
      success: false,
      error: error.message ||
        "GENI AI encountered an error."
    });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(
    `GENI AI server running on port ${PORT}`
  );
});
