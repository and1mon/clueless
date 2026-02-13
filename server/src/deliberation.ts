import {
  createProposal,
  getGame,
  getTeamLlmPlayers,
  postChatMessage,
  setDeliberating,
  setLlmError,
  submitHint,
  voteOnProposal,
} from './gameStore.js';
import { LlmClient } from './llmClient.js';
import { type TeamColor } from './types.js';

const locks = new Map<string, boolean>();

function lockKey(gameId: string, team: TeamColor): string {
  return `${gameId}:${team}`;
}

function acquireLock(gameId: string, team: TeamColor): boolean {
  const key = lockKey(gameId, team);
  if (locks.get(key)) return false;
  locks.set(key, true);
  return true;
}

function releaseLock(gameId: string, team: TeamColor): void {
  locks.set(lockKey(gameId, team), false);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Run ONE LLM player's turn. Returns true if the player did something visible.
 */
async function runOnePlayer(
  gameId: string,
  team: TeamColor,
  playerId: string,
): Promise<boolean> {
  const game = getGame(gameId);
  if (game.winner || game.turn.activeTeam !== team) return false;

  const player = game.players[playerId];
  if (!player || player.type !== 'llm') return false;

  // Spymaster stays silent during guess phase
  if (player.role === 'spymaster' && game.turn.phase === 'guess') return false;

  const pending = game.proposals[team].filter((p) => p.status === 'pending');
  const chatHistory = game.chatLog
    .filter((m) => m.team === team)
    .map((m) => ({ name: m.playerName, content: m.content }));

  // Use per-player model override if set, otherwise fall back to global config
  const playerConfig = player.model
    ? { ...game.llmConfig, model: player.model }
    : game.llmConfig;
  const client = new LlmClient(playerConfig);
  const boardWords = game.cards.map((c) => c.word.toLowerCase());

  // For spymaster hints, retry up to 5 times if the hint word is on the board
  const isHinting = player.role === 'spymaster' && game.turn.phase === 'hint';
  const maxAttempts = isHinting ? 5 : 1;
  const rejectedWords: string[] = [];

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      // Add rejected words to chat history so LLM knows what failed
      const extraHistory = rejectedWords.length
        ? [...chatHistory, { name: 'System', content: `Your previous hints were rejected because they are words on the board: ${rejectedWords.join(', ')}. Pick a DIFFERENT word that is NOT on the board.` }]
        : chatHistory;

      const response = await client.getResponse({
        game,
        player,
        team,
        pendingProposals: pending,
        chatHistory: extraHistory,
      });

      const action = response.action;

      // Validate hint word is not on the board (pre-check before submitHint)
      if (action.type === 'hint' && boardWords.includes(action.word.toLowerCase())) {
        console.log(`LLM ${player.name} gave invalid hint "${action.word}" (on board), retrying...`);
        rejectedWords.push(action.word);
        continue;
      }

      // Spymaster hint: only post the hint itself, not the reasoning
      if (action.type === 'hint') {
        try {
          submitHint(gameId, team, player.id, action.word, action.count);
        } catch (hintErr) {
          console.log(`LLM ${player.name} hint "${action.word}" rejected: ${hintErr instanceof Error ? hintErr.message : hintErr}, retrying...`);
          rejectedWords.push(action.word);
          continue;
        }
      } else {
        // Post chat message for non-hint actions
        if (response.message && response.message !== '...') {
          postChatMessage(gameId, team, player.id, response.message);
        }

        if (action.type === 'propose_guess') {
          try {
            createProposal(gameId, team, player.id, 'guess', { word: action.word });
          } catch (propErr) {
            const errMsg = propErr instanceof Error ? propErr.message : String(propErr);
            if (errMsg.includes('not on the board') || errMsg.includes('already been revealed')) {
              // Invalid guess word — log and continue (LLM will see it failed in next round)
              console.log(`LLM ${player.name} proposed invalid guess "${action.word}": ${errMsg}`);
              postChatMessage(gameId, team, player.id, `❌ Cannot guess "${action.word}" — ${errMsg}`);
              return false;
            }
            throw propErr; // Re-throw other errors
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
      // Surface connection/config errors to the frontend
      if (msg.includes('fetch') || msg.includes('Fetch') || msg.includes('ECONNREFUSED') || msg.includes('failed') || msg.includes('401') || msg.includes('403') || msg.includes('404')) {
        setLlmError(gameId, `LLM error (${player.name}): ${msg}`);
      }
      return false;
    }
  }

  console.error(`LLM ${player.name} failed to produce valid hint after ${maxAttempts} attempts`);
  return false;
}

/**
 * One round = each LLM on the team speaks once, in order, with a delay between.
 */
async function runConversationRound(
  gameId: string,
  team: TeamColor,
  delayMs: number,
): Promise<void> {
  const game = getGame(gameId);
  const llmPlayers = getTeamLlmPlayers(game, team);
  if (!llmPlayers.length) return;

  for (const player of llmPlayers) {
    const current = getGame(gameId);
    if (current.winner || current.turn.activeTeam !== team) return;

    await runOnePlayer(gameId, team, player.id);
    await sleep(delayMs);
  }
}

/**
 * After a human acts on their team: all LLM teammates respond once (one round).
 */
export async function runTeammateRound(gameId: string, team: TeamColor): Promise<void> {
  if (!acquireLock(gameId, team)) return;
  try {
    setDeliberating(gameId, team, true);
    await runConversationRound(gameId, team, 1500);
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }
}

/**
 * If the active team has an LLM spymaster and it's hint phase, auto-trigger the spymaster.
 * After a successful hint, triggers an operative discussion round.
 */
export async function autoSpymasterHint(gameId: string, team: TeamColor): Promise<void> {
  const game = getGame(gameId);
  if (game.winner || game.turn.activeTeam !== team || game.turn.phase !== 'hint') return;

  const spymaster = game.teams[team].players
    .map((id) => game.players[id])
    .find((p) => p.role === 'spymaster');
  if (!spymaster || spymaster.type !== 'llm') return;

  if (!acquireLock(gameId, team)) return;
  try {
    setDeliberating(gameId, team, true);
    await sleep(1500);
    await runOnePlayer(gameId, team, spymaster.id);
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }

  // After hint is given, kick off operative discussion
  const updated = getGame(gameId);
  if (!updated.winner && updated.turn.activeTeam === team && updated.turn.phase === 'guess') {
    await runTeammateRound(gameId, team);
  }
}

/**
 * When the active team is all-LLM: run conversation rounds until their turn ends.
 * Keeps going as long as it's still their turn (they may have multiple guesses).
 */
export async function runFullLlmTurn(gameId: string, team: TeamColor, maxRounds = 20): Promise<void> {
  if (!acquireLock(gameId, team)) return;
  try {
    setDeliberating(gameId, team, true);

    // If it starts in hint phase, trigger spymaster first
    {
      const game = getGame(gameId);
      if (!game.winner && game.turn.activeTeam === team && game.turn.phase === 'hint') {
        const spymaster = game.teams[team].players
          .map((id) => game.players[id])
          .find((p) => p.role === 'spymaster' && p.type === 'llm');
        if (spymaster) {
          await sleep(1500);
          await runOnePlayer(gameId, team, spymaster.id);
        }
      }
    }

    for (let round = 0; round < maxRounds; round += 1) {
      const game = getGame(gameId);
      if (game.winner || game.turn.activeTeam !== team) return;
      await runConversationRound(gameId, team, 1200);
    }
  } finally {
    setDeliberating(gameId, team, false);
    releaseLock(gameId, team);
  }
}
