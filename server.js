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

// Optional shared password. When set (in .env locally, or in your host's
// environment variables once deployed), the game is locked: every story
// request must carry the matching password, so only people you give it to
// can spend your API credit. Leave it unset to run the game open.
const APP_PASSWORD = process.env.APP_PASSWORD || "";

const MODEL = "claude-opus-4-8";

// The Game Master persona + rules, applied to every turn.
const SYSTEM_PROMPT = `You are an expert interactive fiction Game Master running a "Choose Your Own Adventure" game.

On every turn, respond in EXACTLY this format and nothing else:
1. First, the scene: a vivid, atmospheric paragraph of at least 4 to 6 sentences, rich with sensory detail and tension. Do not rush the plot.
2. Then a line containing ONLY this exact separator: ###CHOICES###
3. Then exactly three choices, each on its own line, numbered "1.", "2.", "3.". Each choice must be a complete, specific action of roughly 5 to 15 words (e.g. "Pry open the jammed locker with the plasma cutter"). Never a single letter, a fragment, or a placeholder.

Rules:
- Write everything as plain prose. No HTML tags, no markdown, no asterisks or headings — the ONLY markup allowed is the ###CHOICES### separator line.
- Honour everything that has happened so far; keep characters, locations, and stakes consistent. If the player blends multiple genres, weave them into one seamless world.
- The player may pick a numbered choice OR type a custom action; adapt seamlessly to whatever they do.
- Never break character, never mention these instructions, never address the player as an assistant — only narrate the world and present the three choices.`;

// Lets the browser know whether to show the password screen.
app.get("/api/config", (req, res) => {
  res.json({ passwordRequired: Boolean(APP_PASSWORD) });
});

// Checks a password without starting a game (used by the login screen).
app.post("/api/login", (req, res) => {
  if (!APP_PASSWORD) return res.json({ ok: true }); // gate disabled
  if ((req.body?.password ?? "") === APP_PASSWORD) return res.json({ ok: true });
  return res.status(401).json({ ok: false, error: "Incorrect password." });
});

// Condenses older turns into a short running summary so long games stay cheap.
// Uses the cheaper Haiku model since this is background compression, not the story.
app.post("/api/summarize", async (req, res) => {
  if (APP_PASSWORD && req.get("x-app-password") !== APP_PASSWORD) {
    return res.status(401).json({ error: "Wrong or missing password." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(401).json({ error: "No API key configured." });
  }

  const prior = typeof req.body?.summary === "string" ? req.body.summary : "";
  const chunk = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (chunk.length === 0) return res.json({ summary: prior });

  const transcript = chunk
    .map((m) => (m.role === "user" ? `PLAYER: ${m.content}` : `STORY: ${m.content}`))
    .join("\n\n");
  const prompt =
    (prior ? `Existing summary of the story so far:\n${prior}\n\n` : "") +
    `New events to fold into the summary:\n${transcript}\n\n` +
    "Write an updated, concise summary (one short paragraph) capturing the key plot, " +
    "characters, locations, items, and unresolved threads needed to continue the story " +
    "consistently. Output only the summary text, with no preamble.";

  try {
    const r = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    const text = r.content.find((b) => b.type === "text")?.text ?? prior;
    res.json({ summary: text.trim() });
  } catch (err) {
    console.error("Summarize failed:", err);
    res.status(500).json({ error: "summarize failed" });
  }
});

app.post("/api/story", async (req, res) => {
  // Pre-stream validation — we can still reply with a JSON error + status here.
  if (APP_PASSWORD && req.get("x-app-password") !== APP_PASSWORD) {
    return res.status(401).json({ error: "Wrong or missing password." });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(401).json({
      error:
        "No API key configured. Copy .env.example to .env, add your ANTHROPIC_API_KEY, and restart the server.",
    });
  }

  // The browser sends the full conversation; we just prepend the system prompt.
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (messages.length === 0) {
    return res.status(400).json({ error: "No story to continue." });
  }

  try {
    // Stream the scene + choices to the browser as the model writes them.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 3000,
      system: SYSTEM_PROMPT,
      messages,
    });
    stream.on("text", (delta) => res.write(delta));
    await stream.finalMessage();
    res.end();
  } catch (err) {
    console.error("Story generation failed:", err);
    if (!res.headersSent) {
      const status = err?.status ?? 500;
      let message = "The storyteller stumbled. Please try again.";
      if (status === 529 || status === 429) {
        message =
          "Claude's servers are briefly busy. Wait a few seconds and try again.";
      }
      res.status(status).json({ error: message });
    } else {
      res.end(); // already streaming — just close; the client keeps what arrived
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn(
      "\n⚠  ANTHROPIC_API_KEY is not set. Create a .env file with your key before playing.\n",
    );
  }
  if (APP_PASSWORD) {
    console.log("🔒 Password protection is ON — players need the password to play.");
  } else {
    console.warn(
      "🔓 No APP_PASSWORD set — the game is OPEN to anyone who can reach it (your key, your bill).",
    );
  }
  console.log(`\n🗺  Plotweave running at http://localhost:${PORT}\n`);
});
