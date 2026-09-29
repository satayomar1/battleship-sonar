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

export type GamePhase = 'placement' | 'playing' | 'game_over';