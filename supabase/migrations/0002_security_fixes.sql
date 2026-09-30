-- ============================================================================
-- 0002_security_fixes.sql
-- Sonar.io — security fixes from the Gate 4.5 audit. Applies on top of
-- 0001_init.sql. Every statement is idempotent: the migration can be re-run.
--
-- REALTIME SAFETY (read before enabling realtime for multiplayer):
-- public.rooms must NEVER be added to the supabase_realtime publication
-- (Postgres Changes). RLS filters rows, not columns: participants hold SELECT
-- access to the room row, so a Postgres Changes payload would contain the
-- entire row — including host_fleet / guest_fleet — and leak the opponent's
-- hidden fleet. For multiplayer use private channels (Realtime Authorization)
-- with Broadcast as a notification-only transport, or a Postgres Changes
-- stream on public.room_shots (safe columns only). Authoritative state is
-- always re-read from the server; realtime payloads are never trusted.
-- ============================================================================

-- ============================================================================
-- 1. PROFILES: split the over-broad policy.
-- The old single "for all using (true)" policy let any authenticated user
-- DELETE any profile: DELETE checks USING only (WITH CHECK never applies to
-- DELETE), and using (true) passed for everyone. Deletion cascaded into the
-- victim's matches/moves. Public read stays: display names are public data
-- for multiplayer.
-- ============================================================================

drop policy if exists "profiles: read all, update own" on public.profiles;
drop policy if exists "profiles: public read" on public.profiles;
drop policy if exists "profiles: insert own" on public.profiles;
drop policy if exists "profiles: update own" on public.profiles;
drop policy if exists "profiles: delete own" on public.profiles;

create policy "profiles: public read"
  on public.profiles for select
  using (true);

create policy "profiles: insert own"
  on public.profiles for insert
  with check (auth.uid() = id);

create policy "profiles: update own"
  on public.profiles for update
  using (auth.uid() = id)
  with check (auth.uid() = id);

create policy "profiles: delete own"
  on public.profiles for delete
  using (auth.uid() = id);

-- ============================================================================
-- 2. ROOMS / ROOM_STATE / ROOM_SHOTS: minimal column-level privileges.
-- Fleet columns (host_fleet, guest_fleet) stay unreadable by client roles:
-- any client SELECT that touches them fails with permission denied BEFORE
-- row level security is even evaluated.
-- ============================================================================

-- Safe fields only — explicitly excludes host_fleet and guest_fleet.
grant select (id, code, status, host_id, guest_id, turn_player, winner, created_at, updated_at)
  on public.rooms to authenticated;

-- The safe view from 0001 (security_invoker, no fleet columns) becomes
-- readable: the invoker now holds column-level SELECT on exactly the
-- columns the view reads, and RLS still filters rows to participants.
-- anon loses the view grant Supabase default privileges would have given
-- it (defense in depth: anon has no rooms column privileges either way).
grant select on public.room_state to authenticated;
revoke all on public.room_state from anon;

-- Shot history: read-only for clients. Writes happen exclusively through the
-- security definer RPC make_shot; direct client inserts are revoked.
grant select on public.room_shots to authenticated;
revoke insert, update, delete on public.room_shots from anon, authenticated;
revoke all on public.room_shots from anon;

-- ============================================================================
-- 3. JOIN_ROOM: only open rooms can be joined; reconnects are side-effect
-- free. The 0001 version reset status to 'placement' when an already-joined
-- guest "re-joined" mid-game, bricking the match.
-- ============================================================================

