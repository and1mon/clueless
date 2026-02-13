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
  
  // Handle any pending banter first
  const game = getGame(gameId);
  if (!game.winner && game.turn.phase === 'banter') {
    logServer('INFO', 'autoplayIfNeeded', `Handling banter phase (start)`, { gameId });
    await runBanterRound(gameId);
  }

  // Keep running while active team is all-LLM (with a hard safety cap)
  const maxAutoplayTurns = 100;
  for (let i = 0; i < maxAutoplayTurns; i += 1) {
    const current = getGame(gameId);
    if (current.winner) {
      logServer('INFO', 'autoplayIfNeeded', `Game has winner, stopping loop`, { gameId, winner: current.winner, iteration: i });
      break;
    }
    if (hasHumanPlayer(current, current.turn.activeTeam)) {
      logServer('INFO', 'autoplayIfNeeded', `Human player on active team, stopping loop`, { gameId, activeTeam: current.turn.activeTeam, iteration: i });
      break;
    }
    logServer('INFO', 'autoplayIfNeeded', `Running full LLM turn`, { gameId, activeTeam: current.turn.activeTeam, iteration: i });
    await runFullLlmTurn(gameId, current.turn.activeTeam, 20);
  }

  // Handle banter if we ended up in banter phase (e.g., after a turn switch)
  const afterLoop = getGame(gameId);
  if (!afterLoop.winner && afterLoop.turn.phase === 'banter') {
    logServer('INFO', 'autoplayIfNeeded', `Handling banter phase (after loop)`, { gameId });
    await runBanterRound(gameId);
  }

  // Auto-trigger spymaster hint if a human team is now active
  const updated = getGame(gameId);
  if (!updated.winner) {
    logServer('INFO', 'autoplayIfNeeded', `Triggering auto spymaster hint`, { gameId, activeTeam: updated.turn.activeTeam, phase: updated.turn.phase });
    await autoSpymasterHint(gameId, updated.turn.activeTeam);
  }

  // After human team's turn, check if turn switched to an all-LLM team
  const afterHint = getGame(gameId);
  if (!afterHint.winner && !hasHumanPlayer(afterHint, afterHint.turn.activeTeam)) {
    logServer('INFO', 'autoplayIfNeeded', `Turn switched to all-LLM team, continuing autoplay`, { gameId, activeTeam: afterHint.turn.activeTeam });
    // Handle banter if needed before LLM turn
    if (afterHint.turn.phase === 'banter') {
      await runBanterRound(gameId);
    }
    // Run the all-LLM team's turn
    const postBanter = getGame(gameId);
    if (!postBanter.winner && !hasHumanPlayer(postBanter, postBanter.turn.activeTeam)) {
      await runFullLlmTurn(gameId, postBanter.turn.activeTeam, 20);
    }
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
      logServer('INFO', 'afterHumanAction', `Running teammate round`, { gameId, team });
      await runTeammateRound(gameId, team);
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
