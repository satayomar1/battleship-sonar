import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateFleet, allShipsSunk, type Fleet } from "../../engine/board";
import { resolveShot } from "../../engine/shot";
import { computeDebrief } from "../../engine/debrief";
import type { MoveRecord } from "../../types/game";
import {
  loadLocalMatches,
  localStats,
  recordFinishedMatch,
} from "../matchArchive";

// Lightweight Supabase client mock: enough surface for matchArchive
// (auth.getSession + from("matches").insert). Defaults to null client, which
// mirrors "Supabase not configured" and keeps the local-only tests as before.
const fakeSupabase = vi.hoisted(() => ({
  client: null as unknown,
  session: null as { user: { id: string } } | null,
  insertError: null as unknown,
  inserts: [] as Array<Record<string, unknown>>,
  fromTable: "",
}));

vi.mock("../supabase/client", () => ({
  getSupabaseBrowserClient: () => fakeSupabase.client,
}));

function enableFakeSupabase(
  userId: string | null,
  insertError: unknown = null,
) {
  fakeSupabase.session = userId === null ? null : { user: { id: userId } };
  fakeSupabase.insertError = insertError;
  fakeSupabase.inserts = [];
  fakeSupabase.fromTable = "";
  fakeSupabase.client = {
    auth: {
      getSession: async () => ({ data: { session: fakeSupabase.session } }),
    },
    from: (table: string) => ({
      insert: async (payload: Record<string, unknown>) => {
        fakeSupabase.fromTable = table;
        fakeSupabase.inserts.push(payload);
        return { error: fakeSupabase.insertError };
      },
    }),
  };
}

