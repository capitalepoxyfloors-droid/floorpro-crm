/**
 * Phase 2 role-split row security, on a local Postgres only.
 * Proves a crew token cannot read pay, prices, job cost, or another person's
 * PTO note, and that office and owner still can. Does not contact Supabase.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertRoleSplitRest } from './role-rls-rest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase1 = fs.readFileSync(path.join(root, 'supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql'), 'utf8');
const costing = fs.readFileSync(path.join(root, 'supabase/migrations/20261020120000_crew_costing_columns.sql'), 'utf8');
const phase2 = fs.readFileSync(path.join(root, 'supabase/migrations/20261024140000_role_split_rls.sql'), 'utf8');
const revokeAnon = fs.readFileSync(path.join(root, 'supabase/migrations/20261024153000_revoke_crew_rpc_anon.sql'), 'utf8');
const stampRates = fs.readFileSync(path.join(root, 'supabase/migrations/20261024170000_stamp_missing_labor_rates.sql'), 'utf8');
const stampFollowup = fs.readFileSync(path.join(root, 'supabase/migrations/20261024193000_stamp_prior_wage_and_legacy_burden.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(root, 'supabase/rollback/20261024140000_role_split_rls.sql'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const db = 'floorpro_role_test';
const jwtSecret = 'floorpro-role-split-test-secret-32';
const port = 3217;

const CREW_ID = '11111111-1111-1111-1111-111111111111';
const OFFICE_ID = '33333333-3333-3333-3333-333333333333';
const OWNER_ID = '22222222-2222-2222-2222-222222222222';

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
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator NOINHERIT LOGIN PASSWORD 'authenticator';
  END IF;
END $$;
ALTER ROLE authenticator PASSWORD 'authenticator';
GRANT anon, authenticated, service_role TO authenticator;
GRANT CONNECT ON DATABASE ${db} TO authenticator, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role, authenticator;
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
  full_name text,
  first_name text,
  last_name text,
  initials text,
  color text,
  role text,
  phone text,
  specialties text,
  hourly text,
  hours text,
  ss text,
  medicare text,
  futa text,
  wc text,
  gl text,
  benefits text,
  pto_days text,
  sort_order int,
  created_at timestamptz DEFAULT now()
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

const JOB_RECORDS = JSON.stringify([
  {
    id: 'j1', customer: 'Acme Garage', phone: '314-555-0199', value: '18500', status: 'scheduled',
    dayLogs: {
      '2026-06-02': {
        task: 'Prep', overtimeWage: true,
        crewPresent: [{ crewIdx: 0, name: 'Seth West', burdenedRate: '41.50', directRate: '28.00' }],
      },
    },
  },
  { id: 'j2', customer: 'Hidden Job', value: '9900', status: 'scheduled' },
]);
const PTO = JSON.stringify([
  { id: 'p1', crewIdx: 0, crewName: 'Seth West', startDate: '2026-07-01', endDate: '2026-07-01', reason: 'Seth dentist', status: 'pending' },
  { id: 'p2', crewIdx: 1, crewName: 'Brendon Bennett', startDate: '2026-07-02', endDate: '2026-07-02', reason: 'Brendon private', status: 'pending' },
]);

function sampleSql() {
  const job = JOB_RECORDS.replace(/'/g, "''");
  const pto = PTO.replace(/'/g, "''");
  return `
INSERT INTO public.settings (key, value) VALUES
  ('admin_pin', '4821'),
  ('crew_pins', '{"0":"1111","1":"2222"}'),
  ('office_users', '[{"id":"ab12","name":"Pat Office","pin":"3333"}]'),
  ('job_records', '${job}'),
  ('pto_requests', '${pto}'),
  ('job_photos', '{"j1":{}}'),
  ('costing_settings', '{"history":[{"overheadPool":86014}]}'),
  ('crew_history', '{"id_1":{"events":[{"type":"pay_change","rate":25}]}}');
INSERT INTO public.crew (full_name, first_name, last_name, initials, color, role, phone, specialties, hourly, hours, sort_order)
VALUES
  ('Seth West', 'Seth', 'West', 'SW', '#6aabff', 'Installer', '555-0101', '[]', '25.00', '40', 0),
  ('Brendon Bennett', 'Brendon', 'Bennett', 'BB', '#3ddc84', 'Installer', '555-0102', '[]', '30.00', '40', 1),
  ('Will Bradford', 'Will', 'Bradford', 'WB', '#f5c16c', 'Owner', '555-0100', '[]', '72.11', '40', 2);
INSERT INTO public.jobs (customer, value, status) VALUES ('Acme Garage', '18500', 'scheduled');
INSERT INTO public.leads (name, phone, value) VALUES ('Pat Example', '314-555-0100', '5000');
INSERT INTO public.materials (name, price, price_date) VALUES ('ArmorSeal', 12.5, '2026-01-01');
INSERT INTO public.scheduled_slots (label, crew_idx) VALUES ('Acme Garage', 0);
INSERT INTO public.vehicles (name) VALUES ('Shop truck');
INSERT INTO public.vehicle_maintenance (vehicle_id, cost) VALUES (1, 400);
INSERT INTO public.audit_log (actor, action, entity, details) VALUES ('Manager', 'job_updated', 'Acme', 'value 18500');
INSERT INTO storage.buckets (id, name, public) VALUES ('vehicle-docs', 'vehicle-docs', true);
`;
}

function claims(sub, role) {
  return JSON.stringify({ sub, app_metadata: { fp_role: role, fp_nonce: 0 } }).replace(/'/g, "''");
}
function asRole(claimsJson, sql, { commit = false } = {}) {
  const end = commit ? 'COMMIT;' : 'ROLLBACK;';
  return psql(db, ['-f', '-'], `
BEGIN;
SELECT set_config('request.jwt.claims', '${claimsJson}', true);
SET LOCAL ROLE authenticated;
${sql}
${end}
`);
}
function asRoleText(claimsJson, sql) {
  let out = '';
  try { out = asRole(claimsJson, sql); }
  catch (err) { out = String(err.stderr || err.stdout || err.message); }
  return out;
}

function signJwt(sub, role) {
  const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({
    role: role === 'anon' ? 'anon' : 'authenticated',
    sub,
    exp: Math.floor(Date.now() / 1000) + 3600,
    app_metadata: { fp_role: role, fp_nonce: 0 },
  });
  const sig = crypto.createHmac('sha256', jwtSecret).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

function waitForPort(p, timeoutMs) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const sock = net.connect(p, '127.0.0.1', () => { sock.end(); resolve(); });
      sock.on('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error('postgrest did not open port ' + p));
        else setTimeout(tryOnce, 100);
      });
    };
    tryOnce();
  });
}

// Proves the work-date stamp, then rolls the data back so the rest of the role test
// still sees the sample jobs. Does not contact a hosted database.
function assertLaborStamps() {
  const crewJwt = claims(CREW_ID, 'crew');
  const officeJwt = claims(OFFICE_ID, 'office');
  const jobs = JSON.stringify([
    { id: 'keep-direct', customer: 'Keep Direct', dayLogs: { '2026-10-21': { crewPresent: [{ crewIdx: 0, name: 'Seth West', directRate: 33.1, burdenedRate: '50.00' }] } } },
    { id: 'keep-a', customer: 'Keep A', dayLogs: { '2026-10-21': { crewPresent: [{ crewIdx: 1, name: 'Brendon Bennett', burdenedRate: '38.58' }] } } },
    { id: 'keep-b', customer: 'Keep B', dayLogs: { '2026-10-21': { crewPresent: [{ crewIdx: 1, name: 'Brendon Bennett', burdenedRate: '41.00' }] } } },
    { id: 'fill-model', customer: 'Fill Model', dayLogs: {
      '2026-10-21': { fullDay: true, crewPresent: [{ crewIdx: 0, name: 'Seth West' }, { crewIdx: 2, name: 'Will Bradford' }] },
      '2026-10-24': { fullDay: true, crewPresent: [{ crewIdx: 0, name: 'Seth West' }] },
      '2099-01-05': { fullDay: true, crewPresent: [{ crewIdx: 0, name: 'Seth West' }] },
    } },
    { id: 'fill-legacy', customer: 'Fill Legacy', dayLogs: { '2026-09-10': { fullDay: true, crewPresent: [{ crewIdx: 0, name: 'Seth West' }] } } },
    { id: 'fill-brendon', customer: 'Fill Brendon', dayLogs: { '2026-10-21': { fullDay: true, crewPresent: [{ crewIdx: 1, name: 'Brendon Bennett' }] } } },
    { id: 'pw-day', customer: 'PW Job', prevailingWage: true, prevailingWageRate: 44.7, dayLogs: { '2026-10-21': { fullDay: true, crewPresent: [{ crewIdx: 0, name: 'Seth West' }] } } },
  ]);
  const fallbackJob = JSON.stringify([
    { id: 'fallback', customer: 'Fallback', dayLogs: { '2026-10-21': { fullDay: true, crewPresent: [{ crewIdx: 0, name: 'Seth West' }] } } },
  ]);
  const heliasFirst = JSON.stringify([
    { id: 'helias', customer: 'Helias Polishing Phase 3', dayLogs: {
      '2026-10-02': { fullDay: true, crewPresent: [{ crewIdx: 0, name: 'Seth West' }] },
      '2026-10-01': { fullDay: true, crewPresent: [{ crewIdx: 4, name: 'Hunter Schuler' }] },
    } },
    { id: 'cody-may', customer: 'Cody May', dayLogs: {
      '2026-05-15': { fullDay: true, crewPresent: [{ crewIdx: 3, name: 'Cody Faulkner' }] },
    } },
  ]);
  const heliasSecond = JSON.stringify([
    ...JSON.parse(heliasFirst),
    { id: 'cody-june', customer: 'Cody June', dayLogs: {
      '2026-06-15': { fullDay: true, crewPresent: [{ crewIdx: 3, name: 'Cody Faulkner' }] },
    } },
    { id: 'hunter-prior', customer: 'Hunter Prior', dayLogs: {
      '2026-07-01': { fullDay: true, crewPresent: [{ crewIdx: 4, name: 'Hunter Schuler' }] },
    } },
  ]);
  psql(db, ['-f', '-'], `
BEGIN;
UPDATE public.crew SET
  hourly = '30.25', hours = '40', ss = '6.20', medicare = '1.45', futa = '0.60', wc = '3.62', gl = '0',
  benefits = '135', pto_days = '12', futa_wage_base = 7000, suta_rate = 1.848, suta_wage_base = 9000,
  k401_match_pct = 4, fixed_fees_yr = 830, clothing_yr = 204, field_rate_override = NULL, is_owner = false
WHERE full_name = 'Seth West';
UPDATE public.crew SET
  hourly = '27.60', hours = '40', ss = '6.20', medicare = '1.45', futa = '0.60', wc = '3.62', gl = '0',
  benefits = '100', pto_days = '11', futa_wage_base = 7000, suta_rate = 1.848, suta_wage_base = 9000,
  k401_match_pct = 4, fixed_fees_yr = 830, clothing_yr = 204, field_rate_override = NULL, is_owner = false
WHERE full_name = 'Brendon Bennett';
UPDATE public.crew SET
  hourly = '72.11', hours = '40', ss = '6.20', medicare = '1.45', futa = '2.70', wc = '5.61', gl = '0',
  benefits = '0', pto_days = '0', field_rate_override = 40.27, is_owner = true
WHERE full_name = 'Will Bradford';
INSERT INTO public.crew (full_name, first_name, last_name, initials, color, role, phone, specialties, hourly, hours, ss, medicare, futa, wc, gl, benefits, pto_days, sort_order, futa_wage_base, suta_rate, suta_wage_base, k401_match_pct, fixed_fees_yr, clothing_yr, is_owner)
VALUES
  ('Hunter Schuler', 'Hunter', 'Schuler', 'HS', '#c084fc', 'Installer', '', '[]', '24.00', '40', '6.20', '1.45', '0.60', '3.62', '0', '0', '10', 4, 7000, 1.848, 9000, 0, 830, 204, false),
  ('Cody Faulkner', 'Cody', 'Faulkner', 'CF', '#ff9f4a', 'Installer', '', '[]', '25.20', '40', '6.20', '1.45', '2.70', '5.61', '0', '0', '10', 3, NULL, NULL, NULL, NULL, NULL, NULL, false);
INSERT INTO public.settings (key, value) VALUES ('crew_inactive', '{"3":{"since":"2026-09-28","name":"Cody Faulkner"}}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
UPDATE public.settings SET value = (
  SELECT jsonb_build_object(
    'id_' || id::text,
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object('type','pay_change','date','2026-01-15','rate',20)))
  )::text FROM public.crew WHERE full_name = 'Seth West'
) WHERE key = 'crew_history';
UPDATE public.settings SET value = $cs$
{"history":[
  {"id":"cs_legacy","effective":"1900-01-01","legacyOverheadPerHour":4.83},
  {"id":"cs_20261020","effective":"2026-10-20","utilization":0.9,"paidHoursPerYear":2080,"overheadMode":"pool","overheadPool":86014,"excludeOwnerFromDivisor":true}
]}
$cs$ WHERE key = 'costing_settings';
UPDATE public.settings SET value = $jobs$${jobs}$jobs$ WHERE key = 'job_records';

DO $check$
DECLARE
  js jsonb := (SELECT value::jsonb FROM public.settings WHERE key = 'job_records');
  seth jsonb;
  will jsonb;
  kept_a jsonb;
  kept_b jsonb;
  kept_direct jsonb;
  legacy jsonb;
  brendon jsonb;
  future jsonb;
  saturday jsonb;
  pw jsonb;
BEGIN
  SELECT e INTO seth FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-21'->'crewPresent') e
    WHERE j->>'id' = 'fill-model' AND e->>'name' = 'Seth West';
  SELECT e INTO will FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-21'->'crewPresent') e
    WHERE j->>'id' = 'fill-model' AND e->>'name' = 'Will Bradford';
  SELECT e INTO saturday FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-24'->'crewPresent') e
    WHERE j->>'id' = 'fill-model';
  SELECT e INTO future FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2099-01-05'->'crewPresent') e
    WHERE j->>'id' = 'fill-model';
  SELECT e INTO legacy FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-09-10'->'crewPresent') e
    WHERE j->>'id' = 'fill-legacy';
  SELECT e INTO brendon FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-21'->'crewPresent') e
    WHERE j->>'id' = 'fill-brendon';
  SELECT e INTO kept_a FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-21'->'crewPresent') e
    WHERE j->>'id' = 'keep-a';
  SELECT e INTO kept_b FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-21'->'crewPresent') e
    WHERE j->>'id' = 'keep-b';
  SELECT e INTO kept_direct FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-21'->'crewPresent') e
    WHERE j->>'id' = 'keep-direct';
  SELECT j INTO pw FROM jsonb_array_elements(js) j WHERE j->>'id' = 'pw-day';

  IF (seth->>'baseRate')::numeric <> 20 THEN RAISE EXCEPTION 'Seth baseRate %, want 20 (history, not the current 30.25)', seth->>'baseRate'; END IF;
  IF (seth->>'directRate')::numeric <> 27.14 THEN RAISE EXCEPTION 'Seth directRate %', seth->>'directRate'; END IF;
  IF (seth->>'otRate')::numeric <> 33.38 THEN RAISE EXCEPTION 'Seth otRate %', seth->>'otRate'; END IF;
  IF (seth->>'overheadRate')::numeric <> 15.32 THEN RAISE EXCEPTION 'Seth overhead %', seth->>'overheadRate'; END IF;
  IF (seth->>'statMult')::numeric <> 1.1127 THEN RAISE EXCEPTION 'Seth statMult %', seth->>'statMult'; END IF;
  IF seth->>'burdenedRate' <> '42.46' THEN RAISE EXCEPTION 'Seth burdenedRate %', seth->>'burdenedRate'; END IF;
  IF seth->>'rateVersion' <> 'cs_20261020' THEN RAISE EXCEPTION 'Seth version %', seth->>'rateVersion'; END IF;
  IF seth ? 'fieldOverride' THEN RAISE EXCEPTION 'Seth is not on the field override'; END IF;
  IF will->>'fieldOverride' <> 'true' OR (will->>'directRate')::numeric <> 40.27 THEN RAISE EXCEPTION 'Will stamp %', will; END IF;
  IF (will->>'otRate')::numeric <> 40.27 THEN RAISE EXCEPTION 'Will ot stays the override %', will->>'otRate'; END IF;
  IF (will->>'overheadRate')::numeric <> 15.32 THEN RAISE EXCEPTION 'Will overhead %', will->>'overheadRate'; END IF;
  IF kept_a->>'burdenedRate' <> '38.58' OR kept_a ? 'directRate' THEN RAISE EXCEPTION 'legacy A changed %', kept_a; END IF;
  IF kept_b->>'burdenedRate' <> '41.00' OR kept_b ? 'directRate' THEN RAISE EXCEPTION 'legacy B changed %', kept_b; END IF;
  IF (kept_direct->>'directRate')::numeric <> 33.1 OR kept_direct->>'burdenedRate' <> '50.00' THEN RAISE EXCEPTION 'saved direct changed %', kept_direct; END IF;
  IF legacy ? 'directRate' OR legacy->>'burdenedRate' <> '28.91' THEN RAISE EXCEPTION 'pre-model stamp %', legacy; END IF;
  IF (brendon->>'baseRate')::numeric <> 27.60 THEN RAISE EXCEPTION 'Brendon fell back to %', brendon->>'baseRate'; END IF;
  IF future ? 'directRate' OR future ? 'burdenedRate' THEN RAISE EXCEPTION 'future day was stamped %', future; END IF;
  IF NOT (saturday ? 'directRate') THEN RAISE EXCEPTION 'Saturday was not stamped %', saturday; END IF;
  IF (pw->>'prevailingWage')::boolean IS NOT TRUE THEN RAISE EXCEPTION 'PW flag changed'; END IF;
  IF NOT ((pw->'dayLogs'->'2026-10-21'->'crewPresent'->0) ? 'directRate') THEN RAISE EXCEPTION 'PW day still needs the person stamp'; END IF;
  IF js::text LIKE '%overtimeWage%' THEN RAISE EXCEPTION 'stamp set overtimeWage'; END IF;
END
$check$;

CREATE TEMP TABLE stamp_out (k text PRIMARY KEY, v text);
GRANT ALL ON stamp_out TO authenticated;
SELECT set_config('request.jwt.claims', '${crewJwt}', true);
SET LOCAL ROLE authenticated;
INSERT INTO stamp_out VALUES ('read', public.fp_crew_read_job_records()::text);
INSERT INTO stamp_out VALUES ('write', public.fp_crew_write_job_records($j$[
  {"id":"jnew","customer":"Crew Logged","phone":"314-555-0100",
   "dayLogs":{"2026-10-23":{"task":"Coat","fullDay":true,
     "crewPresent":[{"crewIdx":0,"name":"Seth West"}]}}}
]$j$::jsonb)::text);
RESET ROLE;

DO $crew$
DECLARE
  rd text := (SELECT v FROM stamp_out WHERE k = 'read');
  wr text := (SELECT v FROM stamp_out WHERE k = 'write');
  stored jsonb := (SELECT value::jsonb FROM public.settings WHERE key = 'job_records');
  newbie jsonb;
BEGIN
  IF rd LIKE '%27.14%' OR rd LIKE '%directRate%' THEN RAISE EXCEPTION 'crew read leaked a rate %', left(rd, 400); END IF;
  IF rd NOT LIKE '%Fill Model%' THEN RAISE EXCEPTION 'crew read dropped the job'; END IF;
  IF wr LIKE '%directRate%' OR wr LIKE '%27.14%' OR wr LIKE '%42.46%' THEN RAISE EXCEPTION 'crew write returned a rate'; END IF;
  IF wr NOT LIKE '%Crew Logged%' THEN RAISE EXCEPTION 'crew write dropped the new job'; END IF;
  SELECT e INTO newbie FROM jsonb_array_elements(stored) j, jsonb_array_elements(j->'dayLogs'->'2026-10-23'->'crewPresent') e
    WHERE j->>'id' = 'jnew';
  IF (newbie->>'directRate')::numeric <> 27.14 THEN RAISE EXCEPTION 'crew save was not stamped %', newbie; END IF;
  IF (stored::text LIKE '%overtimeWage%') THEN RAISE EXCEPTION 'crew save gained overtimeWage'; END IF;
END
$crew$;

SELECT set_config('request.jwt.claims', '${officeJwt}', true);
SET LOCAL ROLE authenticated;
DO $office$
BEGIN
  IF (SELECT hourly FROM public.crew_private WHERE crew_id = (SELECT id FROM public.crew WHERE full_name = 'Seth West')) IS DISTINCT FROM '30.25' THEN
    RAISE EXCEPTION 'office could not read Seth hourly from crew_private';
  END IF;
END
$office$;
UPDATE public.settings SET value = $cs$
{"history":[
  {"id":"cs_a","effective":"2026-11-01","utilization":0.9,"paidHoursPerYear":2080,"overheadMode":"pool","overheadPool":50000,"excludeOwnerFromDivisor":true},
  {"id":"cs_b","effective":"2026-12-01","utilization":0.9,"paidHoursPerYear":2080,"overheadMode":"pool","overheadPool":100000,"excludeOwnerFromDivisor":true}
]}
$cs$ WHERE key = 'costing_settings';
UPDATE public.settings SET value = $fb$${fallbackJob}$fb$ WHERE key = 'job_records';
RESET ROLE;

DO $fall$
DECLARE
  person jsonb;
BEGIN
  SELECT e INTO person FROM jsonb_array_elements((SELECT value::jsonb FROM public.settings WHERE key = 'job_records')) j,
    jsonb_array_elements(j->'dayLogs'->'2026-10-21'->'crewPresent') e;
  IF person->>'rateVersion' <> 'cs_b' THEN RAISE EXCEPTION 'fallback version %', person->>'rateVersion'; END IF;
  IF (person->>'overheadRate')::numeric <> 17.81 THEN RAISE EXCEPTION 'fallback overhead %', person->>'overheadRate'; END IF;
  IF (person->>'baseRate')::numeric <> 20 THEN RAISE EXCEPTION 'fallback still uses history hourly %', person->>'baseRate'; END IF;
END
$fall$;

-- Pre-model replay: old FUTA/WC on the legacy costing entry, itemized overhead,
-- and a second job_records write in this same transaction. The pool-only entry
-- must not gain the legacy percents. Existing stamps are not in this payload.
UPDATE public.settings SET value = $cs$
{"history":[
  {"id":"cs_legacy","effective":"1900-01-01","legacyOverheadPerHour":4.83},
  {"id":"cs_pool_only","effective":"2026-10-19","overheadPool":1},
  {"id":"cs_20261020","effective":"2026-10-20","utilization":0.9,"paidHoursPerYear":2080,"overheadMode":"pool","overheadPool":86014,"excludeOwnerFromDivisor":true}
]}
$cs$ WHERE key = 'costing_settings';
SELECT private.fp_note_legacy_payroll_taxes();
INSERT INTO public.settings (key, value) VALUES ('overhead', $oh$
{"items":[
  {"id":"auto","name":"Progressive Auto","amount":"7488","period":"yr"},
  {"id":"rent","name":"Rent","amount":"2000","period":"mo"},
  {"id":"wave","name":"Wave","amount":"190","period":"yr"},
  {"id":"gl","name":"GL","amount":"1776.88","period":"yr"},
  {"id":"wc","name":"Work Comp","amount":"6756","period":"yr"}
]}
$oh$)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
UPDATE public.settings SET value = (
  SELECT jsonb_build_object(
    'id_' || (SELECT id::text FROM public.crew WHERE full_name = 'Cody Faulkner'),
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'type','pay_change','date','2026-06-01','rate',25.2,'note','Previous wage was $24.00'))),
    'id_' || (SELECT id::text FROM public.crew WHERE full_name = 'Hunter Schuler'),
    jsonb_build_object('events', jsonb_build_array(jsonb_build_object(
      'type','pay_change','date','2026-08-01','rate',24,'oldRate',22,'note','Previous wage was $20.00')))
  )::text
) WHERE key = 'crew_history';
UPDATE public.settings SET value = $h1$${heliasFirst}$h1$ WHERE key = 'job_records';
UPDATE public.settings SET value = $h2$${heliasSecond}$h2$ WHERE key = 'job_records';

DO $replay$
DECLARE
  cs jsonb := (SELECT value::jsonb FROM public.settings WHERE key = 'costing_settings');
  js jsonb := (SELECT value::jsonb FROM public.settings WHERE key = 'job_records');
  seth jsonb;
  hunter jsonb;
  cody_may jsonb;
  cody_june jsonb;
  hunter_prior jsonb;
BEGIN
  IF (cs->'history'->0->>'legacyFutaPct')::numeric <> 2.70
     OR (cs->'history'->0->>'legacyWcPct')::numeric <> 5.61 THEN
    RAISE EXCEPTION 'legacy percents %', cs->'history'->0;
  END IF;
  IF cs->'history'->1 ? 'legacyFutaPct' OR cs->'history'->1 ? 'legacyWcPct' THEN
    RAISE EXCEPTION 'pool-only entry gained legacy percents %', cs->'history'->1;
  END IF;
  IF cs->'history'->2 ? 'legacyFutaPct' THEN
    RAISE EXCEPTION 'model entry gained legacy percents';
  END IF;
  SELECT e INTO seth FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-02'->'crewPresent') e
    WHERE j->>'id' = 'helias';
  SELECT e INTO hunter FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-10-01'->'crewPresent') e
    WHERE j->>'id' = 'helias';
  SELECT e INTO cody_may FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-05-15'->'crewPresent') e
    WHERE j->>'id' = 'cody-may';
  SELECT e INTO cody_june FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-06-15'->'crewPresent') e
    WHERE j->>'id' = 'cody-june';
  SELECT e INTO hunter_prior FROM jsonb_array_elements(js) j, jsonb_array_elements(j->'dayLogs'->'2026-07-01'->'crewPresent') e
    WHERE j->>'id' = 'hunter-prior';
  IF seth->>'burdenedRate' <> '42.09' OR seth ? 'directRate' OR seth ? 'rateEstimated' THEN
    RAISE EXCEPTION 'Seth Helias %', seth;
  END IF;
  IF hunter->>'burdenedRate' <> '33.59' OR hunter ? 'directRate' OR hunter ? 'rateEstimated' THEN
    RAISE EXCEPTION 'Hunter Helias %', hunter;
  END IF;
  IF cody_may->>'burdenedRate' <> '33.59' OR cody_may->>'rateEstimated' <> 'true' OR cody_may ? 'directRate' THEN
    RAISE EXCEPTION 'Cody May %', cody_may;
  END IF;
  IF cody_june->>'burdenedRate' <> '35.02' OR cody_june ? 'rateEstimated' OR cody_june ? 'directRate' THEN
    RAISE EXCEPTION 'Cody June was not stamped in the second save %', cody_june;
  END IF;
  IF hunter_prior->>'burdenedRate' <> '31.19' OR hunter_prior ? 'rateEstimated' THEN
    RAISE EXCEPTION 'structured oldRate %', hunter_prior;
  END IF;
  IF js::text LIKE '%overtimeWage%' THEN RAISE EXCEPTION 'replay set overtimeWage'; END IF;
END
$replay$;

SELECT set_config('request.jwt.claims', '${crewJwt}', true);
SET LOCAL ROLE authenticated;
INSERT INTO stamp_out VALUES ('replay-read', public.fp_crew_read_job_records()::text)
ON CONFLICT (k) DO UPDATE SET v = EXCLUDED.v;
RESET ROLE;

DO $hid$
DECLARE
  rd text := (SELECT v FROM stamp_out WHERE k = 'replay-read');
BEGIN
  IF rd LIKE '%rateEstimated%' OR rd LIKE '%42.09%' OR rd LIKE '%burdenedRate%' THEN
    RAISE EXCEPTION 'crew read leaked a replay stamp %', left(rd, 500);
  END IF;
  IF rd NOT LIKE '%Helias Polishing Phase 3%' THEN RAISE EXCEPTION 'crew read dropped Helias'; END IF;
END
$hid$;
ROLLBACK;
`);
}

function linkAccounts() {
  psql(db, ['-c', `UPDATE public.pin_accounts SET auth_user_id = '${CREW_ID}' WHERE kind = 'crew' AND crew_idx = 0`]);
  psql(db, ['-c', `UPDATE public.pin_accounts SET auth_user_id = '${OFFICE_ID}' WHERE kind = 'office'`]);
  psql(db, ['-c', `UPDATE public.pin_accounts SET auth_user_id = '${OWNER_ID}' WHERE kind = 'owner'`]);
}

function applyPhase2() {
  psql(db, ['-f', '-'], phase2);
  psql(db, ['-f', '-'], revokeAnon);
  psql(db, ['-f', '-'], stampRates);
  psql(db, ['-f', '-'], stampFollowup);
}

test('the website asks for directory columns and the crew job functions', () => {
  assert.match(indexHtml, /fp_crew_read_job_records/);
  assert.match(indexHtml, /fp_crew_write_job_records/);
  assert.match(indexHtml, /fp_crew_read_pto_requests/);
  assert.match(indexHtml, /fp_crew_write_pto_requests/);
  const dir = indexHtml.match(/const CREW_DIRECTORY_SELECT='([^']+)'/);
  assert.ok(dir, 'crew directory select list');
  assert.equal(dir[1].includes('hourly'), false);
  assert.equal(dir[1].includes('phone'), false);
  const mat = indexHtml.match(/const MAT_DIRECTORY_SELECT='([^']+)'/);
  assert.ok(mat, 'material directory select list');
  assert.equal(mat[1].includes('price'), false);
  assert.match(indexHtml, /const mult=ot\?1\.5:1/);
  assert.match(indexHtml, /const SUPABASE_URL = _fpUseTest \? _fpTestUrl : _fpLiveUrl/);
  assert.match(indexHtml, /const _fpLiveUrl = 'https:\/\/cngbsmmdfxmerlqnkate\.supabase\.co'/);
  assert.match(indexHtml, /const _fpTestUrl = 'https:\/\/nndjnywtkgxwvxajwztg\.supabase\.co'/);
  assert.equal(phase2.includes('DROP COLUMN'), false);
  assert.equal(phase2.includes('DELETE FROM public.crew'), false);
  assert.match(stampFollowup, /pg_trigger_depth\(\)/);
  assert.equal(stampFollowup.includes("set_config('fp.stamping'"), false);
  assert.equal(stampFollowup.includes("WHERE key = 'job_records'"), false);
  assert.match(stampFollowup, /legacyFutaPct/);
  assert.match(phase2, /'rateestimated'/);
  assert.equal(rollback.includes('DROP TABLE'), false);
  assert.match(phase2, /REVOKE ALL ON FUNCTION public\.fp_crew_read_job_records\(\) FROM PUBLIC, anon/);
  assert.match(revokeAnon, /REVOKE ALL ON FUNCTION public\.fp_crew_write_pto_requests\(jsonb\) FROM PUBLIC, anon/);
  assert.match(rollback, /REVOKE ALL ON FUNCTION public\.fp_crew_read_job_records\(\) FROM PUBLIC, anon/);
  assert.equal(revokeAnon.includes('TO anon;'), false);
  assert.match(phase1, /key IN \('job_records'/);
});

test('role-split policies hide pay from crew and keep it for office and owner', { skip: hasPsql() ? false : 'psql is not installed' }, async () => {
  psqlAdmin(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${db}' AND pid <> pg_backend_pid();`);
  psqlAdmin(`DROP DATABASE IF EXISTS ${db};`);
  psqlAdmin(`CREATE DATABASE ${db};`);
  psql(db, ['-f', '-'], FIXTURE + sampleSql());
  psql(db, ['--single-transaction', '-f', '-'], phase1);
  psql(db, ['-f', '-'], costing);
  psql(db, ['-c', `UPDATE public.crew SET futa_wage_base = 7000, suta_rate = 1.848, is_owner = false WHERE full_name <> 'Will Bradford'`]);
  applyPhase2();
  applyPhase2();
  linkAccounts();

  psql(db, ['-c', `
    GRANT EXECUTE ON FUNCTION public.fp_crew_read_job_records() TO anon;
    GRANT EXECUTE ON FUNCTION public.fp_crew_write_job_records(jsonb) TO anon;
    GRANT EXECUTE ON FUNCTION public.fp_crew_read_pto_requests() TO anon;
    GRANT EXECUTE ON FUNCTION public.fp_crew_write_pto_requests(jsonb) TO anon;
  `]);
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('anon', 'public.fp_crew_read_job_records()', 'EXECUTE')`), 't');
  psql(db, ['-f', '-'], revokeAnon);
  for (const fn of [
    'public.fp_crew_read_job_records()',
    'public.fp_crew_write_job_records(jsonb)',
    'public.fp_crew_read_pto_requests()',
    'public.fp_crew_write_pto_requests(jsonb)',
  ]) {
    assert.equal(psqlTuples(db, `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')`), 'f', fn);
    assert.equal(psqlTuples(db, `SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE')`), 't', fn);
  }
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('anon', 'private.fp_stamp_job_records_text(text)', 'EXECUTE')`), 'f');
  assert.equal(psqlTuples(db, `SELECT has_function_privilege('authenticated', 'private.fp_stamp_job_records_text(text)', 'EXECUTE')`), 'f');
  for (const fn of [
    'private.fp_wage_for_stamp(jsonb,text,text,text,numeric)',
    'private.fp_legacy_item_overhead(jsonb,jsonb)',
    'private.fp_note_legacy_payroll_taxes()',
    'private.fp_stamp_missing_labor()',
  ]) {
    assert.equal(psqlTuples(db, `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE')`), 'f', fn);
    assert.equal(psqlTuples(db, `SELECT has_function_privilege('authenticated', '${fn}', 'EXECUTE')`), 'f', fn);
  }
  assert.equal(psqlTuples(db, `SELECT count(*) FROM pg_trigger WHERE tgname = 'fp_stamp_missing_labor' AND NOT tgisinternal`), '1');

  assert.equal(psqlTuples(db, `SELECT hourly FROM public.crew WHERE full_name = 'Seth West'`), '25.00');
  assert.equal(psqlTuples(db, `SELECT hourly FROM public.crew_private WHERE crew_id = (SELECT id FROM public.crew WHERE full_name = 'Seth West')`), '25.00');
  assert.equal(psqlTuples(db, `SELECT phone FROM public.crew_private WHERE crew_id = (SELECT id FROM public.crew WHERE full_name = 'Brendon Bennett')`), '555-0102');
  assert.equal(psqlTuples(db, `SELECT price FROM public.materials_private`), '12.5');

  const crewClaims = claims(CREW_ID, 'crew');
  const officeClaims = claims(OFFICE_ID, 'office');
  const ownerClaims = claims(OWNER_ID, 'owner');

  const deniedHourly = asRoleText(crewClaims, `SELECT hourly FROM public.crew;`);
  assert.match(deniedHourly, /permission denied/i);
  const deniedPhone = asRoleText(officeClaims, `SELECT phone FROM public.crew;`);
  assert.match(deniedPhone, /permission denied/i);

  const names = asRole(crewClaims, `SELECT string_agg(full_name, ',' ORDER BY sort_order) FROM public.crew;`);
  assert.match(names, /Seth West/);
  assert.match(names, /Brendon Bennett/);

  const hidden = asRole(crewClaims, `
    SELECT 'priv=' || count(*)::text FROM public.crew_private;
    SELECT 'jobs=' || count(*)::text FROM public.jobs;
    SELECT 'leads=' || count(*)::text FROM public.leads;
    SELECT 'veh=' || count(*)::text FROM public.vehicles;
    SELECT 'maint=' || count(*)::text FROM public.vehicle_maintenance;
    SELECT 'audit=' || count(*)::text FROM public.audit_log;
    SELECT 'jr=' || count(*)::text FROM public.settings WHERE key = 'job_records';
    SELECT 'pto=' || count(*)::text FROM public.settings WHERE key = 'pto_requests';
    SELECT 'cost=' || count(*)::text FROM public.settings WHERE key = 'costing_settings';
    SELECT 'hist=' || count(*)::text FROM public.settings WHERE key = 'crew_history';
    SELECT 'photos=' || count(*)::text FROM public.settings WHERE key = 'job_photos';
    SELECT 'slots=' || count(*)::text FROM public.scheduled_slots;
    SELECT 'matprice=' || count(*)::text FROM public.materials_private;
  `);
  assert.match(hidden, /priv=0/);
  assert.match(hidden, /jobs=0/);
  assert.match(hidden, /leads=0/);
  assert.match(hidden, /veh=0/);
  assert.match(hidden, /maint=0/);
  assert.match(hidden, /audit=0/);
  assert.match(hidden, /jr=0/);
  assert.match(hidden, /pto=0/);
  assert.match(hidden, /cost=0/);
  assert.match(hidden, /hist=0/);
  assert.match(hidden, /photos=1/);
  assert.match(hidden, /slots=1/);
  assert.match(hidden, /matprice=0/);

  const officeSee = asRole(officeClaims, `
    SELECT 'wage=' || hourly FROM public.crew_private WHERE phone = '555-0101';
    SELECT 'job=' || value FROM public.jobs;
    SELECT 'price=' || price::text FROM public.materials_private;
  `);
  assert.match(officeSee, /wage=25\.00/);
  assert.match(officeSee, /job=18500/);
  assert.match(officeSee, /price=12\.5/);
  const ownerSee = asRole(ownerClaims, `SELECT 'n=' || count(*)::text FROM public.crew_private WHERE hourly IS NOT NULL;`);
  assert.match(ownerSee, /n=3/);

  const redacted = asRole(crewClaims, `SELECT public.fp_crew_read_job_records()::text;`);
  assert.match(redacted, /Acme Garage/);
  assert.match(redacted, /314-555-0199/);
  assert.equal(redacted.includes('18500'), false, redacted);
  assert.equal(redacted.includes('41.50'), false, redacted);
  assert.equal(redacted.includes('overtimeWage'), false, redacted);

  asRole(crewClaims, `
    SELECT public.fp_crew_write_job_records($j$[
      {"id":"j1","customer":"Acme Garage","value":"1","phone":"314-555-0199",
       "dayLogs":{"2026-06-02":{"task":"Coat","overtimeWage":false,
         "crewPresent":[{"crewIdx":0,"name":"Seth West","burdenedRate":"999","directRate":"1"}]}}}
    ]$j$::jsonb);
  `, { commit: true });
  const stored = psqlTuples(db, `SELECT value FROM public.settings WHERE key = 'job_records'`);
  assert.match(stored, /18500/);
  assert.match(stored, /41\.50/);
  assert.match(stored, /Coat/);
  assert.match(stored, /Hidden Job/);
  assert.match(stored, /overtimeWage/);
  assert.equal(stored.includes('999'), false, stored);

  asRole(crewClaims, `
    SELECT public.fp_crew_write_job_records($j$[
      {"id":"j1","customer":"Acme Garage","dayLogs":{"2026-06-03":{"task":"Next","crewPresent":[]}}}
    ]$j$::jsonb);
  `, { commit: true });
  const droppedDay = psqlTuples(db, `SELECT value FROM public.settings WHERE key = 'job_records'`);
  assert.equal(droppedDay.includes('2026-06-02'), false, droppedDay);
  assert.match(droppedDay, /2026-06-03/);
  assert.match(droppedDay, /18500/);

  assertLaborStamps();

  const ptoRead = asRole(crewClaims, `SELECT public.fp_crew_read_pto_requests()::text;`);
  assert.match(ptoRead, /Seth dentist/);
  assert.equal(ptoRead.includes('Brendon private'), false, ptoRead);

  asRole(crewClaims, `
    SELECT public.fp_crew_write_pto_requests($j$[
      {"id":"p1","crewIdx":1,"crewName":"Brendon Bennett","startDate":"2026-07-01","endDate":"2026-07-01","reason":"Seth dentist","status":"approved"}
    ]$j$::jsonb);
  `, { commit: true });
  const ptoStored = psqlTuples(db, `SELECT value FROM public.settings WHERE key = 'pto_requests'`);
  assert.match(ptoStored, /Brendon private/);
  assert.match(ptoStored, /"status": "pending"/);
  assert.equal(ptoStored.includes('"status": "approved"'), false, ptoStored);

  const officeBlocked = asRoleText(officeClaims, `SELECT public.fp_crew_read_job_records();`);
  assert.match(officeBlocked, /not allowed/);
  const anonBlocked = asRoleText(claims('00000000-0000-0000-0000-000000000000', 'anon'), `SET LOCAL ROLE anon; SELECT public.fp_crew_read_job_records();`);
  assert.match(anonBlocked, /permission denied/i);

  asRole(crewClaims, `INSERT INTO public.audit_log (actor, action, entity, details) VALUES ('Seth', 'schedule_added', 'Acme', '');`, { commit: true });
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.audit_log WHERE actor = 'Seth'`), '1');
  const crewAudit = asRole(crewClaims, `SELECT 'seen=' || count(*)::text FROM public.audit_log;`);
  assert.match(crewAudit, /seen=0/);

  asRole(officeClaims, `
    UPDATE public.materials_private SET price = 13 WHERE material_id = (SELECT id FROM public.materials WHERE name = 'ArmorSeal');
  `, { commit: true });
  assert.equal(psqlTuples(db, `SELECT price FROM public.materials WHERE name = 'ArmorSeal'`), '13');
  psql(db, ['-c', `UPDATE public.materials SET price = 14 WHERE name = 'ArmorSeal'`]);
  assert.equal(psqlTuples(db, `SELECT price FROM public.materials_private`), '14');

  psql(db, ['-f', '-'], rollback);
  const restored = asRole(crewClaims, `SELECT 'wage=' || hourly FROM public.crew WHERE full_name = 'Seth West';`);
  assert.match(restored, /wage=25\.00/);
  const anonAfterRollback = asRoleText(claims('00000000-0000-0000-0000-000000000000', 'anon'), `SET LOCAL ROLE anon; SELECT public.fp_crew_read_job_records();`);
  assert.match(anonAfterRollback, /permission denied/i);
  assert.equal(psqlTuples(db, `SELECT count(*) FROM public.crew_private`), '3');
  assert.equal(psqlTuples(db, `SELECT price FROM public.materials WHERE name = 'ArmorSeal'`), '14');

  applyPhase2();
  linkAccounts();
  const hiddenAgain = asRoleText(crewClaims, `SELECT hourly FROM public.crew;`);
  assert.match(hiddenAgain, /permission denied/i);
  assert.equal(psqlTuples(db, `SELECT hourly FROM public.crew WHERE full_name = 'Seth West'`), '25.00');
  psql(db, ['-c', `UPDATE public.materials SET price = 12.5 WHERE name = 'ArmorSeal'`]);
  psql(db, ['-c', `UPDATE public.settings SET value = $jr$${JOB_RECORDS}$jr$ WHERE key = 'job_records'`]);
  psql(db, ['-c', `UPDATE public.settings SET value = $jr$${PTO}$jr$ WHERE key = 'pto_requests'`]);

  const postgrest = spawn('/tmp/postgrest', [], {
    env: {
      ...process.env,
      PGRST_DB_URI: `postgres://authenticator:authenticator@127.0.0.1:5432/${db}`,
      PGRST_DB_SCHEMAS: 'public',
      PGRST_DB_ANON_ROLE: 'anon',
      PGRST_JWT_SECRET: jwtSecret,
      PGRST_SERVER_PORT: String(port),
      PGRST_DB_CHANNEL_ENABLED: 'false',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  postgrest.stdout.on('data', (b) => { log += b; });
  postgrest.stderr.on('data', (b) => { log += b; });
  try {
    await waitForPort(port, 8000);
    await assertRoleSplitRest({
      baseUrl: `http://127.0.0.1:${port}`,
      sendApiKey: false,
      prefix: '',
      crewJwt: signJwt(CREW_ID, 'crew'),
      officeJwt: signJwt(OFFICE_ID, 'office'),
      ownerJwt: signJwt(OWNER_ID, 'owner'),
      anonJwt: signJwt('00000000-0000-0000-0000-000000000000', 'anon'),
    });
  } catch (err) {
    err.message += '\nPostgREST log:\n' + log;
    throw err;
  } finally {
    postgrest.kill('SIGTERM');
  }
});
