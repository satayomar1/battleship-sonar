"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Session } from "@supabase/supabase-js";
import {
  getSupabaseBrowserClient,
  isSupabaseConfigured,
} from "../../lib/supabase/client";
import {
  loadLocalMatches,
  localStats,
  type StoredMatch,
} from "../../lib/matchArchive";

const MODE_LABELS: Record<string, string> = {
  easy: "vs Юнга",
  normal: "vs Мичман",
  hard: "vs Адмирал",
  multiplayer: "Мультиплеер",
};

export default function ProfilePage() {
  const [matches, setMatches] = useState<StoredMatch[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);
  const [cloudMatches, setCloudMatches] = useState<number | null>(null);

  const configured = isSupabaseConfigured();

  useEffect(() => {
    queueMicrotask(() => setMatches(loadLocalMatches()));
  }, []);

  useEffect(() => {
    if (!configured) return;
    const supabase = getSupabaseBrowserClient()!;
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, [configured]);

  useEffect(() => {
    if (!session) return;
    const supabase = getSupabaseBrowserClient()!;
    supabase
      .from("matches")
      .select("id", { count: "exact", head: true })
      .eq("player_id", session.user.id)
      .then(({ count }) => setCloudMatches(count ?? 0));
  }, [session]);

  const stats = localStats(matches);
  const totalWins = Object.values(stats).reduce((a, s) => a + s.wins, 0);
  const totalLosses = Object.values(stats).reduce((a, s) => a + s.losses, 0);

  const signIn = async () => {
    setAuthMessage(null);
    const supabase = getSupabaseBrowserClient()!;
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setAuthMessage(error ? `Ошибка: ${error.message}` : "Вход выполнен");
  };

  const signUp = async () => {
    setAuthMessage(null);
    const supabase = getSupabaseBrowserClient()!;
    const { error } = await supabase.auth.signUp({ email, password });
    setAuthMessage(
      error
        ? `Ошибка: ${error.message}`
        : "Аккаунт создан. Проверьте почту, если подтверждение включено.",
    );
  };

  const signOut = async () => {
    await getSupabaseBrowserClient()!.auth.signOut();
  };

  return (
    <main className="flex flex-col items-center px-4 py-8 sm:py-12 gap-6 min-h-screen">
      <header className="text-center">
        <h1 className="text-2xl sm:text-3xl font-bold tracking-[0.3em] uppercase text-sonar">
          Профиль
        </h1>
        <Link href="/" className="mt-2 inline-block text-xs text-muted hover:text-sonar underline underline-offset-4">
          ← К игре
        </Link>
      </header>

      <section className="glass rounded-2xl p-5 w-full max-w-md" aria-label="Статистика">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3">
          Статистика (на этом устройстве)
        </h2>
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="glass rounded-xl p-3">
            <div className="text-2xl font-bold text-kelp">{totalWins}</div>
            <div className="text-xs text-muted">Побед</div>
          </div>
          <div className="glass rounded-xl p-3">
            <div className="text-2xl font-bold text-coral">{totalLosses}</div>
            <div className="text-xs text-muted">Поражений</div>
          </div>
        </div>
        {Object.keys(stats).length > 0 && (
          <ul className="mt-4 flex flex-col gap-2 text-sm">
            {Object.entries(stats).map(([mode, s]) => {
              const total = s.shots || 1;
              return (
                <li key={mode} className="flex justify-between text-muted">
                  <span>{MODE_LABELS[mode] ?? mode}</span>
                  <span className="font-mono text-xs">
                    {s.wins}W / {s.losses}L · точность {Math.round((s.hits / total) * 100)}%
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="glass rounded-2xl p-5 w-full max-w-md" aria-label="История матчей">
        <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3">
          История матчей
        </h2>
        {matches.length === 0 ? (
          <p className="text-sm text-muted">Пока пусто — сыграйте партию.</p>
        ) : (
          <ul className="flex flex-col gap-2 max-h-80 overflow-y-auto text-sm">
            {matches.map((m) => (
              <li key={m.id} className="flex justify-between items-center glass rounded-lg px-3 py-2">
                <span>{MODE_LABELS[m.mode] ?? m.mode}</span>
                <span className="flex items-center gap-2">
                  <span className={m.result === "win" ? "text-kelp" : "text-coral"}>
                    {m.result === "win" ? "W" : "L"}
                  </span>
                  <span className="font-mono text-xs text-muted">
                    {m.hits}/{m.totalShots} · {new Date(m.finishedAt).toLocaleDateString()}
                    {m.synced ? " ☁" : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        )}
        {configured ? (
          cloudMatches !== null && (
            <p className="mt-3 text-xs text-muted">
              В облаке Supabase: {cloudMatches} матчей
            </p>
          )
        ) : (
          <p className="mt-3 text-xs text-muted/70">
            Облачная синхронизация отключена — история хранится локально.
          </p>
        )}
      </section>

      {configured && (
        <section className="glass rounded-2xl p-5 w-full max-w-md" aria-label="Аккаунт">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted mb-3">
            Аккаунт
          </h2>
          {session ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm break-all">{session.user.email}</p>
              <button type="button" className="btn btn-ghost" onClick={signOut}>
                Выйти
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                autoComplete="email"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="пароль"
                className="bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm"
                autoComplete="current-password"
              />
              <div className="flex gap-3">
                <button type="button" className="btn btn-primary" onClick={signIn}>
                  Войти
                </button>
                <button type="button" className="btn btn-ghost" onClick={signUp}>
                  Регистрация
                </button>
              </div>
              {authMessage && <p className="text-xs text-muted">{authMessage}</p>}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