const store = new Map<string, string>();
const windowStub = {
  localStorage: {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

function playFullGame(): { fleet: Fleet; moves: MoveRecord[] } {
  let fleet = generateFleet();
  const moves: MoveRecord[] = [];
  for (let y = 0; y < 10 && !allShipsSunk(fleet.ships); y++) {
    for (let x = 0; x < 10 && !allShipsSunk(fleet.ships); x++) {
      const out = resolveShot(fleet.board, fleet.ships, x, y);
      if (!out) continue;
      fleet = { board: out.board, ships: out.ships };
      moves.push({ x, y, result: out.result });
    }
  }
  return { fleet, moves };
}

describe("match archive: game over -> archive -> profile data", () => {
  beforeEach(() => {
    store.clear();
    fakeSupabase.client = null;
    (globalThis as Record<string, unknown>).window = windowStub;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  it("archives a finished game with correct profile fields", () => {
    const { fleet, moves } = playFullGame();
    expect(allShipsSunk(fleet.ships)).toBe(true);

    const stats = computeDebrief(moves);
    const startedAt = Date.now() - 120_000;
    const recorded = recordFinishedMatch("hard", "win", moves, stats, startedAt);
    expect(recorded).not.toBeNull();

    const archive = loadLocalMatches();
    expect(archive).toHaveLength(1);
    const m = archive[0];
    expect(m.mode).toBe("hard");
    expect(m.result).toBe("win");
    expect(m.totalShots).toBe(moves.length);
    expect(m.hits).toBe(stats.hits);
    expect(m.totalShots - m.hits).toBe(stats.misses);
    expect(m.accuracy).toBeCloseTo(stats.accuracy, 10);
    expect(new Date(m.finishedAt).toISOString().slice(0, 10)).toBe(
      new Date().toISOString().slice(0, 10),
    );
    expect(m.durationSeconds).toBeGreaterThanOrEqual(120);
    // No Supabase client in tests -> local-only, no cloud sync attempted.
    expect(m.synced).toBe(false);

    // Profile aggregation over the same archive.
    const agg = localStats(archive);
    expect(agg.hard.wins).toBe(1);
    expect(agg.hard.losses).toBe(0);
    expect(agg.hard.shots).toBe(moves.length);
    expect(agg.hard.hits).toBe(stats.hits);
  });

  it("does not duplicate a match when the game_over effect re-fires (reload)", () => {
    const { moves } = playFullGame();
    const stats = computeDebrief(moves);
    const startedAt = Date.now() - 60_000;

    recordFinishedMatch("normal", "win", moves, stats, startedAt);
    // Page reload: component remounts, effect fires again for the same game.
    recordFinishedMatch("normal", "win", moves, stats, startedAt);

    const archive = loadLocalMatches();
    expect(archive).toHaveLength(1);
    expect(localStats(archive).normal.wins).toBe(1);
  });

  it("keeps separate games separate and aggregates both", () => {
    const first = playFullGame();
    const second = playFullGame();

    recordFinishedMatch(
      "easy",
      "win",
      first.moves,
      computeDebrief(first.moves),
      1_000,
    );
    recordFinishedMatch(
      "easy",
      "loss",
      second.moves,
      computeDebrief(second.moves),
      2_000,
    );

    const archive = loadLocalMatches();
    expect(archive).toHaveLength(2);
    const agg = localStats(archive);
    expect(agg.easy.wins).toBe(1);
    expect(agg.easy.losses).toBe(1);
    expect(agg.easy.shots).toBe(first.moves.length + second.moves.length);
  });

  it("returns null on the server (no window) without touching storage", () => {
    delete (globalThis as Record<string, unknown>).window;
    const moves: MoveRecord[] = [{ x: 0, y: 0, result: "miss" }];
    expect(recordFinishedMatch("easy", "loss", moves, computeDebrief(moves), 123)).toBeNull();
    expect(store.has("sonar.io/matches/v1")).toBe(false);
  });
});

describe("match archive: cloud sync", () => {
  const USER_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

  beforeEach(() => {
    store.clear();
    fakeSupabase.client = null;
    (globalThis as Record<string, unknown>).window = windowStub;
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).window;
  });

  const oneMoveGame = (): { moves: MoveRecord[]; stats: ReturnType<typeof computeDebrief> } => {
    const moves: MoveRecord[] = [{ x: 0, y: 0, result: "miss" }];
    return { moves, stats: computeDebrief(moves) };
  };

  it("authenticated: insert carries the session user id as player_id", async () => {
    enableFakeSupabase(USER_ID);
    const { moves, stats } = oneMoveGame();
    recordFinishedMatch("hard", "win", moves, stats, 777);

    await vi.waitFor(() => expect(fakeSupabase.inserts).toHaveLength(1));
    expect(fakeSupabase.fromTable).toBe("matches");
    expect(fakeSupabase.inserts[0].player_id).toBe(USER_ID);
    expect(fakeSupabase.inserts[0].mode).toBe("bot_hard");
    expect(fakeSupabase.inserts[0].result).toBe("win");

    await vi.waitFor(() => expect(loadLocalMatches()[0].synced).toBe(true));
  });

  it("unauthenticated: no insert, local record still works", async () => {
    enableFakeSupabase(null);
    const { moves, stats } = oneMoveGame();
    const recorded = recordFinishedMatch("easy", "loss", moves, stats, 888);
    expect(recorded).not.toBeNull();

    await flush();
    expect(fakeSupabase.inserts).toHaveLength(0);
    const archive = loadLocalMatches();
    expect(archive).toHaveLength(1);
    expect(archive[0].synced).toBe(false);
    expect(archive[0].result).toBe("loss");
  });

  it("cloud insert error: synced stays false and the local record survives", async () => {
    enableFakeSupabase(USER_ID, { message: "new row violates row-level security policy" });
    const { moves, stats } = oneMoveGame();
    const recorded = recordFinishedMatch("normal", "win", moves, stats, 999);
    expect(recorded).not.toBeNull();

    await vi.waitFor(() => expect(fakeSupabase.inserts).toHaveLength(1));
    await flush();
    const archive = loadLocalMatches();
    expect(archive).toHaveLength(1);
    expect(archive[0].synced).toBe(false);
    expect(archive[0].result).toBe("win");
    expect(archive[0].totalShots).toBe(moves.length);
  });
});
