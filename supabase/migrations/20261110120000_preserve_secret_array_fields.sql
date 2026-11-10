-- Keep stored prices on material lines when a crew member saves a job.
--
-- APPLY THIS FILE FIRST, then 20261110123000_strip_crew_unit_cost.sql.
-- Do not apply either file on the live project until that order is accepted.
-- This file does not UPDATE, INSERT, or DELETE any stored row.
--
-- Crew saves go through fp_patch_job_records and the older
-- fp_crew_write_job_records. Both merge with fp_overlay_json. A secret field
-- on a matching object was already kept (a wage stamp on a person, the job's
-- contract value). An array was not: the phone's array replaced the stored
-- array. dayLogs[].materialsUsed is that array. Today the phone still receives
-- unitCost and sends it back, so the price survives. The moment unitCost is
-- hidden, the phone stops sending it and the next crew save would erase every
-- stored unitCost. Office costing would then price the line from today's list.
--
-- After this file, a crew material line keeps the stored secret fields of the
-- matching stored line. Match is matId. A line with no matId matches name plus
-- the unit (usageUnit on a day log, otherwise unit). Order can change. A new
-- line gets no stored cost. A line the phone leaves out is removed. A price
-- the phone itself sends is ignored. The same rule covers every other array
-- of objects in a job (planned materials, photos, credited hours) so a secret
-- field inside one of those cannot be wiped by replacing the list. Lists of
-- plain values (extra days, the dates under crewDays) stay the phone's list.
-- supplierInvoices and commissions are secret keys already, so the whole
-- stored list is kept and the phone cannot replace it.
--
-- unitCost and amount are added to the secret list in this same step. Hiding
-- them and teaching the save to keep them has to happen together. Applying
-- only the hide would erase the stored costs on the next crew save.
--
-- Rollback (both the merge and the secret list): 
-- supabase/rollback/20261110120000_preserve_secret_array_fields.sql

BEGIN;

