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
    phase: 'hint' | 'guess';
    hintWord?: string;
    hintCount?: number;
    guessesMade: number;
    maxGuesses: number;
  };
  winner?: TeamColor;
  loserReason?: string;
  deliberating: Record<TeamColor, boolean>;
}
