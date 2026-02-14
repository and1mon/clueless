# Clueless

Clueless is a local word spy game where one human and multiple LLM players chat, propose hints/guesses, vote, and play turns until a winner is decided.

## Stack

- **Frontend:** React + Vite + TypeScript
- **Backend:** Node.js + Express + TypeScript
- **LLM integration:** OpenAI-compatible `/chat/completions` endpoint

## Quick start

```bash
npm install
npm run dev
```

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3001`

## How it works

1. Start a game from the UI with your human name/team, team LLM counts, and LLM endpoint config.
2. Each team has its own chat and proposal log.
3. Players can:
   - send chat messages,
   - propose `hint`, `guess`, or `end_turn`,
   - vote accept/reject on pending proposals.
4. A proposal is applied once team votes reach majority.
5. If the active team has no human players, the backend auto-runs LLM deliberation for that turn.

## LLM endpoint expectations

The backend sends prompts to:

`{baseUrl}/chat/completions`

with OpenAI-style payload:

```json
{
  "model": "your-model",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "..." }
  ]
}
```

The model must return valid JSON action objects in message content (`chat`, `propose`, `vote`, or `pass`).
