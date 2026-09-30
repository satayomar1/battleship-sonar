"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import Battlefield from '../components/Battlefield';
import TacticalDebrief from '../components/TacticalDebrief';
import { useGame } from '../hooks/useGame';
import { computeDebrief, formatShareText } from '../engine/debrief';
import { recordFinishedMatch } from '../lib/matchArchive';
import { Difficulty } from '../types/game';

const DIFFICULTIES: { id: Difficulty; label: string; hint: string }[] = [
  { id: 'easy', label: 'Юнга', hint: 'Стреляет наугад' },
  { id: 'normal', label: 'Мичман', hint: 'Добивает найденные корабли' },
  { id: 'hard', label: 'Адмирал', hint: 'Шахматный поиск и точное добивание' },
];

const subscribeHydration = () => () => {};

const useHydrated = () =>
  useSyncExternalStore(subscribeHydration, () => true, () => false);

export default function Home() {
  const hydrated = useHydrated();
  const { state, fire, randomize, start, reset, maskedEnemyBoard } = useGame();
  const [difficulty, setDifficulty] = useState<Difficulty>('normal');
  const [copied, setCopied] = useState(false);

  const won = state.winner === 'player';
  const debrief = computeDebrief(state.playerMoves);

  const recordedRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.phase !== 'game_over' || !state.winner) return;
    const key = `${state.startedAt}-${state.winner}`;
    if (recordedRef.current === key) return;
    recordedRef.current = key;
    recordFinishedMatch(
      state.difficulty,
      won ? 'win' : 'loss',
      state.playerMoves,
      debrief,
      state.startedAt,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, state.winner]);

  const copyResult = async () => {
    const text = formatShareText(won, debrief, `против бота · ${DIFFICULTIES.find((d) => d.id === state.difficulty)?.label ?? ''}`);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable
    }
  };

  if (!hydrated) {
    return <main className="min-h-screen" aria-busy="true" />;
  }

  return (
    <main className="flex flex-col items-center px-4 py-8 sm:py-12 gap-6 min-h-screen">
      <header className="text-center">
        <h1 className="text-3xl sm:text-4xl font-bold tracking-[0.3em] uppercase text-sonar">
          Sonar<span className="text-ink">.io</span>
        </h1>
        <p className="mt-2 text-sm text-muted">Тактический морской бой</p>
        <Link href="/profile" className="mt-1 inline-block text-xs text-sonar/80 hover:text-sonar underline underline-offset-4">
          Профиль и статистика
        </Link>
        <span className="mx-2 text-muted/50">·</span>
        <Link
          href="/multiplayer"
          className="mt-1 inline-block text-xs text-sonar/80 hover:text-sonar underline underline-offset-4"
        >
          Multiplayer
        </Link>
      </header>

      {state.phase === 'placement' && (
        <section className="flex flex-col items-center gap-5" aria-label="Расстановка флота">
          <div className="glass rounded-2xl p-4 sm:p-5 w-full max-w-md">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3 text-center">
              Сложность противника
            </h2>
            <div className="flex flex-col gap-2">
              {DIFFICULTIES.map((d) => (
                <button
                  key={d.id}
                  type="button"
                  onClick={() => setDifficulty(d.id)}
                  aria-pressed={difficulty === d.id}
                  className={`btn ${difficulty === d.id ? 'btn-primary' : 'btn-ghost'} justify-between`}
                >
                  <span>{d.label}</span>
                  <span className="text-xs font-normal opacity-70">{d.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <Battlefield
            title="Твой флот"
            board={state.playerFleet.board}
            label="Ваше поле с кораблями"
          />

          <div className="flex gap-3">
            <button type="button" className="btn btn-ghost" onClick={randomize}>
              🎲 Перемешать
            </button>
            <button type="button" className="btn btn-primary" onClick={() => start(difficulty)}>
              🚀 В бой
            </button>
          </div>
        </section>
      )}

      {state.phase === 'playing' && (
        <section className="flex flex-col items-center gap-5 w-full" aria-label="Игра">
          <div
            className={`px-5 py-2 rounded-full glass font-mono font-bold text-sm tracking-widest ${
              state.playerTurn ? 'text-kelp' : 'text-coral animate-pulse'
            }`}
            role="status"
            aria-live="polite"
          >
            {state.playerTurn ? '▶ ТВОЙ ХОД' : '… ПРОТИВНИК ЦЕЛИТСЯ'}
          </div>

          <div className="flex flex-col min-[900px]:flex-row gap-6 min-[900px]:gap-12 items-center justify-center">
            <Battlefield
              title="Радар · враг"
              board={maskedEnemyBoard}
              onCellClick={fire}
              disabled={!state.playerTurn}
              label="Поле противника — стреляйте по клеткам"
            />
            <div className="hidden min-[900px]:block">
              <Battlefield
                title="База · твой флот"
                board={state.playerFleet.board}
                label="Ваше поле"
              />
            </div>

            <details className="w-[min(94vw,392px)] min-[900px]:hidden">
              <summary className="glass block cursor-pointer select-none rounded-xl px-3 py-3 text-center text-xs font-semibold uppercase tracking-widest text-muted">
                Показать свой флот
              </summary>
              <div className="mt-3 flex justify-center">
                <Battlefield
                  title="База · твой флот"
                  board={state.playerFleet.board}
                  label="Ваше поле"
                />
              </div>
            </details>
          </div>
        </section>
      )}

      {state.phase === 'game_over' && (
        <section className="flex flex-col items-center gap-5 w-full max-w-xl" aria-label="Результат">
          <div className="glass rounded-2xl p-6 sm:p-8 text-center w-full">
            <h2
              className={`text-2xl sm:text-3xl font-bold uppercase tracking-widest ${
                won ? 'text-kelp' : 'text-coral'
              }`}
            >
              {won ? '🏆 Победа' : '💀 Поражение'}
            </h2>
            <p className="mt-2 text-muted text-sm">
              {won
                ? 'Вражеский флот на дне. Разберите партию ниже.'
                : 'Соперник оказался точнее. Изучите разбор и берите реванш.'}
            </p>
            <div className="mt-5 flex flex-wrap gap-3 justify-center">
              <button type="button" className="btn btn-primary" onClick={reset}>
                🔄 Новая игра
              </button>
              <button type="button" className="btn btn-ghost" onClick={copyResult}>
                {copied ? '✓ Скопировано' : '📋 Поделиться результатом'}
              </button>
            </div>
          </div>

          <TacticalDebrief stats={debrief} moves={state.playerMoves} />
        </section>
      )}

      <footer className="mt-auto pt-6 text-xs text-muted/70">
        Корабли не касаются друг друга · вокруг потопленного — промахи
      </footer>
    </main>
  );
}
