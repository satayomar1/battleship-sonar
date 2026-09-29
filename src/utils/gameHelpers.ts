import { Board, Position, Ship } from '../types/game';

export const createEmptyBoard = (): Board =>
  Array(10).fill(null).map(() => Array(10).fill('empty'));

const SHIPS_CONFIG = [
  { id: 'battleship', size: 4, count: 1 },
  { id: 'cruiser', size: 3, count: 2 },
  { id: 'destroyer', size: 2, count: 3 },
  { id: 'submarine', size: 1, count: 4 },
];

export const generateRandomBoard = (): { board: Board, ships: Ship[] } => {
  const board = createEmptyBoard();
  const ships: Ship[] = [];

  const canPlace = (board: Board, x: number, y: number, size: number, isVertical: boolean) => {
    if (isVertical && y + size > 10) return false;
    if (!isVertical && x + size > 10) return false;

    for (let i = 0; i < size; i++) {
      const curY = isVertical ? y + i : y;
      const curX = isVertical ? x : x + i;

      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = curY + dy;
          const nx = curX + dx;
          if (ny >= 0 && ny < 10 && nx >= 0 && nx < 10) {
            if (board[ny][nx] !== 'empty') return false;
          }
        }
      }
    }
    return true;
  };

  SHIPS_CONFIG.forEach(({ id, size, count }) => {
    for (let i = 0; i < count; i++) {
      let placed = false;
      while (!placed) {
        const isVertical = Math.random() > 0.5;
        const x = Math.floor(Math.random() * 10);
        const y = Math.floor(Math.random() * 10);

        if (canPlace(board, x, y, size, isVertical)) {
          const positions: Position[] = [];
          for (let j = 0; j < size; j++) {
            const curY = isVertical ? y + j : y;
            const curX = isVertical ? x : x + j;
            board[curY][curX] = 'ship';
            positions.push({ x: curX, y: curY });
          }
          ships.push({ id: `${id}-${i}`, size, positions, hits: 0, isSunk: false });
          placed = true;
        }
      }
    }
  });

  return { board, ships };
};

// Функция проверки: потоплен ли корабль, и если да — установка статуса 'sunk' и авто-промахов вокруг
export const checkShipSunkAndMark = (board: Board, ships: Ship[], x: number, y: number) => {
  let hitShip: Ship | null = null;
  
  // Находим, какому кораблю принадлежит эта клетка
  for (const ship of ships) {
    if (ship.positions.some(p => p.x === x && p.y === y)) {
      hitShip = ship;
      break;
    }
  }

  if (!hitShip) return { ships, isSunk: false };

  // Проверяем, все ли палубы подбиты
  const allHit = hitShip.positions.every(p => board[p.y][p.x] === 'hit' || board[p.y][p.x] === 'sunk');

  if (allHit && !hitShip.isSunk) {
    hitShip.isSunk = true;
    // Меняем статус клеток на 'sunk'
    hitShip.positions.forEach(p => {
      board[p.y][p.x] = 'sunk';
    });
    // Автоматически ставим промахи (точки) вокруг потопленного корабля
    hitShip.positions.forEach(p => {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ny = p.y + dy;
          const nx = p.x + dx;
          if (ny >= 0 && ny < 10 && nx >= 0 && nx < 10) {
            if (board[ny][nx] === 'empty') {
              board[ny][nx] = 'miss';
            }
          }
        }
      }
    });
    return { ships, isSunk: true };
  }

  return { ships, isSunk: false };
};