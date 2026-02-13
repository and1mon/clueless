export type TeamColor = 'red' | 'blue';
export type CardOwner = TeamColor | 'neutral' | 'assassin';
export type PlayerType = 'human' | 'llm';
export type PlayerRole = 'spymaster' | 'operative';
export type TurnPhase = 'hint' | 'guess' | 'banter';
export type ProposalKind = 'guess' | 'end_turn';

export interface Card {
  word: string;
  owner: CardOwner;
  revealed: boolean;
}

export interface Player {
  id: string;
  name: string;
  type: PlayerType;
  role: PlayerRole;
  team: TeamColor;
  personality?: string;
  model?: string;
  voice?: string;
}

export interface TeamState {
  color: TeamColor;
  players: string[];
}

export interface TurnState {
  activeTeam: TeamColor;
  phase: TurnPhase;
  hintWord?: string;
  hintCount?: number;
  guessesMade: number;
  maxGuesses: number;
  previousTeam?: TeamColor;
}

export interface Message {
  id: string;
  team: TeamColor;
  playerId: string;
  playerName: string;
  kind: 'chat' | 'proposal' | 'system';
  content: string;
  createdAt: string;
  proposalId?: string;
  phase?: TurnPhase;
}

export interface Proposal {
  id: string;
  team: TeamColor;
  kind: ProposalKind;
  payload: { word?: string };
  status: 'pending' | 'accepted' | 'rejected';
  createdBy: string;
  createdAt: string;
  resolvedAt?: string;
  votes: Record<string, 'accept' | 'reject'>;
}

export interface LlmConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
}

export interface GameState {
  id: string;
  createdAt: string;
  cards: Card[];
  players: Record<string, Player>;
  teams: Record<TeamColor, TeamState>;
  chatLog: Message[];
  proposals: Record<TeamColor, Proposal[]>;
  turn: TurnState;
  winner?: TeamColor;
  loserReason?: string;
  llmConfig: LlmConfig;
  deliberating: Record<TeamColor, boolean>;
  llmError?: string;
  gameOverBanter?: boolean;
}

export interface LlmPlayerInput {
  name?: string;
  model?: string;
  personality?: string;
}

export interface CreateGameInput {
  humanName?: string;
  humanTeam?: TeamColor;
  humanRole?: PlayerRole | 'spectator';
  llmPlayers?: Partial<Record<TeamColor, number>>;
  llmPlayerConfigs?: Partial<Record<TeamColor, LlmPlayerInput[]>>;
  llm?: Partial<LlmConfig>;
}
