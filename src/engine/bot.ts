import { Board, Difficulty, Position } from '../types/game';
import { BOARD_SIZE, inBounds } from './board';

/**
 * The bot only sees "knowledge": its own shots' results on the target board.
 * 'unknown' means not shot at yet. It never inspects hidden ship cells.
 */
export type Knowledge = ('unknown' | 'miss' | 'hit' | 'sunk')[][];

export interface BotState {
  /** Candidate cells to try while finishing off a wounded ship. */
  queue: Position[];
  /** Axis locked in after two hits in a row. */
  axis: 'h' | 'v' | null;
}

export const initialBotState = (): BotState => ({ queue: [], axis: null });

export const knowledgeFromBoard = (board: Board): Knowledge =>
  board.map((row) =>
    row.map((c) => (c === 'miss' || c === 'hit' || c === 'sunk' ? (c === 'miss' ? 'miss' : 'hit') : 'unknown')),
  );

const ORTH = [
  { dx: 0, dy: -1 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 1, dy: 0 },
] as const;

const unshot = (k: Knowledge, p: Position): boolean =>
  inBounds(p.x, p.y) && k[p.y][p.x] === 'unknown';

const randomUnshotCell = (k: Knowledge): Position => {
  const candidates: Position[] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (k[y][x] === 'unknown') candidates.push({ x, y });
    }
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
};

/** Hard mode hunts on the checkerboard parity first (no ship is smaller than 1, so full parity for subs). */
const randomUnshotParity = (k: Knowledge): Position | null => {
  const candidates: Position[] = [];
  for (let y = 0; y < BOARD_SIZE; y++) {
    for (let x = 0; x < BOARD_SIZE; x++) {
      if (k[y][x] === 'unknown' && (x + y) % 2 === 0) candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)];
};

/** Refine queue after a new hit, optionally locking an axis. */
const pushTargets = (
  state: BotState,
  k: Knowledge,
  hit: Position,
): BotState => {
  const state2: BotState = { ...state, queue: [...state.queue] };

  if (state.axis) {
    const orthAlong = ORTH.filter((o) =>
      state.axis === 'h' ? o.dy === 0 : o.dx === 0,
    ).map((o) => ({ x: hit.x + o.dx, y: hit.y + o.dy }));
    state2.queue = [...orthAlong.filter((p) => unshot(k, p)), ...state2.queue];
    return state2;
  }

  const orth = ORTH.map((o) => ({ x: hit.x + o.dx, y: hit.y + o.dy })).filter(
    (p) => unshot(k, p),
  );
  // If a neighboring cell is a known hit, the ship direction is implied.
  const aligned = ORTH.find((o) => {
    const nx = hit.x + o.dx;
    const ny = hit.y + o.dy;
    return inBounds(nx, ny) && k[ny][nx] === 'hit';
  });
  if (aligned) {
    state2.axis =
      aligned.dy === 0 ? 'h' : 'v';
    const pair: Position[] =
      state2.axis === 'h'
        ? [
            { x: hit.x + aligned.dx, y: hit.y },
            { x: hit.x - aligned.dx, y: hit.y },
          ]
        : [
            { x: hit.x, y: hit.y + aligned.dy },
            { x: hit.x, y: hit.y - aligned.dy },
          ];
    state2.queue = [...pair.filter((p) => unshot(k, p)), ...state2.queue];
  } else {
    state2.queue = [...orth, ...state2.queue];
  }
  return state2;
};

export interface BotTurn {
  target: Position;
  state: BotState;
}

/**
 * Pick the next shot. `lastResult`/`lastTarget` describe the bot's previous
 * shot; pass null for the first shot of the game.
 */
export const nextBotShot = (
  knowledge: Knowledge,
  state: BotState,
  difficulty: Difficulty,
  lastResult: 'miss' | 'hit' | 'sunk' | null,
  lastTarget: Position | null,
): BotTurn => {
  let state2: BotState = { queue: [...state.queue], axis: state.axis };

  if (lastResult && lastTarget) {
    if (lastResult === 'hit') {
      state2 = pushTargets(state2, knowledge, lastTarget);
    } else if (lastResult === 'sunk') {
      state2 = { queue: [], axis: null };
    }
  }

  // Filter out targets that became known in the meantime.
  state2.queue = state2.queue.filter((p) => unshot(knowledge, p));

  if (state2.queue.length > 0 && difficulty !== 'easy') {
    const target = state2.queue.shift()!;
    return { target, state: { ...state2, queue: state2.queue } };
  }

  if (difficulty === 'hard') {
    const parity = randomUnshotParity(knowledge);
    if (parity) return { target: parity, state: state2 };
  }
  return { target: randomUnshotCell(knowledge), state: state2 };
};
