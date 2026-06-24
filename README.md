# 🗺️ Pick Your Path — Adventure

A "Choose Your Own Adventure" web game where the story is written dynamically as
you play. Pick a setting, then steer the tale with the three offered choices —
or type any custom action you can imagine. Powered by Claude (`claude-opus-4-8`).

## How it works

- **Frontend** (`public/`) — a themed single-page UI: theme selection, the story
  panel, three choice buttons, and a free-text action box.
- **Backend** (`server.js`) — a small Express server that keeps your API key
  server-side and calls Claude with the Game Master rules baked into the system
  prompt. It uses structured outputs so every turn reliably returns a scene plus
  exactly three choices. The server is stateless; the browser holds the running
  story history and sends it back each turn.

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Add your API key** — copy `.env.example` to `.env` and paste your key:
   ```bash
   cp .env.example .env
   ```
   Get a key at https://console.anthropic.com/. The `.env` file is gitignored.

3. **Run it**
   ```bash
   npm start
   ```
   Open http://localhost:3000 and begin your adventure.

   During development, `npm run dev` restarts the server on file changes.

## Customising

- **The Game Master's style** lives in `SYSTEM_PROMPT` in `server.js` — tweak the
  narrative rules there.
- **The starter themes** are the `data-theme` cards in `public/index.html`.
- **The look** is all in `public/style.css`.
