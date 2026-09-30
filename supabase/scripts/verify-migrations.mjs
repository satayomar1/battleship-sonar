#!/usr/bin/env node
// Standalone verifier for migrations 0001 + 0002 + 0003.
// Mirrors supabase/__tests__/security.test.ts 1:1, but runs in a single plain
// Node process: this machine cannot fit a vitest worker (vite transform +
// PGlite WASM) in free memory. Use `npm test` where vitest is runnable;
// use this script in constrained environments:
//   node supabase/scripts/verify-migrations.mjs
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';

const migrationsDir = join(process.cwd(), 'supabase', 'migrations');
const readMigration = (name) => readFileSync(join(migrationsDir, name), 'utf8');

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

// --- mini test harness ------------------------------------------------------

const tests = [];
const it = (name, fn) => tests.push([name, fn]);
const describe = (_name, body) => body(); // groups run inline; order is preserved

async function assertRejects(fn, pattern, label) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  if (!err) throw new Error(`${label}: expected rejection but the call succeeded`);
  const msg = String((err && err.message) || err);
  if (pattern && !pattern.test(msg)) {
    throw new Error(`${label}: got "${msg}", expected match ${pattern}`);
  }
}

const plain = (rows) => rows.map((r) => ({ ...r }));

// --- database helpers -------------------------------------------------------

const db = new PGlite();
let alphaId = ''; // room created by A, joined by B, full battle
let bravoId = ''; // room used for save_fleet validation lifecycle

async function runAsSuperuser(sql, params = []) {
  return db.query(sql, params);
}

async function runAs(role, uid, sql, params = []) {
  await db.exec('reset role');
  await db.exec(`set role ${role}`);
  await db.query('select set_config($1, $2, false)', [
    'request.jwt.claims',
    uid === null ? '' : JSON.stringify({ sub: uid }),
  ]);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claims', '', false)");
  }
}

// --- fleet fixtures ----------------------------------------------------------