create or replace function public.join_room(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  -- Lock the row: two concurrent joins are serialized, the loser re-reads
  -- the committed winner's row and is rejected below.
  select * into v_room from public.rooms where code = p_code for update;
  if v_room is null then
    raise exception 'room not found';
  end if;

  -- Host or already-joined guest reconnecting: return the room unchanged,
  -- regardless of status.
  if v_room.host_id = auth.uid() then
    return v_room.id;
  end if;
  if v_room.guest_id = auth.uid() then
    return v_room.id;
  end if;

  -- A new guest can only join a room that is still open.
  if v_room.status <> 'waiting' then
    raise exception 'room is not open for joining';
  end if;
  if v_room.guest_id is not null then
    raise exception 'room is full';
  end if;

  update public.rooms
  set guest_id = auth.uid(), status = 'placement', updated_at = now()
  where id = v_room.id;
  return v_room.id;
end;
$$;

-- ============================================================================
-- 4. SAVE_FLEET: server-authoritative validation, pre-battle only.
-- Never trusts client input: the whole fleet is validated against the game
-- rules (10x10 board, exact fleet composition 1x4 + 2x3 + 3x2 + 4x1, straight
-- consecutive ships, no overlap, no touching even diagonally, board and ships
-- consistent). Saving after the battle started is rejected.
-- ============================================================================

create or replace function public.save_fleet(p_room_id uuid, p_host boolean, p_fleet jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_board jsonb;
  v_ships jsonb;
  v_y int;
  v_x int;
  v_ship_count_by_size int[];
  v_ship jsonb;
  v_distinct_x int;
  v_distinct_y int;
  v_min_x int;
  v_max_x int;
  v_min_y int;
  v_max_y int;
  v_board_ship_cells int := 0;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;

  select * into v_room from public.rooms where id = p_room_id for update;
  if v_room is null then
    raise exception 'room not found';
  end if;

  if p_host and v_room.host_id <> auth.uid() then
    raise exception 'not host';
  end if;
  if not p_host and (v_room.guest_id is null or v_room.guest_id <> auth.uid()) then
    raise exception 'not guest';
  end if;

  -- Fleets are immutable once the battle has started (blocks mid-game
  -- reshuffling / hit-clearing cheats).
  if v_room.status not in ('waiting', 'placement') then
    raise exception 'fleet cannot be saved after the battle has started';
  end if;

  if p_fleet is null or jsonb_typeof(p_fleet) <> 'object'
    or not (p_fleet ? 'board') or not (p_fleet ? 'ships') then
    raise exception 'invalid fleet: expected an object with board and ships';
  end if;

  v_board := p_fleet->'board';
  v_ships := p_fleet->'ships';

  -- Board: strictly 10x10, only untouched cell states.
  if v_board is null or jsonb_typeof(v_board) <> 'array' or jsonb_array_length(v_board) <> 10 then
    raise exception 'invalid fleet: board must be a 10x10 array';
  end if;
  for v_y in 0..9 loop
    if v_board->v_y is null or jsonb_typeof(v_board->v_y) <> 'array'
      or jsonb_array_length(v_board->v_y) <> 10 then
      raise exception 'invalid fleet: board row % must have 10 cells', v_y;
    end if;
    for v_x in 0..9 loop
      if coalesce(v_board->v_y->v_x #>> '{}', '') not in ('empty', 'ship') then
        raise exception 'invalid fleet: board cell (%,%) must be empty or ship', v_x, v_y;
      end if;
      if (v_board->v_y->v_x #>> '{}') = 'ship' then
        v_board_ship_cells := v_board_ship_cells + 1;
      end if;
    end loop;
  end loop;

  if v_board_ship_cells <> 20 then
    raise exception 'invalid fleet: expected exactly 20 ship cells, got %', v_board_ship_cells;
  end if;

  -- Ships: exactly 10 with the mandatory composition checked afterwards.
  if v_ships is null or jsonb_typeof(v_ships) <> 'array' or jsonb_array_length(v_ships) <> 10 then
    raise exception 'invalid fleet: ships must contain exactly 10 ships';
  end if;

  v_ship_count_by_size := array_fill(0, array[4]); -- indexes 1..4
  for v_ship in select * from jsonb_array_elements(v_ships) loop
    if v_ship->>'size' is null or v_ship->>'size' !~ '^[1-4]$' then
      raise exception 'invalid fleet: ship size must be an integer 1..4';
    end if;
    v_ship_count_by_size[(v_ship->>'size')::int] := v_ship_count_by_size[(v_ship->>'size')::int] + 1;

    if v_ship->>'id' is null then
      raise exception 'invalid fleet: ship id is required';
    end if;
    if coalesce(v_ship->>'hits', '') !~ '^[0-9]+$' or (v_ship->>'hits')::int <> 0 then
      raise exception 'invalid fleet: ship hits must be 0 before the battle';
    end if;
    if coalesce(v_ship->>'isSunk', 'false') <> 'false' then
      raise exception 'invalid fleet: ships must not be sunk before the battle';
    end if;

    if v_ship->'positions' is null
      or jsonb_typeof(v_ship->'positions') <> 'array'
      or jsonb_array_length(v_ship->'positions') <> (v_ship->>'size')::int then
      raise exception 'invalid fleet: ship % must have exactly % positions', v_ship->>'id', v_ship->>'size';
    end if;

    if exists (
      select 1 from jsonb_array_elements(v_ship->'positions') p
      where jsonb_typeof(p) <> 'object'
         or p->>'x' is null or p->>'y' is null
         or p->>'x' !~ '^[0-9]$' or p->>'y' !~ '^[0-9]$'
    ) then
      raise exception 'invalid fleet: ship % has invalid position coordinates', v_ship->>'id';
    end if;

    select count(distinct (p->>'x')::int),
           count(distinct (p->>'y')::int),
           min((p->>'x')::int),
           max((p->>'x')::int),
           min((p->>'y')::int),
           max((p->>'y')::int)
      into v_distinct_x, v_distinct_y, v_min_x, v_max_x, v_min_y, v_max_y
      from jsonb_array_elements(v_ship->'positions') as p;

    if v_min_x is null or v_min_x < 0 or v_max_x > 9
      or v_min_y is null or v_min_y < 0 or v_max_y > 9 then
      raise exception 'invalid fleet: ship % has coordinates outside the board', v_ship->>'id';
    end if;

    -- Straight line: all positions share one row or one column.
    if v_distinct_x > 1 and v_distinct_y > 1 then
      raise exception 'invalid fleet: ship % is not a straight line', v_ship->>'id';
    end if;

    -- Consecutive: the bounding-box length must equal the ship size.
    if (v_max_x - v_min_x) + (v_max_y - v_min_y) + 1 <> (v_ship->>'size')::int then
      raise exception 'invalid fleet: ship % is not a consecutive line', v_ship->>'id';
    end if;
  end loop;

  if v_ship_count_by_size[4] <> 1
    or v_ship_count_by_size[3] <> 2
    or v_ship_count_by_size[2] <> 3
    or v_ship_count_by_size[1] <> 4 then
    raise exception 'invalid fleet: fleet composition must be 1x size 4, 2x size 3, 3x size 2, 4x size 1';
  end if;

  -- No overlaps anywhere in the fleet (same coordinate used twice).
  if exists (
    select 1
    from jsonb_array_elements(v_ships) s,
         jsonb_array_elements(s->'positions') p
    group by (p->>'x')::int, (p->>'y')::int
    having count(*) > 1
  ) then
    raise exception 'invalid fleet: ships overlap';
  end if;

  -- Every ship position must sit on a ship cell of the board.
  if exists (
    select 1
    from jsonb_array_elements(v_ships) s,
         jsonb_array_elements(s->'positions') p
    where coalesce(v_board->((p->>'y')::int)->((p->>'x')::int) #>> '{}', '') <> 'ship'
  ) then
    raise exception 'invalid fleet: ship positions do not match the board';
  end if;

  -- Every board ship cell must be covered by a ship position.
  if exists (
    select 1
    from generate_series(0, 9) as gy, generate_series(0, 9) as gx
    where (v_board->gy->gx #>> '{}') = 'ship'
      and not exists (
        select 1
        from jsonb_array_elements(v_ships) s,
             jsonb_array_elements(s->'positions') p
        where (p->>'x')::int = gx and (p->>'y')::int = gy
      )
  ) then
    raise exception 'invalid fleet: board ship cells are not covered by ships';
  end if;

  -- Ships must not touch each other, not even diagonally.
  if exists (
    select 1
    from jsonb_array_elements(v_ships) with ordinality as a(sa, ia),
         jsonb_array_elements(a.sa->'positions') as pa(p),
         jsonb_array_elements(v_ships) with ordinality as b(sb, ib),
         jsonb_array_elements(b.sb->'positions') as pb(p)
    where a.ia <> b.ib
      and abs((pa.p->>'x')::int - (pb.p->>'x')::int) <= 1
      and abs((pa.p->>'y')::int - (pb.p->>'y')::int) <= 1
  ) then
    raise exception 'invalid fleet: ships must not touch, even diagonally';
  end if;

  -- All checks passed: persist the fleet.
  if p_host then
    update public.rooms set host_fleet = p_fleet, updated_at = now() where id = p_room_id;
  else
    update public.rooms set guest_fleet = p_fleet, updated_at = now() where id = p_room_id;
  end if;

  -- Both fleets saved -> start the match, host moves first.
  if p_host and v_room.guest_fleet is not null then
    update public.rooms set status = 'playing', turn_player = v_room.host_id, updated_at = now()
    where id = p_room_id;
  elsif not p_host and v_room.host_fleet is not null then
    update public.rooms set status = 'playing', turn_player = v_room.host_id, updated_at = now()
    where id = p_room_id;
  end if;
end;
$$;

-- ============================================================================
-- 5. CREATE_ROOM: server-side room code validation.
-- Codes: 4-6 characters, uppercase A-Z or digits 0-9. Collisions with
-- another host's code raise a clear error instead of returning null.
-- ============================================================================

create or replace function public.create_room(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null then
    raise exception 'not authenticated';
  end if;
  if p_code is null or p_code !~ '^[A-Z0-9]{4,6}$' then
    raise exception 'invalid room code: use 4-6 characters A-Z or 0-9';
  end if;

  insert into public.rooms (code, host_id, turn_player)
  values (p_code, auth.uid(), auth.uid())
  on conflict (code) do nothing
  returning id into v_id;

  if v_id is null then
    -- Idempotent re-create by the same host, or a collision with another host.
    select id into v_id from public.rooms where code = p_code and host_id = auth.uid();
    if v_id is null then
      raise exception 'room code already taken';
    end if;
  end if;
  return v_id;
end;
$$;

-- ============================================================================
-- 6. MAKE_SHOT: fix jsonb navigation.
-- 0001 indexed the fleet object as if it were the board array
-- (v_fleet->y->x). The `jsonb -> text` operator is an object-KEY lookup and
-- returns NULL when the left side is not an object, so every shot raised
-- 'bad coordinates'. The stored fleet is {board, ships}; navigate through
-- the 'board' key with integer operators. Game logic is otherwise unchanged.
-- ============================================================================

create or replace function public.make_shot(p_room_id uuid, p_x int, p_y int)
returns text -- 'miss' | 'hit' | 'sunk'
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
  v_fleet jsonb;
  v_cell text;
  v_result text;
  v_ship_index int;
  v_ship jsonb;
  v_positions jsonb;
  v_hit_count int;
  v_opponent uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated'; end if;
  select * into v_room from public.rooms where id = p_room_id for update;
  if v_room is null then raise exception 'room not found'; end if;
  if v_room.status <> 'playing' then raise exception 'match is not in progress'; end if;
  if v_room.turn_player <> auth.uid() then raise exception 'not your turn'; end if;
  if v_room.host_id <> auth.uid() and v_room.guest_id <> auth.uid() then raise exception 'not a participant'; end if;

  -- duplicate shot check
  if exists (
    select 1 from public.room_shots
    where room_id = p_room_id and shooter = auth.uid() and x = p_x and y = p_y
  ) then
    raise exception 'duplicate shot';
  end if;

  v_opponent := case when v_room.host_id = auth.uid() then v_room.guest_id else v_room.host_id end;
  v_fleet := case when v_room.host_id = auth.uid() then v_room.guest_fleet else v_room.host_fleet end;

  -- find the cell state in the opponent's fleet board: fleet->board[y][x]
  v_cell := v_fleet->'board'->p_y->p_x #>> '{}';
  if v_cell is null then raise exception 'bad coordinates'; end if;

  if v_cell = 'ship' then
    -- mark hit in the authoritative fleet
    v_fleet := jsonb_set(v_fleet, array['board', (p_y)::text, (p_x)::text], '"hit"');

    -- find the ship containing this cell and count hits
    select i, s into v_ship_index, v_ship
    from jsonb_array_elements(v_fleet->'ships') with ordinality as t(s, i)
    where exists (
      select 1 from jsonb_array_elements(s->'positions') as p
      where (p->>'x')::int = p_x and (p->>'y')::int = p_y
    );

    select count(*) into v_hit_count
    from jsonb_array_elements(v_ship->'positions') as p
    where (v_fleet->'board'->(p->>'y')::int->>(p->>'x')::int) in ('hit', 'sunk');

    if v_hit_count = (v_ship->'size')::int then
      v_fleet := jsonb_set(
        v_fleet,
        array['ships', (v_ship_index - 1)::text, 'isSunk'],
        'true'
      );
      v_result := 'sunk';
    else
      v_result := 'hit';
    end if;

    -- Hit or sunk: shooter keeps the turn. Single authoritative fleet write.
    update public.rooms set
      host_fleet = case when host_id = auth.uid() then host_fleet else v_fleet end,
      guest_fleet = case when host_id = auth.uid() then v_fleet else guest_fleet end,
      updated_at = now()
      where id = p_room_id;
  else
    v_result := 'miss';
    update public.rooms set turn_player = v_opponent, updated_at = now() where id = p_room_id;
  end if;

  insert into public.room_shots (room_id, shooter, x, y, result)
  values (p_room_id, auth.uid(), p_x, p_y, v_result);

  -- win check: all ships sunk?
  if v_result = 'sunk' then
    if not exists (
      select 1
      from jsonb_array_elements(v_fleet->'ships') as s
      where (s->>'isSunk')::boolean is not true
    ) then
      update public.rooms set status = 'finished', winner = auth.uid(), updated_at = now()
      where id = p_room_id;
    end if;
  end if;

  return v_result;
end;
$$;

-- ============================================================================
-- 7. RPC EXECUTE: least privilege.
-- Postgres grants function EXECUTE to PUBLIC by default and Supabase's
-- default privileges additionally grant it to anon/authenticated. All four
-- RPCs authenticate inside the function, but anon must not be able to invoke
-- them at all. handle_new_user is a trigger function: PostgreSQL rejects
-- direct invocation of trigger functions, so its PUBLIC EXECUTE is inert.
-- ============================================================================

revoke execute on function public.create_room(text) from public, anon, authenticated;
revoke execute on function public.join_room(text) from public, anon, authenticated;
revoke execute on function public.save_fleet(uuid, boolean, jsonb) from public, anon, authenticated;
revoke execute on function public.make_shot(uuid, integer, integer) from public, anon, authenticated;

grant execute on function public.create_room(text) to authenticated;
grant execute on function public.join_room(text) to authenticated;
grant execute on function public.save_fleet(uuid, boolean, jsonb) to authenticated;
grant execute on function public.make_shot(uuid, integer, integer) to authenticated;
