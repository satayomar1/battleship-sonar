export type CellState = 'empty' | 'ship' | 'miss' | 'hit' | 'sunk';

export interface Position {
  x: number;
  y: number;
}

export interface Ship {
  id: string;
  size: number;
  positions: Position[];
  hits: number;
  isSunk: boolean;
}

export type Board = CellState[][];

export type ShotResult = 'miss' | 'hit' | 'sunk';

export interface ShotOutcome {
  board: Board;
  ships: Ship[];
  result: ShotResult;
  sunkShip: Ship | null;
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface MoveRecord {
  x: number;
  y: number;
  result: ShotResult;
}

export type GamePhase = 'placement' | 'playing' | 'game_over';

export interface DebriefStats {
  totalShots: number;
  hits: number;
  misses: number;
  accuracy: number;
  longestHitStreak: number;
  edgeShotShare: number;
  parityShare: number;
  observations: string[];
  tips: string[];
}