const VALID_LAYOUT = [
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
const WRONG_COMPOSITION = [
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

function fleetJson(specs, overrides = []) {
  const board = Array.from({ length: 10 }, () => Array(10).fill('empty'));
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

function mutateFleet(json, mutate) {
  const fleet = JSON.parse(json);
  mutate(fleet);
  return JSON.stringify(fleet);
}

const VALID_FLEET = fleetJson(VALID_LAYOUT);

// ============================================================================
// Setup: bootstrap + 0001 + users + 0002 applied twice (idempotency)
// ============================================================================

async function setup() {
  await db.exec(BOOTSTRAP);
  await db.exec(readMigration('0001_init.sql'));

  const users = [
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
  await db.exec(readMigration('0002_security_fixes.sql'));
  await db.exec(readMigration('0003_live_security_alignment.sql'));
  await db.exec(readMigration('0003_live_security_alignment.sql'));
}

// ============================================================================
// Catalog: policies, privileges, function grants after 0002
// ============================================================================

describe('0002 migration state', () => {
  it('has no client-facing profiles policies after 0003', async () => {
    const res = await runAsSuperuser(
      `select policyname, cmd from pg_policies
       where schemaname = 'public' and tablename = 'profiles'
       order by policyname`,
    );
    assert.deepEqual(plain(res.rows), []);
  });

  it('applies the final application policies after 0003', async () => {
    const res = await runAsSuperuser(
      `select tablename, policyname from pg_policies
       where schemaname = 'public'
         and tablename in ('matches', 'moves', 'rooms', 'room_shots')
       order by tablename, policyname`,
    );
    assert.deepEqual(plain(res.rows), [
      { tablename: 'matches', policyname: 'matches: insert own' },
      { tablename: 'matches', policyname: 'matches: select own' },
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
    assert.deepEqual(
      plain(res.rows).map((r) => r.column_name),
      ['code', 'created_at', 'guest_id', 'host_id', 'id', 'status', 'turn_player', 'updated_at', 'winner'],
    );
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
    assert.deepEqual(plain(res.rows), [
      {
        auth_host_fleet: false,
        auth_guest_fleet: false,
        auth_table_select: false,
        anon_table_select: false,
        auth_table_update: false,
        anon_table_update: false,
      },
    ]);
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
    assert.deepEqual(plain(res.rows), [
      {
        auth_view: true,
        anon_view: false,
        auth_shots: true,
        anon_shots: false,
        auth_shots_insert: false,
        auth_shots_update: false,
        auth_shots_delete: false,
      },
    ]);
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
      assert.deepEqual(plain(res.rows), [{ anon_exec: false, auth_exec: true }], rpc);
    }
  });

  it('room_state view exposes no fleet columns', async () => {
    const res = await runAsSuperuser(
      `select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'room_state'
       order by column_name`,
    );
    const columns = plain(res.rows).map((r) => r.column_name);
    assert.deepEqual(columns, [
      'code', 'created_at', 'guest_id', 'host_id', 'id',
      'status', 'turn_player', 'updated_at', 'winner',
    ]);
    assert.ok(!columns.includes('host_fleet'));
    assert.ok(!columns.includes('guest_fleet'));
  });

  it('handle_new_user cannot be invoked directly (trigger-only)', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select public.handle_new_user()'),
      /trigger functions can only be/i,
      'handle_new_user',
    );
  });
});

// ============================================================================
// Profiles RLS
// ============================================================================

describe('client least privilege after 0003', () => {
  it('gives profiles no direct client grants and denies direct reads', async () => {
    const grants = await runAsSuperuser(
      `select grantee, privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name = 'profiles'
         and grantee in ('anon', 'authenticated')
       order by grantee, privilege_type`,
    );
    assert.deepEqual(plain(grants.rows), []);

    await assertRejects(
      () => runAs('anon', null, 'select display_name from public.profiles where id = $1', [USER_A]),
      /permission denied/i,
      'anon profiles read',
    );

    await assertRejects(
      () => runAs('authenticated', USER_A, 'select display_name from public.profiles where id = $1', [USER_A]),
      /permission denied/i,
      'authenticated profiles read',
    );
  });

  it('grants authenticated exactly SELECT and INSERT on matches, and nothing to anon', async () => {
    const auth = await runAsSuperuser(
      `select privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name = 'matches'
         and grantee = 'authenticated'
       order by privilege_type`,
    );

    assert.deepEqual(
      plain(auth.rows).map((r) => r.privilege_type),
      ['INSERT', 'SELECT'],
    );

    const anon = await runAsSuperuser(
      `select privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name = 'matches'
         and grantee = 'anon'
       order by privilege_type`,
    );

    assert.deepEqual(plain(anon.rows), []);
  });

  it('denies authenticated UPDATE and DELETE on matches', async () => {
    await assertRejects(
      () => runAs(
        'authenticated',
        USER_A,
        'update public.matches set result = result where player_id = $1',
        [USER_A],
      ),
      /permission denied/i,
      'matches update',
    );

    await assertRejects(
      () => runAs(
        'authenticated',
        USER_A,
        'delete from public.matches where player_id = $1',
        [USER_A],
      ),
      /permission denied/i,
      'matches delete',
    );
  });

  it('gives moves no direct client privileges', async () => {
    const grants = await runAsSuperuser(
      `select grantee, privilege_type
       from information_schema.role_table_grants
       where table_schema = 'public'
         and table_name = 'moves'
         and grantee in ('anon', 'authenticated')
       order by grantee, privilege_type`,
    );

    assert.deepEqual(plain(grants.rows), []);

    await assertRejects(
      () => runAs('authenticated', USER_A, 'select * from public.moves'),
      /permission denied/i,
      'authenticated moves read',
    );
  });

  it('targets every remaining client application policy to authenticated only', async () => {
    const res = await runAsSuperuser(
      `select tablename, policyname, roles::text as roles
       from pg_policies
       where schemaname = 'public'
         and tablename in ('matches', 'moves', 'profiles', 'rooms', 'room_shots')
       order by tablename, policyname`,
    );

    const rows = plain(res.rows);

    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.roles, '{authenticated}');
    }
  });
});
// ============================================================================
// create_room
// ============================================================================

describe('create_room validation', () => {
  it('rejects malformed room codes', async () => {
    for (const code of ['alp', 'ABC', 'ABCDEFG', '', 'A B1', 'ТЕСТ']) {
      await assertRejects(
        () => runAs('authenticated', USER_A, 'select public.create_room($1) as id', [code]),
        /invalid room code/i,
        `code ${JSON.stringify(code)}`,
      );
    }
  });

  it('rejects unauthenticated callers', async () => {
    await assertRejects(
      () => runAs('authenticated', null, 'select public.create_room($1) as id', ['NOATH']),
      /not authenticated/i,
      'unauthenticated',
    );
  });

  it('rejects anon role at the privilege level', async () => {
    await assertRejects(
      () => runAs('anon', null, 'select public.create_room($1) as id', ['ANON1']),
      /permission denied/i,
      'anon role',
    );
  });

  it('creates a room and is idempotent for the same host', async () => {
    const res = await runAs('authenticated', USER_A, 'select public.create_room($1) as id', ['ALPHA']);
    alphaId = res.rows[0].id;
    assert.ok(alphaId);

    const again = await runAs('authenticated', USER_A, 'select public.create_room($1) as id', ['ALPHA']);
    assert.equal(again.rows[0].id, alphaId);
  });

  it('rejects another host taking an existing code', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_B, 'select public.create_room($1) as id', ['ALPHA']),
      /room code already taken/i,
      'code collision',
    );
  });
});

