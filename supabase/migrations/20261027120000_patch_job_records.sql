-- Patch jobs inside settings.job_records one at a time.
--
-- NEEDS APPROVAL BEFORE LIVE. Applied to the test project only
-- (nndjnywtkgxwvxajwztg) on 2026-10-27. Do not run it on the live project
-- until that approval.
-- The website falls back to a re-read-and-patch write if this function is missing,
-- so the page can ship before the live database has it. The function is what
-- closes the gap between that re-read and the write.
--
-- Office Save used to send the whole job_records array. A page that had loaded
-- before someone else edited a different job wrote the stale array back and
-- dropped that other job's crewDays. Direct SQL does not bump a column the page
-- can see, so the lock is here: this function takes the settings row FOR UPDATE,
-- changes only the jobs in the patch, and rejects the patch when the job's
-- updated_at or one of the fields being written no longer matches what the page
-- edited from.
--
-- patches: [{id, op: "patch"|"insert"|"delete", expected, patch, drop, basis}]
-- expected.updated_at is the updated_at the page loaded (null if the job has none).
-- expected also carries the previous value of every key in patch and drop.
-- basis (deletes) is the job the page loaded, without updated_at.

BEGIN;

CREATE OR REPLACE FUNCTION private.fp_json_same(a jsonb, b jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT a IS NOT DISTINCT FROM b
    OR ((a IS NULL OR a = 'null'::jsonb) AND (b IS NULL OR b = 'null'::jsonb));
$$;

REVOKE ALL ON FUNCTION private.fp_json_same(jsonb, jsonb) FROM PUBLIC, anon, authenticated;

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
  found boolean;
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

    found := false;
    job := NULL;
    i := 0;
    n := jsonb_array_length(jobs);
    WHILE i < n LOOP
      IF (jobs -> i) ->> 'id' = pid THEN
        job := jobs -> i;
        found := true;
        EXIT;
      END IF;
      i := i + 1;
    END LOOP;

    IF op = 'delete' THEN
      IF role = 'crew' THEN
        RAISE EXCEPTION 'not allowed';
      END IF;
      IF NOT found THEN
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

    IF NOT found THEN
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

COMMIT;
