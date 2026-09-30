"use client";

import type { User } from "@supabase/supabase-js";
import { getSupabaseBrowserClient } from "./supabase/client";
import type { Fleet } from "../engine/board";
import type { ShotResult } from "../types/game";

export type RoomStatus = "waiting" | "placement" | "playing" | "finished";

export interface MultiplayerRoom {
  id: string;
  code: string;
  status: RoomStatus;
  host_id: string;
  guest_id: string | null;
  turn_player: string | null;
  winner: string | null;
  created_at: string;
  updated_at: string;
}

export interface MultiplayerShot {
  shooter: string;
  x: number;
  y: number;
  result: ShotResult;
}

function client() {
  const supabase = getSupabaseBrowserClient();
  if (!supabase) {
    throw new Error("Supabase is not configured.");
  }
  return supabase;
}

let anonymousUserPromise: Promise<User> | null = null;

export async function ensureAnonymousUser(): Promise<User> {
  if (anonymousUserPromise) {
    return anonymousUserPromise;
  }

  anonymousUserPromise = (async () => {
    const supabase = client();

    const {
      data: { session },
      error: sessionError,
    } = await supabase.auth.getSession();

    if (sessionError) throw sessionError;
    if (session?.user) return session.user;

    const { data, error } = await supabase.auth.signInAnonymously();

    if (error) throw error;
    if (!data.user) {
      throw new Error("Anonymous sign-in returned no user.");
    }

    return data.user;
  })();

  try {
    return await anonymousUserPromise;
  } finally {
    anonymousUserPromise = null;
  }
}

export function makeRoomCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

export async function createRandomRoom(): Promise<{
  id: string;
  code: string;
}> {
  const supabase = client();

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = makeRoomCode();

    const { data, error } = await supabase.rpc("create_room", {
      p_code: code,
    });

    if (!error && data) {
      return { id: String(data), code };
    }

    if (!error?.message.toLowerCase().includes("taken")) {
      throw error ?? new Error("Could not create room.");
    }
  }

  throw new Error("Could not generate a free room code.");
}

export async function joinRoomByCode(code: string): Promise<string> {
  const supabase = client();
  const normalized = code.trim().toUpperCase();

  const { data, error } = await supabase.rpc("join_room", {
    p_code: normalized,
  });

  if (error) throw error;
  if (!data) throw new Error("Room was not found.");

  return String(data);
}

export async function getRoomState(
  roomId: string,
): Promise<MultiplayerRoom> {
  const supabase = client();

  const { data, error } = await supabase
    .from("room_state")
    .select(
      "id,code,status,host_id,guest_id,turn_player,winner,created_at,updated_at",
    )
    .eq("id", roomId)
    .single();

  if (error) throw error;
  return data as MultiplayerRoom;
}

export async function getRoomShots(
  roomId: string,
): Promise<MultiplayerShot[]> {
  const supabase = client();

  const { data, error } = await supabase
    .from("room_shots")
    .select("shooter,x,y,result")
    .eq("room_id", roomId);

  if (error) throw error;
  return (data ?? []) as MultiplayerShot[];
}

export async function submitFleet(
  roomId: string,
  isHost: boolean,
  fleet: Fleet,
): Promise<void> {
  const supabase = client();

  const { error } = await supabase.rpc("save_fleet", {
    p_room_id: roomId,
    p_host: isHost,
    p_fleet: fleet,
  });

  if (error) throw error;
}

export async function makeShot(
  roomId: string,
  x: number,
  y: number,
): Promise<ShotResult> {
  const supabase = client();

  const { data, error } = await supabase.rpc("make_shot", {
    p_room_id: roomId,
    p_x: x,
    p_y: y,
  });

  if (error) throw error;

  if (data !== "miss" && data !== "hit" && data !== "sunk") {
    throw new Error("Unexpected shot result.");
  }

  return data;
}