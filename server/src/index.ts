import cors from 'cors';
import express from 'express';
import {
  createGame,
  createProposal,
  getGame,
  hasHumanPlayer,
  isAbandoned,
  postChatMessage,
  serializeGame,
  setHumanPaused,
  submitHint,
  touchGame,
  voteOnProposal,
} from './gameStore.js';
import { runFullLlmTurn, autoSpymasterHint, runOperativeLoop, runBanterRound, runEndGameBanter, fireAndForget } from './deliberation.js';
import { type TeamColor } from './types.js';
import { initTTS, generateAudio, isTTSReady } from './ttsService.js';
import { setTtsMode, ackTts } from './ttsGate.js';

// Logging helper
function logServer(level: 'INFO' | 'WARN' | 'ERROR', context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  const log = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;
  log(`[${timestamp}] [${level}] [${context}] ${message}${dataStr}`);
}

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
  logServer('INFO', 'autoplayIfNeeded', `Starting autoplay check`, { gameId });

  // Keep running while active team is all-LLM (with a hard safety cap)
  const maxAutoplayTurns = 100;
  for (let i = 0; i < maxAutoplayTurns; i += 1) {
    const current = getGame(gameId);
    if (current.winner || isAbandoned(gameId)) {
      logServer('INFO', 'autoplayIfNeeded', `Game ended or abandoned, stopping loop`, { gameId, winner: current.winner, abandoned: isAbandoned(gameId), iteration: i });
      break;
    }

    // Handle banter between turns
    if (current.turn.phase === 'banter') {
      logServer('INFO', 'autoplayIfNeeded', `Handling banter phase`, { gameId, iteration: i });
      await runBanterRound(gameId);
      continue;
    }

    if (hasHumanPlayer(current, current.turn.activeTeam)) {
      logServer('INFO', 'autoplayIfNeeded', `Human player on active team, stopping loop`, { gameId, activeTeam: current.turn.activeTeam, iteration: i });
      break;
    }
    logServer('INFO', 'autoplayIfNeeded', `Running full LLM turn`, { gameId, activeTeam: current.turn.activeTeam, iteration: i });
    const didWork = await runFullLlmTurn(gameId, current.turn.activeTeam, 20);
    if (!didWork) {
      logServer('INFO', 'autoplayIfNeeded', `Turn did no work (lock contention), stopping loop`, { gameId, iteration: i });
      break;
    }
  }

  // Auto-trigger spymaster hint if a human team is now active
  const updated = getGame(gameId);
  if (!updated.winner) {
    logServer('INFO', 'autoplayIfNeeded', `Triggering auto spymaster hint`, { gameId, activeTeam: updated.turn.activeTeam, phase: updated.turn.phase });
    await autoSpymasterHint(gameId, updated.turn.activeTeam);
  }

  // End-game banter if game just ended
  if (getGame(gameId).winner) {
    logServer('INFO', 'autoplayIfNeeded', `Game ended, running end-game banter`, { gameId });
    await runEndGameBanter(gameId);
  }

  logServer('INFO', 'autoplayIfNeeded', `Autoplay completed`, { gameId });
}

// C3: Use fireAndForget for background LLM actions
function afterHumanAction(gameId: string, team: TeamColor): void {
  logServer('INFO', 'afterHumanAction', `Triggered`, { gameId, team });
  setHumanPaused(gameId, team, false);
  fireAndForget(async () => {
    const game = getGame(gameId);
    if (game.winner) {
      logServer('INFO', 'afterHumanAction', `Game has winner, running end-game banter`, { gameId, winner: game.winner });
      await runEndGameBanter(gameId);
      return;
    }
    if (game.turn.phase === 'banter') {
      logServer('INFO', 'afterHumanAction', `In banter phase, running banter round`, { gameId });
      await runBanterRound(gameId);
    }
    const updated = getGame(gameId);
    if (!updated.winner && updated.turn.activeTeam === team) {
      if (updated.turn.phase === 'hint') {
        logServer('INFO', 'afterHumanAction', `Running auto spymaster hint`, { gameId, team });
        await autoSpymasterHint(gameId, team);
      } else if (updated.turn.phase === 'guess') {
        logServer('INFO', 'afterHumanAction', `Running operative discussion loop`, { gameId, team });
        await runOperativeLoop(gameId, team);
      }
    }
    const postRound = getGame(gameId);
    if (postRound.humanPaused[team]) {
      logServer('INFO', 'afterHumanAction', `Paused by human`, { gameId, team });
      return;
    }
    logServer('INFO', 'afterHumanAction', `Running autoplay`, { gameId });
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
    touchGame(req.params.gameId);
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
    // Chat does NOT trigger afterHumanAction — LLMs are already running freely.
    // The human's message will be seen by LLMs in the next conversation round.
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

// ✋ Hold on — pause LLM discussion
app.post('/api/games/:gameId/teams/:team/pause', (req, res) => {
  try {
    const team = parseTeam(req.params.team);
    setHumanPaused(req.params.gameId, team, true);
    res.json(serializeGame(getGame(req.params.gameId)));
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

// ▶️ Continue — resume LLM discussion
app.post('/api/games/:gameId/teams/:team/resume', (req, res) => {
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
  touchGame(req.params.gameId);
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
