import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

// Applies 0001_init.sql + 0002_security_fixes.sql to a real Postgres engine
// (PGlite) with the Supabase client roles emulated, and verifies the security
// guarantees: hidden fleets unreadable, RLS policy splits, server-side
// validation, and least-privilege grants.
//
// Tests are a stateful sequence: vitest runs them in file order and they
// share the single PGlite instance and its data.

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
const readMigration = (name: string) => readFileSync(join(migrationsDir, name), 'utf8');

const USER_A = '11111111-1111-4111-8111-111111111111'; // host
const USER_B = '22222222-2222-4222-8222-222222222222'; // guest
const USER_C = '33333333-3333-4333-8333-333333333333'; // outsider
const USER_D = '44444444-4444-4444-8444-444444444444'; // delete-own test user
const USER_E = '55555555-5555-4555-8555-555555555555'; // insert-own test user

const BOOTSTRAP = `
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

-- Emulate Supabase default privileges: objects created in public by the
-- migration role are granted to the client roles at creation time. 0001
-- revokes rooms; 0002 re-grants column level. This mirrors production.
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant execute on functions to anon, authenticated, service_role;

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key,
  email text,
  raw_user_meta_data jsonb not null default '{}'::jsonb
);

create or replace function auth.uid() returns uuid
language sql
stable
as $fn$
  select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid
$fn$;
`;

let db: PGlite;
let alphaId = ''; // room created by A, joined by B, full battle
let bravoId = ''; // room used for save_fleet validation lifecycle

type Row = Record<string, unknown>;
type QueryRows = { rows: Row[] };

async function runAsSuperuser(sql: string, params: unknown[] = []): Promise<QueryRows> {
  return (await db.query(sql, params)) as unknown as QueryRows;
}

