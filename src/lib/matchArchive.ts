import type { DebriefStats, Difficulty, MoveRecord } from "../types/game";
import { getSupabaseBrowserClient } from "./supabase/client";

export interface StoredMatch {
  id: string;
  startedAt: number;
  mode: Difficulty;
  result: "win" | "loss";
  totalShots: number;
  hits: number;
  accuracy: number;
  durationSeconds: number | null;
  finishedAt: string;
  synced: boolean;
}

const ARCHIVE_KEY = "sonar.io/matches/v1";
const MAX_LOCAL_MATCHES = 50;

export function loadLocalMatches(): StoredMatch[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(ARCHIVE_KEY);
    return raw ? (JSON.parse(raw) as StoredMatch[]) : [];
  } catch {
    return [];
  }
}

export function localStats(matches: StoredMatch[]) {
  const byMode: Record<string, { wins: number; losses: number; shots: number; hits: number }> = {};
  for (const m of matches) {
    const bucket = (byMode[m.mode] ??= { wins: 0, losses: 0, shots: 0, hits: 0 });
    if (m.result === "win") bucket.wins += 1;
    else bucket.losses += 1;
    bucket.shots += m.totalShots;
    bucket.hits += m.hits;
  }
  return byMode;
}

function saveLocalMatches(matches: StoredMatch[]) {
  window.localStorage.setItem(
    ARCHIVE_KEY,
    JSON.stringify(matches.slice(0, MAX_LOCAL_MATCHES)),
  );
}

async function syncMatchToCloud(match: StoredMatch) {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) return false;
  const { data: session } = await supabase.auth.getSession();
  if (!session.session) return false;

  const mode = `bot_${match.mode}`;
  const { error } = await supabase.from("matches").insert({
    mode,
    result: match.result,
    total_shots: match.totalShots,
    hits: match.hits,
    accuracy: match.accuracy,
    duration_seconds: match.durationSeconds,
  });
  return !error;
}

export function recordFinishedMatch(
  mode: Difficulty,
  result: "win" | "loss",
  moves: MoveRecord[],
  stats: DebriefStats,
  startedAt: number | null,
): StoredMatch | null {
  if (typeof window === "undefined") return null;
  const existing = loadLocalMatches();
  // The game_over effect re-fires on page reload (state is persisted);
  // one startedAt identifies one game, so archive it exactly once.
  if (startedAt !== null) {
    const already = existing.find((m) => m.startedAt === startedAt);
    if (already) return already;
  }
  const match: StoredMatch = {
    id: crypto.randomUUID(),
    startedAt: startedAt ?? 0,
    mode,
    result,
    totalShots: moves.length,
    hits: stats.hits,
    accuracy: stats.accuracy,
    durationSeconds: startedAt ? Math.round((Date.now() - startedAt) / 1000) : null,
    finishedAt: new Date().toISOString(),
    synced: false,
  };
  saveLocalMatches([match, ...existing]);
  void syncMatchToCloud(match).then((ok) => {
    if (!ok) return;
    const all = loadLocalMatches();
    const target = all.find((m) => m.id === match.id);
    if (target) target.synced = true;
    saveLocalMatches(all);
  });
  return match;
}
