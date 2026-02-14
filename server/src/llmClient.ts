import { type GameState, type Player, type Proposal, type TeamColor } from './types.js';

export interface LlmResponse {
  message: string;
  action:
    | { type: 'none' }
    | { type: 'hint'; word: string; count: number; targets: string[]; reasoning?: string }
    | { type: 'propose_guess'; word: string }
    | { type: 'propose_end_turn' }
    | { type: 'vote'; proposalId: string; decision: 'accept' | 'reject' };
}

function extractJson(raw: string): unknown {
  // Strip <think>...</think> blocks from reasoning models (e.g. Qwen3, DeepSeek)
  let cleaned = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  if (cleaned.startsWith('{') && cleaned.endsWith('}')) return JSON.parse(cleaned);

  const fenced = cleaned.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return JSON.parse(fenced[1].trim());

  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return JSON.parse(cleaned.slice(firstBrace, lastBrace + 1));
  }

  throw new Error(`Not valid JSON: ${raw.slice(0, 300)}`);
}

function parseResponse(data: unknown): LlmResponse {
  if (!data || typeof data !== 'object') throw new Error('Response must be an object.');
  const v = data as Record<string, unknown>;

  const message = typeof v.message === 'string' ? v.message.trim() : '';
  const action = v.action as Record<string, unknown> | undefined;

  if (!action || typeof action !== 'object' || !action.type || action.type === 'none') {
    return { message: message || '...', action: { type: 'none' } };
  }

  if (action.type === 'hint') {
    if (typeof action.word !== 'string' || !action.word.trim()) throw new Error('hint needs word');
    if (typeof action.count !== 'number' || action.count < 1) throw new Error('hint needs count >= 1');
    const targets = Array.isArray(action.targets)
      ? (action.targets as unknown[]).filter((t): t is string => typeof t === 'string').map((t) => t.trim())
      : [];
    const reasoning = typeof action.reasoning === 'string' ? action.reasoning.trim() : undefined;
    return { message, action: { type: 'hint', word: action.word.trim(), count: Math.floor(action.count), targets, reasoning } };
  }
  if (action.type === 'propose_guess') {
    if (typeof action.word !== 'string' || !action.word.trim()) throw new Error('propose_guess needs word');
    return { message, action: { type: 'propose_guess', word: action.word.trim() } };
  }
  if (action.type === 'propose_end_turn') {
    return { message, action: { type: 'propose_end_turn' } };
  }
  if (action.type === 'vote') {
    if (typeof action.proposalId !== 'string') throw new Error('vote needs proposalId');
    if (action.decision !== 'accept' && action.decision !== 'reject') throw new Error('vote needs accept/reject');
    return { message, action: { type: 'vote', proposalId: action.proposalId, decision: action.decision } };
  }

  return { message: message || '...', action: { type: 'none' } };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GAME_RULES = `## Clueless Rules
Two teams (red & blue) compete to find their team's words on a 25-word board.
Each word is secretly assigned an owner: red, blue, neutral, or assassin. Only spymasters see the assignments.
Words are independent — there is NO spatial layout, adjacency, or connection between words on the board.
Neither team's operatives know which words belong to whom. The enemy team does NOT know your card colors either.

Each turn the spymaster gives a one-word hint and a number. The number is how many board words the hint relates to.
Operatives discuss, then propose guesses that the team votes on (majority wins). They can also propose ending the turn.
Revealing a word shows its owner: your team (good — keep guessing), other team (bad — turn ends), neutral (turn ends), or assassin (instant loss).
Spymasters act during the hint phase. Operatives act during the guess phase.
During banter phase (between turns), everyone chats but nobody takes game actions.`;

const ACTION_SCHEMA = `## Response Format
Always respond with JSON: {"message": "your chat message", "action": {...}}

Action types:
- {"type": "none"} — just chat, no game action
- {"type": "hint", "word": "WORD", "count": N, "targets": ["WORD1", "WORD2"], "reasoning": "why this hint connects to your targets"} — spymaster gives a hint (hint phase only). targets = the board words you intend this hint for. reasoning = brief explanation of why this hint connects to those targets
- {"type": "propose_guess", "word": "BOARD_WORD"} — propose guessing a word (guess phase, operatives)
- {"type": "propose_end_turn"} — propose ending the turn (guess phase, operatives)
- {"type": "vote", "proposalId": "ID", "decision": "accept"|"reject"} — vote on a pending proposal`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSystemPrompt(player: Player, team: TeamColor, personality: string): string {
  return [
    `You are ${player.name}, playing Clueless on team ${team}. Role: ${player.role}.`,
    personality,
    '',
    GAME_RULES,
    '',
    ACTION_SCHEMA,
    '',
    `## Communication
- 1-2 sentences. Say what you think and briefly why.
- When discussing guesses, explain the connection to the hint.
- Your message must match your action.`,
  ].join('\n');
}

function buildChatMessages(
  chatHistory: Array<{ name: string; content: string }>,
  playerName: string,
): Array<{ role: 'assistant' | 'user'; content: string }> {
  const raw = chatHistory
    .slice(-50)
    .filter((m) => m.content && m.content.trim())
    .map((m) => ({
      role: (m.name === playerName ? 'assistant' : 'user') as 'assistant' | 'user',
      content: m.name === playerName ? m.content : `${m.name}: ${m.content}`,
    }));

  // Merge consecutive same-role messages
  const merged: Array<{ role: 'assistant' | 'user'; content: string }> = [];
  for (const msg of raw) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      last.content += `\n${msg.content}`;
    } else {
      merged.push({ ...msg });
    }
  }

  // Strict models require conversation to start with 'user'
  if (merged.length > 0 && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '[game chat begins]' });
  }

  return merged;
}

