/**
 * Applies the security migration to a local Postgres (not Supabase).
 * Proves PIN hashes, that anon sees nothing, and that a signed-in role
 * cannot read the PIN rows. Skips only when psql is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationPath = path.join(root, 'supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql');

function hasPsql() {
  try {
    execFileSync('psql', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function psql(db, args, input) {
  return execFileSync('sudo', [
    '-u', 'postgres', 'psql',
    '-d', db,
    '-v', 'ON_ERROR_STOP=1',
    '-X', '-q',
    ...args,
  ], { input, encoding: 'utf8' });
}

function psqlTuples(db, sql) {
  return psql(db, ['-t', '-A', '-c', sql]).trim();
}

function psqlAdmin(sql) {
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql],
    { encoding: 'utf8' });
}

function recreate(db, sql) {
  psqlAdmin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`);
  psqlAdmin(`DROP DATABASE IF EXISTS ${db};`);
  psqlAdmin(`CREATE DATABASE ${db};`);
  psql(db, ['-f', '-'], sql);
}

const FIXTURE = `
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS auth;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT COALESCE(NULLIF(current_setting('request.jwt.claims', true), ''), '{}')::jsonb;
$$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(auth.jwt() ->> 'sub', '')::uuid;
$$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY,
  name text NOT NULL,
  public boolean NOT NULL DEFAULT false
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id text,
  name text
);
GRANT ALL ON storage.buckets TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.settings (key text PRIMARY KEY, value text);
CREATE TABLE public.crew (
  id serial PRIMARY KEY,
  full_name text,
  sort_order int,
  created_at timestamptz DEFAULT now()
);
CREATE TABLE public.leads (id serial PRIMARY KEY, name text);
CREATE TABLE public.jobs (id serial PRIMARY KEY, customer text);
CREATE TABLE public.materials (id serial PRIMARY KEY, name text);
CREATE TABLE public.pto_blocks (id serial PRIMARY KEY, crew_idx int);
CREATE TABLE public.scheduled_slots (id serial PRIMARY KEY, label text);
CREATE TABLE public.vehicles (id serial PRIMARY KEY, name text);
CREATE TABLE public.vehicle_maintenance (id serial PRIMARY KEY, vehicle_id int);
CREATE TABLE public.audit_log (
  id serial PRIMARY KEY,
  actor text,
  action text,
  entity text,
  details text
);

ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_maintenance ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all_vehicles ON public.vehicles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY anon_all_vehicle_maintenance ON public.vehicle_maintenance FOR ALL USING (true) WITH CHECK (true);

GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
`;

const SAMPLE = `
INSERT INTO public.settings (key, value) VALUES
  ('admin_pin', '4821'),
  ('crew_pins', '{"0":"1111","1":"2222"}'),
  ('office_users', '[{"id":"ab12","name":"Pat Office","pin":"3333"}]'),
  ('job_records', '[{"customer":"Acme Garage"}]');
INSERT INTO public.crew (full_name, sort_order) VALUES ('Seth West', 0), ('Brendon Bennett', 1);
INSERT INTO public.jobs (customer) VALUES ('Acme Garage');
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle-docs', 'vehicle-docs', true);
INSERT INTO storage.objects (bucket_id, name) VALUES ('vehicle-docs', 'jobs/photo.jpg');
`;

test('security migration hashes PINs and locks out the anon key', { skip: hasPsql() ? false : 'psql is not installed' }, () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const db = 'floorpro_sec_test';
  recreate(db, FIXTURE + SAMPLE);
  psql(db, ['--single-transaction', '-f', '-'], migration);

  assert.equal(psqlTuples(db, `SELECT value FROM public.settings WHERE key = 'admin_pin'`), '4821');
  assert.equal(psqlTuples(db, `SELECT public FROM storage.buckets WHERE id = 'vehicle-docs'`), 'f');

  const anonView = psqlTuples(db, `
    BEGIN;
    SET LOCAL ROLE anon;
    SELECT 'jobs=' || count(*)::text FROM public.jobs;
    SELECT 'settings=' || count(*)::text FROM public.settings;
    SELECT 'objects=' || count(*)::text FROM storage.objects;
    ROLLBACK;
  `);
  assert.match(anonView, /jobs=0/);
  assert.match(anonView, /settings=0/);
  assert.match(anonView, /objects=0/);

  let anonWrite = '';
  try {
    psqlTuples(db, `
      BEGIN;
      SET LOCAL ROLE anon;
      INSERT INTO public.jobs (customer) VALUES ('should fail');
      ROLLBACK;
    `);
  } catch (err) {
    anonWrite = String(err.stderr || err.stdout || err.message);
  }
  assert.match(anonWrite, /row-level security|permission denied/i);

  const crewId = '11111111-1111-1111-1111-111111111111';
  const ownerId = '22222222-2222-2222-2222-222222222222';
  psql(db, ['-c', `UPDATE public.pin_accounts SET auth_user_id = '${crewId}' WHERE kind = 'crew' AND crew_idx = 0`]);
  psql(db, ['-c', `UPDATE public.pin_accounts SET auth_user_id = '${ownerId}' WHERE kind = 'owner'`]);
  psql(db, ['-c', `INSERT INTO public.settings (key, value) VALUES ('crew_inactive', '{}') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`]);

  const stranger = psqlTuples(db, `
    BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"33333333-3333-3333-3333-333333333333","app_metadata":{"fp_role":"owner","fp_nonce":0}}', true);
    SET LOCAL ROLE authenticated;
    SELECT 'jobs=' || count(*)::text FROM public.jobs;
    ROLLBACK;
  `);
  assert.match(stranger, /jobs=0/);

  const metadataOnly = psqlTuples(db, `
    BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${ownerId}","user_metadata":{"fp_role":"owner","fp_nonce":0}}', true);
    SET LOCAL ROLE authenticated;
    SELECT 'jobs=' || count(*)::text FROM public.jobs;
    ROLLBACK;
  `);
  assert.match(metadataOnly, /jobs=0/);

  const crewClaims = `{"sub":"${crewId}","app_metadata":{"fp_role":"crew","fp_nonce":0}}`;
  const authView = psqlTuples(db, `
    BEGIN;
    SELECT set_config('request.jwt.claims', '${crewClaims}', true);
    SET LOCAL ROLE authenticated;
    SELECT 'jobs=' || count(*)::text FROM public.jobs;
    SELECT 'job_records=' || count(*)::text FROM public.settings WHERE key = 'job_records';
    SELECT 'pins=' || count(*)::text FROM public.settings WHERE key IN ('admin_pin', 'crew_pins', 'office_users');
    SELECT 'objects=' || count(*)::text FROM storage.objects;
    ROLLBACK;
  `);
  assert.match(authView, /jobs=1/);
  assert.match(authView, /job_records=1/);
  assert.match(authView, /pins=0/);
  assert.match(authView, /objects=1/);

  let crewInactiveWrite = '';
  try {
    crewInactiveWrite = psqlTuples(db, `
      BEGIN;
      SELECT set_config('request.jwt.claims', '${crewClaims}', true);
      SET LOCAL ROLE authenticated;
      UPDATE public.settings SET value = '{"0":{"since":"2026-01-01"}}' WHERE key = 'crew_inactive';
      SELECT value FROM public.settings WHERE key = 'crew_inactive';
      ROLLBACK;
    `);
  } catch (err) {
    crewInactiveWrite = String(err.stderr || err.stdout || err.message);
  }
  assert.equal(crewInactiveWrite.includes('2026-01-01'), false);
  assert.match(crewInactiveWrite, /\{\}|row-level security|permission denied/i);

  const ownerClaims = `{"sub":"${ownerId}","app_metadata":{"fp_role":"owner","fp_nonce":0}}`;
  const ownerWrite = psqlTuples(db, `
    BEGIN;
    SELECT set_config('request.jwt.claims', '${ownerClaims}', true);
    SET LOCAL ROLE authenticated;
    UPDATE public.settings SET value = '{"0":{"since":"2026-01-01","name":"Seth West"}}' WHERE key = 'crew_inactive';
    SELECT value FROM public.settings WHERE key = 'crew_inactive';
    ROLLBACK;
  `);
  assert.match(ownerWrite, /Seth West/);

  psql(db, ['-c', `UPDATE public.settings SET value = '{"0":{"since":"2026-01-01"}}' WHERE key = 'crew_inactive'`]);
  const inactiveCrew = psqlTuples(db, `
    BEGIN;
    SELECT set_config('request.jwt.claims', '${crewClaims}', true);
    SET LOCAL ROLE authenticated;
    SELECT 'jobs=' || count(*)::text FROM public.jobs;
    ROLLBACK;
  `);
  assert.match(inactiveCrew, /jobs=0/);
  psql(db, ['-c', `UPDATE public.settings SET value = '{}' WHERE key = 'crew_inactive'`]);

  psql(db, ['-c', `UPDATE public.pin_accounts SET auth_user_id = NULL WHERE kind = 'crew' AND crew_idx = 0`]);
  const unlinked = psqlTuples(db, `
    BEGIN;
    SELECT set_config('request.jwt.claims', '${crewClaims}', true);
    SET LOCAL ROLE authenticated;
    SELECT 'jobs=' || count(*)::text FROM public.jobs;
    ROLLBACK;
  `);
  assert.match(unlinked, /jobs=0/);

  let pinRead = '';
  try {
    psqlTuples(db, `
      BEGIN;
      SET LOCAL ROLE authenticated;
      SELECT count(*) FROM public.pin_accounts;
      ROLLBACK;
    `);
  } catch (err) {
    pinRead = String(err.stderr || err.stdout || err.message);
  }
  assert.match(pinRead, /permission denied/i);

  const rows = psqlTuples(db, `
    SELECT kind || '|' || COALESCE(crew_idx::text, '') || '|' || COALESCE(office_id, '') || '|' || pin_hash
    FROM public.pin_accounts
    ORDER BY kind, crew_idx NULLS FIRST, office_id NULLS FIRST
  `).split('\n').filter(Boolean);
  const expected = {
    'owner||': '4821',
    'crew|0|': '1111',
    'crew|1|': '2222',
    'office||ab12': '3333',
  };
  assert.equal(rows.length, 4);
  for (const line of rows) {
    const hashAt = line.lastIndexOf('|');
    const key = line.slice(0, hashAt);
    const hash = line.slice(hashAt + 1);
    assert.match(hash, /^\$2a\$08\$/);
    assert.equal(bcrypt.compareSync(expected[key], hash), true, key);
    assert.equal(psqlTuples(db, `SELECT extensions.crypt('${expected[key]}', '${hash}') = '${hash}'`), 't');
  }
  const ownerHash = rows.find(r => r.startsWith('owner|')).split('|').pop();
  assert.equal(bcrypt.compareSync('0000', ownerHash), false);

  const label = psqlTuples(db, `SELECT label FROM public.pin_accounts WHERE kind = 'crew' AND crew_idx = 0`);
  assert.equal(label, 'Seth West');

  const insertPolicy = psqlTuples(db, `
    SELECT pg_get_expr(polwithcheck, polrelid)
    FROM pg_policy WHERE polname = 'fp_settings_insert'
  `);
  assert.match(insertPolicy, /SELECT auth\.jwt\(\)/);

  const userA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const userB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const sessA = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
  const sessB = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
  psql(db, ['-c', `
    CREATE TABLE auth.users (id uuid PRIMARY KEY);
    CREATE TABLE auth.sessions (
      id uuid PRIMARY KEY,
      user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE
    );
    CREATE TABLE auth.refresh_tokens (
      id bigserial PRIMARY KEY,
      token varchar(255),
      user_id varchar(255),
      session_id uuid REFERENCES auth.sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE auth.mfa_amr_claims (
      id uuid PRIMARY KEY,
      session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE
    );
    INSERT INTO auth.users VALUES ('${userA}'), ('${userB}');
    INSERT INTO auth.sessions VALUES ('${sessA}', '${userA}'), ('${sessB}', '${userB}');
    INSERT INTO auth.refresh_tokens (token, user_id, session_id) VALUES
      ('tok-a', '${userA}', '${sessA}'),
      ('tok-a-nosession', '${userA}', NULL),
      ('tok-b', '${userB}', '${sessB}');
    INSERT INTO auth.mfa_amr_claims VALUES ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '${sessA}');
  `]);

  const revoked = psqlTuples(db, `
    BEGIN;
    SET LOCAL ROLE service_role;
    SELECT public.fp_revoke_sessions('${userA}'::uuid);
    RESET ROLE;
    SELECT 'sessions_a=' || count(*)::text FROM auth.sessions WHERE user_id = '${userA}';
    SELECT 'refresh_a=' || count(*)::text FROM auth.refresh_tokens WHERE user_id = '${userA}';
    SELECT 'amr_a=' || count(*)::text FROM auth.mfa_amr_claims;
    SELECT 'sessions_b=' || count(*)::text FROM auth.sessions WHERE user_id = '${userB}';
    SELECT 'refresh_b=' || count(*)::text FROM auth.refresh_tokens WHERE user_id = '${userB}';
    ROLLBACK;
  `);
  assert.match(revoked, /sessions_a=0/);
  assert.match(revoked, /refresh_a=0/);
  assert.match(revoked, /amr_a=0/);
  assert.match(revoked, /sessions_b=1/);
  assert.match(revoked, /refresh_b=1/);

  for (const role of ['anon', 'authenticated']) {
    let denied = '';
    try {
      psqlTuples(db, `
        BEGIN;
        SET LOCAL ROLE ${role};
        SELECT public.fp_revoke_sessions('${userB}'::uuid);
        ROLLBACK;
      `);
    } catch (err) {
      denied = String(err.stderr || err.stdout || err.message);
    }
    assert.match(denied, /permission denied/i, role);
  }

  const stillThere = psqlTuples(db, `
    SELECT count(*) FROM auth.sessions WHERE user_id = '${userB}'
  `);
  assert.equal(stillThere, '1');
});

test('migration refuses to run when the manager code was not saved', { skip: hasPsql() ? false : 'psql is not installed' }, () => {
  const migration = fs.readFileSync(migrationPath, 'utf8');
  const db = 'floorpro_sec_nopin';
  recreate(db, FIXTURE);
  let message = '';
  try {
    psql(db, ['--single-transaction', '-f', '-'], migration);
  } catch (err) {
    message = String(err.stderr || err.stdout || err.message);
  }
  assert.match(message, /No usable admin_pin/);
  const tables = psqlTuples(db, `SELECT to_regclass('public.pin_accounts')`);
  assert.equal(tables, '', 'a failed migration must not leave pin_accounts behind');
});
