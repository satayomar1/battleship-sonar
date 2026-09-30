import { Board, Position, Ship } from '../types/game';

export const BOARD_SIZE = 10;

export const FLEET_CONFIG = [
  { id: 'battleship', size: 4, count: 1 },
  { id: 'cruiser', size: 3, count: 2 },
  { id: 'destroyer', size: 2, count: 3 },
  { id: 'submarine', size: 1, count: 4 },
] as const;

export const TOTAL_SHIP_CELLS = FLEET_CONFIG.reduce(
  (sum, s) => sum + s.size * s.count,
  0,
);

export const createEmptyBoard = (): Board =>
  Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => 'empty' as const),
  );

export const inBounds = (x: number, y: number): boolean =>
  x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE;

const neighborsOf = (p: Position): Position[] => {
  const out: Position[] = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = p.x + dx;
      const ny = p.y + dy;
      if (inBounds(nx, ny)) out.push({ x: nx, y: ny });
    }
  }
  return out;
};

/** Ships must not touch each other, including diagonally. */
export const canPlaceShip = (
  board: Board,
  x: number,
  y: number,
  size: number,
  isVertical: boolean,
): boolean => {
  if (!inBounds(x, y)) return false;
  if (isVertical && y + size > BOARD_SIZE) return false;
  if (!isVertical && x + size > BOARD_SIZE) return false;

  for (let i = 0; i < size; i++) {
    const cy = isVertical ? y + i : y;
    const cx = isVertical ? x : x + i;
    if (board[cy][cx] !== 'empty') return false;
    for (const n of neighborsOf({ x: cx, y: cy })) {
      if (board[n.y][n.x] !== 'empty') return false;
    }
  }
  return true;
};

const placeShip = (
  board: Board,
  ship: Ship,
): Board => {
  const next = board.map((row) => [...row]);
  for (const p of ship.positions) next[p.y][p.x] = 'ship';
  return next;
};

export const shipPositions = (
  x: number,
  y: number,
  size: number,
  isVertical: boolean,
): Position[] => {
  const out: Position[] = [];
  for (let i = 0; i < size; i++) {
    out.push({
      x: isVertical ? x : x + i,
      y: isVertical ? y + i : y,
    });
  }
  return out;
};

export interface Fleet {
  board: Board;
  ships: Ship[];
}

export const generateFleet = (): Fleet => {
  let board = createEmptyBoard();
  const ships: Ship[] = [];

  for (const { id, size, count } of FLEET_CONFIG) {
    for (let i = 0; i < count; i++) {
      let placed = false;
      let attempts = 0;
      while (!placed) {
        attempts++;
        if (attempts > 5000) {
          // Practically unreachable on a 10x10 with this fleet; retry from scratch.
          board = createEmptyBoard();
          ships.length = 0;
          attempts = 0;
          continue;
        }
        const isVertical = Math.random() > 0.5;
        const x = Math.floor(Math.random() * BOARD_SIZE);
        const y = Math.floor(Math.random() * BOARD_SIZE);
        if (!canPlaceShip(board, x, y, size, isVertical)) continue;

        const ship: Ship = {
          id: `${id}-${i}`,
          size,
          positions: shipPositions(x, y, size, isVertical),
          hits: 0,
          isSunk: false,
        };
        board = placeShip(board, ship);
        ships.push(ship);
        placed = true;
      }
    }
  }

  return { board, ships };
};

export const findShipAt = (ships: Ship[], x: number, y: number): Ship | null =>
  ships.find((s) => s.positions.some((p) => p.x === x && p.y === y)) ?? null;

export const allShipsSunk = (ships: Ship[]): boolean =>
  ships.every((s) => s.isSunk);
