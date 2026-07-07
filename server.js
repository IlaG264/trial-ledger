import express from "express";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.post("/api/chat", async (req, res) => {
  try {
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({
        error: {
          message: "Missing ANTHROPIC_API_KEY. Create a .env file and add your key."
        }
      });
    }

    const { system, messages } = req.body || {};

    if (!system || !Array.isArray(messages)) {
      return res.status(400).json({
        error: {
          message: "Request must include system and messages."
        }
      });
    }

    const anthropicResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": ANTHROPIC_API_KEY
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 1000,
        system,
        messages
      })
    });

    const text = await anthropicResponse.text();

    res
      .status(anthropicResponse.status)
      .type("application/json")
      .send(text);
  } catch (error) {
    res.status(500).json({
      error: {
        message: `Server could not reach Anthropic: ${error.message}`
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`Trial Ledger running at http://localhost:${PORT}`);
});
