import { randomUUID } from 'node:crypto';
import { WORD_POOL } from './words.js';
import {
  type CreateGameInput,
  type GameState,
  type Player,
  type PlayerRole,
  type Proposal,
  type ProposalKind,
  type TeamColor,
} from './types.js';

const games = new Map<string, GameState>();

// Track last client poll per game (not serialized, not on GameState)
const lastClientPoll = new Map<string, number>();

export function touchGame(gameId: string): void {
  lastClientPoll.set(gameId, Date.now());
}

export function isAbandoned(gameId: string): boolean {
  const last = lastClientPoll.get(gameId);
  if (!last) return false; // never polled = just created
  return Date.now() - last > 15_000; // 15s ≈ 10 missed polls
}

const VOICE_POOL = [
  'af_heart', 'af_bella', 'af_aoede', 'af_kore', 'af_sarah', 'af_sky',
  'am_fenrir', 'am_michael', 'am_puck', 'am_adam', 'am_eric',
  'bf_emma', 'bf_isabella', 'bf_alice',
  'bm_george', 'bm_fable', 'bm_daniel', 'bm_lewis',
];

function pickVoice(index: number): string {
  return VOICE_POOL[index % VOICE_POOL.length];
}

const DEFAULT_LLM = {
  baseUrl: process.env.LLM_BASE_URL || 'http://localhost:8082/v1',
  model: process.env.LLM_MODEL || 'Qwen3-VL-8B-Instruct-Q8_0',
  apiKey: process.env.LLM_API_KEY || '',
};

const PERSONALITIES = [
  'You overthink everything and second-guess yourself constantly. Every choice stresses you out and you keep imagining what could go wrong.',
  'You\'re impatient and get fired up easily. You want to guess NOW and hate when people deliberate forever. Not rude, just intense.',
  'You\'re super relaxed and laid-back. Nothing phases you. You go with the flow and keep things mellow.',
  'You love talking shit — to the other team AND your own teammates (lovingly). Competitive banter is your love language.',
  'You\'re endlessly positive and supportive. You hype up every teammate\'s idea. Even bad guesses get encouragement from you.',
];

function nowIso(): string {
  return new Date().toISOString();
}

function shuffle<T>(items: T[]): T[] {
  const clone = [...items];
  for (let i = clone.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [clone[i], clone[j]] = [clone[j], clone[i]];
  }
  return clone;
}

export function otherTeam(team: TeamColor): TeamColor {
  return team === 'red' ? 'blue' : 'red';
}

function operativeCount(game: GameState, team: TeamColor): number {
  return game.teams[team].players.filter((id) => game.players[id]?.role === 'operative').length;
}

function requiredVotes(count: number): number {
  return Math.ceil(count / 2);
}

function createPlayers(input: CreateGameInput): {
  players: Record<string, Player>;
  teams: GameState['teams'];
} {
  const isSpectator = input.humanRole === 'spectator';
  const humanTeam = input.humanTeam ?? 'red';
  const humanRole = isSpectator ? 'operative' : (input.humanRole ?? 'operative') as PlayerRole;
  const enemyTeam = otherTeam(humanTeam);
  const llmPerTeam = {
    [humanTeam]: input.llmPlayers?.[humanTeam] ?? (isSpectator ? 3 : 2),
    [enemyTeam]: input.llmPlayers?.[enemyTeam] ?? 3,
  };

  const players: Record<string, Player> = {};
  const teams: GameState['teams'] = {
    red: { color: 'red', players: [] },
    blue: { color: 'blue', players: [] },
  };

  const shuffledPersonalities = shuffle(PERSONALITIES);
  let personalityIdx = 0;

  // Create human (unless spectator)
  if (!isSpectator) {
    const humanId = `human-${randomUUID()}`;
    players[humanId] = {
      id: humanId,
      name: input.humanName?.trim() || 'You',
      team: humanTeam,
      role: humanRole,
      type: 'human',
    };
    teams[humanTeam].players.push(humanId);
  }

  // Create LLMs
  (['red', 'blue'] as TeamColor[]).forEach((team) => {
    const llmCount = llmPerTeam[team] ?? 0;
    const configs = input.llmPlayerConfigs?.[team] ?? [];
    const teamDefaultModel = input.llmTeamModels?.[team]?.trim();
    for (let i = 0; i < llmCount; i += 1) {
      const cfg = configs[i];
      const id = `llm-${team}-${i + 1}-${randomUUID()}`;
      const defaultName = `${team === 'red' ? 'Red' : 'Blue'}-${i + 1}`;
      const defaultPersonality = shuffledPersonalities[personalityIdx % shuffledPersonalities.length];
      personalityIdx += 1;
      players[id] = {
        id,
        name: cfg?.name?.trim() || defaultName,
        role: 'operative',
        team,
        type: 'llm',
        personality: input.llmNeutralMode ? undefined : (cfg?.personality?.trim() || defaultPersonality),
        model: cfg?.model?.trim() || teamDefaultModel || undefined,
        voice: pickVoice(personalityIdx - 1),
      };
      teams[team].players.push(id);
    }
  });

  // Assign spymasters
  (['red', 'blue'] as TeamColor[]).forEach((team) => {
    const playerIds = teams[team].players;
    // If human chose spymaster on this team, they're already set
    const humanOnTeam = playerIds.find((id) => players[id].type === 'human' && players[id].role === 'spymaster');
    if (humanOnTeam) return;

    // Otherwise first LLM becomes spymaster
    const llmSpymaster = playerIds.find((id) => players[id].type === 'llm');
    const fallback = playerIds[0];
    const spymasterId = llmSpymaster ?? fallback;
    if (!spymasterId) throw new Error(`Team ${team} has no players.`);
    players[spymasterId].role = 'spymaster';
  });

  return { players, teams };
}

