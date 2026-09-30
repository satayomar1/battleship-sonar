"use client";

import React from 'react';
import { Board } from '../types/game';

interface BattlefieldProps {
  title: string;
  board: Board;
  onCellClick?: (x: number, y: number) => void;
  disabled?: boolean;
  label: string;
}

const cellDisplay = (cell: Board[number][number]) => {
  switch (cell) {
    case 'ship':
      return <span aria-hidden className="block w-2/3 h-2/3 rounded-sm bg-sonar/60" />;
    case 'miss':
      return (
        <span aria-hidden className="block w-1.5 h-1.5 rounded-full bg-muted/70" />
      );
    case 'hit':
      return (
        <span aria-hidden className="text-coral font-bold leading-none">✕</span>
      );
    case 'sunk':
      return (
        <span aria-hidden className="text-white/90 font-bold leading-none">✕</span>
      );
    default:
      return null;
  }
};

const cellClass = (cell: Board[number][number], shootable: boolean) => {
  if (shootable) return 'cell cell-shootable';
  switch (cell) {
    case 'ship':
      return 'cell cell-ship';
    case 'miss':
      return 'cell cell-miss';
    case 'hit':
      return 'cell cell-hit';
    case 'sunk':
      return 'cell cell-sunk';
    default:
      return 'cell';
  }
};

export default function Battlefield({
  title,
  board,
  onCellClick,
  disabled = false,
  label,
}: BattlefieldProps) {
  const interactive = Boolean(onCellClick) && !disabled;
  return (
    <div className="glass rounded-2xl p-3 sm:p-4 inline-block" role="group" aria-label={label}>
      <h3 className="mb-2 text-center font-mono text-xs uppercase tracking-widest text-muted">
        {title}
      </h3>
      <div
        className="grid grid-cols-10 gap-[3px] w-[min(86vw,320px)] sm:w-[360px]"
        aria-hidden={disabled}
      >
        {board.map((row, y) =>
          row.map((cell, x) => {
            const shootable = interactive && (cell === 'empty' || cell === 'ship');
            return (
              <button
                key={`${y}-${x}`}
                type="button"
                className={cellClass(cell, shootable)}
                disabled={!shootable}
                aria-label={`Клетка ${String.fromCharCode(65 + x)}${y + 1}: ${
                  cell === 'miss'
                    ? 'промах'
                    : cell === 'hit'
                      ? 'попадание'
                      : cell === 'sunk'
                        ? 'потоплен'
                        : 'неизвестно'
                }`}
                onClick={() => onCellClick?.(x, y)}
              >
                {cellDisplay(cell)}
              </button>
            );
          }),
        )}
      </div>
    </div>
  );
}
