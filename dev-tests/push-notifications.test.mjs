/**
 * Phone notifications.
 * The database half runs on local Postgres only. It does not contact Supabase.
 * The page half uses a mocked fetch, including ?env=test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM, ResourceLoader, VirtualConsole } from 'jsdom';
import {
  classifyPushStatus,
  notificationPayload,
  payloadKeys,
  pushPreview,
} from '../supabase/functions/send-push/push-preview.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const phase1 = read('supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql');
const costing = read('supabase/migrations/20261020120000_crew_costing_columns.sql');
const phase2 = read('supabase/migrations/20261024140000_role_split_rls.sql');
const jobMessages = read('supabase/migrations/20261028170000_job_messages.sql');
const direct = read('supabase/migrations/20261031120000_direct_messages.sql');
const ownerRead = read('supabase/migrations/20261031150000_owner_read_direct_messages.sql');
const pushSql = read('supabase/migrations/20261031180000_push_notifications.sql');
const rollback = read('supabase/rollback/20261031180000_push_notifications.sql');
const indexHtml = read('index.html');
const sw = read('sw.js');
const manifest = JSON.parse(read('manifest.json'));
const manifestTest = JSON.parse(read('manifest-test.json'));
const sender = read('supabase/functions/send-push/index.ts');
const db = 'floorpro_push_test';

const SETH = '11111111-1111-1111-1111-111111111111';
const BREN = '55555555-5555-5555-5555-555555555555';
const CASEY = '66666666-6666-6666-6666-666666666666';
const OFFICE = '33333333-3333-3333-3333-333333333333';
const BOT = '44444444-4444-4444-4444-444444444444';
const OWNER = '22222222-2222-2222-2222-222222222222';
const PEER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
        AND c.relname NOT IN ('push_subscriptions', 'push_prefs')
    ) s
  `);
}

test('lock-screen text is the sender and the first line only', () => {
  const preview = pushPreview('Seth West', 'Bring the grinder\nRate is $25.00 call 314-555-0199');
  assert.equal(preview.title, 'Seth West');
  assert.equal(preview.body, 'Bring the grinder');
  const redacted = pushPreview('Pat Office', 'Rate is $25.00 call 314-555-0199 today\nsecond line');
  assert.equal(redacted.body.includes('$'), false);
  assert.equal(redacted.body.includes('314'), false);
  assert.equal(redacted.body.includes('second'), false);
  assert.match(redacted.body, /Rate is/);
  assert.equal(pushPreview('', '   ').body, 'New message');
  const note = notificationPayload({
    title: 'Seth West',
    body: 'Pay the crew $72.11 at 555-0101',
    open: 'dm',
    peer: PEER,
    tag: 'm:abc',
    badge: 4,
    subscriptions: [{ endpoint: 'https://push.example/secret', p256dh: 'key', auth_key: 'auth' }],
  }, 'https://capitalepoxyfloors-droid.github.io');
  assert.deepEqual(Object.keys(note).sort(), payloadKeys().sort());
  assert.equal(JSON.stringify(note).includes('72.11'), false);
  assert.equal(JSON.stringify(note).includes('555-0101'), false);
  assert.equal(JSON.stringify(note).includes('push.example'), false);
  assert.equal(note.badge, 4);
  assert.match(note.url, /\/floorpro-crm\/\?env=test&open=dm&peer=/);
  assert.equal(classifyPushStatus(410), 'gone');
  assert.equal(classifyPushStatus(404), 'gone');
  assert.equal(classifyPushStatus(201), 'sent');
  assert.equal(classifyPushStatus(500), 'failed');
});

test('manifests install on the GitHub Pages path, and the worker does not cache the app', () => {
  for (const file of [manifest, manifestTest]) {
    assert.equal(file.display, 'standalone');
    assert.equal(file.scope, '/floorpro-crm/');
    assert.ok(file.icons.some((icon) => icon.sizes === '192x192' && icon.src.includes('/floorpro-crm/icon.png')));
    assert.ok(file.icons.some((icon) => icon.sizes === '512x512'));
  }
  assert.equal(manifest.start_url, '/floorpro-crm/');
  assert.equal(manifestTest.start_url, '/floorpro-crm/?env=test');
  assert.match(manifestTest.id, /env=test/);
  assert.equal(/addEventListener\(\s*['"]fetch['"]/.test(sw), false);
  assert.match(sw, /setAppBadge/);
  assert.match(sw, /notificationclick/);
  assert.match(sw, /showNotification/);
  assert.match(indexHtml, /manifest-test\.json/);
  assert.match(indexHtml, /Turn on notifications/);
  assert.match(indexHtml, /Add to Home Screen/);
  assert.match(indexHtml, /iOS 16\.4/);
  assert.match(indexHtml, /id="push-banner-team"/);
  assert.match(indexHtml, /id="push-banner-cv"/);
  assert.match(indexHtml, /id="push-banner-settings"/);
  assert.match(indexHtml, /fpSetAppBadge\(fpUnreadTotal\(\)\)/);
  assert.match(pushSql, /nndjnywtkgxwvxajwztg/);
  assert.match(pushSql, /Do not run this on live/);
  assert.match(pushSql, /cngbsmmdfxmerlqnkate/);
  assert.equal(/ALTER POLICY/i.test(pushSql), false);
  assert.equal(/DROP POLICY/i.test(pushSql), false);
  assert.equal(/GRANT\s[^;]*\bON\s+(TABLE\s+)?public\.crew\b/i.test(pushSql), false);
  assert.match(pushSql, /account_id = \(SELECT private\.fp_dm_account_id\(\)\)/);
  assert.match(rollback, /DROP TABLE IF EXISTS public\.push_subscriptions/);
  assert.equal(/DROP TABLE[^;]*job_messages/i.test(rollback), false);
  assert.equal(/DROP TABLE[^;]*direct_messages/i.test(rollback), false);
  assert.match(sender, /nndjnywtkgxwvxajwztg/);
  assert.match(sender, /cngbsmmdfxmerlqnkate/);
  assert.match(sender, /classifyPushStatus/);
  assert.match(sender, /notificationPayload/);
  assert.equal(sender.includes('hourly'), false);
  assert.equal(sender.includes('pin_hash'), false);
});

test('pushes follow the thread rules and each login keeps only its own subscription', { skip: hasPsql() ? false : 'psql is not installed' }, () => {
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
  psql(db, ['-f', '-'], direct);
  psql(db, ['-f', '-'], ownerRead);
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
  const beforePhone = psqlTuples(db, `SELECT has_column_privilege('authenticated', 'public.crew', 'phone', 'SELECT')`);
  assert.equal(beforeHourly, 'f');
  assert.equal(beforePhone, 'f');
  psql(db, ['-f', '-'], pushSql);
  assert.equal(policySnapshot(), beforePolicies, 'existing policies changed');
  assert.equal(psqlTuples(db, `SELECT has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_column_privilege('authenticated', 'public.crew', 'phone', 'SELECT')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('authenticated', 'public.fp_push_plan(text, uuid)', 'EXECUTE')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('anon', 'public.fp_push_runtime_config()', 'EXECUTE')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('authenticated', 'public.fp_push_runtime_config()', 'EXECUTE')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('service_role', 'public.fp_push_plan(text, uuid)', 'EXECUTE')`), 't');

  const pin = (authUser) => psqlTuples(db, `SELECT id FROM public.pin_accounts WHERE auth_user_id = '${authUser}'`);
  const sethId = pin(SETH);
  const brenId = pin(BREN);
  const ownerId = pin(OWNER);
  const officeId = pin(OFFICE);
  const botId = pin(BOT);
  const sethClaims = claims(SETH, 'crew');
  const brenClaims = claims(BREN, 'crew');
  const ownerClaims = claims(OWNER, 'owner');
  const officeClaims = claims(OFFICE, 'office');

  const endpoint = 'https://push.example/device-one';
  const endpoint2 = 'https://push.example/device-two';
  asRole(sethClaims, `SELECT public.fp_save_push_subscription('${endpoint}', 'p256dh-key-value-pad', 'auth-key');`, { commit: true });
  const sethSees = asRoleValue(sethClaims, `SELECT endpoint FROM public.push_subscriptions;`);
  assert.equal(sethSees, endpoint);
  const brenSeesNone = asRoleValue(brenClaims, `SELECT count(*) FROM public.push_subscriptions;`);
  assert.equal(brenSeesNone, '0');
  const stolen = asRoleText(brenClaims, `
    INSERT INTO public.push_subscriptions (account_id, endpoint, p256dh, auth_key)
    VALUES ('${sethId}', 'https://push.example/stolen-endpoint', 'p256dh-key-value-pad', 'auth-key');
  `);
  assert.match(stolen, /row-level security|permission denied/i);
  asRole(brenClaims, `SELECT public.fp_save_push_subscription('${endpoint}', 'p256dh-key-value-new', 'auth-new');`, { commit: true });
  const ownerOfEndpoint = psqlTuples(db, `SELECT account_id::text || ' ' || p256dh FROM public.push_subscriptions WHERE endpoint = '${endpoint}'`);
  assert.equal(ownerOfEndpoint, `${brenId} p256dh-key-value-new`);
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.push_subscriptions WHERE account_id = '${sethId}'`), '0');
  asRole(brenClaims, `SELECT public.fp_save_push_subscription('${endpoint2}', 'p256dh-key-value-two', 'auth-two');`, { commit: true });

  const status = JSON.parse(asRoleValue(brenClaims, `SELECT public.fp_push_status()::text;`));
  assert.equal(status.ready, false);
  assert.equal(status.team_alerts, false);
  assert.equal(status.public_key, null);
  assert.deepEqual(status.endpoints.sort(), [endpoint, endpoint2].sort());
  assert.equal(JSON.stringify(status).includes('p256dh'), false);
  asRole(ownerClaims, `SELECT public.fp_set_team_push(true);`, { commit: true });
  assert.equal(JSON.parse(asRoleValue(ownerClaims, `SELECT public.fp_push_status()::text;`)).team_alerts, true);
  assert.equal(JSON.parse(asRoleValue(sethClaims, `SELECT public.fp_push_status()::text;`)).team_alerts, false);
  assert.match(asRoleText(sethClaims, `SELECT public.fp_push_plan('direct_messages', gen_random_uuid());`), /permission denied/i);
  assert.match(asRoleText(ownerClaims, `SELECT public.fp_push_runtime_config();`), /permission denied/i);

  asRole(sethClaims, `SELECT public.fp_post_direct_message('${brenId}'::uuid, 'Bring the grinder');`, { commit: true });
  const dmId = psqlTuples(db, `SELECT id FROM public.direct_messages WHERE body = 'Bring the grinder'`);
  const dmPlan = JSON.parse(psqlTuples(db, `SELECT private.fp_push_plan('direct_messages', '${dmId}'::uuid)::text`));
  assert.deepEqual(dmPlan.map((row) => row.account_id).sort(), [brenId].sort());
  assert.equal(dmPlan[0].title, 'Seth West');
  assert.equal(dmPlan[0].body, 'Bring the grinder');
  assert.equal(dmPlan[0].open, 'dm');
  assert.equal(dmPlan[0].peer, sethId);
  assert.equal(dmPlan[0].badge >= 1, true);
  assert.equal(dmPlan[0].subscriptions.length, 2);
  assert.equal(JSON.stringify(dmPlan).includes('555-'), false);
  assert.equal(JSON.stringify(dmPlan).includes('25.00'), false);
  assert.equal(JSON.stringify(dmPlan).includes('72.11'), false);
  assert.equal(JSON.stringify(dmPlan).includes('18500'), false);

  asRole(officeClaims, `SELECT public.fp_post_job_message('j1', $body$${`Rate is $25.00 call 314-555-0199 today
second line`}$body$, '[]'::jsonb);`, { commit: true });
  const jobId = psqlTuples(db, `SELECT id FROM public.job_messages WHERE job_id = 'j1'`);
  const jobPlan = JSON.parse(psqlTuples(db, `SELECT private.fp_push_plan('job_messages', '${jobId}'::uuid)::text`));
  const jobWho = jobPlan.map((row) => row.account_id).sort();
  assert.deepEqual(jobWho, [botId, ownerId, sethId].sort());
  assert.equal(jobWho.includes(brenId), false);
  assert.equal(jobWho.includes(officeId), false);
  for (const row of jobPlan) {
    assert.equal(row.open, 'job');
    assert.equal(row.job, 'j1');
    assert.equal(row.body.includes('$'), false);
    assert.equal(row.body.includes('314'), false);
    assert.equal(row.body.includes('second'), false);
    assert.equal(row.title, 'Pat Office');
    assert.equal(JSON.stringify(row).includes('Acme'), false);
    assert.equal(JSON.stringify(row).includes('18500'), false);
  }

  asRole(sethClaims, `SELECT public.fp_set_team_push(true);`, { commit: true });
  asRole(sethClaims, `SELECT public.fp_post_job_message('team', 'hello company', '${JSON.stringify([brenId])}'::jsonb);`, { commit: true });
  const teamId = psqlTuples(db, `SELECT id FROM public.job_messages WHERE body = 'hello company'`);
  const teamPlan = JSON.parse(psqlTuples(db, `SELECT private.fp_push_plan('job_messages', '${teamId}'::uuid)::text`));
  const teamWho = teamPlan.map((row) => row.account_id).sort();
  assert.deepEqual(teamWho, [brenId, ownerId].sort());
  assert.equal(teamWho.includes(sethId), false);
  assert.equal(teamWho.includes(officeId), false);
  assert.equal(teamWho.includes(botId), false);
  assert.equal(teamPlan.every((row) => row.open === 'team'), true);

  const posted = psqlTuples(db, `SELECT count(*) FROM public.job_messages WHERE body = 'hello company'`);
  assert.equal(posted, '1');

  psql(db, ['-f', '-'], rollback);
  assert.equal(policySnapshot(), beforePolicies, 'rollback changed an existing policy');
  assert.equal(psqlTuples(db, `SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'push_subscriptions'`), '0');
  assert.equal(psqlTuples(db, `SELECT count(*) FROM pg_trigger WHERE tgname = 'fp_job_messages_push'`), '0');
  assert.equal(psqlTuples(db, `SELECT has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT')`), 'f');
  assert.match(asRoleValue(sethClaims, `SELECT public.fp_list_job_messages('team')::text;`), /hello company/);
  asRole(officeClaims, `SELECT public.fp_post_job_message('team', 'still works', '[]'::jsonb);`, { commit: true });
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.job_messages WHERE body = 'still works'`), '1');
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
}

async function bootPage(url, userAgent) {
  const calls = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', () => {});
  const badges = [];
  const dom = new JSDOM(indexHtml, {
    url,
    resources: new ResourceLoader({ userAgent }),
    runScripts: 'dangerously',
    pretendToBeVisual: false,
    virtualConsole,
    beforeParse(window) {
      window.fetch = (u, opts = {}) => {
        let body = null;
        if (opts.body && typeof opts.body === 'string') {
          try { body = JSON.parse(opts.body); } catch { body = opts.body; }
        }
        calls.push({ url: String(u), body });
        const path = String(u);
        if (path.includes('/rpc/fp_push_status')) {
          if (window.__pushMissing) {
            return Promise.resolve(jsonResponse({ message: 'Could not find the function public.fp_push_status', code: 'PGRST202' }, 404));
          }
          return Promise.resolve(jsonResponse({
            ready: true,
            public_key: 'test-public-key',
            team_alerts: false,
            endpoints: [],
          }));
        }
        if (path.includes('/rpc/fp_set_team_push')) return Promise.resolve(jsonResponse({ ok: true, team_alerts: !!(body && body.enabled) }));
        if (path.includes('/rpc/fp_list_direct_messages')) {
          return Promise.resolve(jsonResponse({
            peer_id: body.peer_id,
            peer_label: 'Seth West',
            private: true,
            me: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
            last_read_at: null,
            can_post: true,
            can_hide: false,
            manual_read: true,
            mention_choices: [],
            messages: [],
          }));
        }
        if (path.includes('/rpc/fp_list_job_messages')) {
          return Promise.resolve(jsonResponse({
            job_id: 'team', me: 'me', last_read_at: null, can_post: true, can_hide: false,
            manual_read: true, mention_choices: [], messages: [],
          }));
        }
        if (path.includes('/rpc/fp_list_dm_people')) return Promise.resolve(jsonResponse([]));
        if (path.includes('/rpc/fp_list_all_dm_threads')) return Promise.resolve(jsonResponse([]));
        if (path.includes('/rpc/fp_unread_job_messages')) return Promise.resolve(jsonResponse([{ job_id: 'team', unread: 1 }, { job_id: 'j1', unread: 2 }]));
        if (path.includes('/rest/v1/')) return Promise.resolve(jsonResponse([]));
        return Promise.resolve(new Response('', { status: 200 }));
      };
      window.AbortController = AbortController;
      window.CSS = window.CSS || { escape(s) { return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&'); } };
      window.navigator.setAppBadge = (n) => { badges.push(n); return Promise.resolve(); };
      window.navigator.clearAppBadge = () => { badges.push(0); return Promise.resolve(); };
    },
  });
  await new Promise((r) => setTimeout(r, 30));
  return { dom, calls, badges };
}

function closeDom(dom) {
  const w = dom.window;
  try {
    w.eval(`
      clearTimeout(_autoLockTimer);
      clearInterval(window._msgTimer);
      const max = setTimeout(() => {}, 0);
      for (let i = 0; i <= max; i++) { clearTimeout(i); clearInterval(i); }
    `);
  } catch { /* already closed */ }
  try { w.close(); } catch { /* timers */ }
}