// ============================================================================
// Rooms: hidden fleets are never readable
// ============================================================================

describe('rooms hidden-state isolation', () => {
  it('denies SELECT on fleet columns for participants', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select host_fleet from public.rooms where id = $1', [alphaId]),
      /permission denied/i,
      'host_fleet',
    );
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select guest_fleet from public.rooms where id = $1', [alphaId]),
      /permission denied/i,
      'guest_fleet',
    );
  });

  it('denies SELECT * on rooms (star includes fleet columns)', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select * from public.rooms where id = $1', [alphaId]),
      /permission denied/i,
      'select star',
    );
  });

  it('lets participants read the safe columns, outsiders see nothing', async () => {
    const safe = 'select id, code, status, host_id, guest_id, turn_player, winner, created_at, updated_at from public.rooms where id = $1';
    const asHost = await runAs('authenticated', USER_A, safe, [alphaId]);
    assert.equal(asHost.rows.length, 1);
    assert.equal(asHost.rows[0].code, 'ALPHA');

    const asOutsider = await runAs('authenticated', USER_C, safe, [alphaId]);
    assert.equal(asOutsider.rows.length, 0);
  });

  it('serves room_state to participants only', async () => {
    const asHost = await runAs('authenticated', USER_A, 'select * from public.room_state where id = $1', [alphaId]);
    assert.equal(asHost.rows.length, 1);
    assert.equal(asHost.rows[0].status, 'waiting');

    const asOutsider = await runAs('authenticated', USER_C, 'select * from public.room_state where id = $1', [alphaId]);
    assert.equal(asOutsider.rows.length, 0);
  });

  it('has no fleet columns on room_state (querying them fails)', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select host_fleet from public.room_state where id = $1', [alphaId]),
      /column .* does not exist/i,
      'room_state host_fleet',
    );
  });

  it('denies anon reads of room_state and room_shots', async () => {
    await assertRejects(
      () => runAs('anon', null, 'select * from public.room_state'),
      /permission denied/i,
      'anon room_state',
    );
    await assertRejects(
      () => runAs('anon', null, 'select * from public.room_shots'),
      /permission denied/i,
      'anon room_shots',
    );
    await assertRejects(
      () => runAs('anon', null, 'select * from public.rooms'),
      /permission denied/i,
      'anon rooms',
    );
  });

  it('denies direct writes to rooms and room_shots (RPC-only mutations)', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_A, "update public.rooms set status = 'finished' where id = $1", [alphaId]),
      /permission denied/i,
      'update rooms',
    );
    await assertRejects(
      () => runAs('authenticated', USER_A,
        "insert into public.room_shots (room_id, shooter, x, y, result) values ($1, $2, 0, 0, 'hit')",
        [alphaId, USER_A]),
      /permission denied/i,
      'insert room_shots',
    );
    await assertRejects(
      () => runAs('authenticated', USER_A, "update public.room_shots set result = 'sunk'"),
      /permission denied/i,
      'update room_shots',
    );
    await assertRejects(
      () => runAs('authenticated', USER_A, 'delete from public.room_shots'),
      /permission denied/i,
      'delete room_shots',
    );
  });
});

