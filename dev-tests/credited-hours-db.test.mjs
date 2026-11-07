/**
 * Credited-hours guard on a throwaway local Postgres. Fake accounts only.
 * Does not connect to Supabase or any shared database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const db = 'floorpro_credit_guard_test';
const OFFICE = '33333333-3333-3333-3333-333333333331';
const CREW_USER = '44444444-4444-4444-4444-444444444441';
const DAY = '2026-06-23';

function hasPsql() {
  try { execFileSync('psql', ['--version'], { stdio: 'ignore' }); return true; }
  catch { return false; }
}
function psql(database, input) {
  return execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', database, '-v', 'ON_ERROR_STOP=1', '-X', '-q'], {
    input, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
  });
}
function psqlAdmin(sql) {
  execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-c', sql], { encoding: 'utf8' });
}
function psqlTuples(sql) {
  return execFileSync('sudo', ['-n', '-u', 'postgres', 'psql', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X', '-q', '-t', '-A', '-c', sql], {
    encoding: 'utf8',
  }).trim();
}
function claims(sub, role) {
  return JSON.stringify({ sub, app_metadata: { fp_role: role, fp_nonce: 0 } }).replace(/'/g, "''");
}
function asRole(sub, role, sql, { commit = false } = {}) {
  const end = commit ? 'COMMIT;' : 'ROLLBACK;';
  return psql(db, `
BEGIN;
SELECT set_config('request.jwt.claims', '${claims(sub, role)}', true);
SET LOCAL ROLE authenticated;
${sql}
${end}
`);
}
function jobs() {
  const raw = psqlTuples("SELECT value FROM public.settings WHERE key = 'job_records'");
  return JSON.parse(raw);
}
function credits(jobId, date) {
  const job = jobs().find(j => j.id === jobId);
  return job.dayLogs[date].hourAdjustments;
}

const seed = {
  id: 'harbor',
  customer: 'Harbor Hall',
  dayLogs: {
    [DAY]: {
      fullDay: false,
      noWork: false,
      startTime: '9:00 AM',
      endTime: '3:10 PM',
      notes: 'old note',
      crewPresent: [
        { crewIdx: 0, name: 'Avery Cole', startTime: '7:50 AM', endTime: '3:10 PM' },
        { crewIdx: 1, name: 'Blake Diaz', startTime: '9:00 AM', endTime: '3:10 PM' },
        { crewIdx: 1, name: 'Blake Diaz', startTime: '7:45 AM', endTime: '8:15 AM' },
      ],
      hourAdjustments: [
        {
          crewIdx: 0, name: 'Avery Cole', creditedTenths: 80, reason: 'Count the short clock as a full day',
          by: 'Ops Reviewer', at: '2026-06-23T15:00:00.000Z',
        },
        {
          crewIdx: 1, name: 'Blake Diaz', creditedTenths: 18, reason: 'Balance to 8.0h',
          requestedMinutes: 110,
          balance: { dayTargetTenths: 80, otherJobsTenths: 62 },
          by: 'Ops Reviewer', at: '2026-06-23T15:00:00.000Z',
        },
      ],
    },
  },
};

function sqlJson(value) {
  return JSON.stringify(value).replace(/'/g, "''");
}
function rawJson(value) {
  return JSON.stringify(value);
}

test('server rejects crew credit changes and stamps office credits itself', { skip: !hasPsql() }, () => {
  psqlAdmin(`DROP DATABASE IF EXISTS ${db};`);
  psqlAdmin(`CREATE DATABASE ${db};`);
  psql(db, `
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
GRANT CONNECT ON DATABASE ${db} TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

CREATE TABLE public.settings (key text PRIMARY KEY, value text);
CREATE TABLE public.audit_log (
  id serial PRIMARY KEY,
  actor text,
  action text,
  entity text,
  details text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.pin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  crew_idx integer,
  office_id text,
  label text NOT NULL,
  pin_hash text NOT NULL DEFAULT 'x',
  auth_user_id uuid,
  session_nonce integer NOT NULL DEFAULT 0
);
CREATE TABLE public.crew (id uuid PRIMARY KEY, full_name text);
CREATE TABLE public.materials (id uuid PRIMARY KEY, name text);
CREATE TABLE public.jobs (id serial PRIMARY KEY);
CREATE TABLE public.leads (id serial PRIMARY KEY);
CREATE TABLE public.vehicles (id serial PRIMARY KEY);
CREATE TABLE public.vehicle_maintenance (id serial PRIMARY KEY);
CREATE TABLE public.scheduled_slots (id serial PRIMARY KEY);
CREATE TABLE public.pto_blocks (id serial PRIMARY KEY);
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.materials ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_maintenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_slots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pto_blocks ENABLE ROW LEVEL SECURITY;
GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.fp_crew_inactive(idx integer) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$ SELECT false; $$;
CREATE OR REPLACE FUNCTION private.fp_member() RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.pin_accounts AS p
    WHERE p.auth_user_id = auth.uid()
      AND p.kind = COALESCE(auth.jwt() -> 'app_metadata' ->> 'fp_role', '')
      AND (auth.jwt() -> 'app_metadata' -> 'fp_nonce') = to_jsonb(p.session_nonce)
  );
$$;
CREATE OR REPLACE FUNCTION private.fp_role() RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT CASE WHEN private.fp_member() THEN auth.jwt() -> 'app_metadata' ->> 'fp_role' END;
$$;
REVOKE ALL ON FUNCTION private.fp_crew_inactive(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_member() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_role() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.fp_member() TO authenticated;
GRANT EXECUTE ON FUNCTION private.fp_role() TO authenticated;
GRANT USAGE ON SCHEMA private TO authenticated;
`);

  psql(db, fs.readFileSync(path.join(root, 'supabase/migrations/20261024140000_role_split_rls.sql'), 'utf8'));
  psql(db, fs.readFileSync(path.join(root, 'supabase/migrations/20261027120000_patch_job_records.sql'), 'utf8'));
  psql(db, fs.readFileSync(path.join(root, 'supabase/migrations/20261107134106_guard_credited_hours.sql'), 'utf8'));
  psql(db, fs.readFileSync(path.join(root, 'supabase/migrations/20261107143000_fix_patch_job_insert.sql'), 'utf8'));

  psql(db, `
INSERT INTO public.pin_accounts (kind, label, auth_user_id, office_id, session_nonce)
VALUES ('office', 'Ops Reviewer', '${OFFICE}', 'ops', 0);
INSERT INTO public.pin_accounts (kind, label, auth_user_id, crew_idx, session_nonce)
VALUES ('crew', 'Avery Cole', '${CREW_USER}', 0, 0);
INSERT INTO public.settings (key, value) VALUES ('job_records', '${sqlJson([seed])}');
`);

  const seeded = credits('harbor', DAY);
  assert.equal(seeded[0].creditedTenths, 80);
  assert.equal(seeded[1].creditedTenths, 18);
  assert.equal(seeded[1].requestedMinutes, 110);
  assert.equal(jobs()[0].dayLogs[DAY].crewPresent[0].startTime, '7:50 AM');
  assert.equal(jobs()[0].dayLogs[DAY].crewPresent[1].endTime, '3:10 PM');
  assert.equal(jobs()[0].dayLogs[DAY].fullDay, false);
  assert.equal(jobs()[0].dayLogs[DAY].noWork, false);

  asRole(CREW_USER, 'crew', `
DO $$
DECLARE n int;
BEGIN
  UPDATE public.settings SET value = '[]' WHERE key = 'job_records';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'crew updated job_records (% rows)', n;
  END IF;
END $$;
`);
  assert.equal(credits('harbor', DAY)[0].by, 'Ops Reviewer');
  assert.equal(credits('harbor', DAY)[0].creditedTenths, 80);

  const forgedDay = JSON.parse(JSON.stringify(seed.dayLogs));
  forgedDay[DAY].notes = 'crew note';
  forgedDay[DAY].crewPresent[2].endTime = '8:20 AM';
  forgedDay[DAY].hourAdjustments = [
    { crewIdx: 0, name: 'Avery Cole', creditedTenths: 10, reason: 'forged', by: 'Impersonator', at: '2000-01-01T00:00:00.000Z' },
  ];
  asRole(CREW_USER, 'crew', `
SELECT public.fp_crew_write_job_records($payload$${rawJson([{ id: 'harbor', dayLogs: forgedDay }])}$payload$::jsonb);
`, { commit: true });
  const afterCrew = jobs()[0].dayLogs[DAY];
  assert.equal(afterCrew.notes, 'crew note');
  assert.equal(afterCrew.crewPresent[2].endTime, '8:20 AM');
  assert.equal(afterCrew.crewPresent[0].startTime, '7:50 AM');
  assert.equal(afterCrew.crewPresent[0].endTime, '3:10 PM');
  assert.equal(afterCrew.crewPresent[1].startTime, '9:00 AM');
  assert.equal(afterCrew.hourAdjustments.length, 2);
  assert.equal(afterCrew.hourAdjustments[0].creditedTenths, 80);
  assert.equal(afterCrew.hourAdjustments[1].creditedTenths, 18);
  assert.equal(afterCrew.hourAdjustments[0].by, 'Ops Reviewer');
  assert.equal(afterCrew.hourAdjustments[0].at, '2026-06-23T15:00:00.000Z');
  assert.equal(JSON.stringify(afterCrew.hourAdjustments).includes('Impersonator'), false);
  assert.equal(afterCrew.fullDay, false);
  assert.equal(afterCrew.noWork, false);

  const dropped = JSON.parse(JSON.stringify(forgedDay));
  delete dropped[DAY];
  asRole(CREW_USER, 'crew', `
SELECT public.fp_crew_write_job_records($payload$${rawJson([{ id: 'harbor', dayLogs: dropped }])}$payload$::jsonb);
`, { commit: true });
  assert.equal(jobs()[0].dayLogs[DAY].hourAdjustments[1].creditedTenths, 18);
  assert.equal(jobs()[0].dayLogs[DAY].crewPresent[0].endTime, '3:10 PM');
  assert.equal(jobs()[0].dayLogs[DAY].notes, 'crew note');

  const fresh = JSON.parse(JSON.stringify(jobs()[0].dayLogs));
  fresh[DAY].notes = 'still the crew note';
  fresh[DAY].hourAdjustments = [
    { crewIdx: 9, name: 'Eden Brooks', creditedTenths: 80, reason: 'added by crew', by: 'Impersonator', at: '1999-01-01T00:00:00.000Z' },
  ];
  asRole(CREW_USER, 'crew', `
SELECT public.fp_patch_job_records($payload$${rawJson([{
    id: 'harbor', op: 'patch',
    expected: { updated_at: null, dayLogs: jobs()[0].dayLogs },
    patch: { dayLogs: fresh },
    drop: [],
  }])}$payload$::jsonb);
`, { commit: true });
  assert.equal(jobs()[0].dayLogs[DAY].notes, 'still the crew note');
  assert.equal(jobs()[0].dayLogs[DAY].hourAdjustments.map(a => a.creditedTenths).join(','), '80,18');
  assert.equal(JSON.stringify(jobs()[0].dayLogs).includes('Eden Brooks'), false);

  let stale = '';
  try {
    asRole(OFFICE, 'office', `
SELECT public.fp_patch_job_records($payload$${rawJson([{
    id: 'harbor', op: 'patch',
    expected: { updated_at: '1999-01-01T00:00:00.000Z', dayLogs: jobs()[0].dayLogs },
    patch: { notes: 'too late' },
    drop: [],
  }])}$payload$::jsonb);
`);
  } catch (err) {
    stale = String(err.stderr || err.stdout || err.message);
  }
  assert.match(stale, /stale_job/);
  assert.equal(jobs()[0].dayLogs[DAY].hourAdjustments[0].creditedTenths, 80);

  const officeDay = JSON.parse(JSON.stringify(jobs()[0].dayLogs));
  officeDay[DAY].hourAdjustments = [
    {
      crewIdx: 0, name: 'Avery Cole', creditedTenths: 75, reason: 'Shorter credit',
      by: 'Impersonator', at: '2000-01-01T00:00:00.000Z',
    },
    officeDay[DAY].hourAdjustments[1],
  ];
  officeDay[DAY].hourAdjustments[1].by = 'Impersonator';
  officeDay[DAY].hourAdjustments[1].at = '2000-01-01T00:00:00.000Z';
  asRole(OFFICE, 'office', `
SELECT public.fp_patch_job_records($payload$${rawJson([{
    id: 'harbor', op: 'patch',
    expected: { updated_at: jobs()[0].updated_at || null, dayLogs: jobs()[0].dayLogs },
    patch: { dayLogs: officeDay },
    drop: [],
  }])}$payload$::jsonb);
`, { commit: true });
  const sealed = credits('harbor', DAY);
  assert.equal(sealed[0].creditedTenths, 75);
  assert.equal(sealed[0].by, 'Ops Reviewer');
  assert.notEqual(sealed[0].at, '2000-01-01T00:00:00.000Z');
  assert.match(sealed[0].at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const dbHour = psqlTuples(`SELECT to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24')`);
  assert.equal(sealed[0].at.slice(0, 13), dbHour);
  assert.equal(sealed[1].creditedTenths, 18);
  assert.equal(sealed[1].by, 'Ops Reviewer');
  assert.equal(sealed[1].at, '2026-06-23T15:00:00.000Z');
  assert.equal(sealed[1].requestedMinutes, 110);
  assert.equal(jobs()[0].dayLogs[DAY].crewPresent[0].startTime, '7:50 AM');
  assert.equal(jobs()[0].dayLogs[DAY].crewPresent[2].endTime, '8:20 AM');

  const audit = psqlTuples("SELECT actor || '|' || coalesce(details, '') FROM public.audit_log ORDER BY id");
  assert.match(audit, /Ops Reviewer/);
  assert.equal(audit.includes('Impersonator'), false);
  assert.match(audit, /"server": true/);
  let forgedAudit = '';
  try {
    asRole(CREW_USER, 'crew', `
INSERT INTO public.audit_log (actor, action, entity, details)
VALUES ('Impersonator', 'job_updated', 'Credited hours', '{"server": true}');
`, { commit: true });
  } catch (err) {
    forgedAudit = String(err.stderr || err.stdout || err.message);
  }
  assert.match(forgedAudit, /not allowed/);
  assert.equal(psqlTuples("SELECT count(*) FROM public.audit_log WHERE actor = 'Impersonator'"), '0');

  const unchanged = JSON.parse(JSON.stringify(jobs()[0].dayLogs));
  unchanged[DAY].notes = 'office note';
  unchanged[DAY].hourAdjustments[0].by = 'Impersonator';
  unchanged[DAY].hourAdjustments[0].at = '1999-05-05T00:00:00.000Z';
  asRole(OFFICE, 'office', `
UPDATE public.settings
SET value = '${sqlJson([{ ...jobs()[0], dayLogs: unchanged }])}'
WHERE key = 'job_records';
`, { commit: true });
  assert.equal(jobs()[0].dayLogs[DAY].notes, 'office note');
  assert.equal(credits('harbor', DAY)[0].by, 'Ops Reviewer');
  assert.equal(credits('harbor', DAY)[0].at, sealed[0].at);
  assert.equal(credits('harbor', DAY)[0].creditedTenths, 75);
  assert.equal(jobs()[0].dayLogs[DAY].startTime, '9:00 AM');
  assert.equal(jobs()[0].dayLogs[DAY].endTime, '3:10 PM');

  assert.equal(psqlTuples("SELECT count(*) FROM public.settings WHERE key = 'job_records'"), '1');
  const harborBeforeInsert = jobs()[0];
  asRole(OFFICE, 'office', `
SELECT public.fp_patch_job_records($payload$${rawJson([{
    id: 'ridge', op: 'insert',
    patch: {
      customer: 'Ridge Hall',
      status: 'scheduled',
      dayLogs: {
        [DAY]: {
          fullDay: false, noWork: false,
          crewPresent: [{ crewIdx: 1, name: 'Blake Diaz', startTime: '7:45 AM', endTime: '8:15 AM' }],
          hourAdjustments: [{ crewIdx: 1, name: 'Blake Diaz', creditedTenths: 18, reason: 'Balance to 8.0h', by: 'Impersonator', at: '2000-01-01T00:00:00.000Z' }],
        },
      },
    },
  }])}$payload$::jsonb);
`, { commit: true });
  assert.equal(psqlTuples("SELECT count(*) FROM public.settings WHERE key = 'job_records'"), '1');
  const ridge = jobs().find(j => j.id === 'ridge');
  const harbor = jobs().find(j => j.id === 'harbor');
  assert.ok(ridge);
  assert.equal(ridge.customer, 'Ridge Hall');
  assert.equal(ridge.dayLogs[DAY].crewPresent[0].startTime, '7:45 AM');
  assert.equal(ridge.dayLogs[DAY].hourAdjustments[0].creditedTenths, 18);
  assert.equal(ridge.dayLogs[DAY].hourAdjustments[0].by, 'Ops Reviewer');
  assert.notEqual(ridge.dayLogs[DAY].hourAdjustments[0].at, '2000-01-01T00:00:00.000Z');
  assert.equal(harbor.dayLogs[DAY].notes, 'office note');
  assert.equal(harbor.dayLogs[DAY].hourAdjustments[0].creditedTenths, 75);
  assert.equal(harbor.dayLogs[DAY].hourAdjustments[0].at, sealed[0].at);
  assert.equal(harbor.updated_at, harborBeforeInsert.updated_at);

  asRole(OFFICE, 'office', `
SELECT public.fp_patch_job_records($payload$${rawJson([{
    id: 'harbor', op: 'patch',
    expected: { updated_at: harbor.updated_at || null, notes: harbor.notes },
    patch: { notes: 'patched after the insert' },
    drop: [],
  }])}$payload$::jsonb);
`, { commit: true });
  assert.equal(jobs().find(j => j.id === 'harbor').notes, 'patched after the insert');
  assert.equal(jobs().find(j => j.id === 'harbor').dayLogs[DAY].hourAdjustments[0].creditedTenths, 75);
  assert.equal(jobs().find(j => j.id === 'ridge').dayLogs[DAY].hourAdjustments[0].creditedTenths, 18);
  assert.equal(psqlTuples("SELECT count(*) FROM public.settings WHERE key = 'job_records'"), '1');

  const crewFlags = JSON.parse(JSON.stringify(jobs().find(j => j.id === 'harbor').dayLogs));
  crewFlags[DAY].fullDay = true;
  crewFlags[DAY].noWork = true;
  crewFlags[DAY].notes = 'crew flags';
  crewFlags[DAY].hourAdjustments = [{ crewIdx: 0, name: 'Avery Cole', creditedTenths: 10, reason: 'crew wipe', by: 'Impersonator', at: '2000-01-01T00:00:00.000Z' }];
  const harborNow = jobs().find(j => j.id === 'harbor');
  asRole(CREW_USER, 'crew', `
SELECT public.fp_patch_job_records($payload$${rawJson([{
    id: 'harbor', op: 'patch',
    expected: { updated_at: harborNow.updated_at || null, dayLogs: harborNow.dayLogs, notes: harborNow.notes },
    patch: { dayLogs: crewFlags, notes: 'crew flags' },
    drop: [],
  }])}$payload$::jsonb);
`, { commit: true });
  const flagged = jobs().find(j => j.id === 'harbor').dayLogs[DAY];
  assert.equal(flagged.fullDay, true);
  assert.equal(flagged.noWork, true);
  assert.equal(flagged.notes, 'crew flags');
  assert.equal(flagged.hourAdjustments[0].creditedTenths, 75);
  assert.equal(flagged.hourAdjustments[0].by, 'Ops Reviewer');
  assert.equal(flagged.crewPresent[0].startTime, '7:50 AM');

  asRole(CREW_USER, 'crew', `
SELECT public.fp_patch_job_records($payload$${rawJson([{
    id: 'meadow', op: 'insert',
    patch: {
      customer: 'Meadow Hall',
      dayLogs: {
        [DAY]: {
          fullDay: true, noWork: false, notes: 'crew created',
          crewPresent: [{ crewIdx: 0, name: 'Avery Cole', startTime: '8:00 AM', endTime: '4:00 PM' }],
          hourAdjustments: [{ crewIdx: 0, name: 'Avery Cole', creditedTenths: 80, reason: 'crew insert', by: 'Impersonator', at: '2000-01-01T00:00:00.000Z' }],
        },
      },
    },
  }])}$payload$::jsonb);
`, { commit: true });
  const meadow = jobs().find(j => j.id === 'meadow');
  assert.equal(meadow.dayLogs[DAY].notes, 'crew created');
  assert.equal(meadow.dayLogs[DAY].fullDay, true);
  assert.equal(meadow.dayLogs[DAY].crewPresent[0].endTime, '4:00 PM');
  assert.equal(meadow.dayLogs[DAY].hourAdjustments, undefined);
  assert.equal(psqlTuples("SELECT count(*) FROM public.settings WHERE key = 'job_records'"), '1');
  assert.equal(jobs().filter(j => j.id === 'harbor' || j.id === 'ridge' || j.id === 'meadow').length, 3);

  const roleless = JSON.parse(JSON.stringify(jobs()));
  const rolelessHarbor = roleless.find(j => j.id === 'harbor');
  rolelessHarbor.dayLogs[DAY].hourAdjustments[0].creditedTenths = 10;
  rolelessHarbor.dayLogs[DAY].hourAdjustments[0].by = 'Script';
  rolelessHarbor.dayLogs[DAY].hourAdjustments[0].at = '2001-01-01T00:00:00.000Z';
  psql(db, `
UPDATE public.settings SET value = '${sqlJson(roleless)}' WHERE key = 'job_records';
`);
  assert.equal(psqlTuples("SELECT count(*) FROM public.settings WHERE key = 'job_records'"), '1');
  assert.equal(credits('harbor', DAY)[0].creditedTenths, 10);
  assert.equal(credits('harbor', DAY)[0].by, 'Script');
  assert.equal(credits('harbor', DAY)[0].at, '2001-01-01T00:00:00.000Z');
});
