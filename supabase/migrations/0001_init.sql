-- Sonar.io initial schema: profiles, matches, moves.
-- Apply with: supabase db push  (or run in Supabase SQL editor)

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'Sonar operator',
  created_at timestamptz not null default now()
);

create table if not exists public.matches (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.profiles(id) on delete cascade,
  mode text not null check (mode in ('bot_easy', 'bot_normal', 'bot_hard', 'multiplayer')),
  result text not null check (result in ('win', 'loss')),
  total_shots int not null,
  hits int not null,
  accuracy numeric not null check (accuracy between 0 and 1),
  duration_seconds int,
  created_at timestamptz not null default now()
);

create index if not exists matches_player_created_idx on public.matches (player_id, created_at desc);

create table if not exists public.moves (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.matches(id) on delete cascade,
  player_id uuid not null references public.profiles(id) on delete cascade,
  x int not null check (x between 0 and 9),
  y int not null check (y between 0 and 9),
  result text not null check (result in ('miss', 'hit', 'sunk')),
  created_at timestamptz not null default now()
);

create index if not exists moves_match_idx on public.moves (match_id, id);

-- Multiplayer rooms
create table if not exists public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text unique not null,
  status text not null default 'waiting' check (status in ('waiting', 'placement', 'playing', 'finished', 'abandoned')),
  host_id uuid not null references public.profiles(id),
  guest_id uuid references public.profiles(id),
  turn_player uuid references public.profiles(id),
  winner uuid references public.profiles(id),
  -- Server-side authoritative fleets. Never readable via client select.
  host_fleet jsonb,
  guest_fleet jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.room_shots (
  id bigint generated always as identity primary key,
  room_id uuid not null references public.rooms(id) on delete cascade,
  shooter uuid not null references public.profiles(id),
  x int not null check (x between 0 and 9),
  y int not null check (y between 0 and 9),
  result text not null check (result in ('miss', 'hit', 'sunk')),
  created_at timestamptz not null default now()
);

create index if not exists room_shots_room_idx on public.room_shots (room_id, id);

-- RLS
alter table public.profiles enable row level security;
alter table public.matches enable row level security;
alter table public.moves enable row level security;
alter table public.rooms enable row level security;
alter table public.room_shots enable row level security;

create policy "profiles: read all, update own"
  on public.profiles for all
  using (true)
  with check (auth.uid() = id);

create policy "matches: insert own, read own"
  on public.matches for all
  using (auth.uid() = player_id)
  with check (auth.uid() = player_id);

create policy "moves: own rows only"
  on public.moves for all
  using (auth.uid() = player_id)
  with check (auth.uid() = player_id);

-- Room shots are visible to room participants only (result columns, never fleets).
create policy "room_shots: participants read, own insert blocked (RPC only)"
  on public.room_shots for select
  using (
    exists (
      select 1 from public.rooms r
      where r.id = room_id and (r.host_id = auth.uid() or r.guest_id = auth.uid())
    )
  );

-- Rooms: participants can see room row; fleets are protected by a restricted view.
create policy "rooms: participants read row"
  on public.rooms for select
  using (host_id = auth.uid() or guest_id = auth.uid());

revoke all on public.rooms from anon, authenticated;

-- Safe view without fleet columns; access restricted to participants via RPC-free select.
create or replace view public.room_state
with (security_invoker = true) as
select id, code, status, host_id, guest_id, turn_player, winner, created_at, updated_at
from public.rooms;

-- ============================================================================
-- SECURITY DEFINER RPCs (server-authoritative game logic)
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
  insert into public.rooms (code, host_id, turn_player)
  values (p_code, auth.uid(), auth.uid())
  on conflict (code) do nothing
  returning id into v_id;

  if v_id is null then
    select id into v_id from public.rooms where code = p_code and host_id = auth.uid();
  end if;
  return v_id;
end;
$$;

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
  select * into v_room from public.rooms where code = p_code for update;
  if v_room is null then
    raise exception 'room not found';
  end if;
  if v_room.host_id = auth.uid() then
    return v_room.id;
  end if;
  if v_room.guest_id is not null and v_room.guest_id <> auth.uid() then
    raise exception 'room is full';
  end if;
  update public.rooms
  set guest_id = auth.uid(), status = 'placement', updated_at = now()
  where id = v_room.id;
  return v_room.id;
end;
$$;

create or replace function public.save_fleet(p_room_id uuid, p_host boolean, p_fleet jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room public.rooms;
begin
  select * into v_room from public.rooms where id = p_room_id for update;
  if v_room is null then raise exception 'room not found'; end if;
  if p_host and v_room.host_id <> auth.uid() then raise exception 'not host'; end if;
  if not p_host and (v_room.guest_id is null or v_room.guest_id <> auth.uid()) then raise exception 'not guest'; end if;

  if p_host then
    update public.rooms set host_fleet = p_fleet, updated_at = now() where id = p_room_id;
  else
    update public.rooms set guest_fleet = p_fleet, updated_at = now() where id = p_room_id;
  end if;

  -- Both fleets saved -> start the match, host moves first.
  if p_host and v_room.guest_fleet is not null then
    update public.rooms set status = 'playing', turn_player = host_id, updated_at = now() where id = p_room_id;
  elsif not p_host and v_room.host_fleet is not null then
    update public.rooms set status = 'playing', turn_player = host_id, updated_at = now() where id = p_room_id;
  end if;
end;
$$;

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

  -- find the cell state in the opponent's fleet jsonb: [["empty"|"ship", ...], ...]
  v_cell := v_fleet->(p_y)::text->(p_x)::text;
  if v_cell is null then raise exception 'bad coordinates'; end if;

  if v_cell = 'ship' then
    -- mark hit in the authoritative fleet
    v_fleet := jsonb_set(v_fleet, array[(p_y)::text, (p_x)::text], '"hit"');

    -- find the ship containing this cell and count hits
    select i, s into v_ship_index, v_ship
    from jsonb_array_elements(v_fleet->'ships') with ordinality as t(s, i)
    where exists (
      select 1 from jsonb_array_elements(s->'positions') as p
      where (p->>'x')::int = p_x and (p->>'y')::int = p_y
    );

    select count(*) into v_hit_count
    from jsonb_array_elements(v_ship->'positions') as p
    where (v_fleet->(p->>'y')->>(p->>'x')) in ('hit', 'sunk');

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

-- Profile creation on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', 'Sonar operator'))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