// ============================================================================
// join_room
// ============================================================================

describe('join_room', () => {
  it('rejects unknown codes', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_D, 'select public.join_room($1) as id', ['ZZZZ']),
      /room not found/i,
      'unknown code',
    );
  });

  it('lets the guest join a waiting room', async () => {
    const res = await runAs('authenticated', USER_B, 'select public.join_room($1) as id', ['ALPHA']);
    assert.equal(res.rows[0].id, alphaId);

    const state = await runAs('authenticated', USER_A, 'select guest_id, status, turn_player from public.room_state where id = $1', [alphaId]);
    assert.equal(state.rows[0].guest_id, USER_B);
    assert.equal(state.rows[0].status, 'placement');
    assert.equal(state.rows[0].turn_player, USER_A);
  });

  it('rejects a third player once the room left the waiting state', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_C, 'select public.join_room($1) as id', ['ALPHA']),
      /not open for joining/i,
      'third player',
    );
  });

  it('reconnect of an already-joined guest is side-effect free', async () => {
    const res = await runAs('authenticated', USER_B, 'select public.join_room($1) as id', ['ALPHA']);
    assert.equal(res.rows[0].id, alphaId);
    const state = await runAs('authenticated', USER_A, 'select status, guest_id from public.room_state where id = $1', [alphaId]);
    assert.equal(state.rows[0].status, 'placement');
    assert.equal(state.rows[0].guest_id, USER_B);
  });
});

// ============================================================================
// save_fleet: server-side validation
// ============================================================================

const BENT = VALID_LAYOUT.map((s) =>
  s.id === 'cruiser' ? { ...s, positions: [[0, 2], [1, 2], [0, 3]] } : s,
);
const GAPPED = VALID_LAYOUT.map((s) =>
  s.id === 'cruiser' ? { ...s, positions: [[0, 2], [1, 2], [3, 2]] } : s,
);
const TOUCHING = VALID_LAYOUT.map((s) =>
  s.id === 'patrol2' ? { ...s, positions: [[1, 6]] } : s,
);
const DIAGONAL = VALID_LAYOUT.map((s) =>
  s.id === 'patrol2' ? { ...s, positions: [[1, 5]] } : s,
);
const OVERLAPPING = VALID_LAYOUT.map((s) =>
  s.id === 'patrol2' ? { ...s, positions: [[0, 6]] } : s,
);