function createCards(_startingTeam: TeamColor): GameState['cards'] {
  const words = shuffle(WORD_POOL).slice(0, 25);
  const owners: Array<'red' | 'blue' | 'neutral' | 'assassin'> = [];

  // Equal teams: 8 red, 8 blue, 1 assassin, 8 neutral
  for (let i = 0; i < 8; i += 1) owners.push('red');
  for (let i = 0; i < 8; i += 1) owners.push('blue');
  owners.push('assassin');
  while (owners.length < 25) owners.push('neutral');
  const shuffledOwners = shuffle(owners);

  return words.map((word, index) => ({
    word,
    owner: shuffledOwners[index],
    revealed: false,
  }));
}

export function createGame(input: CreateGameInput): GameState {
  const id = randomUUID();
  const createdAt = nowIso();
  const activeTeam = Math.random() > 0.5 ? 'red' : 'blue';
  const { players, teams } = createPlayers(input);

  const game: GameState = {
    id,
    createdAt,
    players,
    teams,
    cards: createCards(activeTeam),
    turn: {
      activeTeam,
      phase: 'hint',
      guessesMade: 0,
      maxGuesses: 0,
    },
    chatLog: [],
    proposals: { red: [], blue: [] },
    llmConfig: {
      baseUrl: input.llm?.baseUrl?.trim() || DEFAULT_LLM.baseUrl,
      model: input.llm?.model?.trim() || DEFAULT_LLM.model,
      apiKey: input.llm?.apiKey?.trim() || DEFAULT_LLM.apiKey,
    },
    llmNeutralMode: !!input.llmNeutralMode,
    deliberating: { red: false, blue: false },
    awaitingHumanContinuation: { red: false, blue: false },
  };

  games.set(id, game);
  touchGame(id);
  return game;
}

export function getGame(gameId: string): GameState {
  const game = games.get(gameId);
  if (!game) throw new Error('Game not found.');
  return game;
}

const SYSTEM_PLAYER_ID = 'system';

function ensureSystemPlayer(game: GameState): void {
  if (game.players[SYSTEM_PLAYER_ID]) return;
  game.players[SYSTEM_PLAYER_ID] = {
    id: SYSTEM_PLAYER_ID,
    name: 'System',
    role: 'operative',
    team: 'red',
    type: 'llm',
  };
}

function addMessage(
  game: GameState,
  team: TeamColor,
  playerId: string,
  content: string,
  kind: 'chat' | 'proposal' | 'system',
  proposalId?: string,
): void {
  const player = game.players[playerId];
  if (!player) throw new Error('Unknown player.');
  game.chatLog.push({
    id: randomUUID(),
    team,
    playerId,
    playerName: player.name,
    kind,
    content,
    createdAt: nowIso(),
    proposalId,
    phase: game.turn.phase,
  });
}

function addSystemMessage(game: GameState, team: TeamColor, content: string): void {
  ensureSystemPlayer(game);
  addMessage(game, team, SYSTEM_PLAYER_ID, content, 'system');
}

function assertTeamMember(game: GameState, team: TeamColor, playerId: string): void {
  if (!game.teams[team].players.includes(playerId)) {
    throw new Error('Player is not in this team.');
  }
}

export function postChatMessage(gameId: string, team: TeamColor, playerId: string, content: string): GameState {
  const game = getGame(gameId);
  assertTeamMember(game, team, playerId);
  if (!content.trim()) throw new Error('Message cannot be empty.');
  addMessage(game, team, playerId, content.trim(), 'chat');
  return game;
}

// --- Hints: spymaster gives them directly ---

