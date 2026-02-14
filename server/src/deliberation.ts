import {
  createProposal,
  endBanter,
  forfeitTurn,
  getGame,
  getSpymaster,
  getTeamLlmPlayers,
  hasHumanPlayer,
  otherTeam,
  postChatMessage,
  setDeliberating,
  setLlmError,
  submitHint,
  voteOnProposal,
} from './gameStore.js';
import { LlmClient } from './llmClient.js';
import type { Player, TeamColor } from './types.js';
import { waitForTtsAck } from './ttsGate.js';

// ---------------------------------------------------------------------------
// Logging helpers
// ---------------------------------------------------------------------------
function logInfo(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  console.log(`[${timestamp}] [INFO] [${context}] ${message}${dataStr}`);
}

function logWarn(context: string, message: string, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  console.warn(`[${timestamp}] [WARN] [${context}] ${message}${dataStr}`);
}

function logError(context: string, message: string, error?: unknown, data?: Record<string, unknown>): void {
  const timestamp = new Date().toISOString();
  const errStr = error instanceof Error ? error.message : String(error ?? '');
  const dataStr = data ? ` | ${JSON.stringify(data)}` : '';
  console.error(`[${timestamp}] [ERROR] [${context}] ${message}${errStr ? `: ${errStr}` : ''}${dataStr}`);
}

// ---------------------------------------------------------------------------
// C4: Per-team-per-game state grouped in one object
// ---------------------------------------------------------------------------
interface TeamTurnState {
  locked: boolean;
  failures: number;
  proposedWords: Set<string>;
}

const teamStates = new Map<string, TeamTurnState>();

function stateKey(gameId: string, team: TeamColor): string {
  return `${gameId}:${team}`;
}

function getTeamState(gameId: string, team: TeamColor): TeamTurnState {
  const key = stateKey(gameId, team);
  let s = teamStates.get(key);
  if (!s) {
    s = { locked: false, failures: 0, proposedWords: new Set() };
    teamStates.set(key, s);
  }
  return s;
}

function acquireLock(gameId: string, team: TeamColor): boolean {
  const s = getTeamState(gameId, team);
  if (s.locked) {
    logWarn('acquireLock', `Lock already held`, { gameId, team });
    return false;
  }
  s.locked = true;
  logInfo('acquireLock', `Lock acquired`, { gameId, team });
  return true;
}

function releaseLock(gameId: string, team: TeamColor): void {
  getTeamState(gameId, team).locked = false;
  logInfo('releaseLock', `Lock released`, { gameId, team });
}

function resetTurnCounters(gameId: string, team: TeamColor): void {
  const s = getTeamState(gameId, team);
  s.failures = 0;
  s.proposedWords.clear();
}

