const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 3000;
const API_KEY = process.env.OPENAI_API_KEY;
const MEMORY_FILE = path.join(__dirname, "memory.json");
const MODEL = "gpt-6-luna";

function readMemory() {
  try {
    if (!fs.existsSync(MEMORY_FILE)) {
      fs.writeFileSync(MEMORY_FILE, "[]");
    }

    const data = fs.readFileSync(MEMORY_FILE, "utf8");
    const result = JSON.parse(data || "[]");

    return Array.isArray(result) ? result : [];
  } catch {
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
  const response = await fetch(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        input
      })
    }
  );

  const data = await response.json();

  if (!response.ok) {
    throw new Error(
      data.error?.message || "OpenAI API error"
    );
  }

  return (
    data.output
      ?.filter(item => item.type === "message")
      ?.flatMap(item => item.content || [])
      ?.find(item => item.type === "output_text")
      ?.text || ""
  );
}

async function updateMemory(message) {
  const oldMemory = readMemory();

  const result = await askAI([
    {
      role: "system",
      content: `You manage GENI's long-term memory.
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
    console.log("GENI memory saved 🧠");
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
    res.writeHead(404);
    return res.end("Not found");
  }

  let body = "";

  req.on("data", chunk => {
    body += chunk;

    if (body.length > 1000000) {
      res.writeHead(413);
      res.end(JSON.stringify({
        error: "Message too large"
      }));
      req.destroy();
    }
  });

  req.on("end", async () => {
    try {
      if (!API_KEY) {
        throw new Error("API key missing in Termux");
      }

      const { message } = JSON.parse(body);

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
          content: `Your name is GENI.
You are a helpful AI assistant.
Never say your name is ChatGPT.
If asked your name, say: My name is GENI.

Use saved memories when relevant.
Never claim the user said something unless supported by memory.

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

      // Save important facts automatically.
      updateMemory(message.trim()).catch(error => {
        console.log("Memory update failed:", error.message);
      });

    } catch (error) {
      console.log("GENI error:", error.message);

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

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `GENI Backend running at http://127.0.0.1:${PORT}`
  );
});
