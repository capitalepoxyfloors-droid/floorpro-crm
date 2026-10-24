-- CrewBoard phase 2: role-split row security.
--
-- Apply on the TEST project first. Do not run this on the live project from here.
-- Apply this file BEFORE the matching website. The previous page asks PostgREST for
-- every column, and this file removes pay and phone columns from that grant, so the
-- old page cannot load the crew list or the material prices until the new page is up.
--
-- What moves (copied, not dropped):
--   public.crew pay columns and phone  ->  public.crew_private (one row per crew id)
--   public.materials.price, price_date ->  public.materials_private (one row per material id)
-- The original columns stay, and triggers keep the copy and the original in step.
-- Nothing in this file deletes a row or drops a column.
--
-- Who can read what after this:
--   owner and office — same tables as today, plus the two private copies (that is
--     where the website now reads wages and material prices).
--   crew — schedule, their jobs (without prices or wage stamps), PTO, photos,
--     material names. Not leads, the jobs board, vehicles, the audit log, or any
--     settings row that holds rates, payroll, or another person's private notes.
--   The role comes from private.fp_role(), which already checks pin_accounts against
--     the login token. pin-login does not need a new deploy for this file.
--
-- Job prices and wage stamps live inside settings.job_records (one JSON value).
-- Row security cannot hide a field inside that value, so crew no longer have
-- SELECT on that row. They read and save through:
--   public.fp_crew_read_job_records()
--   public.fp_crew_write_job_records(payload)
-- The write keeps every price and wage stamp already stored. It does not stamp
-- new ones. Owner/office saves still stamp rates in the website, same as today.
--
-- PTO request reasons for other people are the same kind of problem (one JSON
-- array). Crew use:
--   public.fp_crew_read_pto_requests()
--   public.fp_crew_write_pto_requests(payload)
-- A crew login can only file or edit their own request, and cannot approve it.
-- Approved time off still shows on the shared calendar (pto_blocks), as it does now.
--
-- Rollback (does not drop the copied rows): supabase/rollback/20261024140000_role_split_rls.sql
-- Run that and put the previous website back together.

BEGIN;

-- The signed-in person is owner or office, or not. Same nonce and pin_accounts
-- check as private.fp_role(). Policies call it as (select private.fp_is_staff())
-- so Postgres runs it once per statement.
CREATE OR REPLACE FUNCTION private.fp_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.fp_role() IN ('owner', 'office');
$$;

-- Crew index of the signed-in crew member, or NULL. Not granted to the API role;
-- only the functions below use it.
CREATE OR REPLACE FUNCTION private.fp_crew_idx()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.crew_idx
  FROM public.pin_accounts AS p
  WHERE p.auth_user_id = auth.uid()
    AND p.kind = 'crew'
    AND private.fp_role() = 'crew';
$$;

REVOKE ALL ON FUNCTION private.fp_is_staff() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_crew_idx() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.fp_is_staff() TO authenticated;

-- Keys inside job JSON that are prices, wage stamps, or costing flags.
-- Compared case-insensitively. Customer phone and address are not in this list:
-- the crew job card shows them so the crew can get to the job.
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
    'overheadrate', 'rateversion', 'fieldoverride',
    'overtimewage', 'cashwages',
    'consumablespct', 'consumablespctset',
    'costcategory', 'costlinkid', 'commissions',
    'tmjob', 'tmlabormarkup', 'tmmaterialmarkup',
    'price', 'hourly', 'wage'
  );
$$;

CREATE OR REPLACE FUNCTION private.fp_redact_json(j jsonb)
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
  IF j IS NULL OR jsonb_typeof(j) = 'null' THEN
    RETURN j;
  ELSIF jsonb_typeof(j) = 'array' THEN
    SELECT coalesce(jsonb_agg(private.fp_redact_json(elem)), '[]'::jsonb)
      INTO out
    FROM jsonb_array_elements(j) AS elem;
    RETURN out;
  ELSIF jsonb_typeof(j) = 'object' THEN
    out := '{}'::jsonb;
    FOR k, v IN SELECT * FROM jsonb_each(j) LOOP
      IF private.fp_secret_key(k) THEN
        CONTINUE;
      END IF;
      out := out || jsonb_build_object(k, private.fp_redact_json(v));
    END LOOP;
    RETURN out;
  ELSE
    RETURN j;
  END IF;
