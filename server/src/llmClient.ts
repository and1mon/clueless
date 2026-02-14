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
    endGameBanter?: boolean;
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
    const isBanterPhase = game.turn.phase === 'banter';

    const proposalLines = input.pendingProposals.length
      ? input.pendingProposals.map((p) =>
          `  ID="${p.id}" ${p.kind}${p.payload.word ? ` "${p.payload.word}"` : ''} by ${game.players[p.createdBy]?.name ?? '?'} votes=${JSON.stringify(p.votes)}`
        ).join('\n')
      : '  none';

    // Build role-specific instructions
    let roleInstructions: string;

    const allBoardWords = game.cards.map((c) => c.word.toLowerCase());

    if (input.endGameBanter) {
      const isWinner = team === game.winner;
      roleInstructions = isWinner
        ? 'Game over — you won! Say something.'
        : 'Game over — you lost. React to it.';
    } else if (isBanterPhase) {
      const isOutgoing = game.turn.previousTeam === team;
      const opponentTeam = team === 'red' ? 'blue' : 'red';
      roleInstructions = [
        'Banter phase is intermission between turns.',
        `You are on team ${team}.`,
        `You are NOT on team ${opponentTeam}. Never speak as if you are ${opponentTeam}.`,
        `Team that just finished: ${game.turn.previousTeam ?? 'unknown'}.`,
        `Team that plays next after banter: ${game.turn.activeTeam}.`,
        isOutgoing ? 'Your team just finished its turn.' : 'Your team is up next after banter.',
        'If prior chat lines are prefixed with team labels, treat your own team label as your perspective and the other team as opponents.',
        'Do NOT hint, guess, propose, or vote in banter.',
        'Do NOT reference unrevealed board words like you are guessing.',
        'Use recent round events from chat (reveals, rejected proposals, bad guesses) for taunts/reactions.',
        'Keep it to light reaction/taunt and momentum talk.',
        'action: {"type":"none"}',
      ].join('\n');
    } else if (isSpymaster && isHintPhase) {
      const enemyTeam = team === 'red' ? 'blue' : 'red';
      const myWords = game.cards.filter((c) => c.owner === team && !c.revealed).map((c) => c.word);
      const enemyWords = game.cards.filter((c) => c.owner === enemyTeam && !c.revealed).map((c) => c.word);
      const assassinWords = game.cards.filter((c) => c.owner === 'assassin' && !c.revealed).map((c) => c.word);

      roleInstructions = [
        `You're the spymaster. Give a one-word hint + a number.`,
        'Important: board words have no spatial positions; there is no "close", "next to", or adjacency logic in Codenames.',
        `Target these: ${myWords.join(', ')}`,
        `Avoid these: ${enemyWords.join(', ')} (enemy team), ${assassinWords.join(', ')} (assassin - instant loss)`,
        `Your hint CANNOT be any board word: ${allBoardWords.join(', ')}`,
        `The number = how many target words connect to your hint.`,
        'message: "..." (stay quiet)',
        'action: {"type":"hint","word":"your_hint","count":2}',
      ].join('\n');
    } else if (isSpymaster && !isHintPhase) {
      roleInstructions = 'Stay silent, game is guessing.';
    } else if (!isHintPhase) {
      const hasPending = input.pendingProposals.length > 0;
      const unrevealed = game.cards.filter((c) => !c.revealed).map((c) => c.word);

      let voteInstructions = '';
      if (hasPending) {
        const proposal = input.pendingProposals[0];
        const proposer = game.players[proposal.createdBy]?.name ?? 'someone';
        const isOwnProposal = proposal.createdBy === player.id;

        if (isOwnProposal) {
          voteInstructions = `You proposed ${proposal.kind === 'guess' ? `guessing "${proposal.payload.word}"` : 'ending the turn'}. Wait for votes.`;
        } else {
          const what = proposal.kind === 'guess' ? `guess "${proposal.payload.word}"` : 'end the turn';
          voteInstructions = `${proposer} wants to ${what}. You MUST vote NOW.\nONLY valid action now: {"type":"vote","proposalId":"${proposal.id}","decision":"accept"|"reject"}\nIf you keep debating instead of voting, your team can lose the turn.`;
        }
      }

      const proposalExamples = [
        'To propose a guess: action: {"type":"propose_guess","word":"BOARD_WORD"}',
        'To end the turn: action: {"type":"propose_end_turn"}',
        'To just talk: action: {"type":"none"}',
      ].join('\n');

      roleInstructions = [
        `Hint: "${game.turn.hintWord}" (${game.turn.hintCount}) — ${game.turn.guessesMade}/${game.turn.maxGuesses} guesses used.`,
        `Valid guesses: ${unrevealed.join(', ')}`,
        'Important: board words have no spatial positions. Do not use "close to", "near", "next to", or adjacency arguments.',
        'Judge guesses only by semantic relation to the hint and game risk (enemy/assassin), not board layout.',
        '',
        voteInstructions || proposalExamples,
      ].join('\n');
    } else {
      roleInstructions = [
        'Waiting for your spymaster hint.',
        'Do not guess, propose, or vote yet.',
        'You can only chat briefly with teammates.',
        'action: {"type":"none"}',
      ].join('\n');
    }

    const personality = game.llmNeutralMode
      ? 'You are a neutral, cooperative Codenames teammate focused on clear strategy and winning.'
      : (player.personality ?? 'You are a chill but competitive teammate.');

    // Find the last speaker (not this player) for conversational context
    const lastOtherMsg = [...input.chatHistory].reverse().find(
      (m) => m.name !== player.name && m.name !== 'System'
    );

    // Find human player on the same team for direct address
    const humanTeammate = Object.values(game.players).find(
      (p) => p.type === 'human' && p.team === team && p.id !== player.id
    );

    const conversationRules = [
      'CONVERSATION RULES (follow strictly):',
      '- PRIMARY GOAL: win the game, not roleplay the personality.',
      '- Personality is flavor only. Be flexible and compromise when needed to keep team momentum.',
      '- Codenames has no board adjacency mechanics: never justify decisions with "near/close/next to" claims.',
      '- Never treat your own previous message as if it was written by another speaker.',
      '- You MUST directly respond to or reference what the previous speaker said before adding your own thoughts.',
      '- When replying to someone, use their NAME (e.g. "Good point, Red-2" or "Nice one, Blue-3"). Never use bare "you" without a name — it is confusing.',
      '- If you agree, say so briefly ("yeah", "totally", "good call"). If you disagree, explain why in one sentence.',
      '- Do NOT repeat information that was just stated by someone else.',
      '- Keep it short: 1-2 sentences max. Only go longer if you have a genuinely new strategic insight.',
      '- For simple reactions, keep it very brief — a few words is fine ("nice!", "oof", "let\'s go").',
      '- Vary your tone: sometimes be brief, sometimes elaborate. Don\'t always use the same pattern.',
      '- If there is a pending proposal from a teammate, stop debating and vote immediately.',
      '- Taking too long to vote can forfeit your team\'s turn.',
      humanTeammate ? `- Occasionally address ${humanTeammate.name} by name and ask for their opinion or input.` : '',
    ].filter(Boolean).join('\n');

    const system = [
      `You're ${player.name}, on team ${team} playing Codenames. Role: ${player.role}.`,
      `Personality: ${personality}`,
      '',
      conversationRules,
      '',
      'Respond as JSON: {"message": "...", "action": {...}}',
      '',
      roleInstructions,
    ].join('\n');

    // Build chat history — mark own messages as assistant role
    const rawChatMessages = input.chatHistory.slice(-50)
      .filter((m) => m.content && m.content.trim()) // filter empty messages
      .map((m) => ({
        role: (m.name === player.name ? 'assistant' : 'user') as 'assistant' | 'user',
        content: m.name === player.name ? m.content : `${m.name}: ${m.content}`,
      }));

    // Ensure strict role alternation: merge consecutive same-role messages
    const chatMessages: Array<{ role: 'assistant' | 'user'; content: string }> = [];
    for (const msg of rawChatMessages) {
      if (!msg.content.trim()) continue; // skip empty
      const last = chatMessages[chatMessages.length - 1];
      if (last && last.role === msg.role) {
        last.content += `\n${msg.content}`;
      } else {
        chatMessages.push({ ...msg });
      }
    }

    // Strict models require conversation to start with 'user'
    if (chatMessages.length > 0 && chatMessages[0].role === 'assistant') {
      chatMessages.unshift({ role: 'user', content: '[conversation start]' });
    }

    const revealedCards = game.cards.filter((c) => c.revealed).map((c) => `[${c.word} → ${c.owner}]`).join(', ');
    const boardContext = isBanterPhase
      ? `Revealed cards: ${revealedCards || 'none yet'}`
      : `Board: ${visibleCards}`;

    const stateContext = [
      lastOtherMsg ? `[RESPOND TO THIS] ${lastOtherMsg.name} just said: "${lastOtherMsg.content}". Reply directly to ${lastOtherMsg.name} by name.` : '',
      `[GAME STATE] Team: ${team} | Your role: ${player.role} | Turn: ${game.turn.activeTeam}/${game.turn.phase}`,
      isBanterPhase ? `[BANTER STATE] Previous team: ${game.turn.previousTeam ?? 'unknown'} | Next team: ${game.turn.activeTeam}` : '',
      isBanterPhase ? `[BANTER TEAM CHECK] You=${team}; Opponent=${team === 'red' ? 'blue' : 'red'}` : '',
      `Score: Red ${remainingRed} left, Blue ${remainingBlue} left`,
      boardContext,
      `Pending proposals:\n${proposalLines}`,
      'Now it\'s your turn to respond. Return JSON with "message" and "action".',
    ].filter(Boolean).join('\n');

    // Ensure the final message is 'user' (stateContext) with proper alternation
    if (chatMessages.length > 0 && chatMessages[chatMessages.length - 1].role === 'user') {
      // Must insert an assistant message before adding another user message
      chatMessages.push({ role: 'assistant', content: 'Understood.' });
    }
    chatMessages.push({ role: 'user', content: stateContext });

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