function buildSituation(input: {
  game: GameState;
  team: TeamColor;
  player: Player;
  pendingProposals: Proposal[];
  endGameBanter?: boolean;
}): string {
  const { game, team, player } = input;
  const lines: string[] = [];

  // -- Board view --
  if (game.turn.phase === 'banter' || input.endGameBanter) {
    const revealed = game.cards.filter((c) => c.revealed).map((c) => `${c.word} (${c.owner})`);
    lines.push(`Revealed cards: ${revealed.length ? revealed.join(', ') : 'none yet'}`);
  } else {
    const board = game.cards.map((card) => {
      if (card.revealed) return `[${card.word} → ${card.owner}]`;
      if (player.role === 'spymaster') return `${card.word}(${card.owner})`;
      return card.word;
    });
    lines.push(`Board: ${board.join(', ')}`);
  }

  // -- Score --
  const remainingRed = game.cards.filter((c) => c.owner === 'red' && !c.revealed).length;
  const remainingBlue = game.cards.filter((c) => c.owner === 'blue' && !c.revealed).length;
  lines.push(`Score: Red ${remainingRed} remaining, Blue ${remainingBlue} remaining`);
  lines.push(`Your team: ${team}`);

  // -- End game --
  if (input.endGameBanter) {
    const isWinner = team === game.winner;
    lines.push(`Game over — ${isWinner ? 'your team won!' : 'your team lost.'}`);
    lines.push('Your turn to respond.');
    return lines.join('\n');
  }

  // -- Turn info --
  lines.push(`Current turn: team ${game.turn.activeTeam}, phase: ${game.turn.phase}`);

  if (game.turn.phase === 'banter') {
    const nextTeam = game.turn.activeTeam === 'red' ? 'blue' : 'red';
    lines.push(`Team ${game.turn.activeTeam} just finished. Next up: ${nextTeam}`);

    // Tell players who the spymaster was so they can react to hint quality
    const outgoingTeam = game.turn.activeTeam;
    const outgoingSm = Object.values(game.players).find(
      (p) => p.team === outgoingTeam && p.role === 'spymaster',
    );
    if (outgoingSm) {
      const smLabel = outgoingSm.team === team ? 'your spymaster' : `${outgoingTeam}'s spymaster`;
      lines.push(`${outgoingSm.name} was ${smLabel} this turn.`);
    }

    const banterBase = 'Banter phase: React to what just happened — the hints given, the guesses made, how the spymaster did. Trash-talk opponents, hype or roast teammates. No strategy discussion or hints about unrevealed words.';
    const banterExtra = player.role === 'spymaster' ? ' NEVER reveal or hint at which words belong to which team.' : '';
    lines.push(banterBase + banterExtra);
  }

  // -- Hint phase: spymaster target/avoid lists --
  if (player.role === 'spymaster' && game.turn.phase === 'hint') {
    const enemyTeam = team === 'red' ? 'blue' : 'red';
    const myWords = game.cards.filter((c) => c.owner === team && !c.revealed).map((c) => c.word);
    const enemyWords = game.cards.filter((c) => c.owner === enemyTeam && !c.revealed).map((c) => c.word);
    const assassinWords = game.cards.filter((c) => c.owner === 'assassin' && !c.revealed).map((c) => c.word);
    const allBoardWords = game.cards.map((c) => c.word.toLowerCase());

    lines.push(`Your team's words (target these): ${myWords.join(', ')}`);
    lines.push(`Enemy words (AVOID — guessing these helps the enemy): ${enemyWords.join(', ')}`);
    lines.push(`Assassin (AVOID — guessing this means instant loss): ${assassinWords.join(', ')}`);
    lines.push(`Your hint must be a SINGLE word that is NOT any word on the board: ${allBoardWords.join(', ')}`);
    const neutralWords = game.cards.filter((c) => c.owner === 'neutral' && !c.revealed).map((c) => c.word);
    lines.push(`Neutral words (guessing these wastes your turn): ${neutralWords.join(', ')}`);
    lines.push(`HINT STRATEGY: First, brainstorm a hint that connects 2-3 of YOUR team's words. Then CROSS-CHECK: does this hint also relate to any enemy word, assassin word, or neutral word? If yes, DISCARD it and pick a safer hint. For example "fire" is bad if the enemy has "phoenix". A safe 2-word hint beats a risky 3-word hint. Set count = only the words your hint truly fits.`);
  }

  // -- Guess phase info --
  if (game.turn.phase === 'guess') {
    lines.push(`Hint: "${game.turn.hintWord}" (${game.turn.hintCount}) — ${game.turn.guessesMade}/${game.turn.maxGuesses} guesses used`);
    if (player.role === 'operative') {
      const unrevealed = game.cards.filter((c) => !c.revealed).map((c) => c.word);
      lines.push(`Valid words to guess (ONLY from this list): ${unrevealed.join(', ')}`);
    }
  }

  // -- Pending proposals --
  if (input.pendingProposals.length > 0) {
    const proposalLines = input.pendingProposals.map((p) =>
      `  ID="${p.id}" ${p.kind}${p.payload.word ? ` "${p.payload.word}"` : ''} by ${game.players[p.createdBy]?.name ?? '?'} votes=${JSON.stringify(p.votes)}`
    );
    lines.push(`Pending proposals:\n${proposalLines.join('\n')}`);
  } else {
    lines.push('Pending proposals: none');
  }

  lines.push('Your turn to respond.');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// LLM Client
// ---------------------------------------------------------------------------

export class LlmClient {
  constructor(private readonly config: { baseUrl: string; model: string; apiKey?: string }) {}

  async getResponse(input: {
    game: GameState;
    team: TeamColor;
    player: Player;
    pendingProposals: Proposal[];
    chatHistory: Array<{ name: string; content: string }>;
    endGameBanter?: boolean;
  }): Promise<LlmResponse> {
    const { game, player, team } = input;

    const personality = game.llmNeutralMode
      ? 'You are a neutral, cooperative Clueless teammate focused on clear strategy and winning.'
      : (player.personality ?? 'You are a chill but competitive teammate.');

    const system = buildSystemPrompt(player, team, personality);
    const chatMessages = buildChatMessages(input.chatHistory, player.name);
    const situation = buildSituation(input);

    // Append situation to the last user message or add as new user message
    if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
      chatMessages[chatMessages.length - 1].content += `\n\n---\n${situation}`;
    } else {
      chatMessages.push({ role: 'user', content: situation });
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0.7,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            ...chatMessages,
          ],
        }),
      });
    } catch (err) {
      const cause = err instanceof Error ? err.cause ?? err.message : err;
      throw new Error(`Fetch to ${url} failed: ${JSON.stringify(cause, null, 2)}`);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`LLM request failed (${response.status}): ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = payload.choices?.[0]?.message?.content;
    if (!content) throw new Error('LLM response missing content');
    return parseResponse(extractJson(content));
  }
}
