import cors from 'cors';
import express from 'express';
import {
  createGame,
  createProposal,
  getGame,
  hasHumanPlayer,
  postChatMessage,
  serializeGame,
  submitHint,
  voteOnProposal,
} from './gameStore.js';
import { runFullLlmTurn, runTeammateRound, autoSpymasterHint } from './deliberation.js';
import { type TeamColor } from './types.js';

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());

function parseTeam(value: string): TeamColor {
  if (value !== 'red' && value !== 'blue') throw new Error('Team must be red or blue.');
  return value;
}

async function autoplayIfNeeded(gameId: string): Promise<void> {
  for (let i = 0; i < 3; i += 1) {
    const game = getGame(gameId);
    if (game.winner || hasHumanPlayer(game, game.turn.activeTeam)) break;
    await runFullLlmTurn(gameId, game.turn.activeTeam, 20);
  }
  // After all-LLM turns resolve, auto-trigger spymaster hint if needed
  const game = getGame(gameId);
  if (!game.winner) {
    await autoSpymasterHint(gameId, game.turn.activeTeam);
  }
}

function afterHumanAction(gameId: string, team: TeamColor): void {
  (async () => {
    try {
      await runTeammateRound(gameId, team);
      await autoplayIfNeeded(gameId);
    } catch (err) {
      console.error('Background LLM error:', err);
    }
  })();
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/games', (req, res) => {
  try {
    const game = createGame(req.body ?? {});
    res.status(201).json(serializeGame(game));
    // Kick off LLM activity in the background
    (async () => {
      try {
        if (!hasHumanPlayer(game, game.turn.activeTeam)) {
          await autoplayIfNeeded(game.id);
        } else {
          await autoSpymasterHint(game.id, game.turn.activeTeam);
        }
      } catch (e) { console.error(e); }
    })();
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.get('/api/games/:gameId', (req, res) => {
  try {
    res.json(serializeGame(getGame(req.params.gameId)));
  } catch (error) {
    res.status(404).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/games/:gameId/chat', (req, res) => {
  try {
    const team = parseTeam(req.body.team);
    const game = postChatMessage(req.params.gameId, team, req.body.playerId, req.body.content);
    res.json(serializeGame(game));
    afterHumanAction(game.id, team);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/games/:gameId/hint', (req, res) => {
  try {
    const team = parseTeam(req.body.team);
    const game = submitHint(req.params.gameId, team, req.body.playerId, req.body.word, req.body.count);
    res.json(serializeGame(game));
    afterHumanAction(game.id, team);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/games/:gameId/proposals', (req, res) => {
  try {
    const team = parseTeam(req.body.team);
    const game = createProposal(req.params.gameId, team, req.body.playerId, req.body.kind, req.body.payload ?? {});
    res.json(serializeGame(game));
    afterHumanAction(game.id, team);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/games/:gameId/proposals/:proposalId/vote', (req, res) => {
  try {
    const team = parseTeam(req.body.team);
    if (req.body.decision !== 'accept' && req.body.decision !== 'reject') {
      throw new Error('decision must be accept or reject.');
    }
    const game = voteOnProposal(req.params.gameId, team, req.body.playerId, req.params.proposalId, req.body.decision);
    res.json(serializeGame(game));
    afterHumanAction(game.id, team);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.post('/api/games/:gameId/teams/:team/llm-deliberate', (req, res) => {
  try {
    const team = parseTeam(req.params.team);
    res.json({ status: 'ok' });
    afterHumanAction(req.params.gameId, team);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

app.listen(port, () => {
  console.log(`Clueless server running on http://localhost:${port}`);
});