END;
$$;

-- Client object wins for ordinary fields. Secret keys stay on the server copy.
-- Nested objects (day logs) merge the same way. crewPresent is matched by person
-- so a wage stamp already on that person is kept and a stamp sent by the phone is not.
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

CREATE OR REPLACE FUNCTION private.fp_merge_crew_present(server jsonb, client jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  c jsonb;
  s jsonb;
  merged jsonb;
  out jsonb := '[]'::jsonb;
  matched boolean;
BEGIN
  IF client IS NULL OR jsonb_typeof(client) <> 'array' THEN
    IF server IS NULL OR jsonb_typeof(server) IS DISTINCT FROM 'array' THEN
      RETURN '[]'::jsonb;
    END IF;
    RETURN server;
  END IF;
  IF server IS NULL OR jsonb_typeof(server) <> 'array' THEN
    server := '[]'::jsonb;
  END IF;
  FOR c IN SELECT value FROM jsonb_array_elements(client) LOOP
    matched := false;
    merged := NULL;
    IF jsonb_typeof(c) = 'object' AND coalesce(c ->> 'crewIdx', '') ~ '^-?[0-9]+$'
       AND (c ->> 'crewIdx')::int >= 0 THEN
      FOR s IN SELECT value FROM jsonb_array_elements(server) LOOP
        IF jsonb_typeof(s) = 'object' AND (s ->> 'crewIdx') IS NOT DISTINCT FROM (c ->> 'crewIdx') THEN
          merged := private.fp_overlay_json(s, c);
          matched := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;
    IF NOT matched AND jsonb_typeof(c) = 'object' AND coalesce(c ->> 'name', '') <> '' THEN
      FOR s IN SELECT value FROM jsonb_array_elements(server) LOOP
        IF jsonb_typeof(s) = 'object' AND coalesce(s ->> 'name', '') = c ->> 'name' THEN
          merged := private.fp_overlay_json(s, c);
          matched := true;
          EXIT;
        END IF;
      END LOOP;
    END IF;
    IF NOT matched THEN
      merged := private.fp_redact_json(c);
    END IF;
    out := out || jsonb_build_array(merged);
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

REVOKE ALL ON FUNCTION private.fp_secret_key(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_redact_json(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_overlay_json(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_merge_crew_present(jsonb, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_merge_day_logs(jsonb, jsonb) FROM PUBLIC;

-- These two stay owned by the migration role (the table owner) so they can read
-- the job_records row crew are no longer allowed to select. Do not change the owner.
CREATE OR REPLACE FUNCTION public.fp_crew_read_job_records()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  js jsonb;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'crew' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN '[]'::jsonb;
  END IF;
  js := raw::jsonb;
  IF jsonb_typeof(js) <> 'array' THEN
    RAISE EXCEPTION 'job_records is damaged';
  END IF;
  RETURN private.fp_redact_json(js);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_crew_write_job_records(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  server jsonb;
  result jsonb;
  elem jsonb;
  s jsonb;
  rebuilt jsonb;
  jid text;
  found boolean;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'crew' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF payload IS NULL OR jsonb_typeof(payload) <> 'array' THEN
    RAISE EXCEPTION 'job_records payload must be a JSON array';
  END IF;

  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records' FOR UPDATE;
  IF raw IS NULL OR btrim(raw) = '' THEN
    server := '[]'::jsonb;
  ELSE
    server := raw::jsonb;
  END IF;
  IF jsonb_typeof(server) <> 'array' THEN
    RAISE EXCEPTION 'job_records is damaged';
  END IF;

  -- Start from the stored jobs so a phone cannot delete one, and cannot drop a
  -- price or a wage stamp by leaving it out. Jobs the phone sends are merged on
  -- top. Jobs only the server has are kept as stored.
  result := server;
  FOR elem IN SELECT value FROM jsonb_array_elements(payload) LOOP
    IF jsonb_typeof(elem) <> 'object' THEN
      CONTINUE;
    END IF;
    jid := elem ->> 'id';
    IF jid IS NULL OR jid = '' THEN
      CONTINUE;
    END IF;
    found := false;
    rebuilt := '[]'::jsonb;
    FOR s IN SELECT value FROM jsonb_array_elements(result) LOOP
      IF s ->> 'id' = jid THEN
        rebuilt := rebuilt || jsonb_build_array(private.fp_overlay_json(s, elem));
        found := true;
      ELSE
        rebuilt := rebuilt || jsonb_build_array(s);
      END IF;
    END LOOP;
    IF NOT found THEN
      rebuilt := rebuilt || jsonb_build_array(private.fp_redact_json(elem));
    END IF;
    result := rebuilt;
  END LOOP;

  UPDATE public.settings SET value = result::text WHERE key = 'job_records';
  IF NOT FOUND THEN
    INSERT INTO public.settings (key, value) VALUES ('job_records', result::text);
  END IF;
  RETURN private.fp_redact_json(result);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_crew_read_pto_requests()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  server jsonb;
  v_idx integer;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'crew' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  v_idx := private.fp_crew_idx();
  IF v_idx IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'pto_requests';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN '[]'::jsonb;
  END IF;
  server := raw::jsonb;
  IF jsonb_typeof(server) <> 'array' THEN
    RAISE EXCEPTION 'pto_requests is damaged';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(e)
    FROM jsonb_array_elements(server) AS e
    WHERE coalesce(e ->> 'crewIdx', '') ~ '^-?[0-9]+$'
      AND (e ->> 'crewIdx')::int = v_idx
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_crew_write_pto_requests(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  server jsonb;
  elem jsonb;
  existing jsonb;
  kept jsonb := '[]'::jsonb;
  mine jsonb := '[]'::jsonb;
  seen text[] := ARRAY[]::text[];
  v_idx integer;
  v_label text;
  eid text;
  old_status text;
  new_status text;
  chosen text;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'crew' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  v_idx := private.fp_crew_idx();
  IF v_idx IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF payload IS NULL OR jsonb_typeof(payload) <> 'array' THEN
    RAISE EXCEPTION 'pto_requests payload must be a JSON array';
  END IF;

  SELECT p.label INTO v_label
  FROM public.pin_accounts AS p
  WHERE p.auth_user_id = auth.uid() AND p.kind = 'crew';

  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'pto_requests' FOR UPDATE;
  IF raw IS NULL OR btrim(raw) = '' THEN
    server := '[]'::jsonb;
  ELSE
    server := raw::jsonb;
  END IF;
  IF jsonb_typeof(server) <> 'array' THEN
    RAISE EXCEPTION 'pto_requests is damaged';
  END IF;

  FOR elem IN SELECT value FROM jsonb_array_elements(server) LOOP
    IF coalesce(elem ->> 'crewIdx', '') !~ '^-?[0-9]+$'
       OR (elem ->> 'crewIdx')::int IS DISTINCT FROM v_idx THEN
      kept := kept || jsonb_build_array(elem);
    END IF;
  END LOOP;

  FOR elem IN SELECT value FROM jsonb_array_elements(payload) LOOP
    IF jsonb_typeof(elem) <> 'object' THEN
      CONTINUE;
    END IF;
    eid := elem ->> 'id';
    IF eid IS NULL OR eid = '' OR eid = ANY (seen) THEN
      CONTINUE;
    END IF;
    seen := seen || eid;

    SELECT e INTO existing
    FROM jsonb_array_elements(server) AS e
    WHERE e ->> 'id' = eid
      AND coalesce(e ->> 'crewIdx', '') ~ '^-?[0-9]+$'
      AND (e ->> 'crewIdx')::int = v_idx
    LIMIT 1;

    IF existing IS NULL THEN
      elem := elem || jsonb_build_object(
        'crewIdx', v_idx,
        'crewName', coalesce(v_label, elem ->> 'crewName'),
        'status', 'pending'
      );
      mine := mine || jsonb_build_array(elem);
    ELSE
      old_status := coalesce(existing ->> 'status', 'pending');
      IF old_status IN ('approved', 'denied') THEN
        mine := mine || jsonb_build_array(existing);
      ELSE
        new_status := coalesce(elem ->> 'status', old_status);
        IF old_status = 'clarify' AND new_status = 'pending' THEN
          chosen := 'pending';
        ELSE
          chosen := old_status;
        END IF;
        elem := (elem - 'crewIdx' - 'crewName' - 'status') || jsonb_build_object(
          'crewIdx', v_idx,
          'crewName', coalesce(v_label, existing ->> 'crewName'),
          'status', chosen
        );
        IF existing ? 'clarify' AND NOT (elem ? 'clarify') THEN
          elem := elem || jsonb_build_object('clarify', existing -> 'clarify');
        END IF;
        mine := mine || jsonb_build_array(elem);
      END IF;
    END IF;
  END LOOP;

  -- An approved or denied request left off the phone's copy is still kept.
  FOR elem IN SELECT value FROM jsonb_array_elements(server) LOOP
    IF coalesce(elem ->> 'crewIdx', '') ~ '^-?[0-9]+$'
       AND (elem ->> 'crewIdx')::int = v_idx
       AND coalesce(elem ->> 'status', '') IN ('approved', 'denied')
       AND NOT (elem ->> 'id' = ANY (seen)) THEN
      mine := mine || jsonb_build_array(elem);
    END IF;
  END LOOP;

  UPDATE public.settings SET value = (kept || mine)::text WHERE key = 'pto_requests';
  IF NOT FOUND THEN
    INSERT INTO public.settings (key, value) VALUES ('pto_requests', (kept || mine)::text);
  END IF;

  RETURN coalesce((
    SELECT jsonb_agg(e) FROM jsonb_array_elements(mine) AS e
  ), '[]'::jsonb);
END;
$$;

-- Supabase also grants EXECUTE to anon when a function is created in public.
-- Revoking from PUBLIC does not remove that grant. Signed-in users only.
-- A project that already applied an older copy of this file should also run
-- supabase/migrations/20261024153000_revoke_crew_rpc_anon.sql.
REVOKE ALL ON FUNCTION public.fp_crew_read_job_records() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_write_job_records(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_read_pto_requests() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_write_pto_requests(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_crew_read_job_records() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_write_job_records(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_read_pto_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_write_pto_requests(jsonb) TO authenticated;

-- Copy pay / phone / material price off the tables crew still have to read.
-- Original columns are not dropped. Triggers copy changes both ways so a service-role
-- script that still writes crew.hourly keeps the private row current, and a website
-- save to the private row keeps the original column current for rollback.
DO $body$
DECLARE
  id_type text;
  col text;
  col_type text;
  present text[] := ARRAY[]::text[];
  crew_secrets text[] := ARRAY[
    'phone', 'hourly', 'hours', 'ss', 'medicare', 'futa', 'wc', 'gl', 'benefits', 'pto_days',
    'futa_wage_base', 'suta_rate', 'suta_wage_base', 'k401_match_pct', 'fixed_fees_yr',
    'clothing_yr', 'field_rate_override', 'is_owner'
  ];
  mat_secrets text[] := ARRAY['price', 'price_date'];
  safe_cols text;
  set_list text;
  diff_list text;
  ins_cols text;
  sel_cols text;
  upd_cols text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'role authenticated is missing';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute AS a
  JOIN pg_class AS c ON c.oid = a.attrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'crew' AND a.attname = 'id' AND NOT a.attisdropped;
  IF id_type IS NULL THEN
    RAISE EXCEPTION 'public.crew has no id column';
  END IF;

  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.crew_private (
       crew_id %s PRIMARY KEY REFERENCES public.crew(id) ON DELETE CASCADE
     )', id_type);
  COMMENT ON TABLE public.crew_private IS
    'Pay rates and phone for each crew member. Owner and office only. Copied from public.crew; those columns are still filled.';

  FOREACH col IN ARRAY crew_secrets LOOP
    SELECT format_type(a.atttypid, a.atttypmod) INTO col_type
    FROM pg_attribute AS a
    JOIN pg_class AS c ON c.oid = a.attrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'crew' AND a.attname = col AND NOT a.attisdropped;
    IF col_type IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.crew_private ADD COLUMN IF NOT EXISTS %I %s', col, col_type);
    present := present || col;
  END LOOP;

  IF coalesce(array_length(present, 1), 0) > 0 THEN
    SELECT string_agg(quote_ident(c), ', '),
           string_agg(quote_ident(c), ', '),
           string_agg(format('%I = EXCLUDED.%I', c, c), ', ')
      INTO ins_cols, sel_cols, upd_cols
    FROM unnest(present) AS c;
    EXECUTE format(
      'INSERT INTO public.crew_private (crew_id, %s)
       SELECT id, %s FROM public.crew
       ON CONFLICT (crew_id) DO UPDATE SET %s',
      ins_cols, sel_cols, upd_cols);

    SELECT string_agg(format('%I = NEW.%I', c, c), ', '),
           string_agg(format('c.%I IS DISTINCT FROM NEW.%I', c, c), ' OR ')
      INTO set_list, diff_list
    FROM unnest(present) AS c;

    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION private.fp_sync_crew_pay_to_directory()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $t$
      BEGIN
        UPDATE public.crew AS c SET %s
        WHERE c.id = NEW.crew_id AND (%s);
        RETURN NEW;
      END;
      $t$;
    $fn$, set_list, diff_list);

    SELECT string_agg(format('%I = EXCLUDED.%I', c, c), ', '),
           string_agg(format('public.crew_private.%I IS DISTINCT FROM EXCLUDED.%I', c, c), ' OR '),
           string_agg(quote_ident(c), ', '),
           string_agg(format('NEW.%I', c), ', ')
      INTO upd_cols, diff_list, ins_cols, sel_cols
    FROM unnest(present) AS c;

    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION private.fp_sync_crew_pay_from_directory()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $t$
      BEGIN
        INSERT INTO public.crew_private (crew_id, %s)
        VALUES (NEW.id, %s)
        ON CONFLICT (crew_id) DO UPDATE SET %s
        WHERE %s;
        RETURN NEW;
      END;
      $t$;
    $fn$, ins_cols, sel_cols, upd_cols, diff_list);

    EXECUTE 'DROP TRIGGER IF EXISTS fp_crew_pay_to_directory ON public.crew_private';
    EXECUTE 'CREATE TRIGGER fp_crew_pay_to_directory
             AFTER INSERT OR UPDATE ON public.crew_private
             FOR EACH ROW EXECUTE FUNCTION private.fp_sync_crew_pay_to_directory()';
    EXECUTE 'DROP TRIGGER IF EXISTS fp_crew_pay_from_directory ON public.crew';
    EXECUTE 'CREATE TRIGGER fp_crew_pay_from_directory
             AFTER INSERT OR UPDATE ON public.crew
             FOR EACH ROW EXECUTE FUNCTION private.fp_sync_crew_pay_from_directory()';

    REVOKE ALL ON FUNCTION private.fp_sync_crew_pay_to_directory() FROM PUBLIC;
    REVOKE ALL ON FUNCTION private.fp_sync_crew_pay_from_directory() FROM PUBLIC;
  END IF;

  -- Directory columns stay readable. Pay and phone do not, for every signed-in role.
  -- Owner and office read those from crew_private. service_role is not touched.
  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO safe_cols
  FROM pg_attribute AS a
  WHERE a.attrelid = 'public.crew'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND NOT (a.attname = ANY (crew_secrets));
  IF safe_cols IS NULL THEN
    RAISE EXCEPTION 'public.crew has no directory columns left to grant';
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE public.crew FROM PUBLIC, anon, authenticated';
  EXECUTE format(
    'GRANT SELECT (%s), INSERT (%s), UPDATE (%s) ON public.crew TO authenticated',
    safe_cols, safe_cols, safe_cols);
  EXECUTE 'GRANT DELETE ON public.crew TO authenticated';

  -- Materials: names and coverage stay. Dollar price moves to materials_private.
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute AS a
  JOIN pg_class AS c ON c.oid = a.attrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'materials' AND a.attname = 'id' AND NOT a.attisdropped;
  IF id_type IS NULL THEN
    RAISE EXCEPTION 'public.materials has no id column';
  END IF;
  EXECUTE format(
    'CREATE TABLE IF NOT EXISTS public.materials_private (
       material_id %s PRIMARY KEY REFERENCES public.materials(id) ON DELETE CASCADE
     )', id_type);
  COMMENT ON TABLE public.materials_private IS
    'Material unit price. Owner and office only. Copied from public.materials; those columns are still filled.';

  present := ARRAY[]::text[];
  FOREACH col IN ARRAY mat_secrets LOOP
    SELECT format_type(a.atttypid, a.atttypmod) INTO col_type
    FROM pg_attribute AS a
    JOIN pg_class AS c ON c.oid = a.attrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'materials' AND a.attname = col AND NOT a.attisdropped;
    IF col_type IS NULL THEN
      CONTINUE;
    END IF;
    EXECUTE format('ALTER TABLE public.materials_private ADD COLUMN IF NOT EXISTS %I %s', col, col_type);
    present := present || col;
  END LOOP;

  IF coalesce(array_length(present, 1), 0) > 0 THEN
    SELECT string_agg(quote_ident(c), ', '),
           string_agg(quote_ident(c), ', '),
           string_agg(format('%I = EXCLUDED.%I', c, c), ', ')
      INTO ins_cols, sel_cols, upd_cols
    FROM unnest(present) AS c;
    EXECUTE format(
      'INSERT INTO public.materials_private (material_id, %s)
       SELECT id, %s FROM public.materials
       ON CONFLICT (material_id) DO UPDATE SET %s',
      ins_cols, sel_cols, upd_cols);

    SELECT string_agg(format('%I = NEW.%I', c, c), ', '),
           string_agg(format('m.%I IS DISTINCT FROM NEW.%I', c, c), ' OR ')
      INTO set_list, diff_list
    FROM unnest(present) AS c;
    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION private.fp_sync_material_price_to_directory()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $t$
      BEGIN
        UPDATE public.materials AS m SET %s
        WHERE m.id = NEW.material_id AND (%s);
        RETURN NEW;
      END;
      $t$;
    $fn$, set_list, diff_list);

    SELECT string_agg(format('%I = EXCLUDED.%I', c, c), ', '),
           string_agg(format('public.materials_private.%I IS DISTINCT FROM EXCLUDED.%I', c, c), ' OR '),
           string_agg(quote_ident(c), ', '),
           string_agg(format('NEW.%I', c), ', ')
      INTO upd_cols, diff_list, ins_cols, sel_cols
    FROM unnest(present) AS c;
    EXECUTE format($fn$
      CREATE OR REPLACE FUNCTION private.fp_sync_material_price_from_directory()
      RETURNS trigger
      LANGUAGE plpgsql
      SECURITY DEFINER
      SET search_path = ''
      AS $t$
      BEGIN
        INSERT INTO public.materials_private (material_id, %s)
        VALUES (NEW.id, %s)
        ON CONFLICT (material_id) DO UPDATE SET %s
        WHERE %s;
        RETURN NEW;
      END;
      $t$;
    $fn$, ins_cols, sel_cols, upd_cols, diff_list);

    EXECUTE 'DROP TRIGGER IF EXISTS fp_material_price_to_directory ON public.materials_private';
    EXECUTE 'CREATE TRIGGER fp_material_price_to_directory
             AFTER INSERT OR UPDATE ON public.materials_private
             FOR EACH ROW EXECUTE FUNCTION private.fp_sync_material_price_to_directory()';
    EXECUTE 'DROP TRIGGER IF EXISTS fp_material_price_from_directory ON public.materials';
    EXECUTE 'CREATE TRIGGER fp_material_price_from_directory
             AFTER INSERT OR UPDATE ON public.materials
             FOR EACH ROW EXECUTE FUNCTION private.fp_sync_material_price_from_directory()';
    REVOKE ALL ON FUNCTION private.fp_sync_material_price_to_directory() FROM PUBLIC;
    REVOKE ALL ON FUNCTION private.fp_sync_material_price_from_directory() FROM PUBLIC;
  END IF;

  SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum) INTO safe_cols
  FROM pg_attribute AS a
  WHERE a.attrelid = 'public.materials'::regclass
    AND a.attnum > 0 AND NOT a.attisdropped
    AND NOT (a.attname = ANY (mat_secrets));
  IF safe_cols IS NULL THEN
    RAISE EXCEPTION 'public.materials has no non-price columns left to grant';
  END IF;
  EXECUTE 'REVOKE ALL ON TABLE public.materials FROM PUBLIC, anon, authenticated';
  EXECUTE format(
    'GRANT SELECT (%s), INSERT (%s), UPDATE (%s) ON public.materials TO authenticated',
    safe_cols, safe_cols, safe_cols);
  EXECUTE 'GRANT DELETE ON public.materials TO authenticated';
END
$body$;

ALTER TABLE public.crew_private ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.materials_private ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.crew_private FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.materials_private FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_private TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.materials_private TO authenticated;
-- Backups and the service-role scripts still read and write the copies. They bypass row security.
GRANT ALL ON TABLE public.crew_private TO service_role;
GRANT ALL ON TABLE public.materials_private TO service_role;

DROP POLICY IF EXISTS fp_crew_private_staff ON public.crew_private;
CREATE POLICY fp_crew_private_staff ON public.crew_private
  FOR ALL TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_materials_private_staff ON public.materials_private;
CREATE POLICY fp_materials_private_staff ON public.materials_private
  FOR ALL TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));

-- Replace the one-policy-for-everyone grants.
-- Schedule and PTO blocks stay open to every signed-in member (no pay columns).
-- Leads, the jobs board, and vehicles are owner/office only: they hold prices,
-- customer pipeline details, or maintenance cost.
DROP POLICY IF EXISTS fp_auth_all ON public.crew;
DROP POLICY IF EXISTS fp_crew_select ON public.crew;
DROP POLICY IF EXISTS fp_crew_write ON public.crew;
DROP POLICY IF EXISTS fp_crew_update ON public.crew;
DROP POLICY IF EXISTS fp_crew_delete ON public.crew;
CREATE POLICY fp_crew_select ON public.crew
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_member()));
CREATE POLICY fp_crew_write ON public.crew
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.fp_is_staff()));
CREATE POLICY fp_crew_update ON public.crew
  FOR UPDATE TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));