// ---------------------------------------------------------------------------
// C3: Fire-and-forget helper (used by index.ts via export)
// ---------------------------------------------------------------------------
export function fireAndForget(fn: () => Promise<void>, label: string): void {
  logInfo('fireAndForget', `Starting async task`, { label });
  fn()
    .then(() => logInfo('fireAndForget', `Completed async task`, { label }))
    .catch((err) => logError('fireAndForget', `Async task failed`, err, { label }));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function shuffle<T>(arr: T[]): T[] {
  const clone = [...arr];
  for (let i = clone.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function isGameOver(gameId: string): boolean {
  return !!getGame(gameId).winner;
}

function isStillActiveTeam(gameId: string, team: TeamColor): boolean {
  const g = getGame(gameId);
  return !g.winner && g.turn.activeTeam === team;
}

// ---------------------------------------------------------------------------
// Core: run a single LLM player turn
// ---------------------------------------------------------------------------
async function runOnePlayer(
  gameId: string,
  team: TeamColor,
  playerId: string,
): Promise<boolean> {
  const game = getGame(gameId);
  if (game.winner) {
    logInfo('runOnePlayer', `Skipped - game has winner`, { gameId, team, playerId });
    return false;
  }

  const isBanter = game.turn.phase === 'banter';
  if (!isBanter && game.turn.activeTeam !== team) {
    logInfo('runOnePlayer', `Skipped - not active team`, { gameId, team, playerId, activeTeam: game.turn.activeTeam });
    return false;
  }

  const player = game.players[playerId];
  if (!player || player.type !== 'llm') {
    logWarn('runOnePlayer', `Skipped - player not LLM`, { gameId, team, playerId });
    return false;
  }
  if (player.role === 'spymaster' && (game.turn.phase === 'guess' || isBanter)) {
    logInfo('runOnePlayer', `Skipped - spymaster in guess/banter phase`, { gameId, team, playerId, phase: game.turn.phase });
    return false;
  }

  logInfo('runOnePlayer', `Starting player turn`, { gameId, team, playerId, playerName: player.name, role: player.role, phase: game.turn.phase });

  const pending = game.proposals[team].filter((p) => p.status === 'pending');
  const chatHistory = game.chatLog
    .filter((m) => m.team === team || m.phase === 'banter')
    .map((m) => ({
      name: m.team !== team ? `[${m.team}] ${m.playerName}` : m.playerName,
      content: m.content,
    }));

  const playerConfig = player.model
    ? { ...game.llmConfig, model: player.model }
    : game.llmConfig;
  const client = new LlmClient(playerConfig);
  const boardWords = game.cards.map((c) => c.word.toLowerCase());

  const isHinting = player.role === 'spymaster' && game.turn.phase === 'hint';
  const maxAttempts = isHinting ? 5 : 1;
  const rejectedWords: string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      let extraHistory = rejectedWords.length
        ? [...chatHistory, { name: 'System', content: `Your previous hints were rejected because they are words on the board: ${rejectedWords.join(', ')}. Pick a DIFFERENT word that is NOT on the board.` }]
        : chatHistory;

      // Vote reminders
      if (pending.length > 0 && player.role === 'operative') {
        const proposal = pending[0];
        if (proposal.createdBy !== playerId) {
          const proposalTime = new Date(proposal.createdAt).getTime();
          const recentMsgs = game.chatLog.filter(
            (m) => m.team === team && new Date(m.createdAt).getTime() > proposalTime && !m.content.includes('voted'),
          ).length;
          if (recentMsgs >= 2) {
            extraHistory = [...extraHistory, { name: 'System', content: `⚠️ STOP TALKING. Vote on the pending proposal NOW.` }];
          } else if (recentMsgs >= 1) {
            extraHistory = [...extraHistory, { name: 'System', content: `There's a proposal waiting for your vote.` }];
          }
        }
      }

      // Failure escalation
      const ts = getTeamState(gameId, team);
      if (game.turn.phase === 'guess' && ts.failures >= 3 && player.role === 'operative') {
        const available = game.cards.filter((c) => !c.revealed).map((c) => c.word);
        extraHistory = [...extraHistory, {
          name: 'System',
          content: `🚨 CRITICAL: ${ts.failures} invalid guesses in a row. Valid words: ${available.join(', ')}. Propose ending the turn if unsure.`,
        }];
      }

      const response = await client.getResponse({
        game, player, team,
        pendingProposals: pending,
        chatHistory: extraHistory,
      });

      const action = response.action;
      logInfo('runOnePlayer', `LLM response received`, { gameId, team, playerId, actionType: action.type });
      const mustVoteProposal = game.turn.phase === 'guess' && player.role === 'operative'
        ? pending.find((p) => p.createdBy !== playerId)
        : undefined;
      if (mustVoteProposal) {
        if (action.type !== 'vote') {
          logWarn('runOnePlayer', `Expected vote but got non-vote action`, {
            gameId, team, playerId, actionType: action.type, proposalId: mustVoteProposal.id,
          });
          ts.failures++;
          return false;
        }
        if (action.proposalId !== mustVoteProposal.id) {
          logWarn('runOnePlayer', `Expected vote on pending proposal`, {
            gameId, team, playerId, expectedProposalId: mustVoteProposal.id, gotProposalId: action.proposalId,
          });
          ts.failures++;
          return false;
        }
      }

      // Validate hint
      if (action.type === 'hint' && boardWords.includes(action.word.toLowerCase())) {
        logWarn('runOnePlayer', `Hint rejected - word on board`, { gameId, team, playerId, word: action.word });
        rejectedWords.push(action.word);
        continue;
      }

      if (action.type === 'hint') {
        try {
          submitHint(gameId, team, player.id, action.word, action.count);
          logInfo('runOnePlayer', `Hint submitted`, { gameId, team, playerId, word: action.word, count: action.count });
        } catch (hintErr) {
          logWarn('runOnePlayer', `Hint submission failed`, { gameId, team, playerId, word: action.word, error: String(hintErr) });
          rejectedWords.push(action.word);
          continue;
        }
      } else {
        if (response.message && response.message !== '...') {
          postChatMessage(gameId, team, player.id, response.message);
        }

        if (action.type === 'propose_guess') {
          try {
            createProposal(gameId, team, player.id, 'guess', { word: action.word });
            logInfo('runOnePlayer', `Guess proposed`, { gameId, team, playerId, word: action.word });
            const normalizedWord = action.word.toLowerCase();
            if (!ts.proposedWords.has(normalizedWord)) {
              ts.failures = 0;
            }
            ts.proposedWords.add(normalizedWord);
          } catch (propErr) {
            const errMsg = propErr instanceof Error ? propErr.message : String(propErr);
            logWarn('runOnePlayer', `Proposal failed`, { gameId, team, playerId, word: action.word, error: errMsg });
            if (errMsg.includes('not on the board') || errMsg.includes('already been revealed') || errMsg.includes('already a pending proposal')) {
              postChatMessage(gameId, team, player.id, `❌ Cannot guess "${action.word}" — ${errMsg}`);
              ts.failures++;
              return false;
            }
            throw propErr;
          }
        } else if (action.type === 'propose_end_turn') {
          createProposal(gameId, team, player.id, 'end_turn', {});
          logInfo('runOnePlayer', `End turn proposed`, { gameId, team, playerId });
        } else if (action.type === 'vote') {
          try {
            voteOnProposal(gameId, team, player.id, action.proposalId, action.decision);
            logInfo('runOnePlayer', `Vote cast`, { gameId, team, playerId, proposalId: action.proposalId, decision: action.decision });
          } catch (voteErr) {
            const voteErrMsg = voteErr instanceof Error ? voteErr.message : String(voteErr);
            // Proposal already resolved or not found - this is okay, just continue
            if (voteErrMsg.includes('not found') || voteErrMsg.includes('not pending')) {
              logWarn('runOnePlayer', `Vote skipped - proposal already resolved`, { gameId, team, playerId, proposalId: action.proposalId, error: voteErrMsg });
            } else {
              throw voteErr;
            }
          }
        }
      }

      logInfo('runOnePlayer', `Player turn completed successfully`, { gameId, team, playerId });
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logError('runOnePlayer', `LLM call failed`, err, { gameId, team, playerId, playerName: player.name, attempt });
      if (/fetch|ECONNREFUSED|failed|40[134]/i.test(msg)) {
        setLlmError(gameId, `LLM error (${player.name}): ${msg}`);
      }
      return false;
    }
  }

  logError('runOnePlayer', `Failed to produce valid hint after max attempts`, undefined, { gameId, team, playerId, playerName: player.name, maxAttempts });
  return false;
}

// ---------------------------------------------------------------------------
// B3: Conversation round with shuffled order
// B4: Back-and-forth — re-prompt players who were directly addressed or need to vote
// ---------------------------------------------------------------------------
async function runConversationRound(
  gameId: string,
  team: TeamColor,
): Promise<boolean> {
  const game = getGame(gameId);
  const llmPlayers = getTeamLlmPlayers(game, team);
  if (!llmPlayers.length) {
    logWarn('runConversationRound', `No LLM players on team`, { gameId, team });
    return false;
  }

  logInfo('runConversationRound', `Starting conversation round`, { gameId, team, playerCount: llmPlayers.length, phase: game.turn.phase });

  // B3: Shuffle speaking order each round
  const speakers = shuffle(llmPlayers);
  // Track who already spoke this round to prevent double-speaking
  const spokePlayers = new Set<string>();

  for (const player of speakers) {
    if (isGameOver(gameId)) {
      logInfo('runConversationRound', `Exiting - game over`, { gameId, team });
      return true;
    }
    if (!isStillActiveTeam(gameId, team)) {
      logInfo('runConversationRound', `Exiting - no longer active team`, { gameId, team });
      return true;
    }
    if (spokePlayers.has(player.id)) continue;

    logInfo('runConversationRound', `Player speaking`, { gameId, team, playerId: player.id, playerName: player.name });
    await runOnePlayer(gameId, team, player.id);
    spokePlayers.add(player.id);
    logInfo('runConversationRound', `Waiting for TTS ack`, { gameId, team, playerId: player.id });
    await waitForTtsAck(gameId);
    logInfo('runConversationRound', `TTS ack received`, { gameId, team, playerId: player.id });

    // B4: If a proposal was just created, let remaining players vote (once each)
    const current = getGame(gameId);
    const pendingNow = current.proposals[team].filter((p) => p.status === 'pending');
    if (pendingNow.length > 0) {
      const proposal = pendingNow[0];
      logInfo('runConversationRound', `Pending proposal found, collecting votes`, { gameId, team, proposalId: proposal.id });
      const voters = speakers.filter(
        (p) => p.id !== proposal.createdBy && !proposal.votes[p.id] && !spokePlayers.has(p.id),
      );
      for (const voter of voters) {
        const check = getGame(gameId);
        const stillPending = check.proposals[team].find((p) => p.id === proposal.id && p.status === 'pending');
        if (!stillPending || check.winner) {
          logInfo('runConversationRound', `Proposal no longer pending or game ended`, { gameId, team, proposalId: proposal.id });
          break;
        }
        logInfo('runConversationRound', `Voter speaking`, { gameId, team, voterId: voter.id, voterName: voter.name });
        await runOnePlayer(gameId, team, voter.id);
        spokePlayers.add(voter.id);
        logInfo('runConversationRound', `Waiting for TTS ack (voter)`, { gameId, team, voterId: voter.id });
        await waitForTtsAck(gameId);
        logInfo('runConversationRound', `TTS ack received (voter)`, { gameId, team, voterId: voter.id });
      }
    }

    // Check failure threshold
    const ts = getTeamState(gameId, team);
    if (ts.failures >= 6) {
      logError('runConversationRound', `Too many failures, forfeiting turn`, undefined, { gameId, team, failures: ts.failures });
      forfeitTurn(gameId, team, `Team ${team} kept making invalid moves. Turn forfeited.`);
      return false;
    }
  }
  logInfo('runConversationRound', `Conversation round completed`, { gameId, team });
  return true;
}

// ---------------------------------------------------------------------------
// D2: Reaction messages after a card reveal
// ---------------------------------------------------------------------------
async function runRevealReaction(gameId: string, team: TeamColor): Promise<void> {
  logInfo('runRevealReaction', `Starting reveal reaction`, { gameId, team });
  const game = getGame(gameId);
  if (game.winner) {
    logInfo('runRevealReaction', `Skipped - game has winner`, { gameId, team });
    return;
  }

  const operatives = getTeamLlmPlayers(game, team).filter((p) => p.role === 'operative');
  if (operatives.length === 0) {
    logInfo('runRevealReaction', `Skipped - no LLM operatives`, { gameId, team });
    return;
  }

  // Pick 1 random operative to react
  const reactor = pickRandom(operatives);
  setDeliberating(gameId, team, true);
  try {
    await runOnePlayer(gameId, team, reactor.id);
    await waitForTtsAck(gameId);
    logInfo('runRevealReaction', `Reveal reaction completed`, { gameId, team, reactorId: reactor.id });
  } finally {
    setDeliberating(gameId, team, false);
  }
}

// ---------------------------------------------------------------------------
// C1 + B5: Banter as actual cross-team dialogue (2-3 exchanges)
// ---------------------------------------------------------------------------
export async function runBanterRound(gameId: string): Promise<void> {
  logInfo('runBanterRound', `Starting banter round`, { gameId });
  const game = getGame(gameId);
  if (game.winner || game.turn.phase !== 'banter') {
    logInfo('runBanterRound', `Skipped - not in banter phase or game ended`, { gameId, phase: game.turn.phase, winner: game.winner });
    return;
  }

  const incomingTeam = game.turn.activeTeam;
  const outgoingTeam = game.turn.previousTeam;
  if (!outgoingTeam) {
    logInfo('runBanterRound', `No previous team, ending banter`, { gameId });
    endBanter(gameId);
    return;
  }

  const outOps = getTeamLlmPlayers(game, outgoingTeam).filter((p) => p.role === 'operative');
  const inOps = getTeamLlmPlayers(game, incomingTeam).filter((p) => p.role === 'operative');

  // B5: 2-3 back-and-forth exchanges across teams
  const exchanges: Array<{ team: TeamColor; players: Player[] }> = [
    { team: outgoingTeam, players: outOps },
    { team: incomingTeam, players: inOps },
    { team: outgoingTeam, players: outOps },
  ];

  for (let i = 0; i < exchanges.length; i++) {
    const { team: t, players } = exchanges[i];
    if (players.length === 0) {
      logInfo('runBanterRound', `Exchange skipped - no players`, { gameId, team: t, exchangeIndex: i });
      continue;
    }
    const check = getGame(gameId);
    if (check.winner || check.turn.phase !== 'banter') {
      logInfo('runBanterRound', `Banter interrupted`, { gameId, winner: check.winner, phase: check.turn.phase });
      break;
    }

    const speaker = pickRandom(players);
    logInfo('runBanterRound', `Banter exchange`, { gameId, team: t, speakerId: speaker.id, speakerName: speaker.name, exchangeIndex: i });
    setDeliberating(gameId, t, true);
    try {
      await runOnePlayer(gameId, t, speaker.id);
      await waitForTtsAck(gameId);
    } finally {
      setDeliberating(gameId, t, false);
    }
  }

  const final = getGame(gameId);
  if (final.turn.phase === 'banter') {
    logInfo('runBanterRound', `Ending banter phase`, { gameId });
    endBanter(gameId);
  }
  logInfo('runBanterRound', `Banter round completed`, { gameId });
}

// ---------------------------------------------------------------------------
// C1: Single banter handler for autoplay
// ---------------------------------------------------------------------------
async function handleBanterIfNeeded(gameId: string): Promise<void> {
  const game = getGame(gameId);
  if (!game.winner && game.turn.phase === 'banter') {
    logInfo('handleBanterIfNeeded', `Banter needed, triggering`, { gameId });
    await runBanterRound(gameId);
  }
}

// ---------------------------------------------------------------------------
// D1: Spymaster "thinking" before hinting
// ---------------------------------------------------------------------------
async function runSpymasterHint(gameId: string, team: TeamColor): Promise<boolean> {
  logInfo('runSpymasterHint', `Starting spymaster hint`, { gameId, team });
  const game = getGame(gameId);
  if (game.winner || game.turn.activeTeam !== team || game.turn.phase !== 'hint') {
    logInfo('runSpymasterHint', `Skipped - conditions not met`, { gameId, team, winner: game.winner, activeTeam: game.turn.activeTeam, phase: game.turn.phase });
    return true;
  }

  const spymaster = getSpymaster(game, team);
  if (!spymaster || spymaster.type !== 'llm') {
    logInfo('runSpymasterHint', `Skipped - no LLM spymaster`, { gameId, team });
    return true;
  }

  const success = await runOnePlayer(gameId, team, spymaster.id);
  if (!success) {
    logError('runSpymasterHint', `Spymaster failed to produce valid hint, forfeiting`, undefined, { gameId, team, spymasterName: spymaster.name });
    forfeitTurn(gameId, team, `${spymaster.name} could not provide a valid hint. Turn forfeited.`);
    return false;
  }
  logInfo('runSpymasterHint', `Spymaster hint completed`, { gameId, team, spymasterName: spymaster.name });
  return true;
}

// ---------------------------------------------------------------------------
// Teammate round (after human acts)
// ---------------------------------------------------------------------------
export async function runTeammateRound(gameId: string, team: TeamColor): Promise<void> {
  logInfo('runTeammateRound', `Starting teammate round`, { gameId, team });
  if (!acquireLock(gameId, team)) {
    logWarn('runTeammateRound', `Could not acquire lock`, { gameId, team });
    return;
  }
  try {
    setDeliberating(gameId, team, true);
    await runConversationRound(gameId, team);
    logInfo('runTeammateRound', `Teammate round completed`, { gameId, team });
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }
}

// ---------------------------------------------------------------------------
// Auto spymaster hint + operative discussion
// ---------------------------------------------------------------------------
export async function autoSpymasterHint(gameId: string, team: TeamColor): Promise<void> {
  logInfo('autoSpymasterHint', `Starting auto spymaster hint`, { gameId, team });
  const game = getGame(gameId);
  if (game.winner || game.turn.activeTeam !== team || game.turn.phase !== 'hint') {
    logInfo('autoSpymasterHint', `Skipped - conditions not met`, { gameId, team, winner: game.winner, activeTeam: game.turn.activeTeam, phase: game.turn.phase });
    return;
  }

  resetTurnCounters(gameId, team);

  const spymaster = getSpymaster(game, team);
  if (!spymaster || spymaster.type !== 'llm') {
    logInfo('autoSpymasterHint', `Skipped - no LLM spymaster`, { gameId, team });
    return;
  }

  if (!acquireLock(gameId, team)) {
    logWarn('autoSpymasterHint', `Could not acquire lock`, { gameId, team });
    return;
  }
  try {
    setDeliberating(gameId, team, true);
    logInfo('autoSpymasterHint', `Waiting for TTS ack before hint`, { gameId, team });
    await waitForTtsAck(gameId);
    if (!await runSpymasterHint(gameId, team)) return;
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }

  // After hint, kick off operative discussion - loop until turn ends or team switches
  const maxRounds = 20;
  let round = 0;
  let staleRounds = 0;
  
  while (round < maxRounds) {
    const current = getGame(gameId);
    if (current.winner || current.turn.activeTeam !== team || current.turn.phase !== 'guess') {
      logInfo('autoSpymasterHint', `Exiting operative loop - conditions changed`, { 
        gameId, team, round, winner: current.winner, activeTeam: current.turn.activeTeam, phase: current.turn.phase 
      });
      break;
    }
    
    const guessesBefore = current.turn.guessesMade;
    logInfo('autoSpymasterHint', `Running teammate round`, { gameId, team, round, staleRounds, guessesBefore });
    await runTeammateRound(gameId, team);
    
    const after = getGame(gameId);
    const madeProgress = after.turn.guessesMade > guessesBefore || after.turn.phase !== 'guess' || after.turn.activeTeam !== team;
    staleRounds = madeProgress ? 0 : staleRounds + 1;
    
    logInfo('autoSpymasterHint', `Teammate round completed`, { 
      gameId, team, round, madeProgress, staleRounds, guessesMade: after.turn.guessesMade 
    });
    
    if (staleRounds >= 10) {
      logError('autoSpymasterHint', `Too many stale rounds, forfeiting`, undefined, { gameId, team, staleRounds });
      forfeitTurn(gameId, team, `Team ${team} couldn't make progress. Turn forfeited.`);
      break;
    }
    
    round++;
  }
  
  if (round >= maxRounds && isStillActiveTeam(gameId, team)) {
    logError('autoSpymasterHint', `Ran out of rounds, forfeiting`, undefined, { gameId, team, round, maxRounds });
    forfeitTurn(gameId, team, `Team ${team} took too long deliberating. Turn forfeited.`);
  }
  
  logInfo('autoSpymasterHint', `Auto spymaster hint completed`, { gameId, team, totalRounds: round });
}

// ---------------------------------------------------------------------------
// C2 + C6: Full LLM turn — restructured as a while loop with clear phases
// ---------------------------------------------------------------------------
export async function runFullLlmTurn(gameId: string, team: TeamColor, maxRounds = 20): Promise<void> {
  logInfo('runFullLlmTurn', `Starting full LLM turn`, { gameId, team, maxRounds });
  
  // Phase 1: Handle any pending banter (before acquiring lock — involves both teams)
  await handleBanterIfNeeded(gameId);

  if (!acquireLock(gameId, team)) {
    logWarn('runFullLlmTurn', `Could not acquire lock`, { gameId, team });
    return;
  }
  try {
    setDeliberating(gameId, team, true);
    resetTurnCounters(gameId, team);

    // Phase 2: Spymaster hint if needed
    logInfo('runFullLlmTurn', `Phase 2: Spymaster hint`, { gameId, team });
    if (!await runSpymasterHint(gameId, team)) {
      logWarn('runFullLlmTurn', `Spymaster hint failed, exiting`, { gameId, team });
      return;
    }

    // Phase 3: Operative conversation rounds until turn ends
    let staleRounds = 0;
    let round = 0;

    logInfo('runFullLlmTurn', `Phase 3: Operative conversation rounds`, { gameId, team });
    while (round < maxRounds && isStillActiveTeam(gameId, team)) {
      logInfo('runFullLlmTurn', `Starting round`, { gameId, team, round, staleRounds });
      const before = getGame(gameId);
      const guessesBefore = before.turn.guessesMade;
      const phaseBefore = before.turn.phase;

      const ok = await runConversationRound(gameId, team);
      if (!ok) {
        logWarn('runFullLlmTurn', `Conversation round returned false, exiting`, { gameId, team, round });
        return;
      }

      if (isGameOver(gameId)) {
        logInfo('runFullLlmTurn', `Game over, exiting`, { gameId, team, round });
        return;
      }
      if (!isStillActiveTeam(gameId, team)) {
        logInfo('runFullLlmTurn', `No longer active team, exiting`, { gameId, team, round });
        return;
      }

      // D2: React after a successful guess
      const after = getGame(gameId);
      if (after.turn.guessesMade > guessesBefore && isStillActiveTeam(gameId, team)) {
        logInfo('runFullLlmTurn', `Triggering reveal reaction`, { gameId, team, guessesMade: after.turn.guessesMade });
        await runRevealReaction(gameId, team);
      }

      const madeProgress = after.turn.guessesMade > guessesBefore || after.turn.phase !== phaseBefore;
      staleRounds = madeProgress ? 0 : staleRounds + 1;
      logInfo('runFullLlmTurn', `Round completed`, { gameId, team, round, madeProgress, staleRounds, guessesMade: after.turn.guessesMade, phase: after.turn.phase });

      if (staleRounds >= 25) {
        logError('runFullLlmTurn', `Too many stale rounds, forfeiting`, undefined, { gameId, team, staleRounds });
        forfeitTurn(gameId, team, `Team ${team} couldn't make progress. Turn forfeited.`);
        return;
      }

      round++;
    }

    // Ran out of rounds
    if (isStillActiveTeam(gameId, team)) {
      logError('runFullLlmTurn', `Ran out of rounds, forfeiting`, undefined, { gameId, team, round, maxRounds });
      forfeitTurn(gameId, team, `Team ${team} took too long deliberating. Turn forfeited.`);
    }
    logInfo('runFullLlmTurn', `Full LLM turn completed`, { gameId, team, totalRounds: round });
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }
}

// ---------------------------------------------------------------------------
// End-game banter with cross-team dialogue
// ---------------------------------------------------------------------------
export async function runEndGameBanter(gameId: string): Promise<void> {
  logInfo('runEndGameBanter', `Starting end-game banter`, { gameId });
  const game = getGame(gameId);
  if (!game.winner || game.gameOverBanter) {
    logInfo('runEndGameBanter', `Skipped - no winner or already ran`, { gameId, winner: game.winner, gameOverBanter: game.gameOverBanter });
    return;
  }
  game.gameOverBanter = true;

  const winner = game.winner;
  const loser = otherTeam(winner);

  // Winner celebrates, loser reacts, then one more winner response
  const teams: Array<{ team: TeamColor; role: 'winner' | 'loser' }> = [
    { team: winner, role: 'winner' },
    { team: loser, role: 'loser' },
    { team: winner, role: 'winner' },
  ];

  for (let i = 0; i < teams.length; i++) {
    const { team, role } = teams[i];
    const players = getTeamLlmPlayers(getGame(gameId), team).filter((p) => p.role === 'operative');
    if (players.length === 0) {
      logInfo('runEndGameBanter', `Skipping exchange - no players`, { gameId, team, role, exchangeIndex: i });
      continue;
    }

    const speaker = pickRandom(players);
    const chatHistory = getGame(gameId).chatLog
      .slice(-20)
      .map((m) => ({ name: m.playerName, content: m.content }));

    const playerConfig = speaker.model
      ? { ...getGame(gameId).llmConfig, model: speaker.model }
      : getGame(gameId).llmConfig;
    const client = new LlmClient(playerConfig);

    logInfo('runEndGameBanter', `End-game banter exchange`, { gameId, team, role, speakerId: speaker.id, speakerName: speaker.name, exchangeIndex: i });
    setDeliberating(gameId, team, true);
    try {
      const response = await client.getResponse({
        game: getGame(gameId),
        player: speaker,
        team,
        pendingProposals: [],
        chatHistory,
        endGameBanter: true,
      });
      if (response.message && response.message !== '...') {
        postChatMessage(gameId, team, speaker.id, response.message);
      }
      await waitForTtsAck(gameId);
      logInfo('runEndGameBanter', `End-game banter exchange completed`, { gameId, team, role, exchangeIndex: i });
    } catch (err) {
      logError('runEndGameBanter', `End-game banter failed`, err, { gameId, team, role, exchangeIndex: i });
    } finally {
      setDeliberating(gameId, team, false);
    }
  }
  logInfo('runEndGameBanter', `End-game banter completed`, { gameId });
}
