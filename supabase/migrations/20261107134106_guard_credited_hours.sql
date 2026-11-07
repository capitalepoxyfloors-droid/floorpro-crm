-- Server guard for per-person credited hours inside settings.job_records.
--
-- REVIEW ONLY. Do not apply this on the live project from here.
-- It does not read or rewrite existing rows. Credits and clocks already stored
-- stay as they are until a later save. On that save, an unchanged credit keeps
-- its stored actor and time. A changed credit is stamped from the signed-in
-- pin account and the database clock, not from the JSON the browser sent.
--
-- Crew cannot add, change, or remove a credit, including by omitting the key
-- or the whole day. Their note and clock edits on a day that still exists are
-- kept. A day that already has a credit is put back if a crew payload drops it.
-- Owner and office may change or clear credits.
--
-- Backup before applying: copy public.settings where key = 'job_records'.
-- Rollback: supabase/rollback/20261107134106_guard_credited_hours.sql
-- That rollback removes this guard only. It does not restore job JSON.

BEGIN;

CREATE OR REPLACE FUNCTION private.fp_credit_actor()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (
      SELECT NULLIF(btrim(p.label), '')
      FROM public.pin_accounts AS p
      WHERE p.auth_user_id = auth.uid()
        AND p.kind = private.fp_role()
      LIMIT 1
    ),
    private.fp_role(),
    'unknown'
  );
$$;

CREATE OR REPLACE FUNCTION private.fp_credit_identity(elem jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN elem IS NULL OR jsonb_typeof(elem) <> 'object' THEN ''
    WHEN COALESCE(elem->>'crewIdx', '') ~ '^[0-9]+$' AND (elem->>'crewIdx')::int >= 0
      THEN 'i:' || (elem->>'crewIdx')
    ELSE 'n:' || lower(btrim(COALESCE(elem->>'name', '')))
  END;
$$;

CREATE OR REPLACE FUNCTION private.fp_credit_tenths(elem jsonb)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN elem IS NULL OR jsonb_typeof(elem) <> 'object' THEN NULL
    WHEN jsonb_typeof(elem->'creditedTenths') <> 'number' THEN NULL
    WHEN (elem->>'creditedTenths') !~ '^[0-9]+$' THEN NULL
    WHEN (elem->>'creditedTenths')::int > 240 THEN NULL
    ELSE (elem->>'creditedTenths')::int
  END;
$$;

-- The credit itself, without actor or time. Used to tell a real edit from a
-- rewritten by/at. balance is only the two tenth counters the page stores.
CREATE OR REPLACE FUNCTION private.fp_credit_body(elem jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'id', private.fp_credit_identity(elem),
    'crewIdx', CASE
      WHEN COALESCE(elem->>'crewIdx', '') ~ '^-?[0-9]+$' THEN (elem->>'crewIdx')::int
      ELSE NULL
    END,
    'name', NULLIF(btrim(COALESCE(elem->>'name', '')), ''),
    'creditedTenths', private.fp_credit_tenths(elem),
    'reason', NULLIF(btrim(COALESCE(elem->>'reason', '')), ''),
    'requestedMinutes', CASE
      WHEN jsonb_typeof(elem->'requestedMinutes') = 'number'
       AND (elem->>'requestedMinutes') ~ '^[0-9]+$'
        THEN (elem->>'requestedMinutes')::int
      ELSE NULL
    END,
    'balance', CASE
      WHEN jsonb_typeof(elem->'balance') = 'object' THEN jsonb_strip_nulls(jsonb_build_object(
        'dayTargetTenths', CASE
          WHEN jsonb_typeof(elem->'balance'->'dayTargetTenths') = 'number'
           AND (elem->'balance'->>'dayTargetTenths') ~ '^[0-9]+$'
            THEN (elem->'balance'->>'dayTargetTenths')::int
          ELSE NULL
        END,
        'otherJobsTenths', CASE
          WHEN jsonb_typeof(elem->'balance'->'otherJobsTenths') = 'number'
           AND (elem->'balance'->>'otherJobsTenths') ~ '^-?[0-9]+$'
            THEN (elem->'balance'->>'otherJobsTenths')::int
          ELSE NULL
        END
      ))
      ELSE NULL
    END
  ));