CREATE POLICY fp_crew_delete ON public.crew
  FOR DELETE TO authenticated
  USING ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_auth_all ON public.materials;
DROP POLICY IF EXISTS fp_materials_select ON public.materials;
DROP POLICY IF EXISTS fp_materials_write ON public.materials;
DROP POLICY IF EXISTS fp_materials_insert ON public.materials;
DROP POLICY IF EXISTS fp_materials_update ON public.materials;
DROP POLICY IF EXISTS fp_materials_delete ON public.materials;
CREATE POLICY fp_materials_select ON public.materials
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_member()));
CREATE POLICY fp_materials_insert ON public.materials
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT private.fp_is_staff()));
CREATE POLICY fp_materials_update ON public.materials
  FOR UPDATE TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));
CREATE POLICY fp_materials_delete ON public.materials
  FOR DELETE TO authenticated
  USING ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_auth_all ON public.jobs;
DROP POLICY IF EXISTS fp_jobs_staff ON public.jobs;
CREATE POLICY fp_jobs_staff ON public.jobs
  FOR ALL TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_auth_all ON public.leads;
DROP POLICY IF EXISTS fp_leads_staff ON public.leads;
CREATE POLICY fp_leads_staff ON public.leads
  FOR ALL TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_auth_all ON public.vehicles;