export function submitHint(gameId: string, team: TeamColor, playerId: string, word: string, count: number, targets?: string[]): GameState {
  const game = getGame(gameId);
  assertTeamMember(game, team, playerId);
  if (game.winner) throw new Error('Game is over.');
  if (game.turn.activeTeam !== team) throw new Error('Not your turn.');
  if (game.turn.phase !== 'hint') throw new Error('Not hint phase.');

  const player = game.players[playerId];
  if (player.role !== 'spymaster') throw new Error('Only the spymaster can give hints.');
  if (!word || word.trim().split(/\s+/).length !== 1) throw new Error('Hint must be a single word.');
  if (!Number.isInteger(count) || count < 1) throw new Error('Count must be a positive integer.');

  const hintWord = word.trim().toLowerCase();
  const boardWords = game.cards.map((c) => c.word.toLowerCase());
  if (boardWords.includes(hintWord)) throw new Error('Hint cannot be a word on the board.');
  game.turn.phase = 'guess';
  game.turn.hintWord = hintWord;
  game.turn.hintCount = count;
  game.turn.hintTargets = targets?.length ? targets : undefined;
  game.turn.guessesMade = 0;
  game.turn.maxGuesses = count + 1;

  addSystemMessage(game, team, `Spymaster says: "${hintWord}" (${count})`);
  return game;
}

// --- Guesses ---

function countRemaining(game: GameState, owner: TeamColor): number {
  return game.cards.filter((card) => card.owner === owner && !card.revealed).length;
}

function switchTurn(game: GameState): void {
  // activeTeam stays as-is (team that just played)
  game.turn.phase = 'banter';
  game.awaitingHumanContinuation.red = false;
  game.awaitingHumanContinuation.blue = false;
  game.turn.hintWord = undefined;
  game.turn.hintCount = undefined;
  game.turn.hintTargets = undefined;
  game.turn.guessesMade = 0;
  game.turn.maxGuesses = 0;
  // NO system message here — moved to endBanter
}

export function endBanter(gameId: string): GameState {
  const game = getGame(gameId);
  if (game.turn.phase !== 'banter') throw new Error('Not in banter phase.');
  game.turn.activeTeam = otherTeam(game.turn.activeTeam);
  game.turn.phase = 'hint';
  addSystemMessage(game, game.turn.activeTeam, `It's now ${game.turn.activeTeam}'s turn.`);
  return game;
}

function finishGame(game: GameState, winner: TeamColor, reason: string): void {
  game.winner = winner;
  game.loserReason = reason;
  addSystemMessage(game, winner, `Game over — ${winner} wins! (${reason})`);
}

function resolveGuess(game: GameState, team: TeamColor, guessWord: string): void {
  const card = game.cards.find((c) => c.word.toLowerCase() === guessWord.toLowerCase());
  if (!card) throw new Error(`"${guessWord}" is not on the board.`);
  if (card.revealed) throw new Error(`"${guessWord}" was already revealed.`);

  // Add the reveal message BEFORE flipping the card so chat log appears before board updates
  addSystemMessage(game, team, `Revealed "${card.word}" → ${card.owner}`);
  card.revealed = true;

  if (card.owner === 'assassin') {
    finishGame(game, otherTeam(team), `${team} hit the assassin!`);
    return;
  }
  if (countRemaining(game, team) === 0) {
    finishGame(game, team, `${team} found all their words`);
    return;
  }
  const enemy = otherTeam(team);
  if (countRemaining(game, enemy) === 0) {
    finishGame(game, enemy, `All ${enemy} words were revealed`);
    return;
  }
  if (card.owner !== team) {
    switchTurn(game);
    return;
  }
  game.turn.guessesMade += 1;
  if (game.turn.guessesMade >= game.turn.maxGuesses) {
    switchTurn(game);
  }
}

