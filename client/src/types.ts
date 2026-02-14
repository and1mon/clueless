export type TeamColor = 'red' | 'blue';
export type ProposalKind = 'guess' | 'end_turn';
export type PlayerRole = 'spymaster' | 'operative';

export interface Card {
  word: string;
  owner: 'red' | 'blue' | 'neutral' | 'assassin';
  revealed: boolean;
}

export interface Player {
  id: string;
  name: string;
  type: 'human' | 'llm';
  role: PlayerRole;
  team: TeamColor;
  model?: string;
  personality?: string;
  voice?: string;
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
  phase?: 'hint' | 'guess' | 'banter';
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

export interface GameState {
  id: string;
  cards: Card[];
  players: Record<string, Player>;
  teams: Record<TeamColor, { color: TeamColor; players: string[] }>;
  chatLog: Message[];
  proposals: Record<TeamColor, Proposal[]>;
  turn: {
    activeTeam: TeamColor;
    phase: 'hint' | 'guess' | 'banter';
    hintWord?: string;
    hintCount?: number;
    hintTargets?: string[];
    hintReasoning?: string;
    guessesMade: number;
    maxGuesses: number;
  };
  winner?: TeamColor;
  loserReason?: string;
  llmNeutralMode: boolean;
  deliberating: Record<TeamColor, boolean>;
  humanPaused: Record<TeamColor, boolean>;
  llmConfig: { baseUrl: string; model: string };
  llmError?: string;
  gameOverBanter?: boolean;
}
