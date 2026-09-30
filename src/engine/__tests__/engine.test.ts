import { describe, expect, it } from 'vitest';
import {
  allShipsSunk,
  canPlaceShip,
  createEmptyBoard,
  findShipAt,
  generateFleet,
  TOTAL_SHIP_CELLS,
} from '../board';
import { resolveShot } from '../shot';
import {
  initialBotState,
  knowledgeFromBoard,
  nextBotShot,
} from '../bot';
import { computeDebrief, formatShareText } from '../debrief';
import { Board, MoveRecord, Ship } from '../../types/game';

const shipAt = (board: Board, x: number, y: number) => {
  board[y][x] = 'ship';
};

describe('generateFleet', () => {
  it('generates correct fleet composition', () => {
    const { ships } = generateFleet();
    expect(ships).toHaveLength(10);
    const sizes = ships.map((s) => s.size).sort();
    expect(sizes).toEqual([1, 1, 1, 1, 2, 2, 2, 3, 3, 4]);
  });

  it('does not let ships touch (including diagonally)', () => {
    const { board, ships } = generateFleet();
    for (const ship of ships) {
      for (const p of ship.positions) {
        expect(board[p.y][p.x]).toBe('ship');
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            const nx = p.x + dx;
            const ny = p.y + dy;
            if (nx < 0 || nx > 9 || ny < 0 || ny > 9) continue;
            const cell = board[ny][nx];
            if (ship.positions.some((q) => q.x === nx && q.y === ny)) continue;
            expect(cell).toBe('empty');
          }
        }
      }
    }
  });

  it('property: 300 generations always legal and complete', () => {
    for (let i = 0; i < 300; i++) {
      const { board, ships } = generateFleet();
      const shipCells = board.flat().filter((c) => c === 'ship').length;
      expect(shipCells).toBe(TOTAL_SHIP_CELLS);
      expect(ships).toHaveLength(10);
      for (const s of ships) {
        expect(s.positions).toHaveLength(s.size);
      }
    }
  });
});

describe('canPlaceShip', () => {
  it('rejects overlap and touching, accepts valid placement', () => {
    const board = createEmptyBoard();
    shipAt(board, 0, 0);
    shipAt(board, 5, 5);
    shipAt(board, 6, 5);
    expect(canPlaceShip(board, 0, 1, 2, false)).toBe(false); // touches (0,0)
    expect(canPlaceShip(board, 4, 5, 1, false)).toBe(false); // touches (5,5)
    expect(canPlaceShip(board, 7, 5, 2, false)).toBe(false); // touches (6,5)
    expect(canPlaceShip(board, 9, 5, 2, false)).toBe(false); // out of bounds
    expect(canPlaceShip(board, 0, 3, 3, false)).toBe(true);
  });
});

describe('resolveShot', () => {
  const setup = () => {
    const board = createEmptyBoard();
    // Ship of 2 at (2,2)-(3,2); ship of 1 at (8,8)
    shipAt(board, 2, 2);
    shipAt(board, 3, 2);
    shipAt(board, 8, 8);
    const ships: Ship[] = [
      {
        id: 'a',
        size: 2,
        positions: [
          { x: 2, y: 2 },
          { x: 3, y: 2 },
        ],
        hits: 0,
        isSunk: false,
      },
      { id: 'b', size: 1, positions: [{ x: 8, y: 8 }], hits: 0, isSunk: false },
    ];
    return { board, ships };
  };

  it('registers a miss and forbids repeat shots', () => {
    const { board, ships } = setup();
    const out = resolveShot(board, ships, 0, 0)!;
    expect(out.result).toBe('miss');
    expect(out.board[0][0]).toBe('miss');
    expect(resolveShot(out.board, out.ships, 0, 0)).toBeNull();
  });

  it('registers a hit without sinking', () => {
    const { board, ships } = setup();
    const out = resolveShot(board, ships, 2, 2)!;
    expect(out.result).toBe('hit');
    expect(out.ships.find((s) => s.id === 'a')!.hits).toBe(1);
    expect(out.ships.find((s) => s.id === 'a')!.isSunk).toBe(false);
    expect(out.board).not.toBe(board); // immutability
    expect(board[2][2]).toBe('ship'); // original untouched
  });

  it('sinks a ship and auto-misses around it', () => {
    const { board, ships } = setup();
    const first = resolveShot(board, ships, 2, 2)!;
    const second = resolveShot(first.board, first.ships, 3, 2)!;
    expect(second.result).toBe('sunk');
    expect(second.ships.find((s) => s.id === 'a')!.isSunk).toBe(true);
    // Surrounding cells become misses
    expect(second.board[1][1]).toBe('miss');
    expect(second.board[1][2]).toBe('miss');
    expect(second.board[2][1]).toBe('miss');
    expect(second.board[3][2]).toBe('miss');
    expect(second.board[3][3]).toBe('miss');
    // Not a neighbor of the ship
    expect(second.board[5][5]).toBe('empty');
  });

  it('win condition triggers only when all ships sunk', () => {
    const { board, ships } = setup();
    let cur = { board, ships };
    for (const [x, y] of [
      [2, 2],
      [3, 2],
    ] as const) {
      cur = resolveShot(cur.board, cur.ships, x, y)!;
    }
    expect(allShipsSunk(cur.ships)).toBe(false);
    const last = resolveShot(cur.board, cur.ships, 8, 8)!;
    expect(last.result).toBe('sunk');
    expect(allShipsSunk(last.ships)).toBe(true);
  });

  it('findShipAt locates the right ship', () => {
    const { ships } = setup();
    expect(findShipAt(ships, 3, 2)!.id).toBe('a');
    expect(findShipAt(ships, 8, 8)!.id).toBe('b');
    expect(findShipAt(ships, 0, 0)).toBeNull();
  });
});

