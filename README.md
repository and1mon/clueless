# Clueless

A word spy game where LLM-powered players debate, bluff, and compete on teams. Play as a spymaster or operative alongside AI teammates, or spectate a fully autonomous match.

## Stack

- **Frontend:** React, Vite, TypeScript
- **Backend:** Node.js, Express, TypeScript
- **LLM:** Any OpenAI-compatible chat completions endpoint
- **TTS:** Optional text-to-speech for voiced player dialogue

## Setup

Create a `.env` file in the project root:

```env
LLM_BASE_URL=http://localhost:8082/v1
LLM_MODEL=your-model-name
LLM_API_KEY=your-api-key
PORT=3001
```

| Variable | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:8082/v1` | Base URL of your OpenAI-compatible endpoint |
| `LLM_MODEL` | `Qwen3-VL-8B-Instruct-Q8_0` | Model name to use |
| `LLM_API_KEY` | (empty) | API key, if your endpoint requires one |
| `PORT` | `3001` | Server port |

Then install and run:

```bash
npm install
npm run dev
```

Frontend at `http://localhost:5173`, API at `http://localhost:3001`.

These defaults can also be overridden per-team or per-player in the game creation UI.

## Game overview

Two teams (red and blue) compete to uncover their team's words on a shared 25-word board. Each word is secretly assigned to red, blue, neutral, or assassin. Only spymasters see the assignments.

**Spymaster** gives a one-word hint and a number indicating how many board words it relates to. **Operatives** discuss, propose guesses, and vote as a team. Guessing correctly lets the team continue; hitting the other team's word or a neutral ends the turn; hitting the assassin loses the game instantly.

## Modes

- **Play as spymaster** -- you give the hints, AI teammates guess
- **Play as operative** -- AI spymaster hints, you guess with AI teammates
- **Spectator** -- watch a full AI-vs-AI match with card visibility and spymaster reasoning

## Project structure

```
server/
  src/
    index.ts          Express API and SSE event stream
    gameStore.ts      Game state, card assignment, proposals, voting
    deliberation.ts   LLM turn orchestration and conversation rounds
    llmClient.ts      Prompt engineering, LLM request/response handling
    words.ts          Board word pool
    types.ts          Shared type definitions
client/
  src/
    App.tsx           Main UI component
    types.ts          Client-side types
```