$$;

CREATE OR REPLACE FUNCTION private.fp_credit_canonical(adj jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT COALESCE(jsonb_agg(body ORDER BY body->>'id', body::text), '[]'::jsonb)
  FROM (
    SELECT private.fp_credit_body(elem) AS body
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(adj) = 'array' THEN adj ELSE '[]'::jsonb END) AS elem
    WHERE jsonb_typeof(elem) = 'object'
      AND private.fp_credit_tenths(elem) IS NOT NULL
      AND NULLIF(btrim(COALESCE(elem->>'reason', '')), '') IS NOT NULL
      AND private.fp_credit_identity(elem) <> ''
      AND private.fp_credit_identity(elem) <> 'n:'
  ) AS rows;
$$;

CREATE OR REPLACE FUNCTION private.fp_seal_credit_list(old_adj jsonb, new_adj jsonb, actor text, stamp text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  elem jsonb;
  body jsonb;
  old_elem jsonb;
  kept jsonb;
  out jsonb := '[]'::jsonb;
BEGIN
  IF new_adj IS NULL OR jsonb_typeof(new_adj) <> 'array' THEN
    RETURN NULL;
  END IF;
  IF private.fp_credit_canonical(old_adj) = private.fp_credit_canonical(new_adj) THEN
    IF jsonb_typeof(old_adj) = 'array' THEN
      RETURN old_adj;
    END IF;
    RETURN '[]'::jsonb;
  END IF;
  FOR elem IN SELECT value FROM jsonb_array_elements(new_adj) LOOP
    body := private.fp_credit_body(elem);
    IF (body->>'creditedTenths') IS NULL OR (body->>'reason') IS NULL OR COALESCE(body->>'id', '') IN ('', 'n:') THEN
      CONTINUE;
    END IF;
    kept := NULL;
    IF jsonb_typeof(old_adj) = 'array' THEN
      FOR old_elem IN SELECT value FROM jsonb_array_elements(old_adj) LOOP
        IF private.fp_credit_body(old_elem) = body THEN
          kept := old_elem;
          EXIT;
        END IF;
      END LOOP;
    END IF;
    IF kept IS NULL THEN
      kept := jsonb_strip_nulls(jsonb_build_object(
        'crewIdx', body->'crewIdx',
        'name', body->'name',
        'creditedTenths', body->'creditedTenths',
        'reason', body->'reason',
        'requestedMinutes', body->'requestedMinutes',
        'balance', NULLIF(body->'balance', '{}'::jsonb),
        'by', actor,
        'at', stamp
      ));
    END IF;
    out := out || jsonb_build_array(kept);
  END LOOP;
  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_guard_day_logs(old_logs jsonb, new_logs jsonb, role text, actor text, stamp text)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  result jsonb := CASE WHEN jsonb_typeof(new_logs) = 'object' THEN new_logs ELSE '{}'::jsonb END;
  old_obj jsonb := CASE WHEN jsonb_typeof(old_logs) = 'object' THEN old_logs ELSE '{}'::jsonb END;
  date_key text;
  old_day jsonb;
  new_day jsonb;
  sealed jsonb;
BEGIN
  IF role = 'crew' THEN
    FOR date_key IN SELECT jsonb_object_keys(old_obj) LOOP
      old_day := old_obj->date_key;
      IF jsonb_typeof(old_day->'hourAdjustments') = 'array'
         AND jsonb_array_length(old_day->'hourAdjustments') > 0 THEN
        IF result ? date_key AND jsonb_typeof(result->date_key) = 'object' THEN
          new_day := jsonb_set(result->date_key, '{hourAdjustments}', old_day->'hourAdjustments', true);
          result := jsonb_set(result, ARRAY[date_key], new_day, true);
        ELSE
          result := jsonb_set(result, ARRAY[date_key], old_day, true);
        END IF;
      END IF;
    END LOOP;
    FOR date_key IN SELECT jsonb_object_keys(result) LOOP
      new_day := result->date_key;
      IF jsonb_typeof(new_day) <> 'object' THEN
        CONTINUE;
      END IF;
      IF NOT (old_obj ? date_key)
         OR jsonb_typeof(old_obj->date_key->'hourAdjustments') IS DISTINCT FROM 'array'
         OR jsonb_array_length(COALESCE(old_obj->date_key->'hourAdjustments', '[]'::jsonb)) = 0 THEN
        result := jsonb_set(result, ARRAY[date_key], new_day - 'hourAdjustments', true);
      END IF;
    END LOOP;
    RETURN result;
  END IF;

  FOR date_key IN SELECT jsonb_object_keys(result) LOOP
    new_day := result->date_key;
    IF jsonb_typeof(new_day) <> 'object' THEN
      CONTINUE;
    END IF;
    old_day := old_obj->date_key;
    sealed := private.fp_seal_credit_list(old_day->'hourAdjustments', new_day->'hourAdjustments', actor, stamp);
    IF sealed IS NULL THEN
      new_day := new_day - 'hourAdjustments';
    ELSE
      new_day := jsonb_set(new_day, '{hourAdjustments}', sealed, true);
    END IF;
    result := jsonb_set(result, ARRAY[date_key], new_day, true);
  END LOOP;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_guard_job_records(old_text text, new_text text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  role text;
  actor text;
  stamp text;
  old_jobs jsonb := '[]'::jsonb;
  new_jobs jsonb := '[]'::jsonb;
  old_job jsonb;
  new_job jsonb;
  guarded jsonb;
  i integer;
  n integer;
BEGIN
  role := private.fp_role();
  IF role IS NULL OR role NOT IN ('owner', 'office', 'crew') THEN
    RETURN new_text;
  END IF;
  IF new_text IS NULL OR btrim(new_text) = '' THEN
    new_jobs := '[]'::jsonb;
  ELSE
    new_jobs := new_text::jsonb;
  END IF;
  IF jsonb_typeof(new_jobs) <> 'array' THEN
    RAISE EXCEPTION 'job_records is damaged';
  END IF;
  IF old_text IS NOT NULL AND btrim(old_text) <> '' THEN
    old_jobs := old_text::jsonb;
    IF jsonb_typeof(old_jobs) <> 'array' THEN
      old_jobs := '[]'::jsonb;
    END IF;
  END IF;
  actor := private.fp_credit_actor();
  stamp := to_char(clock_timestamp() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  n := jsonb_array_length(new_jobs);
  i := 0;
  WHILE i < n LOOP
    new_job := new_jobs->i;
    old_job := NULL;
    IF jsonb_typeof(new_job) = 'object' THEN
      SELECT value INTO old_job
      FROM jsonb_array_elements(old_jobs) AS value
      WHERE value->>'id' IS NOT DISTINCT FROM new_job->>'id'
      LIMIT 1;
      guarded := private.fp_guard_day_logs(old_job->'dayLogs', new_job->'dayLogs', role, actor, stamp);
      new_job := jsonb_set(new_job, '{dayLogs}', guarded, true);
      new_jobs := jsonb_set(new_jobs, ARRAY[i::text], new_job, false);
    END IF;
    i := i + 1;
  END LOOP;
  IF role = 'crew' THEN
    FOR old_job IN SELECT value FROM jsonb_array_elements(old_jobs) LOOP
      IF jsonb_typeof(old_job) <> 'object' OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(new_jobs) AS value
        WHERE value->>'id' IS NOT DISTINCT FROM old_job->>'id'
      ) THEN
        IF old_job->'dayLogs' IS NOT NULL AND EXISTS (
          SELECT 1
          FROM jsonb_each(CASE WHEN jsonb_typeof(old_job->'dayLogs') = 'object' THEN old_job->'dayLogs' ELSE '{}'::jsonb END) AS day(k, v)
          WHERE jsonb_typeof(v->'hourAdjustments') = 'array'
            AND jsonb_array_length(v->'hourAdjustments') > 0
        ) THEN
          new_jobs := new_jobs || jsonb_build_array(old_job);
        END IF;
      END IF;
    END LOOP;
  END IF;
  RETURN new_jobs::text;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_credit_signature(raw text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  jobs jsonb := '[]'::jsonb;
  job jsonb;
  day record;
  out jsonb := '[]'::jsonb;
BEGIN
  IF raw IS NOT NULL AND btrim(raw) <> '' THEN
    BEGIN
      jobs := raw::jsonb;
    EXCEPTION WHEN others THEN
      RETURN '[]'::jsonb;
    END;
  END IF;
  IF jsonb_typeof(jobs) <> 'array' THEN
    RETURN '[]'::jsonb;
  END IF;
  FOR job IN SELECT value FROM jsonb_array_elements(jobs) LOOP
    IF jsonb_typeof(job) <> 'object' OR jsonb_typeof(job->'dayLogs') <> 'object' THEN
      CONTINUE;
    END IF;
    FOR day IN SELECT key, value FROM jsonb_each(job->'dayLogs') LOOP
      IF jsonb_typeof(day.value->'hourAdjustments') = 'array'
         AND jsonb_array_length(day.value->'hourAdjustments') > 0 THEN
        out := out || jsonb_build_array(jsonb_build_object(
          'id', job->>'id',
          'customer', job->>'customer',
          'date', day.key,
          'credits', day.value->'hourAdjustments'
        ));
      END IF;
    END LOOP;
  END LOOP;
  RETURN COALESCE((
    SELECT jsonb_agg(elem ORDER BY elem->>'id', elem->>'date', elem::text)
    FROM jsonb_array_elements(out) AS elem
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_settings_guard_credits()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  before_sig jsonb;
  after_sig jsonb;
BEGIN
  IF NEW.key IS DISTINCT FROM 'job_records' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    before_sig := private.fp_credit_signature(OLD.value);
    NEW.value := private.fp_guard_job_records(OLD.value, NEW.value);
  ELSE
    before_sig := '[]'::jsonb;
    NEW.value := private.fp_guard_job_records(NULL, NEW.value);
  END IF;
  after_sig := private.fp_credit_signature(NEW.value);
  IF before_sig IS DISTINCT FROM after_sig THEN
    INSERT INTO public.audit_log (actor, action, entity, details)
    VALUES (
      private.fp_credit_actor(),
      'job_updated',
      'Credited hours',
      jsonb_build_object(
        '_rich', 1,
        'server', true,
        'summary', 'Credited hours',
        'from', before_sig,
        'to', after_sig
      )::text
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fp_settings_guard_credits ON public.settings;
CREATE TRIGGER fp_settings_guard_credits
  BEFORE INSERT OR UPDATE ON public.settings
  FOR EACH ROW
  EXECUTE FUNCTION private.fp_settings_guard_credits();

-- A signed-in browser session can insert ordinary audit rows. It cannot insert
-- the server credit row. That insert runs as the owner of the guard above,
-- not as the authenticated role.
CREATE OR REPLACE FUNCTION private.fp_audit_reject_forged_credit()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF coalesce(NEW.details, '') ~ '"server"\s*:\s*true'
     AND current_user IN ('authenticated', 'anon') THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS fp_audit_reject_forged_credit ON public.audit_log;
CREATE TRIGGER fp_audit_reject_forged_credit
  BEFORE INSERT ON public.audit_log
  FOR EACH ROW
  EXECUTE FUNCTION private.fp_audit_reject_forged_credit();

REVOKE ALL ON FUNCTION private.fp_credit_actor() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_credit_identity(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_credit_tenths(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_credit_body(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_credit_canonical(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_seal_credit_list(jsonb, jsonb, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_guard_day_logs(jsonb, jsonb, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_guard_job_records(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_credit_signature(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_settings_guard_credits() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_audit_reject_forged_credit() FROM PUBLIC, anon, authenticated;

COMMIT;
