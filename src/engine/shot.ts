import { Board, CellState, Ship, ShotOutcome, ShotResult } from '../types/game';
import { findShipAt, inBounds } from './board';

/**
 * Pure shot resolution: takes an attacker's view of the target board
 * (cells 'ship' hidden from the attacker are simply never revealed —
 * the caller passes the owner's board) and returns new immutable
 * board/ships plus the result.
 *
 * Returns null if the shot is invalid or repeats a known cell.
 */
export const resolveShot = (
  board: Board,
  ships: Ship[],
  x: number,
  y: number,
): ShotOutcome | null => {
  if (!inBounds(x, y)) return null;
  const cell = board[y][x];
  if (cell === 'miss' || cell === 'hit' || cell === 'sunk') return null;

  const nextBoard = board.map((row) => [...row]);
  const nextShips = ships.map((s) => ({ ...s, positions: [...s.positions] }));

  if (cell === 'ship') {
    nextBoard[y][x] = 'hit';
    const ship = findShipAt(nextShips, x, y)!;
    ship.hits += 1;

    if (ship.positions.every((p) => nextBoard[p.y][p.x] === 'hit')) {
      ship.isSunk = true;
      ship.positions.forEach((p) => {
        nextBoard[p.y][p.x] = 'sunk';
      });
      // Auto-miss around the sunk ship, per classic rules.
      ship.positions.forEach((p) => {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = p.x + dx;
            const ny = p.y + dy;
            if (inBounds(nx, ny) && nextBoard[ny][nx] === 'empty') {
              nextBoard[ny][nx] = 'miss';
            }
          }
        }
      });
      return { board: nextBoard, ships: nextShips, result: 'sunk', sunkShip: ship };
    }
    return { board: nextBoard, ships: nextShips, result: 'hit', sunkShip: null };
  }

  nextBoard[y][x] = 'miss';
  return { board: nextBoard, ships: nextShips, result: 'miss', sunkShip: null };
};

/** What an opponent is allowed to see: their own shots only, no hidden ships. */
export const maskBoard = (board: Board): Board =>
  board.map((row) => row.map((c) => (c === 'ship' ? 'empty' : c)));

export const shotResultOf = (cell: CellState): ShotResult | null =>
  cell === 'miss' ? 'miss' : cell === 'hit' || cell === 'sunk' ? 'hit' : null;
