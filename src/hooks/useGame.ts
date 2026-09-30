"use client";

import { useCallback, useEffect, useReducer } from 'react';
import {
  Board,
  Difficulty,
  GamePhase,
  MoveRecord,
  Position,
  Ship,
} from '../types/game';
import { generateFleet, allShipsSunk, Fleet } from '../engine/board';
import { resolveShot, maskBoard } from '../engine/shot';
import {
  initialBotState,
  knowledgeFromBoard,
  nextBotShot,
  BotState,
} from '../engine/bot';

export type Side = 'player' | 'enemy';

export interface GameState {
  phase: GamePhase;
  difficulty: Difficulty;
  playerFleet: Fleet;
  enemyFleet: Fleet;
  playerTurn: boolean;
  winner: Side | null;
  playerMoves: MoveRecord[];
  enemyMoves: MoveRecord[];
  botState: BotState;
  lastBotResult: 'miss' | 'hit' | 'sunk' | null;
  lastBotTarget: Position | null;
  startedAt: number;
}

type Action =
  | { type: 'RANDOMIZE' }
  | { type: 'START'; difficulty: Difficulty }
  | { type: 'PLAYER_FIRE'; x: number; y: number }
  | { type: 'BOT_SHOT' }
  | { type: 'RESET' };

const STORAGE_KEY = 'sonar.io/game/v1';

export const createInitialState = (): GameState => ({
  phase: 'placement',
  difficulty: 'normal',
  playerFleet: generateFleet(),
  enemyFleet: generateFleet(),
  playerTurn: true,
  winner: null,
  playerMoves: [],
  enemyMoves: [],
  botState: initialBotState(),
  lastBotResult: null,
  lastBotTarget: null,
  startedAt: 0,
});

const reducer = (state: GameState, action: Action): GameState => {
  switch (action.type) {
    case 'RANDOMIZE':
      return { ...state, playerFleet: generateFleet() };

    case 'START':
      return {
        ...createInitialState(),
        difficulty: action.difficulty,
        playerFleet: state.playerFleet,
        phase: 'playing',
        startedAt: Date.now(),
      };

    case 'RESET':
      return createInitialState();

    case 'PLAYER_FIRE': {
      if (state.phase !== 'playing' || !state.playerTurn || state.winner) return state;
      const { x, y } = action;
      const outcome = resolveShot(state.enemyFleet.board, state.enemyFleet.ships, x, y);
      if (!outcome) return state;

      const move: MoveRecord = { x, y, result: outcome.result };
      const playerMoves = [...state.playerMoves, move];
      const won = allShipsSunk(outcome.ships);
      return {
        ...state,
        enemyFleet: { board: outcome.board, ships: outcome.ships },
        playerMoves,
        playerTurn: outcome.result !== 'miss' && !won,
        winner: won ? 'player' : null,
        phase: won ? 'game_over' : state.phase,
      };
    }

    case 'BOT_SHOT': {
      if (state.phase !== 'playing' || state.playerTurn || state.winner) return state;
      const knowledge = knowledgeFromBoard(state.playerFleet.board);
      const turn = nextBotShot(
        knowledge,
        state.botState,
        state.difficulty,
        state.lastBotResult,
        state.lastBotTarget,
      );
      const outcome = resolveShot(
        state.playerFleet.board,
        state.playerFleet.ships,
        turn.target.x,
        turn.target.y,
      );
      if (!outcome) return state;

      const enemyMoves = [
        ...state.enemyMoves,
        { x: turn.target.x, y: turn.target.y, result: outcome.result },
      ];
      const lost = allShipsSunk(outcome.ships);
      return {
        ...state,
        playerFleet: { board: outcome.board, ships: outcome.ships },
        enemyMoves,
        playerTurn: outcome.result === 'miss' && !lost,
        winner: lost ? 'enemy' : null,
        phase: lost ? 'game_over' : state.phase,
        botState: turn.state,
        lastBotResult: outcome.result,
        lastBotTarget: turn.target,
      };
    }

    default:
      return state;
  }
};

const loadState = (): GameState => {
  if (typeof window === 'undefined') return createInitialState();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw) as GameState;
    if (parsed?.phase && parsed?.playerFleet?.board) return parsed;
  } catch {
    // corrupted save — start fresh
  }
  return createInitialState();
};

export const useGame = () => {
  const [state, dispatch] = useReducer(reducer, undefined, loadState);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // storage full/unavailable — game continues without persistence
    }
  }, [state]);

  // Bot plays one shot per tick; the effect re-arms while it's the bot's turn.
  useEffect(() => {
    if (state.phase === 'playing' && !state.playerTurn && !state.winner) {
      const t = setTimeout(() => dispatch({ type: 'BOT_SHOT' }), 750);
      return () => clearTimeout(t);
    }
  }, [state.phase, state.playerTurn, state.winner, state.enemyMoves.length]);

  const fire = useCallback((x: number, y: number) => dispatch({ type: 'PLAYER_FIRE', x, y }), []);
  const randomize = useCallback(() => dispatch({ type: 'RANDOMIZE' }), []);
  const start = useCallback((difficulty: Difficulty) => dispatch({ type: 'START', difficulty }), []);
  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);

  return {
    state,
    fire,
    randomize,
    start,
    reset,
    maskedEnemyBoard: maskBoard(state.enemyFleet.board) as Board,
    playerShips: state.playerFleet.ships as Ship[],
  };
};