const INVALID_FLEETS = [
  ['not an object', JSON.stringify([1, 2, 3]), /expected an object with board and ships/i],
  ['missing ships key', JSON.stringify({ board: Array.from({ length: 10 }, () => Array(10).fill('empty')) }), /expected an object with board and ships/i],
  ['board with 9 rows', mutateFleet(VALID_FLEET, (f) => f.board.pop()), /board must be a 10x10 array/i],
  ['board row with 9 cells', mutateFleet(VALID_FLEET, (f) => f.board[3].pop()), /board row 3 must have 10 cells/i],
  ['board cell with a battle state', mutateFleet(VALID_FLEET, (f) => { f.board[0][0] = 'hit'; }), /must be empty or ship/i],
  ['only 19 ship cells', mutateFleet(VALID_FLEET, (f) => { f.board[6][6] = 'empty'; }), /exactly 20 ship cells/i],
  ['only 9 ships', mutateFleet(VALID_FLEET, (f) => f.ships.pop()), /exactly 10 ships/i],
  ['preset hits', mutateFleet(VALID_FLEET, (f) => { f.ships[0].hits = 1; }), /hits must be 0/i],
  ['preset sunk flag', mutateFleet(VALID_FLEET, (f) => { f.ships[0].isSunk = true; }), /must not be sunk/i],
  ['missing ship id', mutateFleet(VALID_FLEET, (f) => { delete f.ships[0].id; }), /ship id is required/i],
  ['ship size out of range', mutateFleet(VALID_FLEET, (f) => { f.ships[0].size = 5; }), /size must be an integer/i],
  ['positions count mismatch', mutateFleet(VALID_FLEET, (f) => f.ships[0].positions.pop()), /must have exactly .* positions/i],
  ['out of bounds coordinate', mutateFleet(VALID_FLEET, (f) => { f.ships[7].positions[0] = { x: 10, y: 0 }; }), /invalid position coordinates/i],
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
    bravoId = res.rows[0].id;
    assert.ok(bravoId);
  });

  it('rejects every invalid fleet without mutating state', async () => {
    for (const [name, fleet, message] of INVALID_FLEETS) {
      await assertRejects(
        () => runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, fleet]),
        message,
        name,
      );
    }
    const res = await runAsSuperuser(
      'select host_fleet is null as empty, status from public.rooms where id = $1',
      [bravoId],
    );
    assert.equal(res.rows[0].empty, true);
    assert.equal(res.rows[0].status, 'waiting');
  });

  it('rejects shots before the battle starts', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select public.make_shot($1, $2, $3) as result', [bravoId, 0, 0]),
      /match is not in progress/i,
      'shot before battle',
    );
  });

  it('accepts a valid fleet while the room is waiting', async () => {
    await runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, VALID_FLEET]);
    const res = await runAsSuperuser(
      'select host_fleet is not null as saved, status from public.rooms where id = $1',
      [bravoId],
    );
    assert.equal(res.rows[0].saved, true);
    assert.equal(res.rows[0].status, 'waiting');
  });

  it('lets the guest join and save, which starts the battle with host first', async () => {
    await runAs('authenticated', USER_B, 'select public.join_room($1) as id', ['BRAVO']);
    await runAs('authenticated', USER_B, 'select public.save_fleet($1, false, $2::jsonb)', [bravoId, VALID_FLEET]);

    const state = await runAs('authenticated', USER_B, 'select status, turn_player, winner from public.room_state where id = $1', [bravoId]);
    assert.equal(state.rows[0].status, 'playing');
    assert.equal(state.rows[0].turn_player, USER_A);
    assert.equal(state.rows[0].winner, null);
  });

  it('blocks joining a room once the battle started (mid-game join)', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_D, 'select public.join_room($1) as id', ['BRAVO']),
      /not open for joining/i,
      'mid-game join',
    );
  });

  it('host reconnect mid-game does not reset the match', async () => {
    const res = await runAs('authenticated', USER_A, 'select public.join_room($1) as id', ['BRAVO']);
    assert.equal(res.rows[0].id, bravoId);
    const state = await runAs('authenticated', USER_A, 'select status, turn_player from public.room_state where id = $1', [bravoId]);
    assert.equal(state.rows[0].status, 'playing');
    assert.equal(state.rows[0].turn_player, USER_A);
  });

  it('rejects saving a fleet after the battle started, without mutating it', async () => {
    const before = await runAsSuperuser('select host_fleet::text as fleet from public.rooms where id = $1', [bravoId]);
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, VALID_FLEET]),
      /after the battle has started/i,
      'save after start',
    );
    const after = await runAsSuperuser('select host_fleet::text as fleet from public.rooms where id = $1', [bravoId]);
    assert.equal(after.rows[0].fleet, before.rows[0].fleet);
  });

  it('rejects role impersonation and unknown rooms', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_B, 'select public.save_fleet($1, true, $2::jsonb)', [bravoId, VALID_FLEET]),
      /not host/i,
      'guest as host',
    );
    await assertRejects(
      () => runAs('authenticated', USER_C, 'select public.save_fleet($1, false, $2::jsonb)', [bravoId, VALID_FLEET]),
      /not guest/i,
      'outsider as guest',
    );
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [
        '99999999-9999-4999-8999-999999999999',
        VALID_FLEET,
      ]),
      /room not found/i,
      'unknown room',
    );
  });
});

// ============================================================================
// make_shot: the full scripted battle on ALPHA
// ============================================================================