CREATE OR REPLACE FUNCTION private.fp_contains_secret(j jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  k text;
  v jsonb;
  elem jsonb;
BEGIN
  IF jsonb_typeof(j) = 'object' THEN
    FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
      IF private.fp_secret_key(k) OR private.fp_contains_secret(v) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  ELSIF jsonb_typeof(j) = 'array' THEN
    FOR elem IN SELECT value FROM jsonb_array_elements(j) LOOP
      IF private.fp_contains_secret(elem) THEN
        RETURN true;
      END IF;
    END LOOP;
    RETURN false;
  END IF;
  RETURN false;
END;
$$;

-- The measure on a material line. Day logs store it as usageUnit.
-- Planned materials store it as unit.
CREATE OR REPLACE FUNCTION private.fp_line_unit(elem jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(btrim(coalesce(
    nullif(btrim(elem ->> 'usageUnit'), ''),
    nullif(btrim(elem ->> 'unit'), ''),
    ''
  )));
$$;

CREATE OR REPLACE FUNCTION private.fp_array_line_match(array_key text, server jsonb, client jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  key_name text := lower(coalesce(array_key, ''));
  client_id text := nullif(btrim(client ->> 'id'), '');
  client_mat text := nullif(btrim(client ->> 'matId'), '');
  client_name text := lower(btrim(coalesce(client ->> 'name', '')));
  server_name text := lower(btrim(coalesce(server ->> 'name', '')));
BEGIN
  IF jsonb_typeof(server) <> 'object' OR jsonb_typeof(client) <> 'object' THEN
    RETURN false;
  END IF;

  IF key_name = 'materialsused' OR key_name = 'plannedmaterials' THEN
    IF client_mat IS NOT NULL THEN
      RETURN nullif(btrim(server ->> 'matId'), '') IS NOT DISTINCT FROM client_mat;
    END IF;
    RETURN client_name = server_name
      AND private.fp_line_unit(server) = private.fp_line_unit(client)
      AND (client_name <> '' OR private.fp_line_unit(client) <> '');
  END IF;

  IF key_name = 'houradjustments' THEN
    IF nullif(btrim(client ->> 'crewIdx'), '') IS NOT NULL THEN
      RETURN nullif(btrim(server ->> 'crewIdx'), '') IS NOT DISTINCT FROM nullif(btrim(client ->> 'crewIdx'), '');
    END IF;
    RETURN client_name <> '' AND client_name = server_name;
  END IF;

  IF client_id IS NOT NULL THEN
    RETURN nullif(btrim(server ->> 'id'), '') IS NOT DISTINCT FROM client_id;
  END IF;
  IF client_mat IS NOT NULL THEN
    RETURN nullif(btrim(server ->> 'matId'), '') IS NOT DISTINCT FROM client_mat;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_stamp_stored_secrets(server jsonb, client jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  k text;
  sv jsonb;
  cv jsonb;
  out jsonb;
BEGIN
  IF jsonb_typeof(client) <> 'object' OR jsonb_typeof(server) <> 'object' THEN
    RETURN client;
  END IF;
  out := client;
  FOR k, sv IN SELECT * FROM jsonb_each(server) LOOP
    IF private.fp_secret_key(k) THEN
      out := out || jsonb_build_object(k, sv);
    ELSIF out ? k THEN
      cv := out -> k;
      IF jsonb_typeof(sv) = 'object' AND jsonb_typeof(cv) = 'object' THEN
        out := jsonb_set(out, ARRAY[k], private.fp_stamp_stored_secrets(sv, cv), true);
      ELSIF jsonb_typeof(sv) = 'array' AND jsonb_typeof(cv) = 'array' THEN
        out := jsonb_set(out, ARRAY[k], private.fp_merge_secret_array(sv, cv, k), true);
      END IF;
    END IF;
  END LOOP;
  RETURN out;
END;
$$;

-- Phone list wins for which lines exist and for ordinary fields.
-- Stored secret fields are copied onto the matching line. A line with no
-- stored match gets none. A stored line the phone left out is gone.
CREATE OR REPLACE FUNCTION private.fp_merge_secret_array(server jsonb, client jsonb, array_key text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  c jsonb;
  redacted jsonb;
  out jsonb := '[]'::jsonb;
  used boolean[];
  i integer;
  n integer;
  found integer;
  has_object boolean := false;
BEGIN
  IF client IS NULL OR jsonb_typeof(client) <> 'array' THEN
    RETURN private.fp_redact_json(client);
  END IF;
  IF server IS NULL OR jsonb_typeof(server) <> 'array' THEN
    server := '[]'::jsonb;
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(client) AS elem WHERE jsonb_typeof(elem) = 'object'
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(server) AS elem WHERE jsonb_typeof(elem) = 'object'
  ) INTO has_object;
  IF NOT has_object THEN
    RETURN private.fp_redact_json(client);
  END IF;

  n := jsonb_array_length(server);
  IF n > 0 THEN
    used := array_fill(false, ARRAY[n]);
  ELSE
    used := ARRAY[]::boolean[];
  END IF;

  FOR c IN SELECT value FROM jsonb_array_elements(client) LOOP
    IF jsonb_typeof(c) <> 'object' THEN
      out := out || jsonb_build_array(private.fp_redact_json(c));
      CONTINUE;
    END IF;
    redacted := private.fp_redact_json(c);
    found := NULL;
    i := 0;
    WHILE i < n LOOP
      IF NOT used[i + 1]
         AND private.fp_array_line_match(array_key, server -> i, c) THEN
        used[i + 1] := true;
        found := i;
        EXIT;
      END IF;
      i := i + 1;
    END LOOP;
    IF found IS NULL THEN
      out := out || jsonb_build_array(redacted);
    ELSE
      out := out || jsonb_build_array(private.fp_stamp_stored_secrets(server -> found, redacted));
    END IF;
  END LOOP;
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_overlay_json(server jsonb, client jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  k text;
  v jsonb;
  out jsonb;
BEGIN
  IF client IS NULL OR jsonb_typeof(client) = 'null' THEN
    RETURN server;
  END IF;
  IF server IS NULL OR jsonb_typeof(server) = 'null' THEN
    RETURN private.fp_redact_json(client);
  END IF;
  IF jsonb_typeof(server) <> 'object' OR jsonb_typeof(client) <> 'object' THEN
    RETURN private.fp_redact_json(client);
  END IF;
  out := server;
  FOR k, v IN SELECT * FROM jsonb_each(client) LOOP
    IF private.fp_secret_key(k) THEN
      CONTINUE;
    ELSIF k = 'crewPresent' THEN
      out := jsonb_set(out, ARRAY[k], private.fp_merge_crew_present(out -> k, v), true);
    ELSIF k = 'dayLogs' THEN
      out := jsonb_set(out, ARRAY[k], private.fp_merge_day_logs(out -> k, v), true);
    ELSIF jsonb_typeof(v) = 'object'
      AND (out -> k IS NULL OR jsonb_typeof(out -> k) IN ('object', 'null')) THEN
      out := jsonb_set(out, ARRAY[k], private.fp_overlay_json(out -> k, v), true);
    ELSIF jsonb_typeof(v) = 'array' THEN
      out := jsonb_set(out, ARRAY[k], private.fp_merge_secret_array(out -> k, v, k), true);
    ELSE
      out := jsonb_set(out, ARRAY[k], private.fp_redact_json(v), true);
    END IF;
  END LOOP;
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_merge_day_logs(server jsonb, client jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  k text;
  v jsonb;
  out jsonb := '{}'::jsonb;
BEGIN
  IF client IS NULL OR jsonb_typeof(client) = 'null' THEN
    RETURN server;
  END IF;
  IF jsonb_typeof(client) <> 'object' THEN
    RETURN private.fp_redact_json(client);
  END IF;
  IF server IS NULL OR jsonb_typeof(server) <> 'object' THEN
    server := '{}'::jsonb;
  END IF;
  FOR k, v IN SELECT * FROM jsonb_each(client) LOOP
    IF private.fp_secret_key(k) THEN
      CONTINUE;
    ELSIF jsonb_typeof(v) = 'object' THEN
      out := out || jsonb_build_object(k, private.fp_overlay_json(server -> k, v));
    ELSIF jsonb_typeof(v) = 'array' THEN
      out := out || jsonb_build_object(k, private.fp_merge_secret_array(server -> k, v, k));
    ELSE
      out := out || jsonb_build_object(k, private.fp_redact_json(v));
    END IF;
  END LOOP;
  RETURN out;
END;
$$;

-- Hide per-unit prices in the same step as the merge that keeps them.
-- 20261110123000 sets this same list again, and refuses to run if this
-- merge is not already installed.
CREATE OR REPLACE FUNCTION private.fp_secret_key(k text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(coalesce(k, '')) IN (
    'value', 'displayval', 'supplierinvoices',
    'mileagerate', 'mileageoneway',
    'prevailingwage', 'prevailingwagerate', 'prevailingwageburden',
    'burdenedrate', 'directrate', 'otrate', 'baserate', 'statmult',
    'overheadrate', 'rateversion', 'fieldoverride', 'rateestimated',
    'overtimewage', 'cashwages',
    'consumablespct', 'consumablespctset',
    'costcategory', 'costlinkid', 'commissions',
    'tmjob', 'tmlabormarkup', 'tmmaterialmarkup',
    'price', 'hourly', 'wage',
    'unitcost', 'amount'
  );
$$;

CREATE OR REPLACE FUNCTION public.fp_patch_job_records(patches jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  jobs jsonb;
  elem jsonb;
  job jsonb;
  expected jsonb;
  patch jsonb;
  drop_keys jsonb;
  pid text;
  op text;
  role text;
  k text;
  v jsonb;
  i integer;
  n integer;
  job_found boolean;
  stamp text;
BEGIN
  role := private.fp_role();
  IF role IS NULL OR role NOT IN ('owner', 'office', 'crew') THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF patches IS NULL OR jsonb_typeof(patches) <> 'array' THEN
    RAISE EXCEPTION 'patches must be a JSON array';
  END IF;

  SELECT s.value INTO raw
  FROM public.settings AS s
  WHERE s.key = 'job_records'
  FOR UPDATE;
  IF raw IS NULL OR btrim(raw) = '' THEN
    jobs := '[]'::jsonb;
  ELSE
    jobs := raw::jsonb;
  END IF;
  IF jsonb_typeof(jobs) <> 'array' THEN
    RAISE EXCEPTION 'job_records is damaged';
  END IF;

  stamp := to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

  FOR elem IN SELECT value FROM jsonb_array_elements(patches) LOOP
    IF jsonb_typeof(elem) <> 'object' THEN
      RAISE EXCEPTION 'stale_job';
    END IF;
    pid := elem ->> 'id';
    IF pid IS NULL OR pid = '' THEN
      RAISE EXCEPTION 'stale_job';
    END IF;
    op := coalesce(elem ->> 'op', 'patch');
    expected := coalesce(elem -> 'expected', '{}'::jsonb);
    patch := coalesce(elem -> 'patch', '{}'::jsonb);
    drop_keys := coalesce(elem -> 'drop', '[]'::jsonb);

    job_found := false;
    job := NULL;
    i := 0;
    n := jsonb_array_length(jobs);
    WHILE i < n LOOP
      IF (jobs -> i) ->> 'id' = pid THEN
        job := jobs -> i;
        job_found := true;
        EXIT;
      END IF;
      i := i + 1;
    END LOOP;

    IF op = 'delete' THEN
      IF role = 'crew' THEN
        RAISE EXCEPTION 'not allowed';
      END IF;
      IF NOT job_found THEN
        CONTINUE;
      END IF;
      IF coalesce(job ->> 'updated_at', '') IS DISTINCT FROM coalesce(expected ->> 'updated_at', '') THEN
        RAISE EXCEPTION 'stale_job' USING DETAIL = pid;
      END IF;
      IF elem ? 'basis'
         AND NOT private.fp_json_same(job - 'updated_at', elem -> 'basis') THEN
        RAISE EXCEPTION 'stale_job' USING DETAIL = pid;
      END IF;
      SELECT coalesce(jsonb_agg(s.value ORDER BY s.ord), '[]'::jsonb)
        INTO jobs
      FROM jsonb_array_elements(jobs) WITH ORDINALITY AS s(value, ord)
      WHERE s.value ->> 'id' IS DISTINCT FROM pid;
      CONTINUE;
    END IF;

    IF NOT job_found THEN
      IF op <> 'insert' THEN
        RAISE EXCEPTION 'stale_job' USING DETAIL = pid;
      END IF;
      job := CASE WHEN role = 'crew' THEN private.fp_redact_json(patch) ELSE patch END;
      job := jsonb_set(job, ARRAY['id'], to_jsonb(pid), true);
      job := jsonb_set(job, ARRAY['updated_at'], to_jsonb(stamp), true);
      jobs := jobs || jsonb_build_array(job);
      CONTINUE;
    END IF;

    IF coalesce(job ->> 'updated_at', '') IS DISTINCT FROM coalesce(expected ->> 'updated_at', '') THEN
      RAISE EXCEPTION 'stale_job' USING DETAIL = pid;
    END IF;

    FOR k, v IN SELECT * FROM jsonb_each(patch) LOOP
      IF k IN ('id', 'updated_at') THEN
        CONTINUE;
      END IF;
      IF role = 'crew' AND private.fp_secret_key(k) THEN
        CONTINUE;
      END IF;
      IF role = 'crew' THEN
        IF NOT private.fp_json_same(private.fp_redact_json(job -> k), private.fp_redact_json(expected -> k)) THEN
          RAISE EXCEPTION 'stale_job' USING DETAIL = pid || ' ' || k;
        END IF;
      ELSIF NOT private.fp_json_same(job -> k, expected -> k) THEN
        RAISE EXCEPTION 'stale_job' USING DETAIL = pid || ' ' || k;
      END IF;
      IF role = 'crew' AND jsonb_typeof(v) = 'object' AND jsonb_typeof(job -> k) = 'object' THEN
        job := jsonb_set(job, ARRAY[k], private.fp_overlay_json(job -> k, v), true);
      ELSIF role = 'crew' AND jsonb_typeof(v) = 'array' THEN
        job := jsonb_set(job, ARRAY[k], private.fp_merge_secret_array(job -> k, v, k), true);
      ELSIF role = 'crew' THEN
        job := jsonb_set(job, ARRAY[k], private.fp_redact_json(v), true);
      ELSE
        job := jsonb_set(job, ARRAY[k], v, true);
      END IF;
    END LOOP;

    IF jsonb_typeof(drop_keys) = 'array' THEN
      FOR k IN SELECT jsonb_array_elements_text(drop_keys) LOOP
        IF k IN ('id', 'updated_at') THEN
          CONTINUE;
        END IF;
        IF role = 'crew' AND (private.fp_secret_key(k) OR private.fp_contains_secret(job -> k)) THEN
          CONTINUE;
        END IF;
        IF role = 'crew' THEN
          IF NOT private.fp_json_same(private.fp_redact_json(job -> k), private.fp_redact_json(expected -> k)) THEN
            RAISE EXCEPTION 'stale_job' USING DETAIL = pid || ' ' || k;
          END IF;
        ELSIF NOT private.fp_json_same(job -> k, expected -> k) THEN
          RAISE EXCEPTION 'stale_job' USING DETAIL = pid || ' ' || k;
        END IF;
        job := job - k;
      END LOOP;
    END IF;

    job := jsonb_set(job, ARRAY['updated_at'], to_jsonb(stamp), true);
    jobs := jsonb_set(jobs, ARRAY[i::text], job, false);
  END LOOP;

  UPDATE public.settings SET value = jobs::text WHERE key = 'job_records' RETURNING value INTO raw;
  IF NOT FOUND THEN
    INSERT INTO public.settings (key, value) VALUES ('job_records', jobs::text) RETURNING value INTO raw;
  END IF;
  jobs := raw::jsonb;

  IF role = 'crew' THEN
    RETURN jsonb_build_object('ok', true, 'jobs', private.fp_redact_json(jobs));
  END IF;
  RETURN jsonb_build_object('ok', true, 'jobs', jobs);
END;
$$;

REVOKE ALL ON FUNCTION private.fp_contains_secret(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_line_unit(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_array_line_match(text, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_stamp_stored_secrets(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_merge_secret_array(jsonb, jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_secret_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_overlay_json(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_merge_day_logs(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fp_patch_job_records(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_patch_job_records(jsonb) TO authenticated;

-- Sample lines, then the stored jobs. Read-only: settings is not written.
-- A crew round-trip is the phone saving the job it was allowed to see.
DO $check$
DECLARE
  server jsonb := $json${
    "id": "sample",
    "customer": "Sample Shop",
    "value": "4821.77",
    "supplierInvoices": [{"vendor": "Acme", "invoiceNum": "100", "amount": 88.25}],
    "commissions": [{"recipient": "Office", "amount": 10, "type": "flat"}],
    "extraDays": ["2026-11-03"],
    "dayLogs": {
      "2026-11-02": {
        "task": "Coat",
        "crewPresent": [{"crewIdx": 0, "name": "Seth West", "burdenedRate": "42.50", "startTime": "8:00 AM"}],
        "materialsUsed": [
          {"matId": "a", "name": "Flake", "qty": "4", "usageUnit": "Lbs", "unitCost": 19.41},
          {"matId": "b", "name": "Epoxy", "qty": "1", "usageUnit": "Gallon", "unitCost": 46.67},
          {"name": "Tape", "qty": "2", "usageUnit": "Roll", "unitCost": 3.5},
          {"matId": "c", "name": "Sand", "qty": "1", "usageUnit": "Bag", "unitCost": 8}
        ]
      }
    }
  }$json$::jsonb;
  client jsonb := $json${
    "id": "sample",
    "customer": "Sample Shop",
    "value": "1",
    "supplierInvoices": [{"vendor": "Nope", "amount": 1}],
    "extraDays": ["2026-11-04"],
    "dayLogs": {
      "2026-11-02": {
        "task": "Coat",
        "crewPresent": [{"crewIdx": 0, "name": "Seth West", "burdenedRate": "1", "startTime": "9:00 AM"}],
        "materialsUsed": [
          {"matId": "b", "name": "Epoxy", "qty": "9", "usageUnit": "Gallon", "unitCost": 999},
          {"name": "Tape", "qty": "2", "usageUnit": "roll", "unitCost": 1},
          {"matId": "a", "name": "Flake renamed", "qty": "4", "usageUnit": "Lbs", "unitCost": 0},
          {"matId": "new", "name": "Quartz", "qty": "1", "usageUnit": "Bag", "unitCost": 50}
        ]
      }
    }
  }$json$::jsonb;
  merged jsonb;
  seen jsonb;
  raw text;
  before_sig jsonb;
  after_sig jsonb;
  cost_keys integer;
BEGIN
  merged := private.fp_overlay_json(server, client);
  IF (merged #>> '{dayLogs,2026-11-02,materialsUsed,0,matId}') IS DISTINCT FROM 'b'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,0,unitCost}') IS DISTINCT FROM '46.67'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,0,qty}') IS DISTINCT FROM '9'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,1,name}') IS DISTINCT FROM 'Tape'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,1,unitCost}') IS DISTINCT FROM '3.5'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,2,matId}') IS DISTINCT FROM 'a'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,2,unitCost}') IS DISTINCT FROM '19.41'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,2,name}') IS DISTINCT FROM 'Flake renamed'
     OR (merged -> 'dayLogs' -> '2026-11-02' -> 'materialsUsed' -> 3) ? 'unitCost'
     OR (merged #>> '{dayLogs,2026-11-02,materialsUsed,3,matId}') IS DISTINCT FROM 'new'
     OR jsonb_array_length(merged #> '{dayLogs,2026-11-02,materialsUsed}') IS DISTINCT FROM 4
     OR (merged #>> '{supplierInvoices,0,amount}') IS DISTINCT FROM '88.25'
     OR (merged #>> '{value}') IS DISTINCT FROM '4821.77'
     OR (merged #>> '{dayLogs,2026-11-02,crewPresent,0,burdenedRate}') IS DISTINCT FROM '42.50'
     OR (merged #>> '{dayLogs,2026-11-02,crewPresent,0,startTime}') IS DISTINCT FROM '9:00 AM'
     OR (merged #>> '{extraDays,0}') IS DISTINCT FROM '2026-11-04'
     OR (merged #> '{commissions,0,amount}') IS DISTINCT FROM '10'::jsonb THEN
    RAISE EXCEPTION 'sample crew save did not keep stored costs';
  END IF;
  seen := private.fp_redact_json(merged);
  IF seen::text ~* 'unitCost|4821|46\.67|88\.25|42\.50|"amount"' THEN
    RAISE EXCEPTION 'sample crew read still contains a cost';
  END IF;

  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RAISE NOTICE 'secret-array check: no stored job_records; sample passed';
    RETURN;
  END IF;

  SELECT coalesce(jsonb_agg(
           jsonb_build_array(job ->> 'id', day.key, elem ->> 'matId', elem -> 'unitCost')
           ORDER BY job ->> 'id', day.key, coalesce(elem ->> 'matId', ''), elem ->> 'unitCost'
         ), '[]'::jsonb)
    INTO before_sig
  FROM jsonb_array_elements(raw::jsonb) AS job
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(job -> 'dayLogs') = 'object' THEN job -> 'dayLogs' ELSE '{}'::jsonb END) AS day(key, value)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(day.value -> 'materialsUsed') = 'array' THEN day.value -> 'materialsUsed' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS line(elem, ord)
  WHERE jsonb_typeof(elem) = 'object' AND elem ? 'unitCost';

  merged := '[]'::jsonb;
  FOR seen IN SELECT value FROM jsonb_array_elements(raw::jsonb) LOOP
    IF jsonb_typeof(seen) = 'object' THEN
      merged := merged || jsonb_build_array(private.fp_overlay_json(seen, private.fp_redact_json(seen)));
    ELSE
      merged := merged || jsonb_build_array(seen);
    END IF;
  END LOOP;

  SELECT coalesce(jsonb_agg(
           jsonb_build_array(job ->> 'id', day.key, elem ->> 'matId', elem -> 'unitCost')
           ORDER BY job ->> 'id', day.key, coalesce(elem ->> 'matId', ''), elem ->> 'unitCost'
         ), '[]'::jsonb)
    INTO after_sig
  FROM jsonb_array_elements(merged) AS job
  CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(job -> 'dayLogs') = 'object' THEN job -> 'dayLogs' ELSE '{}'::jsonb END) AS day(key, value)
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(day.value -> 'materialsUsed') = 'array' THEN day.value -> 'materialsUsed' ELSE '[]'::jsonb END
  ) WITH ORDINALITY AS line(elem, ord)
  WHERE jsonb_typeof(elem) = 'object' AND elem ? 'unitCost';

  IF before_sig IS DISTINCT FROM after_sig THEN
    RAISE EXCEPTION 'stored unitCost would change on a crew save';
  END IF;

  SELECT count(*)::integer INTO cost_keys
  FROM (
    WITH RECURSIVE walk AS (
      SELECT private.fp_redact_json(merged) AS node, NULL::text AS k
      UNION ALL
      SELECT child.node, child.k
      FROM walk AS w
      CROSS JOIN LATERAL (
        SELECT e.value AS node, e.key AS k
        FROM jsonb_each(w.node) AS e
        WHERE jsonb_typeof(w.node) = 'object'
        UNION ALL
        SELECT a.value, NULL::text
        FROM jsonb_array_elements(w.node) AS a
        WHERE jsonb_typeof(w.node) = 'array'
      ) AS child
    )
    SELECT 1
    FROM walk
    WHERE private.fp_secret_key(k)
  ) AS hits;

  RAISE NOTICE 'secret-array check: unitCost values kept=%, crew cost keys=%', jsonb_array_length(before_sig), cost_keys;
  IF cost_keys <> 0 THEN
    RAISE EXCEPTION 'crew read of stored jobs still has % cost keys', cost_keys;
  END IF;
END
$check$;

-- Read-only query to run by hand after this file is applied.
-- It does not write. unitcost_before and unitcost_after must be equal,
-- values_match must be true, and crew_cost_keys must be 0.
--
-- WITH stored AS (
--   SELECT value::jsonb AS jobs
--   FROM public.settings
--   WHERE key = 'job_records'
-- ), roundtrip AS (
--   SELECT coalesce(jsonb_agg(
--            CASE WHEN jsonb_typeof(job) = 'object'
--              THEN private.fp_overlay_json(job, private.fp_redact_json(job))
--              ELSE job
--            END
--          ), '[]'::jsonb) AS jobs
--   FROM stored, jsonb_array_elements(stored.jobs) AS job
-- ), before_sig AS (
--   SELECT coalesce(jsonb_agg(
--            jsonb_build_array(job ->> 'id', day.key, elem ->> 'matId', elem -> 'unitCost')
--            ORDER BY job ->> 'id', day.key, coalesce(elem ->> 'matId', ''), elem ->> 'unitCost'
--          ), '[]'::jsonb) AS sig
--   FROM stored
--   CROSS JOIN LATERAL jsonb_array_elements(stored.jobs) AS job
--   CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(job -> 'dayLogs') = 'object' THEN job -> 'dayLogs' ELSE '{}'::jsonb END) AS day(key, value)
--   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(day.value -> 'materialsUsed') = 'array' THEN day.value -> 'materialsUsed' ELSE '[]'::jsonb END) WITH ORDINALITY AS line(elem, ord)
--   WHERE jsonb_typeof(elem) = 'object' AND elem ? 'unitCost'
-- ), after_sig AS (
--   SELECT coalesce(jsonb_agg(
--            jsonb_build_array(job ->> 'id', day.key, elem ->> 'matId', elem -> 'unitCost')
--            ORDER BY job ->> 'id', day.key, coalesce(elem ->> 'matId', ''), elem ->> 'unitCost'
--          ), '[]'::jsonb) AS sig
--   FROM roundtrip
--   CROSS JOIN LATERAL jsonb_array_elements(roundtrip.jobs) AS job
--   CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(job -> 'dayLogs') = 'object' THEN job -> 'dayLogs' ELSE '{}'::jsonb END) AS day(key, value)
--   CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(day.value -> 'materialsUsed') = 'array' THEN day.value -> 'materialsUsed' ELSE '[]'::jsonb END) WITH ORDINALITY AS line(elem, ord)
--   WHERE jsonb_typeof(elem) = 'object' AND elem ? 'unitCost'
-- ), crew_hits AS (
--   SELECT count(*) AS n
--   FROM (
--     WITH RECURSIVE walk AS (
--       SELECT private.fp_redact_json((SELECT jobs FROM roundtrip)) AS node, NULL::text AS k
--       UNION ALL
--       SELECT child.node, child.k
--       FROM walk AS w
--       CROSS JOIN LATERAL (
--         SELECT e.value AS node, e.key AS k
--         FROM jsonb_each(w.node) AS e
--         WHERE jsonb_typeof(w.node) = 'object'
--         UNION ALL
--         SELECT a.value, NULL::text
--         FROM jsonb_array_elements(w.node) AS a
--         WHERE jsonb_typeof(w.node) = 'array'
--       ) AS child
--     )
--     SELECT 1 FROM walk WHERE private.fp_secret_key(k)
--   ) AS hits
-- )
-- SELECT jsonb_array_length(b.sig) AS unitcost_before,
--        jsonb_array_length(a.sig) AS unitcost_after,
--        b.sig IS NOT DISTINCT FROM a.sig AS values_match,
--        h.n AS crew_cost_keys
-- FROM before_sig AS b, after_sig AS a, crew_hits AS h;

COMMIT;
