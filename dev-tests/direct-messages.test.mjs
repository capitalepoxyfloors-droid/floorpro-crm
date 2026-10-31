/**
 * Private one-to-one messages.
 * The database half runs on local Postgres only. It does not contact Supabase.
 * The page half uses a mocked fetch, including ?env=test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const phase1 = read('supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql');
const costing = read('supabase/migrations/20261020120000_crew_costing_columns.sql');
const phase2 = read('supabase/migrations/20261024140000_role_split_rls.sql');
const jobMessages = read('supabase/migrations/20261028170000_job_messages.sql');
const direct = read('supabase/migrations/20261031120000_direct_messages.sql');
const ownerRead = read('supabase/migrations/20261031150000_owner_read_direct_messages.sql');
const rollback = read('supabase/rollback/20261031120000_direct_messages.sql');
const ownerRollback = read('supabase/rollback/20261031150000_owner_read_direct_messages.sql');
const indexHtml = read('index.html');
const db = 'floorpro_dm_test';

const SETH = '11111111-1111-1111-1111-111111111111';
const BREN = '55555555-5555-5555-5555-555555555555';
const CASEY = '66666666-6666-6666-6666-666666666666';
const OFFICE = '33333333-3333-3333-3333-333333333333';
const BOT = '44444444-4444-4444-4444-444444444444';
const OWNER = '22222222-2222-2222-2222-222222222222';

function hasPsql() {
  try { execFileSync('psql', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function psql(database, args, input) {
  return execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-X', '-q', ...args], {
    input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
}
function psqlTuples(database, sql) {
  return psql(database, ['-t', '-A', '-c', sql]).trim();
}
function psqlAdmin(sql) {
  execFileSync('sudo', ['-u', 'postgres', 'psql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql], { encoding: 'utf8' });
}
function claims(sub, role) {
  return JSON.stringify({ sub, app_metadata: { fp_role: role, fp_nonce: 0 } }).replace(/'/g, "''");
}
function asRole(claimsJson, sql, { commit = false, tuples = false } = {}) {
  const end = commit ? 'COMMIT;' : 'ROLLBACK;';
  const args = tuples ? ['-t', '-A', '-f', '-'] : ['-f', '-'];
  return psql(db, args, `
BEGIN;
SELECT set_config('request.jwt.claims', '${claimsJson}', true);
SET LOCAL ROLE authenticated;
${sql}
${end}
`);
}
function asRoleText(claimsJson, sql) {
  try { return asRole(claimsJson, sql); }
  catch (err) { return String(err.stderr || err.stdout || err.message); }
}
function asRoleValue(claimsJson, sql) {
  const lines = asRole(claimsJson, sql, { tuples: true }).trim().split('\n').filter(Boolean);
  return lines[lines.length - 1];
}

const FIXTURE = `
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'authenticator';
  END IF;
END $$;
ALTER ROLE authenticator PASSWORD 'authenticator';
GRANT anon, authenticated, service_role TO authenticator;
GRANT CONNECT ON DATABASE ${db} TO authenticator, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, authenticator;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role, authenticator;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE storage.buckets (
  id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false
);
CREATE TABLE storage.objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text
);
GRANT ALL ON storage.buckets TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.settings (key text PRIMARY KEY, value text);
CREATE TABLE public.crew (
  id serial PRIMARY KEY,
  full_name text, first_name text, last_name text, initials text, color text,
  role text, phone text, specialties text, hourly text, hours text,
  ss text, medicare text, futa text, wc text, gl text, benefits text, pto_days text,
  sort_order int, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.leads (id serial PRIMARY KEY, name text, phone text, value text);
CREATE TABLE public.jobs (
  id serial PRIMARY KEY, customer text, value text, status text, created_at timestamptz DEFAULT now()
);
CREATE TABLE public.materials (
  id serial PRIMARY KEY, name text, price numeric, price_date text
);
CREATE TABLE public.pto_blocks (id serial PRIMARY KEY, crew_idx int, label text);
CREATE TABLE public.scheduled_slots (id serial PRIMARY KEY, label text, crew_idx int);
CREATE TABLE public.vehicles (id serial PRIMARY KEY, name text);
CREATE TABLE public.vehicle_maintenance (id serial PRIMARY KEY, vehicle_id int, cost numeric);
CREATE TABLE public.ops_backups (id serial PRIMARY KEY, note text);
CREATE TABLE public.audit_log (
  id serial PRIMARY KEY, actor text, action text, entity text, details text
);
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_maintenance ENABLE ROW LEVEL SECURITY;
CREATE POLICY anon_all_vehicles ON public.vehicles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY anon_all_vehicle_maintenance ON public.vehicle_maintenance FOR ALL USING (true) WITH CHECK (true);
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;
`;

function policySnapshot() {
  return psqlTuples(db, `
    SELECT coalesce(string_agg(line, chr(10) ORDER BY line), '')
    FROM (
      SELECT c.relname || ' ' || pol.polname || ' ' || pol.polcmd::text || ' ' ||
             coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '') AS line
      FROM pg_policy pol
      JOIN pg_class c ON c.oid = pol.polrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relname NOT IN ('direct_messages', 'direct_message_reads')
    ) s
  `);
}

test('the direct-message files leave the old rules alone', () => {
  assert.match(direct, /nndjnywtkgxwvxajwztg/);
  assert.match(direct, /Do not run this on live/);
  assert.match(direct, /cngbsmmdfxmerlqnkate/);
  assert.equal(/ALTER POLICY/i.test(direct), false);
  assert.equal(/DROP POLICY/i.test(direct), false);
  assert.equal(/GRANT\s[^;]*\bON\s+(TABLE\s+)?public\.crew\b/i.test(direct), false);
  assert.match(direct, /sender_account_id = \(SELECT private\.fp_dm_account_id\(\)\)/);
  assert.match(direct, /recipient_account_id = \(SELECT private\.fp_dm_account_id\(\)\)/);
  assert.match(direct, /REVOKE ALL ON TABLE public\.direct_messages FROM PUBLIC, anon, authenticated/);
  assert.equal(/DROP TABLE[^;]*job_messages/i.test(rollback), false);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.direct_messages/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS private\.fp_dm_account_id\(\)/);
  assert.match(indexHtml, /id="team-direct-list"/);
  assert.match(indexHtml, /id="cv-direct-list"/);
  assert.match(indexHtml, /fp_list_dm_people/);
  assert.match(indexHtml, /fp_post_direct_message/);
  assert.match(indexHtml, /Message '\+name\+' privately'/);
  assert.match(indexHtml, /const _fpUseTest = typeof location !== 'undefined' && new URLSearchParams\(location\.search \|\| ''\)\.get\('env'\) === 'test'/);
  assert.match(ownerRead, /nndjnywtkgxwvxajwztg/);
  assert.match(ownerRead, /Do not run this on live/);
  assert.match(ownerRead, /cngbsmmdfxmerlqnkate/);
  assert.match(ownerRead, /DROP POLICY IF EXISTS fp_direct_messages_select/);
  assert.equal(/DROP POLICY(?! IF EXISTS fp_direct_messages_select)/i.test(ownerRead), false);
  assert.equal(/ALTER TABLE[^;]*job_messages/i.test(ownerRead), false);
  assert.equal(/DROP TABLE[^;]*job_messages/i.test(ownerRead), false);
  assert.match(ownerRead, /\(SELECT private\.fp_role\(\)\) = 'owner'/);
  assert.equal(/fp_is_staff\(\)/.test(ownerRead), false);
  assert.match(ownerRead, /fp_list_all_dm_threads/);
  assert.match(ownerRead, /fp_list_dm_between/);
  assert.match(ownerRollback, /DROP FUNCTION IF EXISTS public\.fp_list_all_dm_threads/);
  assert.match(rollback, /DROP FUNCTION IF EXISTS public\.fp_list_all_dm_threads/);
  assert.match(indexHtml, /id="team-all-dm-list"/);
  assert.match(indexHtml, /Opening it does not mark it read for them/);
});

test('only the two people can read a direct message, and crew still cannot see pay', { skip: hasPsql() ? false : 'psql is not installed' }, () => {
  psqlAdmin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`);
  psqlAdmin(`DROP DATABASE IF EXISTS ${db};`);
  psqlAdmin(`CREATE DATABASE ${db};`);
  psqlAdmin(`ALTER DATABASE ${db} SET search_path TO public, extensions;`);
  const jobs = JSON.stringify([
    { id: 'j1', customer: 'Acme Garage', value: '18500', phone: '314-555-0199', crewNames: 'Seth West' },
  ]).replace(/'/g, "''");
  psql(db, ['-f', '-'], FIXTURE + `
INSERT INTO public.settings (key, value) VALUES
  ('admin_pin', '4821'),
  ('crew_pins', '{"0":"1111","1":"2222","2":"3333"}'),
  ('office_users', '[{"id":"ab12","name":"Pat Office","pin":"3333"},{"id":"bot1","name":"Grok – Ops Manager","pin":"4444"}]'),
  ('job_records', '${jobs}');
INSERT INTO public.crew (full_name, first_name, last_name, initials, color, role, phone, specialties, hourly, hours, sort_order)
VALUES
  ('Seth West', 'Seth', 'West', 'SW', '#6aabff', 'Installer', '555-0101', '[]', '25.00', '40', 0),
  ('Brendon Bennett', 'Brendon', 'Bennett', 'BB', '#3ddc84', 'Installer', '555-0102', '[]', '30.00', '40', 1),
  ('Casey Idle', 'Casey', 'Idle', 'CI', '#cccccc', 'Installer', '555-0199', '[]', '22.00', '40', 2),
  ('Will Bradford', 'Will', 'Bradford', 'WB', '#f5c16c', 'Owner', '555-0100', '[]', '72.11', '40', 3);
`);
  psql(db, ['--single-transaction', '-f', '-'], phase1);
  psql(db, ['-f', '-'], costing);
  psql(db, ['-f', '-'], phase2);
  psql(db, ['-f', '-'], jobMessages);
  psql(db, ['-c', `
    UPDATE public.pin_accounts SET auth_user_id = '${SETH}' WHERE kind = 'crew' AND crew_idx = 0;
    UPDATE public.pin_accounts SET auth_user_id = '${BREN}' WHERE kind = 'crew' AND crew_idx = 1;
    UPDATE public.pin_accounts SET auth_user_id = '${CASEY}' WHERE kind = 'crew' AND crew_idx = 2;
    UPDATE public.pin_accounts SET auth_user_id = '${OFFICE}' WHERE kind = 'office' AND office_id = 'ab12';
    UPDATE public.pin_accounts SET auth_user_id = '${BOT}' WHERE kind = 'office' AND office_id = 'bot1';
    UPDATE public.pin_accounts SET auth_user_id = '${OWNER}' WHERE kind = 'owner';
    INSERT INTO public.settings (key, value) VALUES ('crew_inactive', '{"2":true}')
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
  `]);

  const beforePolicies = policySnapshot();
  const beforeHourly = psqlTuples(db, `SELECT has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT')`);
  assert.equal(beforeHourly, 'f');
  psql(db, ['-f', '-'], direct);
  psql(db, ['-f', '-'], ownerRead);
  assert.equal(policySnapshot(), beforePolicies, 'existing policies changed');
  assert.equal(psqlTuples(db, `SELECT has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_column_privilege('authenticated', 'public.crew', 'phone', 'SELECT')`), 'f');
  assert.equal(psqlTuples(db, `SELECT c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'direct_messages'`), 't');

  const pin = (authUser) => psqlTuples(db, `SELECT id FROM public.pin_accounts WHERE auth_user_id = '${authUser}'`);
  const sethId = pin(SETH);
  const brenId = pin(BREN);
  const caseyId = pin(CASEY);
  const botId = pin(BOT);
  const ownerId = pin(OWNER);
  const officeId = pin(OFFICE);
  assert.match(sethId, /^[0-9a-f-]{36}$/);

  const ownerClaims = claims(OWNER, 'owner');
  const sethClaims = claims(SETH, 'crew');
  const brenClaims = claims(BREN, 'crew');
  const botClaims = claims(BOT, 'office');
  const officeClaims = claims(OFFICE, 'office');

  const people = JSON.parse(asRoleValue(sethClaims, `SELECT public.fp_list_dm_people()::text;`));
  const labels = people.map((p) => p.label).sort();
  assert.deepEqual(labels, ['Brendon Bennett', 'Grok – Ops Manager', 'Pat Office', 'Will Bradford']);
  assert.equal(people.some((p) => p.label === 'Casey Idle'), false);
  assert.equal(people.some((p) => p.label === 'Seth West'), false);
  for (const person of people) {
    assert.deepEqual(Object.keys(person).sort(), ['account_id', 'kind', 'label', 'unread']);
  }
  assert.equal(JSON.stringify(people).includes('555-'), false);
  assert.equal(JSON.stringify(people).includes('25.00'), false);
  assert.equal(JSON.stringify(people).includes('$2'), false);

  asRole(ownerClaims, `SELECT public.fp_post_direct_message('${botId}'::uuid, 'owner-bot-secret');`, { commit: true });
  asRole(sethClaims, `SELECT public.fp_post_direct_message('${brenId}'::uuid, 'seth-brendon-note');`, { commit: true });

  const botSees = asRoleValue(botClaims, `SELECT public.fp_list_direct_messages('${ownerId}'::uuid)::text;`);
  assert.match(botSees, /owner-bot-secret/);
  assert.equal(botSees.includes('seth-brendon-note'), false);
  const ownerSees = asRoleValue(ownerClaims, `SELECT public.fp_list_direct_messages('${botId}'::uuid)::text;`);
  assert.match(ownerSees, /owner-bot-secret/);
  assert.equal(ownerSees.includes('seth-brendon-note'), false);

  const sethLooksAtBot = asRoleValue(sethClaims, `SELECT public.fp_list_direct_messages('${botId}'::uuid)::text;`);
  assert.equal(sethLooksAtBot.includes('owner-bot-secret'), false, sethLooksAtBot);
  assert.equal(sethLooksAtBot.includes('seth-brendon-note'), false, sethLooksAtBot);
  const brenSees = asRoleValue(brenClaims, `SELECT public.fp_list_direct_messages('${sethId}'::uuid)::text;`);
  assert.match(brenSees, /seth-brendon-note/);
  assert.equal(brenSees.includes('owner-bot-secret'), false);

  const sethPeople = JSON.parse(asRoleValue(sethClaims, `SELECT public.fp_list_dm_people()::text;`));
  assert.equal(sethPeople.find((p) => p.account_id === brenId).unread, 0);
  const brenPeople = JSON.parse(asRoleValue(brenClaims, `SELECT public.fp_list_dm_people()::text;`));
  assert.equal(brenPeople.find((p) => p.account_id === sethId).unread, 1);

  const readsBefore = psqlTuples(db, `SELECT account_id::text || ' ' || peer_account_id::text || ' ' || last_read_at::text FROM public.direct_message_reads ORDER BY 1`);
  const ownerWatch = asRoleValue(ownerClaims, `SELECT public.fp_list_dm_between('${sethId}'::uuid, '${brenId}'::uuid)::text;`);
  assert.match(ownerWatch, /seth-brendon-note/);
  assert.match(ownerWatch, /"watch_only": true/);
  assert.equal(ownerWatch.includes('owner-bot-secret'), false);
  const allThreads = JSON.parse(asRoleValue(ownerClaims, `SELECT public.fp_list_all_dm_threads()::text;`));
  assert.equal(allThreads.some((t) => {
    const names = [t.label_a, t.label_b].sort();
    return names[0] === 'Brendon Bennett' && names[1] === 'Seth West' && t.mine === false;
  }), true);
  const readsAfter = psqlTuples(db, `SELECT account_id::text || ' ' || peer_account_id::text || ' ' || last_read_at::text FROM public.direct_message_reads ORDER BY 1`);
  assert.equal(readsAfter, readsBefore, 'owner reading changed a read cursor');
  const brenStill = JSON.parse(asRoleValue(brenClaims, `SELECT public.fp_list_dm_people()::text;`));
  assert.equal(brenStill.find((p) => p.account_id === sethId).unread, 1);
  assert.match(asRoleText(officeClaims, `SELECT public.fp_list_dm_between('${sethId}'::uuid, '${brenId}'::uuid);`), /not allowed/);
  assert.match(asRoleText(officeClaims, `SELECT public.fp_list_all_dm_threads();`), /not allowed/);
  assert.match(asRoleText(sethClaims, `SELECT public.fp_list_dm_between('${ownerId}'::uuid, '${botId}'::uuid);`), /not allowed/);
  assert.match(asRoleText(sethClaims, `SELECT public.fp_list_all_dm_threads();`), /not allowed/);

  assert.match(asRoleText(brenClaims, `SELECT public.fp_list_job_messages('j1');`), /not allowed/);
  assert.match(asRoleValue(ownerClaims, `SELECT public.fp_list_job_messages('j1')::text;`), /Acme|j1|messages/);
  asRole(sethClaims, `SELECT public.fp_post_job_message('team', 'company hello', '[]'::jsonb);`, { commit: true });
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.job_messages WHERE body = 'owner-bot-secret' OR body = 'seth-brendon-note'`), '0');
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.direct_messages WHERE body = 'company hello'`), '0');

  assert.match(asRoleText(sethClaims, `SELECT public.fp_post_direct_message('${sethId}'::uuid, 'me');`), /not allowed/);
  assert.match(asRoleText(sethClaims, `SELECT public.fp_post_direct_message('${caseyId}'::uuid, 'hey casey');`), /not allowed/);
  assert.match(asRoleText(sethClaims, `SELECT public.fp_post_direct_message('${botId}'::uuid, '');`), /not allowed/);
  assert.match(asRoleText(sethClaims, `SELECT public.fp_post_direct_message('${botId}'::uuid, '${'x'.repeat(2001)}');`), /not allowed/);
  assert.match(asRoleText(claims('99999999-9999-9999-9999-999999999999', 'crew'), `SELECT public.fp_list_dm_people();`), /not allowed/);

  const secretId = psqlTuples(db, `SELECT id FROM public.direct_messages WHERE body = 'owner-bot-secret'`);
  const noteId = psqlTuples(db, `SELECT id FROM public.direct_messages WHERE body = 'seth-brendon-note'`);
  assert.match(asRoleText(ownerClaims, `SELECT public.fp_hide_direct_message('${noteId}'::uuid);`), /not allowed/);
  assert.equal(psqlTuples(db, `SELECT deleted_at IS NULL FROM public.direct_messages WHERE id = '${noteId}'`), 't');
  assert.match(asRoleText(botClaims, `SELECT public.fp_hide_direct_message('${secretId}'::uuid);`), /not allowed/);
  asRole(ownerClaims, `SELECT public.fp_hide_direct_message('${secretId}'::uuid);`, { commit: true });
  assert.equal(psqlTuples(db, `SELECT deleted_at IS NULL FROM public.direct_messages WHERE id = '${secretId}'`), 'f');
  assert.equal(asRoleValue(botClaims, `SELECT public.fp_list_direct_messages('${ownerId}'::uuid)::text;`).includes('owner-bot-secret'), false);

  const edit = asRoleText(ownerClaims, `UPDATE public.direct_messages SET body = 'hacked' WHERE id = '${noteId}';`);
  assert.match(edit, /permission denied|not allowed/i);
  assert.equal(psqlTuples(db, `SELECT body FROM public.direct_messages WHERE id = '${noteId}'`), 'seth-brendon-note');

  assert.match(asRoleText(sethClaims, `SELECT body FROM public.direct_messages;`), /permission denied/i);
  psql(db, ['-c', `GRANT SELECT ON public.direct_messages TO authenticated;`]);
  const sethRows = asRoleValue(sethClaims, `SELECT coalesce(string_agg(body, '|'), '') FROM public.direct_messages;`);
  assert.equal(sethRows, 'seth-brendon-note');
  const officeRows = asRoleValue(officeClaims, `SELECT coalesce(string_agg(body, '|'), '') FROM public.direct_messages;`);
  assert.equal(officeRows.includes('seth-brendon-note'), false, officeRows);
  assert.equal(officeRows.includes('owner-bot-secret'), false, officeRows);
  const ownerRows = asRoleValue(ownerClaims, `SELECT coalesce(string_agg(body, '|'), '') FROM public.direct_messages;`);
  assert.match(ownerRows, /seth-brendon-note/);
  psql(db, ['-c', `REVOKE SELECT ON public.direct_messages FROM authenticated;`]);

  psql(db, ['-c', `GRANT SELECT ON public.direct_message_reads TO authenticated;`]);
  const sethReads = asRoleValue(sethClaims, `SELECT count(*) FROM public.direct_message_reads WHERE account_id <> '${sethId}';`);
  assert.equal(sethReads, '0');
  psql(db, ['-c', `REVOKE SELECT ON public.direct_message_reads FROM authenticated;`]);

  psql(db, ['-c', `GRANT INSERT ON public.direct_messages TO authenticated;`]);
  const inserted = asRoleText(sethClaims, `
    INSERT INTO public.direct_messages (sender_account_id, recipient_account_id, author_label, author_kind, body)
    VALUES ('${sethId}', '${botId}', 'Seth', 'crew', 'sneaky');
  `);
  assert.match(inserted, /row-level security|permission denied/i);
  psql(db, ['-c', `REVOKE INSERT ON public.direct_messages FROM authenticated;`]);
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.direct_messages WHERE body = 'sneaky'`), '0');

  const audit = psqlTuples(db, `SELECT coalesce(string_agg(details, '|'), '') FROM public.audit_log WHERE action LIKE 'dm_%'`);
  assert.match(audit, /private/);
  assert.equal(audit.includes('owner-bot-secret'), false, audit);
  assert.equal(audit.includes('seth-brendon-note'), false, audit);

  assert.match(asRoleText(sethClaims, `SELECT hourly FROM public.crew;`), /permission denied/i);
  assert.match(asRoleText(sethClaims, `SELECT phone FROM public.crew;`), /permission denied/i);
  const crewPrivate = asRoleValue(sethClaims, `SELECT count(*) FROM public.crew_private;`);
  assert.equal(crewPrivate, '0');
  const matPrivate = asRoleValue(sethClaims, `SELECT count(*) FROM public.materials_private;`);
  assert.equal(matPrivate, '0');
  const officePay = asRoleValue(officeClaims, `SELECT hourly FROM public.crew_private WHERE crew_id = (SELECT id FROM public.crew WHERE full_name = 'Seth West');`);
  assert.equal(officePay, '25.00');

  assert.equal(psqlTuples(db, `SELECT has_function_privilege('anon', 'public.fp_post_direct_message(uuid, text)', 'EXECUTE')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('authenticated', 'public.fp_list_direct_messages(uuid)', 'EXECUTE')`), 't');

  psql(db, ['-f', '-'], ownerRollback);
  assert.match(asRoleText(ownerClaims, `SELECT public.fp_list_all_dm_threads();`), /does not exist|not allowed/i);
  psql(db, ['-c', `GRANT SELECT ON public.direct_messages TO authenticated;`]);
  const ownerAfterUndo = asRoleValue(ownerClaims, `SELECT coalesce(string_agg(body, '|'), '') FROM public.direct_messages;`);
  assert.equal(ownerAfterUndo.includes('seth-brendon-note'), false, ownerAfterUndo);
  const sethAfterUndo = asRoleValue(sethClaims, `SELECT coalesce(string_agg(body, '|'), '') FROM public.direct_messages;`);
  assert.equal(sethAfterUndo, 'seth-brendon-note');
  psql(db, ['-c', `REVOKE SELECT ON public.direct_messages FROM authenticated;`]);
  assert.equal(policySnapshot(), beforePolicies, 'owner rollback changed an existing policy');

  psql(db, ['-f', '-'], rollback);
  assert.equal(policySnapshot(), beforePolicies, 'rollback changed an existing policy');
  assert.equal(psqlTuples(db, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'direct_messages'`), '0');
  assert.equal(psqlTuples(db, `SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = 'fp_list_dm_people'`), '0');
  assert.match(asRoleText(sethClaims, `SELECT hourly FROM public.crew;`), /permission denied/i);
  assert.match(asRoleValue(sethClaims, `SELECT public.fp_list_job_messages('team')::text;`), /company hello/);
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.job_messages WHERE deleted_at IS NULL`), '1');
});

test('tapping a person opens a private thread on the test page', async () => {
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const bot = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const seth = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

  function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
  }
  function mockFetch(url, opts = {}) {
    const u = String(url);
    let body = null;
    if (opts.body && typeof opts.body === 'string') {
      try { body = JSON.parse(opts.body); } catch { body = opts.body; }
    }
    calls.push({ url: u, body });
    if (u.includes('/functions/v1/pin-login')) return Promise.resolve(jsonResponse({ accounts: [] }));
    if (u.includes('/rpc/fp_list_dm_between')) {
      return Promise.resolve(jsonResponse({
        account_a: body.account_a,
        account_b: body.account_b,
        peer_label: 'Seth West · Grok – Ops Manager',
        private: true,
        watch_only: true,
        me: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        can_post: false,
        can_hide: false,
        manual_read: true,
        mention_choices: [],
        messages: [{
          id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
          body: 'seth-brendon-note',
          created_at: '2026-10-31T15:04:00Z',
          author_label: 'Seth West',
          author_kind: 'crew',
          author_account_id: seth,
          mentions: [],
          seen_by: [],
          seen_count: 0,
        }],
      }));
    }
    if (u.includes('/rpc/fp_list_direct_messages')) {
      return Promise.resolve(jsonResponse({
        peer_id: body.peer_id,
        peer_label: 'Grok – Ops Manager',
        private: true,
        me: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
        last_read_at: null,
        can_post: true,
        can_hide: false,
        manual_read: true,
        mention_choices: [],
        messages: [{
          id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          body: 'Bring the extra grinder',
          created_at: '2026-10-31T15:00:00Z',
          author_label: 'Grok – Ops Manager',
          author_kind: 'office',
          author_account_id: bot,
          mentions: [],
          seen_by: [],
          seen_count: 0,
        }],
      }));
    }
    if (u.includes('/rpc/fp_post_direct_message')) return Promise.resolve(jsonResponse({ ok: true, id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee' }));
    if (u.includes('/rpc/fp_list_job_messages')) {
      return Promise.resolve(jsonResponse({
        job_id: 'team', me: 'cccccccc-cccc-cccc-cccc-cccccccccccc', last_read_at: null,
        can_post: true, can_hide: false, manual_read: true,
        mention_choices: [{ account_id: seth, label: 'Seth West' }],
        messages: [],
      }));
    }
    if (u.includes('/rpc/fp_list_dm_people')) {
      return Promise.resolve(jsonResponse([
        { account_id: bot, label: 'Grok – Ops Manager', kind: 'office', unread: 2 },
        { account_id: seth, label: 'Seth West', kind: 'crew', unread: 0 },
      ]));
    }
    if (u.includes('/rpc/fp_unread_job_messages')) return Promise.resolve(jsonResponse([{ job_id: 'team', unread: 1, mentioned: 0 }]));
    if (u.includes('/rest/v1/')) return Promise.resolve(jsonResponse([]));
    return Promise.resolve(new Response('', { status: 200 }));
  }

  const dom = new JSDOM(indexHtml, {
    url: 'http://127.0.0.1/?env=test',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    virtualConsole,
    beforeParse(window) {
      window.fetch = mockFetch;
      window.AbortController = AbortController;
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
    },
  });
  const w = dom.window;
  try {
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(w.eval('_fpUseTest'), true);
    assert.match(w.eval('SUPABASE_URL'), /nndjnywtkgxwvxajwztg/);
    assert.doesNotMatch(w.eval('SUPABASE_URL'), /cngbsmmdfxmerlqnkate/);

    w.eval(`
      localStorage.setItem('fpAuth_v2', JSON.stringify({
        access_token:'tok', refresh_token:'ref', expires_at: Date.now()+3600000,
        ts: Date.now(), user_id:'user-1', kind:'owner'
      }));
      _msgOn = true;
      _msgDmOn = true;
      _sessionAuthed = true;
      _accessToken = 'tok';
      _refreshToken = 'ref';
      _accessExp = Date.now() + 3600000;
      _sessionUserId = 'user-1';
      _msgUnread = [{job_id:'team', unread:1, mentioned:0}];
      _msgPeople = [
        {account_id:'${bot}', label:'Grok – Ops Manager', kind:'office', unread:2},
        {account_id:'${seth}', label:'Seth West', kind:'crew', unread:0}
      ];
      document.getElementById('page-team').classList.add('active');
      msgPaintPeople();
      msgPaintBadges();
    `);

    const list = w.document.getElementById('team-direct-list');
    const buttons = [...list.querySelectorAll('button')];
    assert.deepEqual(buttons.map((b) => b.dataset.dmLabel), ['Grok – Ops Manager', 'Seth West']);
    assert.equal(buttons[0].classList.contains('msg-chip'), true);
    assert.equal(buttons[0].dataset.unread, '2');
    assert.equal(buttons[0].querySelector('.msg-dm-count').textContent, '2');
    assert.equal(w.document.getElementById('nav-team-badge').textContent, '3');
    assert.equal(w.document.getElementById('team-msg-body').placeholder, 'Message the whole company');

    buttons[0].click();
    await new Promise((r) => setTimeout(r, 40));
    const box = w.document.getElementById('team-msg-body');
    assert.equal(box.placeholder, 'Message Grok – Ops Manager privately');
    assert.equal(box.getAttribute('aria-label'), 'Message Grok – Ops Manager privately');
    assert.equal(w.document.getElementById('team-title').textContent, 'Grok – Ops Manager');
    assert.equal(w.document.getElementById('team-subtitle').textContent, 'Only you and Grok – Ops Manager can read this.');
    assert.equal(w.document.getElementById('team-dm-back').style.display, '');
    assert.match(w.document.getElementById('team-msg-list').textContent, /Bring the extra grinder/);
    assert.equal(w.document.getElementById('team-dm-' + bot).classList.contains('on'), true);

    box.value = 'On my way';
    await w.eval('msgSend("team")');
    const posted = calls.find((c) => c.url.includes('/rpc/fp_post_direct_message'));
    assert.ok(posted, 'expected a private send');
    assert.equal(posted.body.peer_id, bot);
    assert.equal(posted.body.body, 'On my way');
    assert.equal(calls.some((c) => c.url.includes('/rpc/fp_post_job_message')), false);

    w.document.getElementById('team-dm-back').click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(w.document.getElementById('team-msg-body').placeholder, 'Message the whole company');
    assert.equal(w.document.getElementById('team-title').textContent, 'Team');
    assert.equal(w.document.getElementById('team-mention-' + seth).textContent, 'Seth West');

    const beforeMarks = calls.filter((c) => c.url.includes('/rpc/fp_mark_direct_thread_read')).length;
    w.eval(`
      _msgAllOn = true;
      _msgAllThreads = [{
        account_a:'${seth}', label_a:'Seth West',
        account_b:'${bot}', label_b:'Grok – Ops Manager',
        mine:false, peer_id:null
      }];
      msgPaintAllThreads();
    `);
    const pair = w.document.getElementById('team-all-dm-' + seth + '-' + bot);
    assert.equal(pair.textContent, 'Seth West · Grok – Ops Manager');
    pair.click();
    await new Promise((r) => setTimeout(r, 40));
    assert.equal(w.document.getElementById('team-title').textContent, 'Seth West · Grok – Ops Manager');
    assert.equal(w.document.getElementById('team-subtitle').textContent, 'You can read this. Opening it does not mark it read for them.');
    assert.match(w.document.getElementById('team-msg-list').textContent, /seth-brendon-note/);
    assert.equal(w.document.getElementById('team-msg-compose') || w.document.getElementById('team-msg-body').closest('.msg-compose').style.display, 'none');
    assert.equal(calls.filter((c) => c.url.includes('/rpc/fp_mark_direct_thread_read')).length, beforeMarks);
  } finally {
    try {
      w.eval(`
        clearTimeout(_autoLockTimer);
        clearInterval(window._msgTimer);
        if (window._fpMediaHydrator) window._fpMediaHydrator.disconnect();
        const max = setTimeout(() => {}, 0);
        for (let i = 0; i <= max; i++) { clearTimeout(i); clearInterval(i); }
      `);
    } catch { /* window already gone */ }
    try { w.close(); } catch { /* timers */ }
  }
});