DROP POLICY IF EXISTS fp_vehicles_staff ON public.vehicles;
CREATE POLICY fp_vehicles_staff ON public.vehicles
  FOR ALL TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_auth_all ON public.vehicle_maintenance;
DROP POLICY IF EXISTS fp_vehicle_maint_staff ON public.vehicle_maintenance;
CREATE POLICY fp_vehicle_maint_staff ON public.vehicle_maintenance
  FOR ALL TO authenticated
  USING ((SELECT private.fp_is_staff()))
  WITH CHECK ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_auth_all ON public.scheduled_slots;
DROP POLICY IF EXISTS fp_slots_member ON public.scheduled_slots;
CREATE POLICY fp_slots_member ON public.scheduled_slots
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_auth_all ON public.pto_blocks;
DROP POLICY IF EXISTS fp_pto_member ON public.pto_blocks;
CREATE POLICY fp_pto_member ON public.pto_blocks
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

-- Audit rows can quote a price or a wage. Crew still insert (their own actions).
-- They cannot read the log back. Insert with return=representation yields an empty
-- body for them; the row is still stored.
DROP POLICY IF EXISTS fp_audit_select ON public.audit_log;
CREATE POLICY fp_audit_select ON public.audit_log
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_is_staff()));

-- Settings. Crew read only the keys their screens load. job_records and pto_requests
-- are not in that list; the functions above are the only crew path to those two.
-- Owner and office still read and write every key except the PIN rows.
DROP POLICY IF EXISTS fp_settings_select ON public.settings;
DROP POLICY IF EXISTS fp_settings_insert ON public.settings;
DROP POLICY IF EXISTS fp_settings_update ON public.settings;
DROP POLICY IF EXISTS fp_settings_delete ON public.settings;
CREATE POLICY fp_settings_select ON public.settings
  FOR SELECT TO authenticated
  USING (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_is_staff())
      OR (
        (SELECT private.fp_role()) = 'crew'
        AND key IN (
          'job_photos', 'job_docs', 'slot_job_map',
          'material_requests', 'material_notes', 'material_docs',
          'crew_inactive',
          'enabled_holidays', 'custom_holidays',
          'custom_job_types', 'deleted_builtin_keys', 'builtin_renames',
          'job_systems', 'mat_categories', 'reference_library',
          'photo_archive', 'sales_scope_photos'
        )
      )
    )
  );
