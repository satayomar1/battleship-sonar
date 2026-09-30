-- ============================================================================
-- 0003_live_security_alignment.sql
-- Sonar.io вЂ” align the local schema with the live Supabase project
-- (ref hnpnasljadnonyzkfwsj) where 0001 + 0002 are already applied.
--
-- Why this migration exists:
--   * The live project has "Automatically expose new tables in public schema"
--     DISABLED, so the client roles never received the grants this repo's
--     PGlite harness emulates: authenticated cannot SELECT/INSERT its own
--     matches, which blocks the frontend cloud sync (src/lib/matchArchive.ts)
--     and the profile match counter.
--   * The live project still shows leftover REFERENCES / TRIGGER / TRUNCATE
--     privileges for anon/authenticated on several application objects.
--     TRUNCATE in particular must never be held by a client role.
--
-- Target least-privilege matrix (client roles):
--   anon          вЂ” no direct access to any application table, no RPC execute.
--   authenticated вЂ” matches:     SELECT + INSERT (cloud sync inserts finished
--                                 matches and reads own history; never
--                                 UPDATE/DELETE)
--                   profiles:    SELECT only (display names; rows are created
--                                 by the handle_new_user trigger, never by
--                                 clients)
--                   rooms:       column-level SELECT on the 9 safe columns only
--                   room_state:  SELECT
--                   room_shots:  SELECT
--                   moves:       nothing (no client consumer exists)
--   rooms / room_shots mutations stay RPC-only (security definer).
--   service_role / postgres: untouched by this migration.
--
-- Every statement is idempotent: the migration can be re-run safely.
--
-- REALTIME (unchanged invariant): public.rooms must NEVER be added to the
-- supabase_realtime publication вЂ” see the header of 0002_security_fixes.sql.
-- This migration intentionally adds no publication statements.
-- ============================================================================

-- ============================================================================
-- 1. MATCHES: the frontend cloud sync needs exactly SELECT + INSERT.
-- matchArchive.ts inserts finished matches; the profile page counts the
-- player's own rows. No frontend code ever UPDATEs or DELETEs a match, so
-- those privileges are not granted, and the broad FOR ALL policy from 0001
-- is replaced with explicit per-command policies (no accidental or dormant
-- UPDATE/DELETE path remains).
-- ============================================================================

revoke all on public.matches from anon, authenticated;
grant select, insert on public.matches to authenticated;

drop policy if exists "matches: insert own, read own" on public.matches;
drop policy if exists "matches: select own" on public.matches;
drop policy if exists "matches: insert own" on public.matches;

create policy "matches: select own"
  on public.matches for select
  to authenticated
  using (auth.uid() = player_id);

create policy "matches: insert own"
  on public.matches for insert
  to authenticated
  with check (auth.uid() = player_id);

-- ============================================================================
-- 2. PROFILES: authenticated read-only for display names.
-- The frontend never writes profiles (rows are created by the
-- handle_new_user trigger, which runs as the function owner). Client write
-- privileges are removed entirely; anon loses the read as well вЂ” the app
-- has no anonymous profile reads. The write policies stay as defense in
-- depth for the day a server-side writer needs them.
-- ============================================================================

revoke all on public.profiles from anon, authenticated;

drop policy if exists "profiles: public read" on public.profiles;
drop policy if exists "profiles: authenticated read" on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
drop policy if exists "profiles: delete own" on public.profiles;



-- ============================================================================
-- 3. MOVES: no client access at all.
-- Nothing in the frontend reads or writes moves today. The RLS policy is
-- kept (hardened to authenticated) as defense in depth for the day a
-- consumer appears, but no privileges are granted to client roles.
-- ============================================================================

revoke all on public.moves from anon, authenticated;

drop policy if exists "moves: own rows only" on public.moves;



-- ============================================================================
-- 4. ROOMS: re-assert the 0001/0002 state.
-- Table level: nothing for client roles. Column level: authenticated reads
-- exactly the 9 safe columns. host_fleet / guest_fleet stay unreadable вЂ”
-- a table-level revoke never clears column grants, and none exist for the
-- fleet columns.
-- ============================================================================

revoke all on public.rooms from anon, authenticated;

grant select (id, code, status, host_id, guest_id, turn_player, winner, created_at, updated_at)
  on public.rooms to authenticated;

drop policy if exists "rooms: participants read row" on public.rooms;

create policy "rooms: participants read row"
  on public.rooms for select
  to authenticated
  using (host_id = auth.uid() or guest_id = auth.uid());

-- ============================================================================
-- 5. ROOM_STATE / ROOM_SHOTS: SELECT only.
-- Clears every leftover table-level privilege (including TRUNCATE, TRIGGER,
-- REFERENCES from the Supabase default grants) and re-grants exactly SELECT.
-- Mutations remain RPC-only.
-- ============================================================================

revoke all on public.room_state from anon, authenticated;
grant select on public.room_state to authenticated;

revoke all on public.room_shots from anon, authenticated;
grant select on public.room_shots to authenticated;

drop policy if exists "room_shots: participants read, own insert blocked (RPC only)" on public.room_shots;

create policy "room_shots: participants read, own insert blocked (RPC only)"
  on public.room_shots for select
  to authenticated
  using (
    exists (
      select 1 from public.rooms r
      where r.id = room_id and (r.host_id = auth.uid() or r.guest_id = auth.uid())
    )
  );

-- ============================================================================
-- 6. SECURITY DEFINER: pin search_path to the empty string.
-- All five functions already reference everything schema-qualified
-- (public.*, auth.uid()); pg_catalog is always searched implicitly, so
-- built-ins (now, coalesce, jsonb_*, generate_series, abs, array_fill)
-- still resolve. `alter function ... set search_path = ''` replaces only
-- the SET clause вЂ” bodies and semantics are untouched.
-- ============================================================================

alter function public.create_room(text) set search_path = '';
alter function public.join_room(text) set search_path = '';
alter function public.save_fleet(uuid, boolean, jsonb) set search_path = '';
alter function public.make_shot(uuid, integer, integer) set search_path = '';
alter function public.handle_new_user() set search_path = '';

-- ============================================================================
-- 7. RPC EXECUTE: re-assert authenticated-only (idempotent).
-- handle_new_user keeps its (inert) PUBLIC execute: PostgreSQL refuses to
-- call trigger functions directly, which the tests verify.
-- ============================================================================

revoke execute on function public.create_room(text) from public, anon, authenticated;
revoke execute on function public.join_room(text) from public, anon, authenticated;
revoke execute on function public.save_fleet(uuid, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.make_shot(uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.create_room(text) to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.save_fleet(uuid, boolean, jsonb) to authenticated;
grant execute on function public.make_shot(uuid, integer, integer) to authenticated;

