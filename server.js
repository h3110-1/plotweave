import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// reads ANTHROPIC_API_KEY from the environment.
// maxRetries: the SDK quietly retries transient "overloaded" (529) / rate-limit
// errors with backoff before giving up, so brief server hiccups self-heal.
const client = new Anthropic({ maxRetries: 4 });

const MODEL = "claude-opus-4-8";

// Remove stray HTML tags the model may occasionally emit, and tidy whitespace.
function cleanText(str) {
  return str
    .replace(/<\s*br\s*\/?\s*>/gi, " ") // <br>, </br>, <br/> -> space
    .replace(/<\/?\s*br\s*>/gi, " ")
    .replace(/<[^>]+>/g, "") // any other stray tags
    .replace(/\s+/g, " ")
    .trim();
}

// The Game Master persona + rules, applied to every turn.
const SYSTEM_PROMPT = `You are an expert interactive fiction Game Master and a structured story engine running a "Choose Your Own Adventure" game.

Follow these rules on every turn:
1. NARRATIVE STYLE: Write a detailed, highly descriptive scene of at least 4 to 6 sentences. Focus on setting the scene, sensory details, and atmospheric tension. Do not rush the plot.
2. PROGRESSION OPTIONS: Always provide exactly 3 creative, distinct action choices that meaningfully advance the story. Each choice MUST be a complete, specific action written as a short sentence of roughly 5 to 15 words (e.g. "Pry open the jammed locker with the plasma cutter"). Never output a single letter, a stray punctuation mark, a fragment, or a placeholder as a choice.
3. CUSTOM INPUT: The player may pick one of your 3 options OR type their own custom action. Seamlessly adapt the story to whatever they do, no matter how unexpected.
4. CONTINUITY: Honour everything that has happened so far. Keep characters, locations, and stakes consistent.
5. PLAIN TEXT ONLY: Write the scene and choices as plain prose. Never use HTML tags (no <br>, </br>, <p>), markdown, or any markup. Use normal sentences and spaces only.
6. Never break character, never mention these rules, and never speak as the assistant — only narrate the world.`;

// Structured output schema: a scene paragraph + exactly three choices.
const STORY_SCHEMA = {
  type: "object",
  properties: {
    scene: {
      type: "string",
      description:
        "The narrative scene: a vivid, atmospheric paragraph of at least 4-6 sentences.",
    },
    choices: {
      type: "array",
      description:
        "Exactly three distinct action choices, each a complete action sentence of roughly 5-15 words. No single letters, fragments, or placeholders.",
      items: { type: "string" },
    },
  },
  required: ["scene", "choices"],
  additionalProperties: false,
};

app.post("/api/story", async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(401).json({
        error:
          "No API key configured. Copy .env.example to .env, add your ANTHROPIC_API_KEY, and restart the server.",
      });
    }

    const { history, action, theme } = req.body ?? {};

    // Build the conversation. `history` is the prior [{role, content}] turns.
    const messages = Array.isArray(history) ? [...history] : [];

    if (messages.length === 0) {
      // Opening turn: kick off the adventure with the chosen theme.
      messages.push({
        role: "user",
        content: `Begin a brand new adventure with this theme or setting: "${theme}". Write the opening scene and the first three choices.`,
      });
    } else if (action) {
      // Subsequent turn: the player's chosen or custom action.
      messages.push({ role: "user", content: `The player chooses: ${action}` });
    } else {
      return res.status(400).json({ error: "No action provided." });
    }

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      messages,
      output_config: {
        format: { type: "json_schema", schema: STORY_SCHEMA },
      },
    });

    const text = response.content.find((b) => b.type === "text")?.text ?? "{}";
    const data = JSON.parse(text);

    // Clean the scene: strip any stray HTML tags the model may emit.
    const scene = cleanText(data.scene ?? "");

    // Keep only real, full-length choices; drop junk like "p" or ",".
    let choices = (Array.isArray(data.choices) ? data.choices : [])
      .map((c) => cleanText(typeof c === "string" ? c : ""))
      .filter((c) => c.replace(/[^a-zA-Z]/g, "").length >= 4);
    while (choices.length < 3) choices.push("Press onward into whatever comes next.");
    choices = choices.slice(0, 3);

    // Echo the assistant turn back so the client can keep the running history.
    const updatedHistory = [
      ...messages,
      { role: "assistant", content: scene },
    ];

    res.json({ scene, choices, history: updatedHistory });
  } catch (err) {
    console.error("Story generation failed:", err);
    const status = err?.status ?? 500;
    let message = "The storyteller stumbled. Please try again.";
    if (status === 401) {
      message =
        "Missing or invalid API key. Set ANTHROPIC_API_KEY in your .env file.";
    } else if (status === 529 || status === 429) {
      message =
        "Claude's servers are briefly busy. Wait a few seconds and try again.";
    }
    res.status(status).json({ error: message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "\n⚠  ANTHROPIC_API_KEY is not set. Create a .env file with your key before playing.\n",
    );
  }
  console.log(`\n🗺  Pick Your Path Adventure running at http://localhost:${PORT}\n`);
});