describe('bot', () => {
  it('never shoots the same cell twice (normal difficulty, full game)', () => {
    const { board, ships } = generateFleet();
    let curBoard = board;
    let knowledge = knowledgeFromBoard(board);
    let state = initialBotState();
    const shot = new Set<string>();
    let lastResult: 'miss' | 'hit' | 'sunk' | null = null;
    let lastTarget = null as { x: number; y: number } | null;
    let curShips = ships;
    for (let i = 0; i < 200; i++) {
      const turn = nextBotShot(knowledge, state, 'normal', lastResult, lastTarget);
      const out = resolveShot(curBoard, curShips, turn.target.x, turn.target.y)!;
      const key = `${turn.target.x},${turn.target.y}`;
      expect(shot.has(key)).toBe(false);
      shot.add(key);
      curBoard = out.board;
      knowledge = knowledgeFromBoard(out.board);
      curShips = out.ships;
      lastResult = out.result;
      lastTarget = turn.target;
      state = turn.state;
      if (allShipsSunk(curShips)) return;
    }
    throw new Error('bot failed to finish the game');
  });

  it('easy bot also completes without duplicates', () => {
    const { board, ships } = generateFleet();
    let curBoard = board;
    let knowledge = knowledgeFromBoard(board);
    let state = initialBotState();
    const shot = new Set<string>();
    let lastResult: 'miss' | 'hit' | 'sunk' | null = null;
    let lastTarget = null as { x: number; y: number } | null;
    let curShips = ships;
    for (let i = 0; i < 200; i++) {
      const turn = nextBotShot(knowledge, state, 'easy', lastResult, lastTarget);
      const out = resolveShot(curBoard, curShips, turn.target.x, turn.target.y)!;
      const key = `${turn.target.x},${turn.target.y}`;
      expect(shot.has(key)).toBe(false);
      shot.add(key);
      curBoard = out.board;
      knowledge = knowledgeFromBoard(out.board);
      curShips = out.ships;
      lastResult = out.result;
      lastTarget = turn.target;
      state = turn.state;
      if (allShipsSunk(curShips)) return;
    }
    throw new Error('easy bot failed to finish the game');
  });

  it('hard bot beats the fleet efficiently and finishes in <= 100 shots', () => {
    for (let game = 0; game < 20; game++) {
      const { board, ships } = generateFleet();
      let curBoard = board;
      let knowledge = knowledgeFromBoard(board);
      let state = initialBotState();
      let lastResult: 'miss' | 'hit' | 'sunk' | null = null;
      let lastTarget = null as { x: number; y: number } | null;
      let curShips = ships;
      let shots = 0;
      for (let i = 0; i < 200; i++) {
        const turn = nextBotShot(knowledge, state, 'hard', lastResult, lastTarget);
        const out = resolveShot(curBoard, curShips, turn.target.x, turn.target.y)!;
        shots++;
        curBoard = out.board;
        knowledge = knowledgeFromBoard(out.board);
        curShips = out.ships;
        lastResult = out.result;
        lastTarget = turn.target;
        state = turn.state;
        if (allShipsSunk(curShips)) break;
      }
      expect(shots).toBeLessThanOrEqual(100);
    }
  });

  it('targets neighbors after a hit (normal)', () => {
    const board = createEmptyBoard();
    board[4][4] = 'ship';
    board[4][5] = 'ship';
    const knowledge = knowledgeFromBoard(board);
    // Simulate bot just hit (4,4)
    const state = { queue: [], axis: null as null | 'h' | 'v' };
    const turn = nextBotShot(knowledge, state, 'normal', 'hit', { x: 4, y: 4 });
    const neighbors = [
      { x: 4, y: 3 },
      { x: 4, y: 5 },
      { x: 3, y: 4 },
      { x: 5, y: 4 },
    ];
    expect(
      neighbors.some((n) => n.x === turn.target.x && n.y === turn.target.y),
    ).toBe(true);
  });

  it('clears queue after a sunk ship', () => {
    const state = { queue: [{ x: 1, y: 1 }], axis: 'h' as const };
    const turn = nextBotShot(
      knowledgeFromBoard(createEmptyBoard()),
      state,
      'normal',
      'sunk',
      { x: 0, y: 0 },
    );
    expect(turn.state.queue).toHaveLength(0);
    expect(turn.state.axis).toBeNull();
  });
});

describe('debrief', () => {
  it('computes accuracy, streaks and tips from real moves', () => {
    const moves: MoveRecord[] = [
      { x: 0, y: 0, result: 'miss' },
      { x: 2, y: 2, result: 'hit' },
      { x: 3, y: 2, result: 'sunk' },
      { x: 9, y: 9, result: 'miss' },
      { x: 5, y: 5, result: 'miss' },
    ];
    const stats = computeDebrief(moves);
    expect(stats.totalShots).toBe(5);
    expect(stats.hits).toBe(2);
    expect(stats.accuracy).toBeCloseTo(0.4);
    expect(stats.longestHitStreak).toBe(2);
    expect(stats.observations.length).toBeGreaterThan(0);
    expect(stats.tips.length).toBeGreaterThan(0);
  });

  it('share text includes result and accuracy', () => {
    const stats = computeDebrief([
      { x: 0, y: 0, result: 'hit' },
      { x: 1, y: 0, result: 'miss' },
    ]);
    const text = formatShareText(true, stats, 'с ботом');
    expect(text).toContain('Победа');
    expect(text).toContain('50%');
  });
});
