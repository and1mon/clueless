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
import { runFullLlmTurn, runTeammateRound, autoSpymasterHint, runBanterRound, runEndGameBanter, fireAndForget } from './deliberation.js';
import { type TeamColor } from './types.js';
import { initTTS, generateAudio, isTTSReady } from './ttsService.js';
import { setTtsMode, ackTts } from './ttsGate.js';

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json());

function parseTeam(value: string): TeamColor {
  if (value !== 'red' && value !== 'blue') throw new Error('Team must be red or blue.');
  return value;
}

// C1+C2: Simplified autoplay — handles banter once, then loops all-LLM turns
async function autoplayIfNeeded(gameId: string): Promise<void> {
  // Handle any pending banter first
  const game = getGame(gameId);
  if (!game.winner && game.turn.phase === 'banter') {
    await runBanterRound(gameId);
  }

  // Run up to 3 consecutive all-LLM turns (turn may switch to the other all-LLM team)
  for (let i = 0; i < 3; i += 1) {
    const current = getGame(gameId);
    if (current.winner || hasHumanPlayer(current, current.turn.activeTeam)) break;
    await runFullLlmTurn(gameId, current.turn.activeTeam, 20);
  }

  // Auto-trigger spymaster hint if a human team is now active
  const updated = getGame(gameId);
  if (!updated.winner) {
    await autoSpymasterHint(gameId, updated.turn.activeTeam);
  }

  // End-game banter if game just ended
  if (getGame(gameId).winner) {
    await runEndGameBanter(gameId);
  }
}

// C3: Use fireAndForget for background LLM actions
function afterHumanAction(gameId: string, team: TeamColor): void {
  fireAndForget(async () => {
    const game = getGame(gameId);
    if (game.winner) {
      await runEndGameBanter(gameId);
      return;
    }
    if (game.turn.phase === 'banter') {
      await runBanterRound(gameId);
    }
    const updated = getGame(gameId);
    if (!updated.winner && updated.turn.activeTeam === team) {
      await runTeammateRound(gameId, team);
    }
    await autoplayIfNeeded(gameId);
  }, 'afterHumanAction');
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/games', (req, res) => {
  try {
    const game = createGame(req.body ?? {});
    res.status(201).json(serializeGame(game));
    fireAndForget(async () => {
      if (!hasHumanPlayer(game, game.turn.activeTeam)) {
        await autoplayIfNeeded(game.id);
      } else {
        await autoSpymasterHint(game.id, game.turn.activeTeam);
      }
    }, 'gameCreate');
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

app.post('/api/games/:gameId/tts-mode', (req, res) => {
  const enabled = !!req.body.enabled;
  setTtsMode(req.params.gameId, enabled);
  res.json({ ttsEnabled: enabled });
});

app.post('/api/games/:gameId/tts-ack', (req, res) => {
  ackTts(req.params.gameId);
  res.json({ status: 'ok' });
});

app.get('/api/tts/health', (_req, res) => {
  res.json({ status: isTTSReady() ? 'ok' : 'loading' });
});

app.post('/api/tts', async (req, res) => {
  const { text, voice } = req.body ?? {};
  if (!text) return res.status(400).json({ error: 'text is required' });
  if (!isTTSReady()) return res.status(503).json({ error: 'TTS model still loading' });
  const wav = await generateAudio(text, voice || 'af_heart');
  if (!wav) return res.status(500).json({ error: 'TTS generation failed' });
  res.set('Content-Type', 'audio/wav');
  res.send(wav);
});

app.listen(port, () => {
  console.log(`Clueless server running on http://localhost:${port}`);
  initTTS();
});
