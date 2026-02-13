import { type GameState, type Player, type Proposal, type TeamColor } from './types.js';

export interface LlmResponse {
  message: string;
  action:
    | { type: 'none' }
    | { type: 'hint'; word: string; count: number }
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
    return { message, action: { type: 'hint', word: action.word.trim(), count: Math.floor(action.count) } };
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

export class LlmClient {
  constructor(private readonly config: { baseUrl: string; model: string; apiKey?: string }) {}

  async getResponse(input: {
    game: GameState;
    team: TeamColor;
    player: Player;
    pendingProposals: Proposal[];
    chatHistory: Array<{ name: string; content: string }>;
  }): Promise<LlmResponse> {
    const { game, player, team } = input;

    const visibleCards = game.cards
      .map((card) => {
        if (card.revealed) return `[${card.word} → ${card.owner}]`;
        if (player.role === 'spymaster') return `${card.word}(${card.owner})`;
        return card.word;
      })
      .join(', ');

    const remainingRed = game.cards.filter((c) => c.owner === 'red' && !c.revealed).length;
    const remainingBlue = game.cards.filter((c) => c.owner === 'blue' && !c.revealed).length;

    const isSpymaster = player.role === 'spymaster';
    const isHintPhase = game.turn.phase === 'hint';

    const proposalLines = input.pendingProposals.length
      ? input.pendingProposals.map((p) =>
          `  ID="${p.id}" ${p.kind}${p.payload.word ? ` "${p.payload.word}"` : ''} by ${game.players[p.createdBy]?.name ?? '?'} votes=${JSON.stringify(p.votes)}`
        ).join('\n')
      : '  none';

    // Build role-specific instructions
    let roleInstructions: string;

    const allBoardWords = game.cards.map((c) => c.word.toLowerCase());

    if (isSpymaster && isHintPhase) {
      const enemyTeam = team === 'red' ? 'blue' : 'red';
      const myWords = game.cards.filter((c) => c.owner === team && !c.revealed).map((c) => c.word);
      const enemyWords = game.cards.filter((c) => c.owner === enemyTeam && !c.revealed).map((c) => c.word);
      const assassinWords = game.cards.filter((c) => c.owner === 'assassin' && !c.revealed).map((c) => c.word);
      const neutralWords = game.cards.filter((c) => c.owner === 'neutral' && !c.revealed).map((c) => c.word);
      const revealedWords = game.cards.filter((c) => c.revealed).map((c) => `${c.word}(${c.owner})`);

      roleInstructions = [
        `You are the SPYMASTER for team ${team.toUpperCase()}.`,
        '',
        `YOUR TEAM'S WORDS (you want your team to guess these): ${myWords.join(', ')}`,
        `ENEMY WORDS (${enemyTeam} — DANGEROUS! If your hint accidentally matches these, the enemy scores): ${enemyWords.join(', ')}`,
        `ASSASSIN (INSTANT LOSS if your team guesses this!): ${assassinWords.join(', ')}`,
        `NEUTRAL (wastes a guess, avoid): ${neutralWords.join(', ')}`,
        revealedWords.length ? `ALREADY REVEALED (ignore these): ${revealedWords.join(', ')}` : '',
        '',
        'YOUR TASK: Give a ONE-WORD hint and a number.',
        '- The hint should connect as many of YOUR TEAM\'s words as possible.',
        '- The hint must NOT be any word on the board (including revealed words).',
        '- CRITICAL: Before choosing a hint, CHECK if it could also match any ENEMY or ASSASSIN words. If it does, pick a DIFFERENT hint. It is better to give a safe hint for 1-2 words than a risky hint that could match enemy words.',
        '- The number is how many of YOUR TEAM\'s words relate to the hint.',
        '',
        `FORBIDDEN WORDS (your hint MUST NOT be any of these): ${allBoardWords.join(', ')}`,
        '',
        'Return ONLY JSON. Set message to "..." (do NOT explain your reasoning).',
        'Set action: {"type":"hint","word":"yourword","count":N}',
      ].filter(Boolean).join('\n');
    } else if (isSpymaster && !isHintPhase) {
      roleInstructions = [
        'You are the SPYMASTER. Guessing phase is active — you MUST stay silent.',
        'Do NOT speak, react, or give any guidance. Set action: {"type":"none"}',
        'Your message should be empty or "...".',
      ].join('\n');
    } else if (!isHintPhase) {
      const hasPending = input.pendingProposals.length > 0;
      roleInstructions = [
        `You are an OPERATIVE on team ${team}.`,
        `The hint is: "${game.turn.hintWord}" (${game.turn.hintCount})`,
        `Guesses: ${game.turn.guessesMade}/${game.turn.maxGuesses}`,
        '',
        'Think about which unrevealed words on the board connect to the hint.',
        'In your message, share your reasoning with your team. Discuss, agree, or disagree.',
        '',
        'Available actions (pick ONE or none):',
        hasPending
          ? '  THERE IS A PENDING PROPOSAL — you MUST vote on it: {"type":"vote","proposalId":"...","decision":"accept"|"reject"}'
          : '  {"type":"propose_guess","word":"boardword"} — propose a guess\n  {"type":"propose_end_turn"} — propose stopping',
        '  {"type":"none"} — just discuss, no action yet',
        '',
        'RULES:',
        '- Only ONE proposal can be pending at a time. If there is one, you MUST vote on it.',
        '- You CANNOT vote on your own proposal.',
        '- Do NOT propose a word that is already revealed.',
        '- Only propose words that are actually on the board.',
      ].join('\n');
    } else {
      roleInstructions = [
        'You are an OPERATIVE. Waiting for the spymaster to give a hint.',
        'You can chat casually but take no game action.',
        'Set action: {"type":"none"}',
      ].join('\n');
    }

    const personality = player.personality ?? 'You are a thoughtful teammate.';

    const system = [
      `You are "${player.name}", playing a Codenames-style word game on team ${team}.`,
      `Your role: ${player.role}.`,
      personality,
      '',
      'IMPORTANT IDENTITY RULES:',
      `- You are ALWAYS "${player.name}". Never confuse yourself with another player.`,
      '- Messages from other players appear as "TheirName: message".',
      '- Your OWN previous messages appear as "' + player.name + ': message".',
      '- If you have nothing new to add, you may say "nothing to add" or agree briefly.',
      '',
      'RESPONSE FORMAT — return ONLY valid JSON:',
      '{',
      '  "message": "Your natural language message to the team (REQUIRED, be conversational)",',
      '  "action": { "type": "...", ... }',
      '}',
      '',
      'RULES FOR YOUR MESSAGE:',
      '- Be conversational and natural, like a real teammate',
      '- Refer to other players by name when responding to them',
      '- Do NOT repeat what someone else already said',
      '- Do NOT contradict your own previous statements unless you explain why you changed your mind',
      '- Keep it concise (1-3 sentences)',
      '- If you agree and have nothing to add, just say so briefly',
      '',
      roleInstructions,
    ].join('\n');

    // Build chat history — mark own messages as assistant role
    const chatMessages = input.chatHistory.slice(-30).map((m) => ({
      role: (m.name === player.name ? 'assistant' : 'user') as 'assistant' | 'user',
      content: m.name === player.name ? m.content : `${m.name}: ${m.content}`,
    }));

    const stateContext = [
      `[GAME STATE] Team: ${team} | Your role: ${player.role} | Turn: ${game.turn.activeTeam}/${game.turn.phase}`,
      `Score: Red ${remainingRed} left, Blue ${remainingBlue} left`,
      `Board: ${visibleCards}`,
      `Pending proposals:\n${proposalLines}`,
      'Now it\'s your turn to respond. Return JSON with "message" and "action".',
    ].join('\n');

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
            { role: 'user', content: stateContext },
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
