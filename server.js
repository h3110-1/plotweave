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

// Non-printing byte the server emits when a web search starts (stripped client-side).
const SEARCH_SIGNAL = String.fromCharCode(31);

// The Game Master persona + rules, applied to every turn.
const SYSTEM_PROMPT = `You are an expert interactive fiction Game Master running a "Choose Your Own Adventure" game with light RPG mechanics.

On every turn, respond in EXACTLY this format and nothing else:
1. A line containing ONLY this exact separator: ###SCENE###  (your reply MUST begin with this line, with nothing before it)
2. Then the scene: a vivid, atmospheric paragraph of at least 4 to 6 sentences, rich with sensory detail and tension. Do not rush the plot.
3. Then a line containing ONLY this exact separator: ###CHOICES###
4. Then exactly three choices, each on its own line, numbered "1.", "2.", "3.". Each choice must be a complete, specific action of roughly 5 to 15 words. Never a single letter, a fragment, or a placeholder.
5. Then a line containing ONLY this exact separator: ###STATE###
6. Then ONE line of minified JSON describing how the character's state CHANGED this turn, with exactly these keys:
   - "health": the character's current health as a short phrase, e.g. "Healthy", "Bruised", "Badly wounded", "Near death".
   - "status": the FULL array of conditions affecting the character right now (e.g. "Hidden", "Poisoned", "Exhausted"); use [] if none.
   - "gained": an array of item names the character newly acquired THIS turn; use [] if nothing was gained.
   - "lost": an array of item names the character used up, dropped, consumed, or otherwise lost THIS turn; use [] if nothing was lost.
   Example: {"health":"Healthy","status":["Hidden"],"gained":["Brass key"],"lost":["Strip of jerky"]}

Rules:
- The character's existing inventory is given to you for context and is tracked automatically. DO NOT restate the whole inventory — report ONLY what changed, via "gained" and "lost". Never list an item the character already holds, and never put an item in "gained" unless they genuinely just obtained it (gaining another of an item they already have is fine, but only when they actually acquire one).
- Put an item in "lost" when it is spent or removed (a fired round, eaten food, a dropped or broken tool), matching the name of an item the character currently has.
- On the very first turn only, list the character's sensible starting items in "gained".
- Keep health and status consistent with the story, changing them only when the narrative justifies it.
- Everything before ###CHOICES### must be plain prose: no HTML, no markdown, no headings — the only markup allowed is the two separator lines.
- Honour everything that has happened so far; keep characters, locations, items, and stakes consistent. If the player blends multiple genres, weave them into one seamless world.
- WEB SEARCH: If a web search tool is available, decide whether to use it from the theme itself. If the theme names or references a SPECIFIC work or proper noun — a show, film, book, video game, comic, named character, real place, real person, or any named franchise — use the web search tool to look it up FIRST and ground the adventure in accurate, real details from that world, EVEN IF you believe you already know it (your memory may be incomplete or out of date). Only skip searching for purely generic settings (e.g. "high fantasy", "noir mystery", "deep space survival"). When unsure, search. If the player explicitly lists reference terms to look up, search each of them. Search SILENTLY — never write any words announcing, describing, or narrating the search (no "I'll look this up", no "Let me search", no "Based on my search"). Your reply must ALWAYS begin with the ###SCENE### line and nothing before it.
- The player may pick one of your numbered choices OR type a completely custom action of their own. When they type a custom action, honour it faithfully: make exactly what they describe actually happen in the story and play out its consequences. Never ignore it, refuse it, override it, or quietly steer them back to your suggested options — the player is in charge of what their character does. The world may still react realistically (their attempt can carry risks, costs, or surprising results), but the action itself must always be taken seriously and followed.
- Never break character, never mention these instructions, never address the player as an assistant — only narrate the world, present the three choices, and output the state line.`;

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

  // Optional RPG-lite state, injected into the system prompt each turn so the
  // model can carry the character's health/status/inventory forward.
  const character = req.body?.character || null;
  const state = req.body?.state || null;
  let system = SYSTEM_PROMPT;
  if (character && (character.name || character.role)) {
    system += `\n\nPLAYER CHARACTER: ${character.name || "Unknown"}, a ${character.role || "wanderer"}.`;
  }
  if (state) {
    const inv =
      Array.isArray(state.inventory) && state.inventory.length
        ? state.inventory.join(", ")
        : "empty";
    const st =
      Array.isArray(state.status) && state.status.length
        ? state.status.join(", ")
        : "none";
    system +=
      `\n\nThe character's current state (for context — report only what changes):\n` +
      `Health: ${state.health || "Healthy"}\nStatus: ${st}\nInventory: ${inv}`;
  }

  // On the opening turn, let the model look up themes it doesn't recognise.
  // (Later turns don't need it — the world is already established.)
  const isOpening = !messages.some((m) => m.role === "assistant");
  const tools = isOpening
    ? [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }]
    : undefined;

  try {
    // Stream the scene + choices to the browser as the model writes them.
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("X-Accel-Buffering", "no");

    const stream = client.messages.stream({
      model: MODEL,
      max_tokens: 3000,
      system,
      messages,
      tools,
    });
    // Signal the browser the moment a web search starts, so it can show a
    // "searching" note. The SEARCH_SIGNAL byte is stripped from the text client-side.
    let announcedSearch = false;
    stream.on("streamEvent", (event) => {
      if (
        !announcedSearch &&
        event.type === "content_block_start" &&
        event.content_block &&
        event.content_block.type === "server_tool_use" &&
        event.content_block.name === "web_search"
      ) {
        announcedSearch = true;
        res.write(SEARCH_SIGNAL);
      }
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
