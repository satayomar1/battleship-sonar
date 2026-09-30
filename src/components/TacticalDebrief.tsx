"use client";

import React, { useState } from 'react';
import { DebriefStats, MoveRecord } from '../types/game';
import { BOARD_SIZE } from '../engine/board';

interface DebriefProps {
  stats: DebriefStats;
  moves: MoveRecord[];
}

const Heatmap: React.FC<{ moves: MoveRecord[] }> = ({ moves }) => {
  const grid = Array.from({ length: BOARD_SIZE }, () =>
    Array.from({ length: BOARD_SIZE }, () => ({ shots: 0, hits: 0 })),
  );
  for (const m of moves) {
    grid[m.y][m.x].shots++;
    if (m.result !== 'miss') grid[m.y][m.x].hits++;
  }
  return (
    <div
      className="grid grid-cols-10 gap-[3px] w-[min(86vw,320px)]"
      role="img"
      aria-label="Тепловая карта ваших выстрелов"
    >
      {grid.map((row, y) =>
        row.map((cell, x) => {
          const intensity = cell.hits
            ? 0.35 + cell.hits * 0.25
            : cell.shots
              ? 0.12
              : 0;
          return (
            <div
              key={`${x}-${y}`}
              className="cell"
              style={{
                background: cell.hits
                  ? `rgba(248,113,113,${Math.min(intensity, 0.85)})`
                  : cell.shots
                    ? 'rgba(34,211,238,0.12)'
                    : 'rgba(148,184,255,0.04)',
              }}
              title={`${String.fromCharCode(65 + x)}${y + 1}: ${cell.shots} выстр., ${cell.hits} попаданий`}
            />
          );
        }),
      )}
    </div>
  );
};

export default function TacticalDebrief({ stats, moves }: DebriefProps) {
  const [open, setOpen] = useState(true);
  return (
    <section className="glass rounded-2xl p-5 sm:p-6 w-full max-w-xl" aria-label="Тактический разбор">
      <button
        type="button"
        className="w-full flex items-center justify-between cursor-pointer bg-transparent border-0 p-0 text-left"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <h2 className="text-lg font-bold tracking-wide text-ink">
          Тактический разбор
        </h2>
        <span className="text-muted" aria-hidden>{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Точность', value: `${(stats.accuracy * 100).toFixed(0)}%` },
              { label: 'Выстрелов', value: String(stats.totalShots) },
              { label: 'Попаданий', value: String(stats.hits) },
              { label: 'Лучшая серия', value: String(stats.longestHitStreak) },
            ].map((m) => (
              <div key={m.label} className="glass rounded-xl p-3 text-center">
                <div className="text-xl font-bold text-sonar">{m.value}</div>
                <div className="text-xs text-muted mt-1">{m.label}</div>
              </div>
            ))}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-muted mb-2 uppercase tracking-wider">
              Карта выстрелов
            </h3>
            <Heatmap moves={moves} />
          </div>

          <div>
            <h3 className="text-sm font-semibold text-muted mb-2 uppercase tracking-wider">
              Наблюдения
            </h3>
            <ul className="flex flex-col gap-1.5 text-sm text-ink/90 list-disc pl-5">
              {stats.observations.map((o) => (
                <li key={o}>{o}</li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-sonar/30 bg-sonar/5 p-4">
            <h3 className="text-sm font-semibold text-sonar mb-2 uppercase tracking-wider">
              Советы снарёра
            </h3>
            <ul className="flex flex-col gap-1.5 text-sm text-ink/90 list-disc pl-5">
              {stats.tips.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