CREATE POLICY fp_settings_insert ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_is_staff())
      OR (
        (SELECT private.fp_role()) = 'crew'
        AND key IN (
          'job_photos', 'job_docs', 'slot_job_map',
          'material_requests', 'material_notes'
        )
      )
    )
  );
CREATE POLICY fp_settings_update ON public.settings
  FOR UPDATE TO authenticated
  USING (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_is_staff())
      OR (
        (SELECT private.fp_role()) = 'crew'
        AND key IN (
          'job_photos', 'job_docs', 'slot_job_map',
          'material_requests', 'material_notes'
        )
      )
    )
  )
  WITH CHECK (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_is_staff())
      OR (
        (SELECT private.fp_role()) = 'crew'
        AND key IN (
          'job_photos', 'job_docs', 'slot_job_map',
          'material_requests', 'material_notes'
        )
      )
    )
  );
CREATE POLICY fp_settings_delete ON public.settings
  FOR DELETE TO authenticated
  USING (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (SELECT private.fp_is_staff())
  );

-- Fail the whole run if a signed-in role can still read a pay column, or if a
-- new public table was left without row security.
DO $check$
DECLARE
  open_tables text;
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crew' AND column_name = 'hourly'
  ) AND has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated can still read public.crew.hourly';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crew' AND column_name = 'phone'
  ) AND has_column_privilege('authenticated', 'public.crew', 'phone', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated can still read public.crew.phone';
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'materials' AND column_name = 'price'
  ) AND has_column_privilege('authenticated', 'public.materials', 'price', 'SELECT') THEN
    RAISE EXCEPTION 'authenticated can still read public.materials.price';
  END IF;

  SELECT string_agg(c.relname, ', ' ORDER BY c.relname) INTO open_tables
  FROM pg_class AS c
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relrowsecurity;
  IF open_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Row security is still off on: %', open_tables;
  END IF;

  IF has_function_privilege('anon', 'public.fp_crew_read_job_records()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_crew_write_job_records(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_crew_read_pto_requests()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_crew_write_pto_requests(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can still execute a crew job or PTO function';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fp_crew_read_job_records()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_crew_write_job_records(jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_crew_read_pto_requests()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_crew_write_pto_requests(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute a crew job or PTO function';
  END IF;
END
$check$;

COMMIT;

NOTIFY pgrst, 'reload schema';