describe('make_shot battle', () => {
  it('saves both fleets and starts the battle', async () => {
    await runAs('authenticated', USER_A, 'select public.save_fleet($1, true, $2::jsonb)', [alphaId, VALID_FLEET]);
    await runAs('authenticated', USER_B, 'select public.save_fleet($1, false, $2::jsonb)', [alphaId, VALID_FLEET]);
    const state = await runAs('authenticated', USER_A, 'select status, turn_player from public.room_state where id = $1', [alphaId]);
    assert.equal(state.rows[0].status, 'playing');
    assert.equal(state.rows[0].turn_player, USER_A);
  });

  it('plays the scripted battle with correct results and turn transitions', async () => {
    const shot = (uid, x, y) =>
      runAs('authenticated', uid, 'select public.make_shot($1, $2, $3) as result', [alphaId, x, y]);
    const expectShot = async (uid, x, y, result) => {
      const res = await shot(uid, x, y);
      assert.equal(res.rows[0].result, result, `shot (${x},${y}) by ${uid.slice(0, 8)}`);
    };
    const turn = async () => {
      const res = await runAs('authenticated', USER_A, 'select turn_player, status from public.room_state where id = $1', [alphaId]);
      return res.rows[0];
    };

    // Host opens on the guest carrier (0,0)-(3,0): hit, hit, hit, sunk.
    await expectShot(USER_A, 0, 0, 'hit');
    await assertRejects(() => shot(USER_A, 0, 0), /duplicate shot/i, 'duplicate shot');
    await assertRejects(() => shot(USER_B, 5, 0), /not your turn/i, 'out of turn');
    await expectShot(USER_A, 1, 0, 'hit');
    await expectShot(USER_A, 2, 0, 'hit');
    await expectShot(USER_A, 3, 0, 'sunk');

    // Host misses: turn passes to the guest.
    await expectShot(USER_A, 0, 1, 'miss');
    let t = await turn();
    assert.equal(t.turn_player, USER_B);
    assert.equal(t.status, 'playing');

    // Guest hits (keeps turn), then misses (turn back to host).
    await expectShot(USER_B, 0, 0, 'hit');
    await expectShot(USER_B, 9, 9, 'miss');
    t = await turn();
    assert.equal(t.turn_player, USER_A);
    assert.equal(t.status, 'playing');

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
    assert.equal(final.rows[0].status, 'finished');
    assert.equal(final.rows[0].winner, USER_A);
  });

  it('rejects shots after the match finished', async () => {
    await assertRejects(
      () => runAs('authenticated', USER_A, 'select public.make_shot($1, $2, $3) as result', [alphaId, 9, 8]),
      /match is not in progress/i,
      'shot after finish',
    );
  });

  it('authoritative fleets hold the correct final state', async () => {
    const res = await runAsSuperuser(
      'select host_fleet::jsonb as host_fleet, guest_fleet::jsonb as guest_fleet from public.rooms where id = $1',
      [alphaId],
    );
    const hostFleet = res.rows[0].host_fleet;
    const guestFleet = res.rows[0].guest_fleet;

    // Guest fleet: every ship sunk, no untouched ship cells left on the board.
    assert.equal(guestFleet.ships.every((s) => s.isSunk), true);
    assert.equal(guestFleet.board.flat().filter((c) => c === 'ship').length, 0);
    assert.equal(guestFleet.board.flat().filter((c) => c === 'hit').length, 20);

    // Host fleet: only the guest's single hit landed; match not sunk mid-way.
    assert.equal(hostFleet.board[0][0], 'hit');
    assert.equal(hostFleet.ships[0].isSunk, false);
  });

  it('room_shots: 23 rows for participants, none for outsiders', async () => {
    const asGuest = await runAs('authenticated', USER_B, 'select count(*)::int as n from public.room_shots where room_id = $1', [alphaId]);
    assert.equal(asGuest.rows[0].n, 23);

    const asOutsider = await runAs('authenticated', USER_C, 'select count(*)::int as n from public.room_shots where room_id = $1', [alphaId]);
    assert.equal(asOutsider.rows[0].n, 0);
  });
});

// --- runner ------------------------------------------------------------------

const t0 = Date.now();
try {
  await setup();
} catch (err) {
  console.error(`SETUP FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
}

let passed = 0;
const failures = [];
for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  FAIL  ${name}\n        ${err && err.message ? err.message : err}`);
  }
}
await db.close().catch(() => {});

console.log('');
console.log(`Migration verification: ${passed} passed, ${failures.length} failed (${tests.length} total, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
if (failures.length > 0) process.exit(1);
