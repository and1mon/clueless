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

const DEFAULT_LLM = {
  baseUrl: process.env.LLM_BASE_URL || 'http://localhost:8082/v1',
  model: process.env.LLM_MODEL || 'Qwen3-VL-8B-Instruct-Q8_0',
  apiKey: process.env.LLM_API_KEY || '',
};

const PERSONALITIES = [
  'You are cautious and analytical. You think through risks carefully before committing.',
  'You are bold and decisive. You trust your instincts and push the team to act.',
  'You are supportive and collaborative. You build on others\' ideas and look for consensus.',
  'You are skeptical and detail-oriented. You challenge assumptions and spot flaws.',
  'You are creative and lateral-thinking. You find unexpected connections between words.',
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
  return Math.max(1, Math.ceil(count / 2));
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
    for (let i = 0; i < llmCount; i += 1) {
      const id = `llm-${team}-${i + 1}-${randomUUID()}`;
      const name = `${team === 'red' ? 'Red' : 'Blue'}-${i + 1}`;
      const personality = shuffledPersonalities[personalityIdx % shuffledPersonalities.length];
      personalityIdx += 1;
      players[id] = {
        id,
        name,
        role: 'operative',
        team,
        type: 'llm',
        personality,
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
    chats: { red: [], blue: [] },
    proposals: { red: [], blue: [] },
    llmConfig: {
      baseUrl: input.llm?.baseUrl?.trim() || DEFAULT_LLM.baseUrl,
      model: input.llm?.model?.trim() || DEFAULT_LLM.model,
      apiKey: input.llm?.apiKey?.trim() || DEFAULT_LLM.apiKey,
    },
    deliberating: { red: false, blue: false },
  };

  games.set(id, game);
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
  game.chats[team].push({
    id: randomUUID(),
    team,
    playerId,
    playerName: player.name,
    kind,
    content,
    createdAt: nowIso(),
    proposalId,
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

export function submitHint(gameId: string, team: TeamColor, playerId: string, word: string, count: number): GameState {
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
  game.turn.guessesMade = 0;
  game.turn.maxGuesses = count + 1;

  addSystemMessage(game, team, `🔎 Spymaster says: "${hintWord}" (${count})`);
  return game;
}

// --- Guesses ---

function countRemaining(game: GameState, owner: TeamColor): number {
  return game.cards.filter((card) => card.owner === owner && !card.revealed).length;
}

function switchTurn(game: GameState): void {
  game.turn.activeTeam = otherTeam(game.turn.activeTeam);
  game.turn.phase = 'hint';
  game.turn.hintWord = undefined;
  game.turn.hintCount = undefined;
  game.turn.guessesMade = 0;
  game.turn.maxGuesses = 0;
  addSystemMessage(game, game.turn.activeTeam, `It's now ${game.turn.activeTeam}'s turn.`);
}

function finishGame(game: GameState, winner: TeamColor, reason: string): void {
  game.winner = winner;
  game.loserReason = reason;
  addSystemMessage(game, 'red', `🏁 Game over — ${winner} wins! (${reason})`);
  addSystemMessage(game, 'blue', `🏁 Game over — ${winner} wins! (${reason})`);
}

function resolveGuess(game: GameState, team: TeamColor, guessWord: string): void {
  const card = game.cards.find((c) => c.word.toLowerCase() === guessWord.toLowerCase());
  if (!card) throw new Error(`"${guessWord}" is not on the board.`);
  if (card.revealed) throw new Error(`"${guessWord}" was already revealed.`);

  card.revealed = true;
  addSystemMessage(game, team, `Revealed "${card.word}" → ${card.owner}`);

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
  const hasPending = game.proposals[team].some((p) => p.status === 'pending');
  if (hasPending) throw new Error('There is already a pending proposal. Vote on it first.');

  if (kind === 'guess') {
    if (!payload.word?.trim()) throw new Error('Guess must include a word.');
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
  addMessage(game, team, playerId, `${game.players[playerId].name} voted ${decision}`, 'chat', proposal.id);

  // Count votes excluding the proposer
  const votes = Object.values(proposal.votes);
  const voterCount = operativeCount(game, team) - 1; // exclude proposer
  const threshold = requiredVotes(Math.max(1, voterCount));
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
  } else if (rejects >= threshold) {
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