test('the badge is team plus job plus direct, and a missing push function stays hidden', async () => {
  const { dom, calls, badges } = await bootPage('http://127.0.0.1/floorpro-crm/?env=test', 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0');
  const w = dom.window;
  try {
    w.eval(`
      _sessionAuthed = true;
      _accessToken = 'tok';
      _msgOn = true;
      _msgDmOn = true;
      _msgUnread = [{job_id:'team', unread:1}, {job_id:'j1', unread:2}];
      _msgPeople = [{account_id:'${PEER}', label:'Seth West', kind:'crew', unread:4}];
      msgPaintBadges();
    `);
    assert.equal(badges.at(-1), 7);
    w.__pushMissing = true;
    await w.eval('fpPushBoot()');
    assert.equal(w.document.getElementById('push-banner-team').hidden, true);
    assert.equal(w.document.getElementById('push-banner-settings').innerHTML, '');
    assert.ok(calls.some((c) => c.url.includes('/rpc/fp_push_status')));
  } finally {
    closeDom(dom);
  }
});

test('Android shows one tap to turn notifications on, and iPhone shows Home Screen steps', async () => {
  const android = await bootPage('http://127.0.0.1/floorpro-crm/?env=test', 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0');
  try {
    android.dom.window.eval(`_sessionAuthed = true; _accessToken = 'tok';`);
    await android.dom.window.eval('fpPushBoot()');
    const banner = android.dom.window.document.getElementById('push-banner-team');
    assert.equal(banner.hidden, false);
    assert.equal(banner.querySelector('button').textContent, 'Turn on notifications');
    assert.match(banner.textContent, /company thread/);
    assert.equal(banner.textContent.includes('Add to Home Screen'), false);
    const box = banner.querySelector('input');
    box.checked = true;
    box.dispatchEvent(new android.dom.window.Event('change', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 20));
    const saved = android.calls.find((c) => c.url.includes('/rpc/fp_set_team_push'));
    assert.equal(saved.body.enabled, true);
  } finally {
    closeDom(android.dom);
  }

  const iphone = await bootPage(
    'http://127.0.0.1/floorpro-crm/?env=test',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  );
  try {
    iphone.dom.window.eval(`_sessionAuthed = true; _accessToken = 'tok';`);
    await iphone.dom.window.eval('fpPushBoot()');
    const banner = iphone.dom.window.document.getElementById('push-banner-cv');
    assert.match(banner.textContent, /Share, then Add to Home Screen/);
    assert.match(banner.textContent, /iOS 16\.4/);
    assert.equal(banner.querySelector('button'), null);
  } finally {
    closeDom(iphone.dom);
  }
});

test('a notification link opens that direct thread on the test page', async () => {
  const { dom, calls } = await bootPage(
    `http://127.0.0.1/floorpro-crm/?env=test&open=dm&peer=${PEER}`,
    'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0',
  );
  const w = dom.window;
  try {
    assert.equal(w.eval('_fpUseTest'), true);
    assert.match(w.eval('SUPABASE_URL'), /nndjnywtkgxwvxajwztg/);
    w.eval(`
      localStorage.removeItem('fpRole');
      _sessionAuthed = true;
      _accessToken = 'tok';
      _msgOn = true;
      _msgDmOn = true;
      _msgPeople = [{account_id:'${PEER}', label:'Seth West', kind:'crew', unread:1}];
      fpApplyOpenIntent();
    `);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(w.document.getElementById('team-title').textContent, 'Seth West');
    assert.match(w.location.search, /env=test/);
    assert.equal(w.location.search.includes('open='), false);
    assert.ok(calls.some((c) => c.url.includes('/rpc/fp_list_direct_messages') && c.body.peer_id === PEER));
  } finally {
    closeDom(dom);
  }
});
