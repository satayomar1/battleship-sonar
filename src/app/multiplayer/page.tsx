"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import Battlefield from "../../components/Battlefield";
import TacticalDebrief from "../../components/TacticalDebrief";
import { computeDebrief } from "../../engine/debrief";
import { useMultiplayer } from "../../hooks/useMultiplayer";

export default function MultiplayerPage() {
  const game = useMultiplayer();
  const [copied, setCopied] = useState(false);

  const debrief = useMemo(
    () => computeDebrief(game.moves),
    [game.moves],
  );

  const copyInvite = async () => {
    try {
      await game.copyInvite();
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable.
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center gap-6 px-4 py-8 sm:py-12">
      <header className="text-center">
        <Link href="/" className="text-xs text-muted hover:text-sonar">
          ← Single Player
        </Link>

        <h1 className="mt-2 text-3xl font-bold uppercase tracking-[0.25em] text-sonar sm:text-4xl">
          Sonar<span className="text-ink">.io</span>
        </h1>

        <p className="mt-2 text-sm text-muted">
          Multiplayer · Private Room
        </p>
      </header>

      {!game.authReady && (
        <div className="glass rounded-2xl p-6 text-sm text-muted">
          Establishing secure session…
        </div>
      )}

      {game.error && (
        <div
          className="w-full max-w-lg rounded-xl border border-coral/40 bg-coral/10 p-3 text-sm text-coral"
          role="alert"
        >
          {game.error}
        </div>
      )}

      {game.authReady && !game.room && (
        <section className="grid w-full max-w-2xl gap-4 sm:grid-cols-2">
          <div className="glass flex flex-col gap-4 rounded-2xl p-5">
            <div>
              <h2 className="text-lg font-bold text-ink">
                Create Room
              </h2>
              <p className="mt-1 text-sm text-muted">
                Generate a private code and invite another captain.
              </p>
            </div>

            <button
              type="button"
              className="btn btn-primary mt-auto"
              onClick={game.createRoom}
              disabled={game.busy}
            >
              {game.busy ? "Creating…" : "Create Room"}
            </button>
          </div>

          <div className="glass flex flex-col gap-4 rounded-2xl p-5">
            <div>
              <h2 className="text-lg font-bold text-ink">
                Join Room
              </h2>
              <p className="mt-1 text-sm text-muted">
                Enter the 4–6 character room code.
              </p>
            </div>

            <input
              value={game.joinCode}
              onChange={(event) =>
                game.setJoinCode(
                  event.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, "")
                    .slice(0, 6),
                )
              }
              className="glass rounded-xl border border-white/10 px-4 py-3 font-mono text-lg uppercase tracking-[0.2em] text-ink outline-none focus:border-sonar/60"
              placeholder="ABC123"
              maxLength={6}
              aria-label="Room code"
            />

            <button
              type="button"
              className="btn btn-ghost"
              onClick={game.joinRoom}
              disabled={
                game.busy ||
                game.joinCode.trim().length < 4
              }
            >
              {game.busy ? "Joining…" : "Join Room"}
            </button>
          </div>
        </section>
      )}

      {game.room && (
        <section className="flex w-full max-w-4xl flex-col items-center gap-5">
          <div className="glass flex w-full flex-wrap items-center justify-between gap-3 rounded-2xl p-4">
            <div>
              <div className="text-xs uppercase tracking-wider text-muted">
                Room
              </div>
              <div className="font-mono text-xl font-bold tracking-[0.2em] text-sonar">
                {game.roomCode}
              </div>
            </div>

            <div className="text-right text-xs text-muted">
              <div>
                {game.role ?? "Connecting…"}
              </div>
              <div className="uppercase">
                {game.room.status}
              </div>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={copyInvite}
              >
                {copied ? "Copied ✓" : "Copy Invite"}
              </button>

              <button
                type="button"
                className="btn btn-ghost"
                onClick={game.leave}
              >
                Leave
              </button>
            </div>
          </div>

          {(game.room.status === "waiting" ||
            game.room.status === "placement") && (
            <>
              <Battlefield
                title="Your Fleet"
                board={game.ownBoard}
                label="Your fleet placement"
              />

              {!game.fleetReady ? (
                <div className="flex flex-wrap justify-center gap-3">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={game.randomize}
                    disabled={game.busy}
                  >
                    Randomize
                  </button>

                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={game.ready}
                    disabled={game.busy}
                  >
                    {game.busy ? "Locking…" : "Fleet Ready"}
                  </button>
                </div>
              ) : (
                <div
                  className="glass rounded-xl px-5 py-3 text-center text-sm text-kelp"
                  role="status"
                >
                  Fleet locked. Waiting for the other captain…
                </div>
              )}

              {game.room.status === "waiting" && (
                <p className="text-center text-sm text-muted">
                  Share room code {game.roomCode} or use Copy Invite.
                </p>
              )}
            </>
          )}

          {game.room.status === "playing" && (
            <>
              <div
                className={`glass rounded-full px-5 py-2 font-mono text-sm font-bold tracking-widest ${
                  game.myTurn
                    ? "text-kelp"
                    : "text-coral"
                }`}
                role="status"
                aria-live="polite"
              >
                {game.myTurn
                  ? "▶ YOUR TURN"
                  : "… OPPONENT TURN"}
              </div>

              <div className="flex flex-col items-center justify-center gap-6 lg:flex-row lg:gap-12">
                <Battlefield
                  title="Enemy Waters"
                  board={game.enemyBoard}
                  onCellClick={game.fire}
                  disabled={!game.myTurn || game.busy}
                  label="Enemy board"
                />

                <Battlefield
                  title="Your Fleet"
                  board={game.ownBoard}
                  label="Your board"
                />
              </div>
            </>
          )}

          {game.room.status === "finished" && (
            <>
              <div className="glass w-full max-w-xl rounded-2xl p-6 text-center">
                <h2
                  className={`text-3xl font-bold uppercase tracking-widest ${
                    game.winner === "player"
                      ? "text-kelp"
                      : "text-coral"
                  }`}
                >
                  {game.winner === "player"
                    ? "Victory"
                    : "Defeat"}
                </h2>

                <p className="mt-2 text-sm text-muted">
                  Multiplayer battle complete.
                </p>

                <button
                  type="button"
                  className="btn btn-primary mt-5"
                  onClick={game.leave}
                >
                  Back to Lobby
                </button>
              </div>

              <TacticalDebrief
                stats={debrief}
                moves={game.moves}
              />
            </>
          )}
        </section>
      )}
    </main>
  );
}