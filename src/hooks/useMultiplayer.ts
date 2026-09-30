"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { generateFleet, type Fleet } from "../engine/board";
import type {
  Board,
  MoveRecord,
  ShotResult,
} from "../types/game";
import {
  createRandomRoom,
  ensureAnonymousUser,
  getRoomShots,
  getRoomState,
  joinRoomByCode,
  makeShot,
  submitFleet,
  type MultiplayerRoom,
  type MultiplayerShot,
} from "../lib/multiplayer";

const STORAGE_KEY = "sonar.io/multiplayer/v1";

interface PersistedState {
  roomId: string;
  roomCode: string;
  fleet: Fleet;
  fleetReady: boolean;
}

const emptyBoard = (): Board =>
  Array.from({ length: 10 }, () =>
    Array.from({ length: 10 }, () => "empty"),
  ) as Board;

const copyBoard = (board: Board): Board =>
  board.map((row) => [...row]) as Board;

const markConnectedSunk = (
  board: Board,
  startX: number,
  startY: number,
) => {
  const queue: Array<[number, number]> = [[startX, startY]];
  const seen = new Set<string>();

  while (queue.length) {
    const [x, y] = queue.shift()!;
    const key = `${x}:${y}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (x < 0 || x >= 10 || y < 0 || y >= 10) continue;

    const cell = board[y][x];
    if (cell !== "hit" && cell !== "sunk") continue;

    board[y][x] = "sunk";

    queue.push(
      [x - 1, y],
      [x + 1, y],
      [x, y - 1],
      [x, y + 1],
    );
  }
};

const applyPublicShot = (
  board: Board,
  x: number,
  y: number,
  result: ShotResult,
) => {
  board[y][x] = result;
  if (result === "sunk") {
    markConnectedSunk(board, x, y);
  }
};

const applyOpponentShotToOwnFleet = (
  board: Board,
  fleet: Fleet,
  shot: MultiplayerShot,
) => {
  if (shot.result === "miss") {
    board[shot.y][shot.x] = "miss";
    return;
  }

  if (shot.result === "hit") {
    board[shot.y][shot.x] = "hit";
    return;
  }

  const ship = fleet.ships.find((candidate) =>
    candidate.positions.some(
      (position) =>
        position.x === shot.x && position.y === shot.y,
    ),
  );

  if (!ship) {
    board[shot.y][shot.x] = "sunk";
    return;
  }

  for (const position of ship.positions) {
    board[position.y][position.x] = "sunk";
  }
};

const loadPersisted = (): PersistedState | null => {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw) as PersistedState;
    if (
      parsed?.roomId &&
      parsed?.roomCode &&
      parsed?.fleet?.board &&
      parsed?.fleet?.ships
    ) {
      return parsed;
    }
  } catch {
    // Ignore damaged local multiplayer state.
  }

  return null;
};

export function useMultiplayer() {
  const [authReady, setAuthReady] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);

  const [roomId, setRoomId] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState("");
  const [room, setRoom] = useState<MultiplayerRoom | null>(null);
  const [shots, setShots] = useState<MultiplayerShot[]>([]);

  const [fleet, setFleet] = useState<Fleet>(() => generateFleet());
  const [fleetReady, setFleetReady] = useState(false);

  const [joinCode, setJoinCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const user = await ensureAnonymousUser();
        if (cancelled) return;

        setUserId(user.id);

        const saved = loadPersisted();
        if (saved) {
          setRoomId(saved.roomId);
          setRoomCode(saved.roomCode);
          setFleet(saved.fleet);
          setFleetReady(saved.fleetReady);
        }

        const urlCode = new URLSearchParams(
          window.location.search,
        ).get("room");

        if (urlCode) {
          setJoinCode(urlCode.toUpperCase());
        }
      } catch (cause) {
        if (!cancelled) {
          setError(
            cause instanceof Error
              ? cause.message
              : "Could not authenticate.",
          );
        }
      } finally {
        if (!cancelled) setAuthReady(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!roomId || !roomCode) return;

    const persisted: PersistedState = {
      roomId,
      roomCode,
      fleet,
      fleetReady,
    };

    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify(persisted),
      );
    } catch {
      // Multiplayer continues even if storage is unavailable.
    }
  }, [roomId, roomCode, fleet, fleetReady]);

  const refresh = useCallback(async () => {
    if (!roomId) return;

    try {
      const currentUser = await ensureAnonymousUser();
      setUserId(currentUser.id);

      const [nextRoom, nextShots] = await Promise.all([
        getRoomState(roomId),
        getRoomShots(roomId),
      ]);

      setRoom(nextRoom);
      setShots(nextShots);
      setError(null);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not refresh room.",
      );
    }
  }, [roomId]);

  useEffect(() => {
    if (!roomId || !authReady) return;

    const initialRefresh = window.setTimeout(() => {
      void refresh();
    }, 0);

    const timer = window.setInterval(() => {
      void refresh();
    }, 1000);

    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(timer);
    };
  }, [roomId, authReady, refresh]);

  const createRoom = useCallback(async () => {
    if (!authReady || !userId) return;

    setBusy(true);
    setError(null);

    try {
      const created = await createRandomRoom();
      const nextFleet = generateFleet();

      setRoomId(created.id);
      setRoomCode(created.code);
      setRoom(null);
      setShots([]);
      setFleet(nextFleet);
      setFleetReady(false);

      const nextRoom = await getRoomState(created.id);
      setRoom(nextRoom);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not create room.",
      );
    } finally {
      setBusy(false);
    }
  }, [authReady, userId]);

  const joinRoom = useCallback(async () => {
    if (!authReady || !userId || !joinCode.trim()) return;

    setBusy(true);
    setError(null);

    try {
      const normalized = joinCode.trim().toUpperCase();
      const id = await joinRoomByCode(normalized);
      const nextFleet = generateFleet();

      setRoomId(id);
      setRoomCode(normalized);
      setFleet(nextFleet);
      setFleetReady(false);
      setShots([]);

      const nextRoom = await getRoomState(id);
      setRoom(nextRoom);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not join room.",
      );
    } finally {
      setBusy(false);
    }
  }, [authReady, userId, joinCode]);

  const randomize = useCallback(() => {
    if (fleetReady || room?.status === "playing") return;
    setFleet(generateFleet());
  }, [fleetReady, room?.status]);

  const ready = useCallback(async () => {
    if (!roomId || !room || !userId || fleetReady) return;

    const isHost = room.host_id === userId;
    const isGuest = room.guest_id === userId;

    if (!isHost && !isGuest) {
      setError("You are not a participant in this room.");
      return;
    }

    setBusy(true);
    setError(null);

    try {
      await submitFleet(roomId, isHost, fleet);
      setFleetReady(true);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not lock fleet.",
      );
    } finally {
      setBusy(false);
    }
  }, [
    roomId,
    room,
    userId,
    fleetReady,
    fleet,
    refresh,
  ]);

  const myShots = useMemo(
    () =>
      userId
        ? shots.filter((shot) => shot.shooter === userId)
        : [],
    [shots, userId],
  );

  const opponentShots = useMemo(
    () =>
      userId
        ? shots.filter((shot) => shot.shooter !== userId)
        : [],
    [shots, userId],
  );

  const enemyBoard = useMemo(() => {
    const board = emptyBoard();

    for (const shot of myShots) {
      applyPublicShot(
        board,
        shot.x,
        shot.y,
        shot.result,
      );
    }

    return board;
  }, [myShots]);

  const ownBoard = useMemo(() => {
    const board = copyBoard(fleet.board);

    for (const shot of opponentShots) {
      applyOpponentShotToOwnFleet(board, fleet, shot);
    }

    return board;
  }, [fleet, opponentShots]);

  const fire = useCallback(
    async (x: number, y: number) => {
      if (
        !roomId ||
        !room ||
        !userId ||
        room.status !== "playing" ||
        room.turn_player !== userId ||
        busy
      ) {
        return;
      }

      const alreadyShot = myShots.some(
        (shot) => shot.x === x && shot.y === y,
      );
      if (alreadyShot) return;

      setBusy(true);
      setError(null);

      try {
        await makeShot(roomId, x, y);
        await refresh();
      } catch (cause) {
        setError(
          cause instanceof Error
            ? cause.message
            : "Shot failed.",
        );
      } finally {
        setBusy(false);
      }
    },
    [roomId, room, userId, busy, myShots, refresh],
  );

  const leave = useCallback(() => {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Ignore.
    }

    setRoomId(null);
    setRoomCode("");
    setRoom(null);
    setShots([]);
    setFleet(generateFleet());
    setFleetReady(false);
    setJoinCode("");
    setError(null);
  }, []);

  const copyInvite = useCallback(async () => {
    if (!roomCode) return;

    const url =
      `${window.location.origin}/multiplayer?room=` +
      encodeURIComponent(roomCode);

    await navigator.clipboard.writeText(url);
  }, [roomCode]);

  const isHost = Boolean(
    room && userId && room.host_id === userId,
  );

  const role =
    room && userId
      ? room.host_id === userId
        ? "Host"
        : room.guest_id === userId
          ? "Guest"
          : "Syncing"
      : null;

  const myTurn = Boolean(
    room &&
      userId &&
      room.status === "playing" &&
      room.turn_player === userId,
  );

  const winner =
    room?.status === "finished"
      ? room.winner === userId
        ? "player"
        : room.winner
          ? "enemy"
          : null
      : null;

  const moves: MoveRecord[] = myShots.map((shot) => ({
    x: shot.x,
    y: shot.y,
    result: shot.result,
  }));

  return {
    authReady,
    userId,
    room,
    roomCode,
    joinCode,
    setJoinCode,
    busy,
    error,
    fleet,
    fleetReady,
    ownBoard,
    enemyBoard,
    moves,
    isHost,
    role,
    myTurn,
    winner,
    createRoom,
    joinRoom,
    randomize,
    ready,
    fire,
    leave,
    copyInvite,
    refresh,
  };
}