export function createProposal(
  gameId: string,
  team: TeamColor,
  playerId: string,
  kind: ProposalKind,
  payload: { word?: string },
): GameState {
  const game = getGame(gameId);
  assertTeamMember(game, team, playerId);
  if (game.winner) throw new Error('Game is over.');
  if (game.turn.activeTeam !== team) throw new Error('Not your turn.');
  if (game.turn.phase !== 'guess') throw new Error('Wait for the spymaster hint first.');

  // Only one pending proposal at a time
  const pendingProposal = game.proposals[team].find((p) => p.status === 'pending');
  if (pendingProposal) {
    // If proposing the same word as pending, convert to accept vote
    if (kind === 'guess' && pendingProposal.kind === 'guess' &&
        payload.word?.trim().toLowerCase() === pendingProposal.payload.word?.toLowerCase() &&
        pendingProposal.createdBy !== playerId) {
      const player = game.players[playerId];
      addMessage(game, team, playerId, `${player.name} also wants to guess "${payload.word}"`, 'system', pendingProposal.id);
      return voteOnProposal(gameId, team, playerId, pendingProposal.id, 'accept');
    }
    throw new Error('There is already a pending proposal. Vote on it first.');
  }

  if (kind === 'guess') {
    if (!payload.word?.trim()) throw new Error('Guess must include a word.');

    // Validate the word exists on the board and is not already revealed
    const word = payload.word.trim().toLowerCase();
    const card = game.cards.find((c) => c.word.toLowerCase() === word);
    if (!card) throw new Error(`"${payload.word}" is not on the board.`);
    if (card.revealed) throw new Error(`"${payload.word}" has already been revealed.`);
  }

  const proposal: Proposal = {
    id: randomUUID(),
    team,
    kind,
    payload: { word: payload.word?.trim() },
    status: 'pending',
    createdBy: playerId,
    createdAt: nowIso(),
    votes: {},
  };

  game.proposals[team].push(proposal);
  const proposer = game.players[playerId];
  const label = kind === 'guess' ? `proposes guessing "${payload.word}"` : 'proposes ending the turn';
  addMessage(game, team, playerId, `${proposer.name} ${label}`, 'proposal', proposal.id);

  // Auto-pass for solo operatives (threshold = 0)
  const voterCount = operativeCount(game, team) - 1;
  const threshold = requiredVotes(voterCount);
  if (threshold === 0) {
    proposal.status = 'accepted';
    proposal.resolvedAt = nowIso();
    addSystemMessage(game, team, 'Solo operative — proposal auto-accepted.');
    if (proposal.kind === 'guess') {
      resolveGuess(game, team, proposal.payload.word ?? '');
    } else {
      addSystemMessage(game, team, 'Team decided to end their turn.');
      switchTurn(game);
    }
  }

  return game;
}

export function voteOnProposal(
  gameId: string,
  team: TeamColor,
  playerId: string,
  proposalId: string,
  decision: 'accept' | 'reject',
): GameState {
  const game = getGame(gameId);
  assertTeamMember(game, team, playerId);

  const proposal = game.proposals[team].find((p) => p.id === proposalId);
  if (!proposal) throw new Error('Proposal not found.');
  if (proposal.status !== 'pending') throw new Error('Proposal already resolved.');
  if (proposal.createdBy === playerId) throw new Error('You cannot vote on your own proposal.');

  proposal.votes[playerId] = decision;
  addMessage(game, team, playerId, `${game.players[playerId].name} voted ${decision}`, 'system', proposal.id);

  // Count votes excluding the proposer
  const votes = Object.values(proposal.votes);
  const voterCount = operativeCount(game, team) - 1; // exclude proposer
  const threshold = requiredVotes(voterCount);
  const accepts = votes.filter((v) => v === 'accept').length;
  const rejects = votes.filter((v) => v === 'reject').length;

  if (accepts >= threshold) {
    proposal.status = 'accepted';
    proposal.resolvedAt = nowIso();
    if (proposal.kind === 'guess') {
      resolveGuess(game, team, proposal.payload.word ?? '');
    } else {
      addSystemMessage(game, team, 'Team decided to end their turn.');
      switchTurn(game);
    }
  } else if (rejects > voterCount / 2) {
    // Reject requires a strict majority — more than half must explicitly reject
    proposal.status = 'rejected';
    proposal.resolvedAt = nowIso();
    addSystemMessage(game, team, 'Proposal rejected — keep discussing.');
  }

  return game;
}

export function setDeliberating(gameId: string, team: TeamColor, value: boolean): void {
  const game = getGame(gameId);
  game.deliberating[team] = value;
}

export function setAwaitingHumanContinuation(gameId: string, team: TeamColor, value: boolean): void {
  const game = getGame(gameId);
  game.awaitingHumanContinuation[team] = value;
}

export function setLlmError(gameId: string, message: string): void {
  const game = getGame(gameId);
  game.llmError = message;
}

export function forfeitTurn(gameId: string, team: TeamColor, reason: string): GameState {
  const game = getGame(gameId);
  addSystemMessage(game, team, `${reason}`);
  switchTurn(game);
  return game;
}

export function hasHumanPlayer(game: GameState, team: TeamColor): boolean {
  return game.teams[team].players.some((id) => game.players[id].type === 'human');
}

export function getTeamLlmPlayers(game: GameState, team: TeamColor): Player[] {
  return game.teams[team].players
    .map((id) => game.players[id])
    .filter((p) => p.type === 'llm' && p.id !== SYSTEM_PLAYER_ID);
}

export function getSpymaster(game: GameState, team: TeamColor): Player | undefined {
  return game.teams[team].players
    .map((id) => game.players[id])
    .find((p) => p.role === 'spymaster');
}

export function serializeGame(game: GameState): Omit<GameState, 'llmConfig'> & { llmConfig: { baseUrl: string; model: string } } {
  return {
    ...game,
    llmConfig: {
      baseUrl: game.llmConfig.baseUrl,
      model: game.llmConfig.model,
    },
  };
}
