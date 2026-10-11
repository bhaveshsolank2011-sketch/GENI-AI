const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MEMORY_FILE = path.join(__dirname, "memory.json");

function readMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(MEMORY_FILE, "[]");
    }

    const data = fs.readFileSync(MEMORY_FILE, "utf8");
    const result = JSON.parse(data || "[]");

    return Array.isArray(result) ? result : [];
  } catch (error) {
    console.error("Memory read failed:", error.message);
    return [];
  }
}

function saveMemory(memory) {
  fs.writeFileSync(
    MEMORY_FILE,
    JSON.stringify(memory, null, 2),
    "utf8"
  );
}

async function askAI(input) {
  if (!API_KEY) {
    throw new Error("GEMINI_API_KEY is missing in Render environment");
  }

  const systemInstruction = input
    .filter(item => item.role === "system")
    .map(item => typeof item.content === "string"
      ? item.content
      : JSON.stringify(item.content))
    .join("\n\n");

  const contents = input
    .filter(item => item.role !== "system")
    .map(item => ({
      role: item.role === "assistant" ? "model" : "user",
      parts: [{
        text: typeof item.content === "string"
          ? item.content
          : JSON.stringify(item.content)
      }]
    }));

  if (contents.length === 0) {
    throw new Error("No message provided to Gemini");
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": API_KEY
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{
            text: systemInstruction || "You are a helpful AI assistant."
          }]
        },
        contents,
        generationConfig: {
          temperature: 0.7
        }
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    const message =
      data.error?.message || "Gemini API request failed";

    throw new Error(message);
  }

  const reply = data.candidates?.[0]?.content?.parts
    ?.map(part => part.text || "")
    .join("")
    .trim();

  if (!reply) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new Error(
      reason
        ? `Gemini returned no text. Finish reason: ${reason}`
        : "Gemini returned an empty response"
    );
  }

  return reply;
}

async function updateMemory(message) {
  const oldMemory = readMemory();

  const result = await askAI([
    {
      role: "system",
      content: `You manage GENI AI's long-term memory.
Return ONLY a valid JSON array of short strings.
Preserve useful existing memories.
Add stable user facts, preferences, goals and ongoing projects.
If the user explicitly states their name, remember it.
Remove duplicates and update corrected facts.
Never save passwords, API keys, tokens or sensitive personal information.
Do not save ordinary questions or temporary details.
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

  const cleaned = result
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const updated = JSON.parse(cleaned);

  if (
    Array.isArray(updated) &&
    updated.every(item => typeof item === "string")
  ) {
    saveMemory(updated.slice(0, 100));
    console.log("GENI AI memory saved 🧠");
  } else {
    throw new Error("Gemini returned an invalid memory format");
  }
}

const server = http.createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (req.method !== "POST" || req.url !== "/chat") {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8"
    });
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
      res.end(JSON.stringify({
        error: "Message too large"
      }));
    }
  });

  req.on("end", async () => {
    if (tooLarge) return;

    try {
      if (!API_KEY) {
        throw new Error(
          "GEMINI_API_KEY missing. Add it in Render environment variables."
        );
      }

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

      const reply = await askAI([
        {
          role: "system",
          content: `IDENTITY:
Your name is GENI AI.
You are a helpful, friendly AI assistant created and configured by Bhavesh.

CREATOR RULES:
- If asked your name, say: "I am GENI AI."
- If asked who created you, say: "I am GENI AI, created and configured by Bhavesh."
- If asked who owns or developed the GENI AI app, explain that Bhavesh created and configured the app.
- If asked who provides the underlying AI model or API, answer honestly that this app uses Google's Gemini AI API.
- Never claim that Bhavesh personally trained or created Google's underlying Gemini model.
- Do not identify yourself as ChatGPT. Your assistant name is GENI AI.
- Be honest; never invent facts about your creator or capabilities.
- Reply in the user's language and tone.
- Keep answers clear and helpful.
- Use saved memories when relevant.
- Never claim the user said something unless supported by memory.

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

      res.end(JSON.stringify({ reply }));

      // Update memory after sending the chat reply.
      updateMemory(message.trim()).catch(error => {
        console.error("Memory update failed:", error.message);
      });

    } catch (error) {
      console.error("GENI AI error:", error.message);

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
  console.log(`GENI AI Gemini backend running on port ${PORT}`);
});
