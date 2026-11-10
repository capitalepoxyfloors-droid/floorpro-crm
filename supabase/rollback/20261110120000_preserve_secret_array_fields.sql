-- Puts crew job saves back to replacing material lists wholesale, and
-- stops treating unitCost and amount as secret.
-- Does not change settings.job_records.
-- Run this to undo 20261110120000. Do not also run the
-- 20261110123000 rollback; that file refuses once this merge exists,
-- and this rollback already restores the old secret list.

BEGIN;

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
    'price', 'hourly', 'wage'
  );
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
      -- The phone's date list wins, so removing a day stays removed. Each day that
      -- remains is merged, so a wage stamp already stored on that day is kept.
      out := jsonb_set(out, ARRAY[k], private.fp_merge_day_logs(out -> k, v), true);
    ELSIF jsonb_typeof(v) = 'object'
      AND (out -> k IS NULL OR jsonb_typeof(out -> k) IN ('object', 'null')) THEN
      out := jsonb_set(out, ARRAY[k], private.fp_overlay_json(out -> k, v), true);
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
    ELSE
      out := out || jsonb_build_object(k, private.fp_redact_json(v));
    END IF;
  END LOOP;
  RETURN out;
END;
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
        IF NOT private.fp_json_same(private.fp_redact_json(job -> k), expected -> k) THEN
          RAISE EXCEPTION 'stale_job' USING DETAIL = pid || ' ' || k;
        END IF;
      ELSIF NOT private.fp_json_same(job -> k, expected -> k) THEN
        RAISE EXCEPTION 'stale_job' USING DETAIL = pid || ' ' || k;
      END IF;
      IF role = 'crew' AND jsonb_typeof(v) = 'object' AND jsonb_typeof(job -> k) = 'object' THEN
        job := jsonb_set(job, ARRAY[k], private.fp_overlay_json(job -> k, v), true);
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
        IF role = 'crew' AND private.fp_secret_key(k) THEN
          CONTINUE;
        END IF;
        IF role = 'crew' THEN
          IF NOT private.fp_json_same(private.fp_redact_json(job -> k), expected -> k) THEN
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

REVOKE ALL ON FUNCTION public.fp_patch_job_records(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_patch_job_records(jsonb) TO authenticated;


DROP FUNCTION IF EXISTS private.fp_merge_secret_array(jsonb, jsonb, text);
DROP FUNCTION IF EXISTS private.fp_stamp_stored_secrets(jsonb, jsonb);
DROP FUNCTION IF EXISTS private.fp_array_line_match(text, jsonb, jsonb);
DROP FUNCTION IF EXISTS private.fp_line_unit(jsonb);
DROP FUNCTION IF EXISTS private.fp_contains_secret(jsonb);

REVOKE ALL ON FUNCTION private.fp_secret_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_overlay_json(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_merge_day_logs(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fp_patch_job_records(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_patch_job_records(jsonb) TO authenticated;

COMMIT;