async function runAs(
  role: 'anon' | 'authenticated',
  uid: string | null,
  sql: string,
  params: unknown[] = [],
): Promise<QueryRows> {
  await db.exec('reset role');
  await db.exec(`set role ${role}`);
  await db.query('select set_config($1, $2, false)', [
    'request.jwt.claims',
    uid === null ? '' : JSON.stringify({ sub: uid }),
  ]);
  try {
    return (await db.query(sql, params)) as unknown as QueryRows;
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

// ---------------------------------------------------------------------------
// Fleet fixtures (mirror the frontend Fleet shape: {board, ships})
// ---------------------------------------------------------------------------

type Pos = [number, number];
interface ShipSpec {
  id: string;
  size: number;
  positions: Pos[];
}
interface BoardOverride {
  x: number;
  y: number;
  state: 'empty' | 'ship';
}

const VALID_LAYOUT: ShipSpec[] = [
  { id: 'carrier', size: 4, positions: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { id: 'battleship', size: 3, positions: [[5, 0], [6, 0], [7, 0]] },
  { id: 'cruiser', size: 3, positions: [[0, 2], [1, 2], [2, 2]] },
  { id: 'destroyer1', size: 2, positions: [[4, 2], [5, 2]] },
  { id: 'destroyer2', size: 2, positions: [[7, 2], [8, 2]] },
  { id: 'destroyer3', size: 2, positions: [[0, 4], [1, 4]] },
  { id: 'patrol1', size: 1, positions: [[0, 6]] },
  { id: 'patrol2', size: 1, positions: [[2, 6]] },
  { id: 'patrol3', size: 1, positions: [[4, 6]] },
  { id: 'patrol4', size: 1, positions: [[6, 6]] },
];

// 10 ships, 20 cells, but wrong composition (2x size4, 4x size2, 4x size1).
const WRONG_COMPOSITION: ShipSpec[] = [
  { id: 'carrier', size: 4, positions: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { id: 'carrier2', size: 4, positions: [[0, 2], [0, 3], [0, 4], [0, 5]] },
  { id: 'destroyer1', size: 2, positions: [[2, 2], [3, 2]] },
  { id: 'destroyer2', size: 2, positions: [[5, 2], [6, 2]] },
  { id: 'destroyer3', size: 2, positions: [[8, 2], [9, 2]] },
  { id: 'destroyer4', size: 2, positions: [[2, 4], [3, 4]] },
  { id: 'patrol1', size: 1, positions: [[0, 7]] },
  { id: 'patrol2', size: 1, positions: [[2, 6]] },
  { id: 'patrol3', size: 1, positions: [[5, 6]] },
  { id: 'patrol4', size: 1, positions: [[8, 6]] },
];

function fleetJson(specs: ShipSpec[], overrides: BoardOverride[] = []): string {
  const board: string[][] = Array.from({ length: 10 }, () => Array<string>(10).fill('empty'));
  for (const spec of specs) {
    for (const [x, y] of spec.positions) board[y][x] = 'ship';
  }
  for (const o of overrides) board[o.y][o.x] = o.state;
  const ships = specs.map((spec) => ({
    id: spec.id,
    size: spec.size,
    positions: spec.positions.map(([x, y]) => ({ x, y })),
    hits: 0,
    isSunk: false,
  }));
  return JSON.stringify({ board, ships });
}

function mutateFleet(json: string, mutate: (fleet: {
  board: string[][];
  ships: Array<{ id?: string; size: number; positions: Array<{ x: number; y: number }>; hits: number; isSunk: boolean }>;
}) => void): string {
  const fleet = JSON.parse(json);
  mutate(fleet);
  return JSON.stringify(fleet);
}

const VALID_FLEET = fleetJson(VALID_LAYOUT);

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  db = new PGlite();
  await db.exec(BOOTSTRAP);
  await db.exec(readMigration('0001_init.sql'));

  const users: Array<[string, string]> = [
    [USER_A, 'Host A'],
    [USER_B, 'Guest B'],
    [USER_C, 'Outsider C'],
    [USER_D, 'Deleter D'],
    [USER_E, 'Inserter E'],
  ];
  for (const [id, name] of users) {
    await db.query(
      'insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)',
      [id, `${name.split(' ')[0].toLowerCase()}@test.local`, JSON.stringify({ display_name: name })],
    );
  }

  await db.exec(readMigration('0002_security_fixes.sql'));
  // Idempotency: re-running the whole migration must not fail.
  await db.exec(readMigration('0002_security_fixes.sql'));
}, 120_000);

// ---------------------------------------------------------------------------
// Catalog: policies, privileges, function grants after 0002
// ---------------------------------------------------------------------------

describe('0002 migration state', () => {
  it('splits the profiles policy into per-command policies (no FOR ALL)', async () => {
    const res = await runAsSuperuser(
      `select policyname, cmd from pg_policies
       where schemaname = 'public' and tablename = 'profiles'
       order by policyname`,
    );
    expect(res.rows).toEqual([
      { policyname: 'profiles: delete own', cmd: 'DELETE' },
      { policyname: 'profiles: insert own', cmd: 'INSERT' },
      { policyname: 'profiles: public read', cmd: 'SELECT' },
      { policyname: 'profiles: update own', cmd: 'UPDATE' },
    ]);
  });

  it('keeps the other policies from 0001 intact', async () => {
    const res = await runAsSuperuser(
      `select tablename, policyname from pg_policies
       where schemaname = 'public' and tablename in ('matches', 'moves', 'rooms', 'room_shots')
       order by tablename`,
    );
    expect(res.rows).toEqual([
      { tablename: 'matches', policyname: 'matches: insert own, read own' },
      { tablename: 'moves', policyname: 'moves: own rows only' },
      { tablename: 'room_shots', policyname: 'room_shots: participants read, own insert blocked (RPC only)' },
      { tablename: 'rooms', policyname: 'rooms: participants read row' },
    ]);
  });

  it('grants authenticated column-level SELECT on rooms safe columns only', async () => {
    const res = await runAsSuperuser(
      `select column_name from information_schema.column_privileges
       where table_schema = 'public' and table_name = 'rooms'
         and grantee = 'authenticated' and privilege_type = 'SELECT'
       order by column_name`,
    );
    expect(res.rows.map((r) => String(r.column_name))).toEqual([
      'code',
      'created_at',
      'guest_id',
      'host_id',
      'id',
      'status',
      'turn_player',
      'updated_at',
      'winner',
    ]);
  });

  it('never grants client roles any privilege on fleet columns or table-level rooms', async () => {
    const res = await runAsSuperuser(`
      select
        has_column_privilege('authenticated', 'public.rooms', 'host_fleet', 'select') as auth_host_fleet,
        has_column_privilege('authenticated', 'public.rooms', 'guest_fleet', 'select') as auth_guest_fleet,
        has_table_privilege('authenticated', 'public.rooms', 'select') as auth_table_select,
        has_table_privilege('anon', 'public.rooms', 'select') as anon_table_select,
        has_table_privilege('authenticated', 'public.rooms', 'update') as auth_table_update,
        has_table_privilege('anon', 'public.rooms', 'update') as anon_table_update
    `);
    expect(res.rows[0]).toEqual({
      auth_host_fleet: false,
      auth_guest_fleet: false,
      auth_table_select: false,
      anon_table_select: false,
      auth_table_update: false,
      anon_table_update: false,
    });
  });

  it('exposes room_state and room_shots SELECT to authenticated only', async () => {
    const res = await runAsSuperuser(`
      select
        has_table_privilege('authenticated', 'public.room_state', 'select') as auth_view,
        has_table_privilege('anon', 'public.room_state', 'select') as anon_view,
        has_table_privilege('authenticated', 'public.room_shots', 'select') as auth_shots,
        has_table_privilege('anon', 'public.room_shots', 'select') as anon_shots,
        has_table_privilege('authenticated', 'public.room_shots', 'insert') as auth_shots_insert,
        has_table_privilege('authenticated', 'public.room_shots', 'update') as auth_shots_update,
        has_table_privilege('authenticated', 'public.room_shots', 'delete') as auth_shots_delete
    `);
    expect(res.rows[0]).toEqual({
      auth_view: true,
      anon_view: false,
      auth_shots: true,
      anon_shots: false,
      auth_shots_insert: false,
      auth_shots_update: false,
      auth_shots_delete: false,
    });
  });

  it('restricts RPC execute to authenticated (anon and PUBLIC revoked)', async () => {
    const rpcs = [
      'public.create_room(text)',
      'public.join_room(text)',
      'public.save_fleet(uuid, boolean, jsonb)',
      'public.make_shot(uuid, integer, integer)',
    ];
    for (const rpc of rpcs) {
      const res = await runAsSuperuser(
        `select
           has_function_privilege('anon', $1, 'execute') as anon_exec,
           has_function_privilege('authenticated', $1, 'execute') as auth_exec`,
        [rpc],
      );
      // has_function_privilege honors PUBLIC grants, so anon_exec=false also
      // proves PUBLIC execute was revoked.
      expect(res.rows[0], rpc).toEqual({ anon_exec: false, auth_exec: true });
    }
  });

  it('room_state view exposes no fleet columns', async () => {
    const res = await runAsSuperuser(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'room_state'
       order by column_name`,
    );
    const columns = res.rows.map((r) => String(r.column_name));
    expect(columns).toEqual([
      'code',
      'created_at',
      'guest_id',
      'host_id',
      'id',
      'status',
      'turn_player',
      'updated_at',
      'winner',
    ]);
    expect(columns).not.toContain('host_fleet');
    expect(columns).not.toContain('guest_fleet');
  });

  it('handle_new_user cannot be invoked directly (trigger-only)', async () => {
    await expect(
      runAs('authenticated', USER_A, 'select public.handle_new_user()'),
    ).rejects.toThrow(/trigger functions can only be/i);
  });
});

// ---------------------------------------------------------------------------
// Profiles RLS
// ---------------------------------------------------------------------------

describe('profiles RLS after 0002', () => {
  it('still allows public read of display names (anon and authenticated)', async () => {
    const asAnon = await runAs('anon', null, 'select display_name from public.profiles where id = $1', [USER_A]);
    expect(asAnon.rows[0].display_name).toBe('Host A');

    const asAuth = await runAs('authenticated', USER_C, 'select display_name from public.profiles where id = $1', [USER_A]);
    expect(asAuth.rows[0].display_name).toBe('Host A');
  });

  it('blocks deleting another user profile (the 0001 hole is closed)', async () => {
    await runAs('authenticated', USER_C, 'delete from public.profiles where id = $1', [USER_A]);
    const res = await runAsSuperuser('select count(*)::int as n from public.profiles where id = $1', [USER_A]);
    expect(res.rows[0].n).toBe(1);
  });

  it('allows deleting own profile', async () => {
    await runAs('authenticated', USER_D, 'delete from public.profiles where id = $1', [USER_D]);
    const res = await runAsSuperuser('select count(*)::int as n from public.profiles where id = $1', [USER_D]);
    expect(res.rows[0].n).toBe(0);
  });

  it('allows updating own profile and blocks updating others', async () => {
    await runAs('authenticated', USER_A, "update public.profiles set display_name = 'Host A updated' where id = $1", [USER_A]);
    let res = await runAsSuperuser('select display_name from public.profiles where id = $1', [USER_A]);
    expect(res.rows[0].display_name).toBe('Host A updated');

    await runAs('authenticated', USER_C, "update public.profiles set display_name = 'hacked' where id = $1", [USER_A]);
    res = await runAsSuperuser('select display_name from public.profiles where id = $1', [USER_A]);
    expect(res.rows[0].display_name).toBe('Host A updated');
  });

  it('allows inserting own profile and blocks inserting for others', async () => {
    await runAsSuperuser('delete from public.profiles where id = $1', [USER_E]);

    await expect(
      runAs('authenticated', USER_C, 'insert into public.profiles (id) values ($1)', [USER_E]),
    ).rejects.toThrow(/row-level security/i);

    await runAs('authenticated', USER_E, 'insert into public.profiles (id) values ($1)', [USER_E]);
    const res = await runAsSuperuser('select count(*)::int as n from public.profiles where id = $1', [USER_E]);
    expect(res.rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// create_room
// ---------------------------------------------------------------------------

describe('create_room validation', () => {
  it('rejects malformed room codes', async () => {
    for (const code of ['alp', 'ABC', 'ABCDEFG', '', 'A B1', 'ТЕСТ']) {
      await expect(
        runAs('authenticated', USER_A, 'select public.create_room($1) as id', [code]),
      ).rejects.toThrow(/invalid room code/i);
    }
  });

  it('rejects unauthenticated callers', async () => {
    await expect(
      runAs('authenticated', null, 'select public.create_room($1) as id', ['NOATH']),
    ).rejects.toThrow(/not authenticated/i);
  });

  it('rejects anon role at the privilege level', async () => {
    await expect(
      runAs('anon', null, 'select public.create_room($1) as id', ['ANON1']),
    ).rejects.toThrow(/permission denied/i);
  });

  it('creates a room and is idempotent for the same host', async () => {
    const res = await runAs('authenticated', USER_A, 'select public.create_room($1) as id', ['ALPHA']);
    alphaId = res.rows[0].id as string;
    expect(alphaId).toBeTruthy();

    const again = await runAs('authenticated', USER_A, 'select public.create_room($1) as id', ['ALPHA']);
    expect(again.rows[0].id).toBe(alphaId);
  });

  it('rejects another host taking an existing code', async () => {
    await expect(
      runAs('authenticated', USER_B, 'select public.create_room($1) as id', ['ALPHA']),
    ).rejects.toThrow(/room code already taken/i);
  });
});

// ---------------------------------------------------------------------------
// Rooms: hidden fleets are never readable
// ---------------------------------------------------------------------------

describe('rooms hidden-state isolation', () => {
  it('denies SELECT on fleet columns for participants', async () => {
    await expect(
      runAs('authenticated', USER_A, 'select host_fleet from public.rooms where id = $1', [alphaId]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runAs('authenticated', USER_A, 'select guest_fleet from public.rooms where id = $1', [alphaId]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('denies SELECT * on rooms (star includes fleet columns)', async () => {
    await expect(
      runAs('authenticated', USER_A, 'select * from public.rooms where id = $1', [alphaId]),
    ).rejects.toThrow(/permission denied/i);
  });

  it('lets participants read the safe columns, outsiders see nothing', async () => {
    const safe = 'select id, code, status, host_id, guest_id, turn_player, winner, created_at, updated_at from public.rooms where id = $1';
    const asHost = await runAs('authenticated', USER_A, safe, [alphaId]);
    expect(asHost.rows).toHaveLength(1);
    expect(asHost.rows[0].code).toBe('ALPHA');

    const asOutsider = await runAs('authenticated', USER_C, safe, [alphaId]);
    expect(asOutsider.rows).toHaveLength(0);
  });

  it('serves room_state to participants only', async () => {
    const asHost = await runAs('authenticated', USER_A, 'select * from public.room_state where id = $1', [alphaId]);
    expect(asHost.rows).toHaveLength(1);
    expect(asHost.rows[0].status).toBe('waiting');

    const asOutsider = await runAs('authenticated', USER_C, 'select * from public.room_state where id = $1', [alphaId]);
    expect(asOutsider.rows).toHaveLength(0);
  });

  it('has no fleet columns on room_state (querying them fails)', async () => {
    await expect(
      runAs('authenticated', USER_A, 'select host_fleet from public.room_state where id = $1', [alphaId]),
    ).rejects.toThrow(/column .* does not exist/i);
  });

  it('denies anon reads of room_state and room_shots', async () => {
    await expect(
      runAs('anon', null, 'select * from public.room_state'),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runAs('anon', null, 'select * from public.room_shots'),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runAs('anon', null, 'select * from public.rooms'),
    ).rejects.toThrow(/permission denied/i);
  });

  it('denies direct writes to rooms and room_shots (RPC-only mutations)', async () => {
    await expect(
      runAs('authenticated', USER_A, "update public.rooms set status = 'finished' where id = $1", [alphaId]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runAs('authenticated', USER_A,
        "insert into public.room_shots (room_id, shooter, x, y, result) values ($1, $2, 0, 0, 'hit')",
        [alphaId, USER_A]),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runAs('authenticated', USER_A, "update public.room_shots set result = 'sunk'"),
    ).rejects.toThrow(/permission denied/i);
    await expect(
      runAs('authenticated', USER_A, 'delete from public.room_shots'),
    ).rejects.toThrow(/permission denied/i);
  });
});

// ---------------------------------------------------------------------------
// join_room
// ---------------------------------------------------------------------------

describe('join_room', () => {
  it('rejects unknown codes', async () => {
    await expect(
      runAs('authenticated', USER_D, 'select public.join_room($1) as id', ['ZZZZ']),
    ).rejects.toThrow(/room not found/i);
  });

  it('lets the guest join a waiting room', async () => {
    const res = await runAs('authenticated', USER_B, 'select public.join_room($1) as id', ['ALPHA']);
    expect(res.rows[0].id).toBe(alphaId);

    const state = await runAs('authenticated', USER_A, 'select guest_id, status, turn_player from public.room_state where id = $1', [alphaId]);
    expect(state.rows[0]).toMatchObject({ guest_id: USER_B, status: 'placement', turn_player: USER_A });
  });

  it('rejects a third player once the room left the waiting state', async () => {
    await expect(
      runAs('authenticated', USER_C, 'select public.join_room($1) as id', ['ALPHA']),
    ).rejects.toThrow(/not open for joining/i);
  });

  it('reconnect of an already-joined guest is side-effect free', async () => {
    const res = await runAs('authenticated', USER_B, 'select public.join_room($1) as id', ['ALPHA']);
    expect(res.rows[0].id).toBe(alphaId);
    const state = await runAs('authenticated', USER_A, 'select status, guest_id from public.room_state where id = $1', [alphaId]);
    expect(state.rows[0]).toMatchObject({ status: 'placement', guest_id: USER_B });
  });
});

// ---------------------------------------------------------------------------
// save_fleet: server-side validation
// ---------------------------------------------------------------------------

const BENT = VALID_LAYOUT.map((s) =>
  s.id === 'cruiser' ? { ...s, positions: [[0, 2], [1, 2], [0, 3]] as Pos[] } : s,
);
const GAPPED = VALID_LAYOUT.map((s) =>
  s.id === 'cruiser' ? { ...s, positions: [[0, 2], [1, 2], [3, 2]] as Pos[] } : s,
);
const TOUCHING = VALID_LAYOUT.map((s) =>
  s.id === 'patrol2' ? { ...s, positions: [[1, 6]] as Pos[] } : s,
);
const DIAGONAL = VALID_LAYOUT.map((s) =>
  s.id === 'patrol2' ? { ...s, positions: [[1, 5]] as Pos[] } : s,
);
const OVERLAPPING = VALID_LAYOUT.map((s) =>
  s.id === 'patrol2' ? { ...s, positions: [[0, 6]] as Pos[] } : s,
);

const INVALID_FLEETS: Array<[string, string, RegExp]> = [
  ['not an object', JSON.stringify([1, 2, 3]), /expected an object with board and ships/i],
  ['missing ships key', JSON.stringify({ board: Array.from({ length: 10 }, () => Array(10).fill('empty')) }), /expected an object with board and ships/i],
  ['board with 9 rows', mutateFleet(VALID_FLEET, (f) => void f.board.pop()), /board must be a 10x10 array/i],
  ['board row with 9 cells', mutateFleet(VALID_FLEET, (f) => void f.board[3].pop()), /board row 3 must have 10 cells/i],
  ['board cell with a battle state', mutateFleet(VALID_FLEET, (f) => void (f.board[0][0] = 'hit')), /must be empty or ship/i],
  ['only 19 ship cells', mutateFleet(VALID_FLEET, (f) => void (f.board[6][6] = 'empty')), /exactly 20 ship cells/i],
  ['only 9 ships', mutateFleet(VALID_FLEET, (f) => void f.ships.pop()), /exactly 10 ships/i],
  ['preset hits', mutateFleet(VALID_FLEET, (f) => void (f.ships[0].hits = 1)), /hits must be 0/i],
  ['preset sunk flag', mutateFleet(VALID_FLEET, (f) => void (f.ships[0].isSunk = true)), /must not be sunk/i],
  ['missing ship id', mutateFleet(VALID_FLEET, (f) => void delete f.ships[0].id), /ship id is required/i],
  ['ship size out of range', mutateFleet(VALID_FLEET, (f) => void (f.ships[0].size = 5)), /size must be an integer/i],
  ['positions count mismatch', mutateFleet(VALID_FLEET, (f) => void f.ships[0].positions.pop()), /must have exactly .* positions/i],
  ['out of bounds coordinate', mutateFleet(VALID_FLEET, (f) => void (f.ships[7].positions[0] = { x: 10, y: 0 })), /invalid position coordinates/i],
  ['wrong fleet composition', fleetJson(WRONG_COMPOSITION), /fleet composition/i],
  ['bent (L-shaped) ship', fleetJson(BENT), /not a straight line/i],
  ['ship with a gap', fleetJson(GAPPED), /not a consecutive line/i],
  ['ships touching side by side', fleetJson(TOUCHING), /must not touch/i],
  ['ships touching diagonally', fleetJson(DIAGONAL), /must not touch/i],
  ['overlapping ships', fleetJson(OVERLAPPING, [{ x: 2, y: 6, state: 'ship' }]), /ships overlap/i],
  ['positions not matching the board', fleetJson(VALID_LAYOUT, [
    { x: 0, y: 0, state: 'empty' },
    { x: 9, y: 9, state: 'ship' },
  ]), /positions do not match the board/i],
];

describe('save_fleet validation', () => {
  it('creates the validation room', async () => {
    const res = await runAs('authenticated', USER_A, 'select public.create_room($1) as id', ['BRAVO']);
    bravoId = res.rows[0].id as string;
  });

  it('rejects every invalid fleet without mutating state', async () => {
    for (const [name, fleet, message] of INVALID_FLEETS) {
      await expect(
        runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, fleet]),
        name,
      ).rejects.toThrow(message);
    }
    const res = await runAsSuperuser(
      'select host_fleet is null as empty, status from public.rooms where id = $1',
      [bravoId],
    );
    expect(res.rows[0]).toEqual({ empty: true, status: 'waiting' });
  });

  it('rejects shots before the battle starts', async () => {
    await expect(
      runAs('authenticated', USER_A, 'select public.make_shot($1, $2, $3) as result', [bravoId, 0, 0]),
    ).rejects.toThrow(/match is not in progress/i);
  });

  it('accepts a valid fleet while the room is waiting', async () => {
    await runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, VALID_FLEET]);
    const res = await runAsSuperuser(
      'select host_fleet is not null as saved, status from public.rooms where id = $1',
      [bravoId],
    );
    expect(res.rows[0]).toEqual({ saved: true, status: 'waiting' });
  });

  it('lets the guest join and save, which starts the battle with host first', async () => {
    await runAs('authenticated', USER_B, 'select public.join_room($1) as id', ['BRAVO']);
    await runAs('authenticated', USER_B, 'select public.save_fleet($1, false, $2::jsonb)', [bravoId, VALID_FLEET]);

    const state = await runAs('authenticated', USER_B, 'select status, turn_player, winner from public.room_state where id = $1', [bravoId]);
    expect(state.rows[0]).toEqual({ status: 'playing', turn_player: USER_A, winner: null });
  });

  it('blocks joining a room once the battle started (mid-game join)', async () => {
    await expect(
      runAs('authenticated', USER_D, 'select public.join_room($1) as id', ['BRAVO']),
    ).rejects.toThrow(/not open for joining/i);
  });

  it('host reconnect mid-game does not reset the match', async () => {
    const res = await runAs('authenticated', USER_A, 'select public.join_room($1) as id', ['BRAVO']);
    expect(res.rows[0].id).toBe(bravoId);
    const state = await runAs('authenticated', USER_A, 'select status, turn_player from public.room_state where id = $1', [bravoId]);
    expect(state.rows[0]).toEqual({ status: 'playing', turn_player: USER_A });
  });

  it('rejects saving a fleet after the battle started, without mutating it', async () => {
    const before = await runAsSuperuser('select host_fleet::text as fleet from public.rooms where id = $1', [bravoId]);
    await expect(
      runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, VALID_FLEET]),
    ).rejects.toThrow(/after the battle has started/i);
    const after = await runAsSuperuser('select host_fleet::text as fleet from public.rooms where id = $1', [bravoId]);
    expect(after.rows[0].fleet).toBe(before.rows[0].fleet);
  });

  it('rejects role impersonation and unknown rooms', async () => {
    await expect(
      runAs('authenticated', USER_B, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, VALID_FLEET]),
    ).rejects.toThrow(/not host/i);
    await expect(
      runAs('authenticated', USER_C, 'select public.save_fleet($1, false, $2::jsonb)', [bravoId, VALID_FLEET]),
    ).rejects.toThrow(/not guest/i);
    await expect(
      runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [
        '99999999-9999-4999-8999-999999999999',
        VALID_FLEET,
      ]),
    ).rejects.toThrow(/room not found/i);
  });
});

// ---------------------------------------------------------------------------
// make_shot: the full scripted battle on ALPHA
// ---------------------------------------------------------------------------

describe('make_shot battle', () => {
  it('saves both fleets and starts the battle', async () => {
    await runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [alphaId, VALID_FLEET]);
    await runAs('authenticated', USER_B, 'select public.save_fleet($1, false, $2::jsonb)', [alphaId, VALID_FLEET]);
    const state = await runAs('authenticated', USER_A, 'select status, turn_player from public.room_state where id = $1', [alphaId]);
    expect(state.rows[0]).toEqual({ status: 'playing', turn_player: USER_A });
  });

  it('plays the scripted battle with correct results and turn transitions', async () => {
    const shot = (uid: string, x: number, y: number) =>
      runAs('authenticated', uid, 'select public.make_shot($1, $2, $3) as result', [alphaId, x, y]);
    const expectShot = async (uid: string, x: number, y: number, result: string) => {
      const res = await shot(uid, x, y);
      expect(res.rows[0].result).toBe(result);
    };
    const turn = async () => {
      const res = await runAs('authenticated', USER_A, 'select turn_player, status from public.room_state where id = $1', [alphaId]);
      return res.rows[0];
    };

    // Host opens on the guest carrier (0,0)-(3,0): hit, hit, hit, sunk.
    await expectShot(USER_A, 0, 0, 'hit');
    await expect(shot(USER_A, 0, 0)).rejects.toThrow(/duplicate shot/i);
    await expect(shot(USER_B, 5, 0)).rejects.toThrow(/not your turn/i);
    await expectShot(USER_A, 1, 0, 'hit');
    await expectShot(USER_A, 2, 0, 'hit');
    await expectShot(USER_A, 3, 0, 'sunk');

    // Host misses: turn passes to the guest.
    await expectShot(USER_A, 0, 1, 'miss');
    expect(await turn()).toMatchObject({ turn_player: USER_B, status: 'playing' });

    // Guest hits (keeps turn), then misses (turn back to host).
    await expectShot(USER_B, 0, 0, 'hit');
    await expectShot(USER_B, 9, 9, 'miss');
    expect(await turn()).toMatchObject({ turn_player: USER_A, status: 'playing' });

    // Host sweeps the rest of the guest fleet; hits keep the turn.
    await expectShot(USER_A, 5, 0, 'hit');
    await expectShot(USER_A, 6, 0, 'hit');
    await expectShot(USER_A, 7, 0, 'sunk');
    await expectShot(USER_A, 0, 2, 'hit');
    await expectShot(USER_A, 1, 2, 'hit');
    await expectShot(USER_A, 2, 2, 'sunk');
    await expectShot(USER_A, 4, 2, 'hit');
    await expectShot(USER_A, 5, 2, 'sunk');
    await expectShot(USER_A, 7, 2, 'hit');
    await expectShot(USER_A, 8, 2, 'sunk');
    await expectShot(USER_A, 0, 4, 'hit');
    await expectShot(USER_A, 1, 4, 'sunk');
    await expectShot(USER_A, 0, 6, 'sunk');
    await expectShot(USER_A, 2, 6, 'sunk');
    await expectShot(USER_A, 4, 6, 'sunk');
    // Last patrol boat: sinking it ends the match with the host as winner.
    await expectShot(USER_A, 6, 6, 'sunk');

    const final = await runAs('authenticated', USER_B, 'select status, winner from public.room_state where id = $1', [alphaId]);
    expect(final.rows[0]).toEqual({ status: 'finished', winner: USER_A });
  });

  it('rejects shots after the match finished', async () => {
    await expect(
      runAs('authenticated', USER_A, 'select public.make_shot($1, $2, $3) as result', [alphaId, 9, 8]),
    ).rejects.toThrow(/match is not in progress/i);
  });

  it('authoritative fleets hold the correct final state', async () => {
    const res = await runAsSuperuser(
      'select host_fleet::jsonb as host_fleet, guest_fleet::jsonb as guest_fleet from public.rooms where id = $1',
      [alphaId],
    );
    const hostFleet = res.rows[0].host_fleet as { board: string[][]; ships: Array<{ isSunk: boolean }> };
    const guestFleet = res.rows[0].guest_fleet as { board: string[][]; ships: Array<{ isSunk: boolean }> };

    // Guest fleet: every ship sunk, no untouched ship cells left on the board.
    expect(guestFleet.ships.every((s: { isSunk: boolean }) => s.isSunk)).toBe(true);
    expect(guestFleet.board.flat().filter((c: string) => c === 'ship')).toHaveLength(0);
    expect(guestFleet.board.flat().filter((c: string) => c === 'hit')).toHaveLength(20);

    // Host fleet: only the guest's single hit landed; match not sunk mid-way.
    expect(hostFleet.board[0][0]).toBe('hit');
    expect(hostFleet.ships[0].isSunk).toBe(false);
  });

  it('room_shots: 23 rows for participants, none for outsiders', async () => {
    const asGuest = await runAs('authenticated', USER_B, 'select count(*)::int as n from public.room_shots where room_id = $1', [alphaId]);
    expect(asGuest.rows[0].n).toBe(23);

    const asOutsider = await runAs('authenticated', USER_C, 'select count(*)::int as n from public.room_shots where room_id = $1', [alphaId]);
    expect(asOutsider.rows[0].n).toBe(0);
  });
});
