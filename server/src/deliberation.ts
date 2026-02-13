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
  if (s.locked) return false;
  s.locked = true;
  return true;
}

function releaseLock(gameId: string, team: TeamColor): void {
  getTeamState(gameId, team).locked = false;
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
  fn().catch((err) => console.error(`[${label}]`, err));
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
  if (game.winner) return false;

  const isBanter = game.turn.phase === 'banter';
  if (!isBanter && game.turn.activeTeam !== team) return false;

  const player = game.players[playerId];
  if (!player || player.type !== 'llm') return false;
  if (player.role === 'spymaster' && (game.turn.phase === 'guess' || isBanter)) return false;

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
      if (ts.failures >= 3 && player.role === 'operative') {
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

      // Validate hint
      if (action.type === 'hint' && boardWords.includes(action.word.toLowerCase())) {
        rejectedWords.push(action.word);
        continue;
      }

      if (action.type === 'hint') {
        try {
          submitHint(gameId, team, player.id, action.word, action.count);
        } catch (hintErr) {
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
            const normalizedWord = action.word.toLowerCase();
            if (!ts.proposedWords.has(normalizedWord)) {
              ts.failures = 0;
            }
            ts.proposedWords.add(normalizedWord);
          } catch (propErr) {
            const errMsg = propErr instanceof Error ? propErr.message : String(propErr);
            if (errMsg.includes('not on the board') || errMsg.includes('already been revealed') || errMsg.includes('already a pending proposal')) {
              postChatMessage(gameId, team, player.id, `❌ Cannot guess "${action.word}" — ${errMsg}`);
              ts.failures++;
              return false;
            }
            throw propErr;
          }
        } else if (action.type === 'propose_end_turn') {
          createProposal(gameId, team, player.id, 'end_turn', {});
        } else if (action.type === 'vote') {
          voteOnProposal(gameId, team, player.id, action.proposalId, action.decision);
        }
      }

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`LLM ${player.name} error:`, msg);
      if (/fetch|ECONNREFUSED|failed|40[134]/i.test(msg)) {
        setLlmError(gameId, `LLM error (${player.name}): ${msg}`);
      }
      return false;
    }
  }

  console.error(`LLM ${player.name} failed to produce valid hint after ${maxAttempts} attempts`);
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
  if (!llmPlayers.length) return false;

  // B3: Shuffle speaking order each round
  const speakers = shuffle(llmPlayers);
  // Track who already spoke this round to prevent double-speaking
  const spokePlayers = new Set<string>();

  for (const player of speakers) {
    if (isGameOver(gameId) || !isStillActiveTeam(gameId, team)) return true;
    if (spokePlayers.has(player.id)) continue;

    await runOnePlayer(gameId, team, player.id);
    spokePlayers.add(player.id);
    await waitForTtsAck(gameId);

    // B4: If a proposal was just created, let remaining players vote (once each)
    const current = getGame(gameId);
    const pendingNow = current.proposals[team].filter((p) => p.status === 'pending');
    if (pendingNow.length > 0) {
      const proposal = pendingNow[0];
      const voters = speakers.filter(
        (p) => p.id !== proposal.createdBy && !proposal.votes[p.id] && !spokePlayers.has(p.id),
      );
      for (const voter of voters) {
        const check = getGame(gameId);
        const stillPending = check.proposals[team].find((p) => p.id === proposal.id && p.status === 'pending');
        if (!stillPending || check.winner) break;
        await runOnePlayer(gameId, team, voter.id);
        spokePlayers.add(voter.id);
        await waitForTtsAck(gameId);
      }
    }

    // Check failure threshold
    const ts = getTeamState(gameId, team);
    if (ts.failures >= 6) {
      forfeitTurn(gameId, team, `Team ${team} kept making invalid moves. Turn forfeited.`);
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// D2: Reaction messages after a card reveal
// ---------------------------------------------------------------------------
async function runRevealReaction(gameId: string, team: TeamColor): Promise<void> {
  const game = getGame(gameId);
  if (game.winner) return;

  const operatives = getTeamLlmPlayers(game, team).filter((p) => p.role === 'operative');
  if (operatives.length === 0) return;

  // Pick 1 random operative to react
  const reactor = pickRandom(operatives);
  setDeliberating(gameId, team, true);
  try {
    await runOnePlayer(gameId, team, reactor.id);
    await waitForTtsAck(gameId);
  } finally {
    setDeliberating(gameId, team, false);
  }
}

// ---------------------------------------------------------------------------
// C1 + B5: Banter as actual cross-team dialogue (2-3 exchanges)
// ---------------------------------------------------------------------------
export async function runBanterRound(gameId: string): Promise<void> {
  const game = getGame(gameId);
  if (game.winner || game.turn.phase !== 'banter') return;

  const incomingTeam = game.turn.activeTeam;
  const outgoingTeam = game.turn.previousTeam;
  if (!outgoingTeam) {
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

  for (const { team: t, players } of exchanges) {
    if (players.length === 0) continue;
    const check = getGame(gameId);
    if (check.winner || check.turn.phase !== 'banter') break;

    const speaker = pickRandom(players);
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
    endBanter(gameId);
  }
}

// ---------------------------------------------------------------------------
// C1: Single banter handler for autoplay
// ---------------------------------------------------------------------------
async function handleBanterIfNeeded(gameId: string): Promise<void> {
  const game = getGame(gameId);
  if (!game.winner && game.turn.phase === 'banter') {
    await runBanterRound(gameId);
  }
}

// ---------------------------------------------------------------------------
// D1: Spymaster "thinking" before hinting
// ---------------------------------------------------------------------------
async function runSpymasterHint(gameId: string, team: TeamColor): Promise<boolean> {
  const game = getGame(gameId);
  if (game.winner || game.turn.activeTeam !== team || game.turn.phase !== 'hint') return true;

  const spymaster = getSpymaster(game, team);
  if (!spymaster || spymaster.type !== 'llm') return true;

  // D1: Post a brief "thinking" message before the actual hint
  postChatMessage(gameId, team, spymaster.id, '🤔 Hmm, let me think about this...');
  await waitForTtsAck(gameId);

  const success = await runOnePlayer(gameId, team, spymaster.id);
  if (!success) {
    console.error(`Spymaster ${spymaster.name} failed to produce valid hint, forfeiting turn`);
    forfeitTurn(gameId, team, `${spymaster.name} could not provide a valid hint. Turn forfeited.`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Teammate round (after human acts)
// ---------------------------------------------------------------------------
export async function runTeammateRound(gameId: string, team: TeamColor): Promise<void> {
  if (!acquireLock(gameId, team)) return;
  try {
    setDeliberating(gameId, team, true);
    await runConversationRound(gameId, team);
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }
}

// ---------------------------------------------------------------------------
// Auto spymaster hint + operative discussion
// ---------------------------------------------------------------------------
export async function autoSpymasterHint(gameId: string, team: TeamColor): Promise<void> {
  const game = getGame(gameId);
  if (game.winner || game.turn.activeTeam !== team || game.turn.phase !== 'hint') return;

  resetTurnCounters(gameId, team);

  const spymaster = getSpymaster(game, team);
  if (!spymaster || spymaster.type !== 'llm') return;

  if (!acquireLock(gameId, team)) return;
  try {
    setDeliberating(gameId, team, true);
    await waitForTtsAck(gameId);
    if (!await runSpymasterHint(gameId, team)) return;
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }

  // After hint, kick off operative discussion
  const updated = getGame(gameId);
  if (!updated.winner && updated.turn.activeTeam === team && updated.turn.phase === 'guess') {
    await runTeammateRound(gameId, team);
  }
}

// ---------------------------------------------------------------------------
// C2 + C6: Full LLM turn — restructured as a while loop with clear phases
// ---------------------------------------------------------------------------
export async function runFullLlmTurn(gameId: string, team: TeamColor, maxRounds = 20): Promise<void> {
  // Phase 1: Handle any pending banter (before acquiring lock — involves both teams)
  await handleBanterIfNeeded(gameId);

  if (!acquireLock(gameId, team)) return;
  try {
    setDeliberating(gameId, team, true);
    resetTurnCounters(gameId, team);

    // Phase 2: Spymaster hint if needed
    if (!await runSpymasterHint(gameId, team)) return;

    // Phase 3: Operative conversation rounds until turn ends
    let staleRounds = 0;
    let round = 0;

    while (round < maxRounds && isStillActiveTeam(gameId, team)) {
      const before = getGame(gameId);
      const guessesBefore = before.turn.guessesMade;
      const phaseBefore = before.turn.phase;

      const ok = await runConversationRound(gameId, team);
      if (!ok) return;

      if (isGameOver(gameId) || !isStillActiveTeam(gameId, team)) return;

      // D2: React after a successful guess
      const after = getGame(gameId);
      if (after.turn.guessesMade > guessesBefore && isStillActiveTeam(gameId, team)) {
        await runRevealReaction(gameId, team);
      }

      const madeProgress = after.turn.guessesMade > guessesBefore || after.turn.phase !== phaseBefore;
      staleRounds = madeProgress ? 0 : staleRounds + 1;

      if (staleRounds >= 25) {
        forfeitTurn(gameId, team, `Team ${team} couldn't make progress. Turn forfeited.`);
        return;
      }

      round++;
    }

    // Ran out of rounds
    if (isStillActiveTeam(gameId, team)) {
      forfeitTurn(gameId, team, `Team ${team} took too long deliberating. Turn forfeited.`);
    }
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }
}

// ---------------------------------------------------------------------------
// End-game banter with cross-team dialogue
// ---------------------------------------------------------------------------
export async function runEndGameBanter(gameId: string): Promise<void> {
  const game = getGame(gameId);
  if (!game.winner || game.gameOverBanter) return;
  game.gameOverBanter = true;

  const winner = game.winner;
  const loser = otherTeam(winner);

  // Winner celebrates, loser reacts, then one more winner response
  const teams: Array<{ team: TeamColor; role: 'winner' | 'loser' }> = [
    { team: winner, role: 'winner' },
    { team: loser, role: 'loser' },
    { team: winner, role: 'winner' },
  ];

  for (const { team, role } of teams) {
    const players = getTeamLlmPlayers(getGame(gameId), team).filter((p) => p.role === 'operative');
    if (players.length === 0) continue;

    const speaker = pickRandom(players);
    const chatHistory = getGame(gameId).chatLog
      .slice(-20)
      .map((m) => ({ name: m.playerName, content: m.content }));

    const playerConfig = speaker.model
      ? { ...getGame(gameId).llmConfig, model: speaker.model }
      : getGame(gameId).llmConfig;
    const client = new LlmClient(playerConfig);

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
    } catch (err) {
      console.error(`End-game banter (${role}) failed:`, err);
    } finally {
      setDeliberating(gameId, team, false);
    }
  }
}
