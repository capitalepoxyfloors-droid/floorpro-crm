-- Live rollout step 1 of the database work. Do not run this on live until Will says go.
-- Do not run it on the test project again. It is already there.
-- This is the only messaging migration from PR #11.
-- Run it once, in the Supabase SQL editor, on live (cngbsmmdfxmerlqnkate), after a backup.
-- Source copy: supabase/migrations/20261028170000_job_messages.sql
-- If it fails partway, run supabase/rollback/20261028170000_job_messages.sql before trying again.

-- Job messages and the company-wide Team thread.
--
-- TEST PROJECT ONLY until Will says to run it on live (cngbsmmdfxmerlqnkate).
-- The website hides Messages and Team when these functions are missing, so the
-- page can ship before live has this file.
--
-- Messages are not stored in settings.job_records. A line of chat must not lock
-- that row or bump a job's updated_at.
--
-- job_id is the job-card id (text, from the job_records blob). The company
-- thread uses the reserved id 'team'. There is no foreign key to public.jobs
-- (that table is the office board, a different id).
--
-- Who can read a job thread: owner and office, or a crew member whose current
-- directory name is on that job's crewNames or crewDays. Who can read and post
-- on 'team': every signed-in owner, office, and crew account. Crew cannot post
-- on a job they are not on. Nobody can edit a body. Only the owner can hide a
-- message (the row stays). The database writes the audit row.

BEGIN;

-- ---------------------------------------------------------------------------
-- Tables. The browser role is not granted access. The functions below are the
-- only client path. Row security is on so a later grant is not wide open.
-- ---------------------------------------------------------------------------

CREATE TABLE public.job_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL,
  author_account_id uuid,
  author_label text NOT NULL,
  author_kind text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  CONSTRAINT job_messages_job_id_len CHECK (char_length(job_id) BETWEEN 1 AND 80),
  CONSTRAINT job_messages_body_len CHECK (char_length(body) BETWEEN 1 AND 2000),
  CONSTRAINT job_messages_kind CHECK (author_kind IN ('owner', 'office', 'crew'))
);

CREATE INDEX job_messages_job_created
  ON public.job_messages (job_id, created_at)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.job_messages IS
  'One thread per job-card id, plus job_id team for the company thread. Bodies are plain text. Pay, rates, and phone numbers are not stored here.';

CREATE TABLE public.job_message_mentions (
  message_id uuid NOT NULL REFERENCES public.job_messages (id) ON DELETE CASCADE,
  account_id uuid NOT NULL,
  PRIMARY KEY (message_id, account_id)
);

COMMENT ON TABLE public.job_message_mentions IS
  'Crew accounts a message is aimed at. A mention does not grant access.';

CREATE TABLE public.job_message_reads (
  account_id uuid NOT NULL,
  job_id text NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, job_id),
  CONSTRAINT job_message_reads_job_id_len CHECK (char_length(job_id) BETWEEN 1 AND 80)
);

COMMENT ON TABLE public.job_message_reads IS
  'Per person, per thread. Unread means a message from someone else newer than last_read_at.';

ALTER TABLE public.job_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_message_mentions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_message_reads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.job_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.job_message_mentions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.job_message_reads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.job_messages TO service_role;
GRANT ALL ON TABLE public.job_message_mentions TO service_role;
GRANT ALL ON TABLE public.job_message_reads TO service_role;

-- ---------------------------------------------------------------------------
-- Helpers. Not granted to the browser. Policies below call fp_my_job_ids.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION private.fp_name_on_job(job jsonb, person text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  n text;
  part text;
  key text;
BEGIN
  n := btrim(coalesce(person, ''));
  IF job IS NULL OR jsonb_typeof(job) != 'object' OR n = '' THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(job -> 'crewNames') = 'string' THEN
    FOREACH part IN ARRAY string_to_array(job ->> 'crewNames', ',') LOOP
      IF btrim(part) = n THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  IF jsonb_typeof(job -> 'crewDays') = 'object' THEN
    FOR key IN SELECT k FROM jsonb_object_keys(job -> 'crewDays') AS k LOOP
      IF btrim(key) = n THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_name_on_job(jsonb, text) FROM PUBLIC, anon, authenticated;

-- Job-card ids the signed-in crew member is on. Owner and office do not use this.
-- Matches the crew chips: directory full_name in crewNames, or a crewDays key.
CREATE OR REPLACE FUNCTION private.fp_my_job_ids()
RETURNS SETOF text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  jobs jsonb;
  job jsonb;
  person text;
  idx integer;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'crew' THEN
    RETURN;
  END IF;
  idx := private.fp_crew_idx();
  IF idx IS NULL THEN
    RETURN;
  END IF;
  SELECT btrim(c.full_name) INTO person
  FROM public.crew AS c
  WHERE c.sort_order = idx
  ORDER BY c.created_at NULLS LAST
  LIMIT 1;
  IF person IS NULL OR person = '' THEN
    SELECT btrim(p.label) INTO person
    FROM public.pin_accounts AS p
    WHERE p.auth_user_id = auth.uid() AND p.kind = 'crew';
  END IF;
  IF person IS NULL OR person = '' THEN
    RETURN;
  END IF;

  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN;
  END IF;
  BEGIN
    jobs := raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN;
  END;
  IF jsonb_typeof(jobs) != 'array' THEN
    RETURN;
  END IF;
  FOR job IN SELECT value FROM jsonb_array_elements(jobs) LOOP
    IF jsonb_typeof(job) = 'object'
       AND coalesce(job ->> 'id', '') != ''
       AND (job ->> 'id') IS DISTINCT FROM 'team'
       AND private.fp_name_on_job(job, person) THEN
      RETURN NEXT job ->> 'id';
    END IF;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_my_job_ids() FROM PUBLIC, anon, authenticated;

-- No INSERT / UPDATE / DELETE policies. Direct writes stay denied if a grant
-- is added later. SELECT is limited the same way the functions are.
CREATE POLICY fp_job_messages_select ON public.job_messages
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      job_id = 'team'
      OR (SELECT private.fp_is_staff())
      OR job_id IN (SELECT private.fp_my_job_ids())
    )
  );

CREATE POLICY fp_job_message_mentions_select ON public.job_message_mentions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.job_messages AS m
      WHERE m.id = message_id
    )
  );

CREATE POLICY fp_job_message_reads_select ON public.job_message_reads
  FOR SELECT TO authenticated
  USING (
    job_id = 'team'
    OR (SELECT private.fp_is_staff())
    OR job_id IN (SELECT private.fp_my_job_ids())
  );

CREATE OR REPLACE FUNCTION private.fp_message_actor()
RETURNS public.pin_accounts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  acct public.pin_accounts;
BEGIN
  IF private.fp_role() IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO acct
  FROM public.pin_accounts AS p
  WHERE p.auth_user_id = auth.uid()
    AND p.kind = private.fp_role();
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  RETURN acct;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_message_actor() FROM PUBLIC, anon, authenticated;

-- Block body edits. Owner may set deleted_at once. Hard delete is refused for
-- every role, including the owner (hide keeps the row).
CREATE OR REPLACE FUNCTION private.fp_job_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.author_account_id IS DISTINCT FROM OLD.author_account_id
     OR NEW.author_label IS DISTINCT FROM OLD.author_label
     OR NEW.author_kind IS DISTINCT FROM OLD.author_kind
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    IF private.fp_role() IS DISTINCT FROM 'owner' OR OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'not allowed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_job_messages_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER fp_job_messages_guard
  BEFORE UPDATE OR DELETE ON public.job_messages
  FOR EACH ROW EXECUTE FUNCTION private.fp_job_messages_guard();

-- Find one job object in the blob. NULL when it is not there.
CREATE OR REPLACE FUNCTION private.fp_job_record(p_job_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  jobs jsonb;
  job jsonb;
BEGIN
  IF p_job_id IS NULL OR btrim(p_job_id) = '' OR p_job_id = 'team' THEN
    RETURN NULL;
  END IF;
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN NULL;
  END IF;
  BEGIN
    jobs := raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;
  IF jsonb_typeof(jobs) != 'array' THEN
    RETURN NULL;
  END IF;
  FOR job IN SELECT value FROM jsonb_array_elements(jobs) LOOP
    IF jsonb_typeof(job) = 'object' AND (job ->> 'id') = p_job_id THEN
      RETURN job;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_job_record(text) FROM PUBLIC, anon, authenticated;

-- True when this login may read and post on the thread.
CREATE OR REPLACE FUNCTION private.fp_can_message(p_job_id text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  role text;
  acct public.pin_accounts;
  person text;
  job jsonb;
BEGIN
  role := private.fp_role();
  IF role IS NULL OR role NOT IN ('owner', 'office', 'crew') THEN
    RETURN false;
  END IF;
  IF p_job_id = 'team' THEN
    RETURN true;
  END IF;
  IF p_job_id IS NULL OR btrim(p_job_id) = '' OR char_length(p_job_id) > 80 THEN
    RETURN false;
  END IF;
  job := private.fp_job_record(p_job_id);
  IF job IS NULL THEN
    RETURN false;
  END IF;
  IF role IN ('owner', 'office') THEN
    RETURN true;
  END IF;
  acct := private.fp_message_actor();
  IF acct.id IS NULL OR acct.crew_idx IS NULL THEN
    RETURN false;
  END IF;
  SELECT btrim(c.full_name) INTO person
  FROM public.crew AS c
  WHERE c.sort_order = acct.crew_idx
  ORDER BY c.created_at NULLS LAST
  LIMIT 1;
  IF person IS NULL OR person = '' THEN
    person := btrim(acct.label);
  END IF;
  RETURN private.fp_name_on_job(job, person);
END;
$$;

REVOKE ALL ON FUNCTION private.fp_can_message(text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.fp_message_audit(p_actor text, p_action text, p_entity text, p_details text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.audit_log (actor, action, entity, details)
  VALUES (
    left(coalesce(nullif(btrim(p_actor), ''), 'Messages'), 200),
    p_action,
    left(coalesce(p_entity, ''), 200),
    left(coalesce(p_details, ''), 500)
  );
EXCEPTION WHEN others THEN
  -- A logging failure must not drop the message.
  NULL;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_message_audit(text, text, text, text) FROM PUBLIC, anon, authenticated;

-- Crew who can be @ mentioned on this thread. Labels only, never phone or pay.
CREATE OR REPLACE FUNCTION private.fp_mention_choices(p_job_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  job jsonb;
  out jsonb;
BEGIN
  IF p_job_id IS DISTINCT FROM 'team' THEN
    job := private.fp_job_record(p_job_id);
    IF job IS NULL THEN
      RETURN '[]'::jsonb;
    END IF;
  END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('account_id', p.id, 'label', p.label) ORDER BY p.label), '[]'::jsonb)
    INTO out
  FROM public.pin_accounts AS p
  LEFT JOIN public.crew AS c ON c.sort_order = p.crew_idx
  WHERE p.kind = 'crew'
    AND NOT private.fp_crew_inactive(p.crew_idx)
    AND (
      p_job_id = 'team'
      OR private.fp_name_on_job(job, btrim(coalesce(nullif(btrim(c.full_name), ''), p.label)))
    );
  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_mention_choices(text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- API
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fp_list_job_messages(job_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job text := btrim(coalesce(job_id, ''));
  acct public.pin_accounts;
  msg jsonb;
  messages jsonb := '[]'::jsonb;
  rec record;
  mentions jsonb;
  seen jsonb;
  seen_n integer;
  last_read timestamptz;
BEGIN
  IF NOT private.fp_can_message(v_job) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  acct := private.fp_message_actor();

  SELECT r.last_read_at INTO last_read
  FROM public.job_message_reads AS r
  WHERE r.account_id = acct.id AND r.job_id = v_job;

  FOR rec IN
    SELECT m.id, m.body, m.created_at, m.author_label, m.author_kind, m.author_account_id
    FROM public.job_messages AS m
    WHERE m.job_id = v_job AND m.deleted_at IS NULL
    ORDER BY m.created_at ASC
    LIMIT 300
  LOOP
    SELECT coalesce(jsonb_agg(jsonb_build_object('account_id', a.id, 'label', a.label) ORDER BY a.label), '[]'::jsonb)
      INTO mentions
    FROM public.job_message_mentions AS mm
    JOIN public.pin_accounts AS a ON a.id = mm.account_id
    WHERE mm.message_id = rec.id;

    SELECT count(*) INTO seen_n
    FROM public.job_message_reads AS r
    WHERE r.job_id = v_job
      AND r.last_read_at >= rec.created_at
      AND r.account_id IS DISTINCT FROM rec.author_account_id;

    SELECT coalesce(jsonb_agg(x.label ORDER BY x.label), '[]'::jsonb) INTO seen
    FROM (
      SELECT a.label
      FROM public.job_message_reads AS r
      JOIN public.pin_accounts AS a ON a.id = r.account_id
      WHERE r.job_id = v_job
        AND r.last_read_at >= rec.created_at
        AND r.account_id IS DISTINCT FROM rec.author_account_id
      ORDER BY a.label
      LIMIT 12
    ) AS x;

    msg := jsonb_build_object(
      'id', rec.id,
      'body', rec.body,
      'created_at', rec.created_at,
      'author_label', rec.author_label,
      'author_kind', rec.author_kind,
      'author_account_id', rec.author_account_id,
      'mentions', mentions,
      'seen_by', seen,
      'seen_count', seen_n
    );
    messages := messages || jsonb_build_array(msg);
  END LOOP;

  RETURN jsonb_build_object(
    'job_id', v_job,
    'me', acct.id,
    'last_read_at', last_read,
    'can_post', true,
    'can_hide', private.fp_role() = 'owner',
    'manual_read', private.fp_role() IN ('owner', 'office'),
    'mention_choices', private.fp_mention_choices(v_job),
    'messages', messages
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_post_job_message(job_id text, body text, mention_ids jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job text := btrim(coalesce(job_id, ''));
  v_body text := btrim(coalesce(body, ''));
  v_mentions jsonb := coalesce(mention_ids, '[]'::jsonb);
  acct public.pin_accounts;
  job jsonb;
  entity text;
  mention uuid;
  elem text;
  n integer := 0;
  seen uuid[] := ARRAY[]::uuid[];
  person text;
  target public.pin_accounts;
  new_id uuid;
BEGIN
  IF NOT private.fp_can_message(v_job) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF v_body = '' OR char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF jsonb_typeof(v_mentions) != 'array' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  acct := private.fp_message_actor();
  IF acct.id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  IF v_job = 'team' THEN
    entity := 'Team';
    job := NULL;
  ELSE
    job := private.fp_job_record(v_job);
    entity := coalesce(nullif(btrim(job ->> 'customer'), ''), v_job);
  END IF;

  INSERT INTO public.job_messages (job_id, author_account_id, author_label, author_kind, body)
  VALUES (v_job, acct.id, left(acct.label, 120), acct.kind, v_body)
  RETURNING id INTO new_id;

  FOR elem IN SELECT value FROM jsonb_array_elements_text(v_mentions) LOOP
    n := n + 1;
    IF n > 12 THEN
      EXIT;
    END IF;
    BEGIN
      mention := elem::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'not allowed';
    END;
    IF mention = ANY (seen) THEN
      CONTINUE;
    END IF;
    seen := seen || mention;

    SELECT * INTO target FROM public.pin_accounts AS p WHERE p.id = mention AND p.kind = 'crew';
    IF NOT FOUND OR private.fp_crew_inactive(target.crew_idx) THEN
      RAISE EXCEPTION 'not allowed';
    END IF;
    IF v_job IS DISTINCT FROM 'team' THEN
      SELECT btrim(c.full_name) INTO person
      FROM public.crew AS c
      WHERE c.sort_order = target.crew_idx
      ORDER BY c.created_at NULLS LAST
      LIMIT 1;
      IF person IS NULL OR person = '' THEN
        person := btrim(target.label);
      END IF;
      IF NOT private.fp_name_on_job(job, person) THEN
        RAISE EXCEPTION 'not allowed';
      END IF;
    END IF;
    INSERT INTO public.job_message_mentions (message_id, account_id) VALUES (new_id, mention);
  END LOOP;

  INSERT INTO public.job_message_reads (account_id, job_id, last_read_at)
  VALUES (acct.id, v_job, clock_timestamp())
  ON CONFLICT ON CONSTRAINT job_message_reads_pkey DO UPDATE SET last_read_at = EXCLUDED.last_read_at;

  PERFORM private.fp_message_audit(
    acct.label,
    'message_posted',
    entity,
    v_job || ' ' || left(v_body, 140)
  );

  RETURN jsonb_build_object('ok', true, 'id', new_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_mark_job_thread_read(job_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_job text := btrim(coalesce(job_id, ''));
  acct public.pin_accounts;
BEGIN
  IF NOT private.fp_can_message(v_job) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  acct := private.fp_message_actor();
  IF acct.id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  INSERT INTO public.job_message_reads (account_id, job_id, last_read_at)
  VALUES (acct.id, v_job, clock_timestamp())
  ON CONFLICT ON CONSTRAINT job_message_reads_pkey DO UPDATE SET last_read_at = EXCLUDED.last_read_at;
  RETURN jsonb_build_object('ok', true, 'job_id', v_job);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_hide_job_message(message_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  acct public.pin_accounts;
  rec public.job_messages;
  entity text;
  job jsonb;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  acct := private.fp_message_actor();
  IF acct.id IS NULL OR message_id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT * INTO rec FROM public.job_messages WHERE id = message_id;
  IF NOT FOUND OR rec.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  UPDATE public.job_messages
     SET deleted_at = clock_timestamp(), deleted_by = acct.id
   WHERE id = message_id;

  IF rec.job_id = 'team' THEN
    entity := 'Team';
  ELSE
    job := private.fp_job_record(rec.job_id);
    entity := coalesce(nullif(btrim(job ->> 'customer'), ''), rec.job_id);
  END IF;
  PERFORM private.fp_message_audit(
    acct.label,
    'message_hidden',
    entity,
    rec.job_id || ' ' || left(rec.body, 140)
  );
  RETURN jsonb_build_object('ok', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_unread_job_messages()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  acct public.pin_accounts;
  out jsonb;
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  acct := private.fp_message_actor();
  IF acct.id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'job_id', s.job_id,
           'unread', s.unread,
           'mentioned', s.mentioned
         )), '[]'::jsonb)
    INTO out
  FROM (
    SELECT m.job_id,
           count(*) FILTER (
             WHERE m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
               AND m.author_account_id IS DISTINCT FROM acct.id
           ) AS unread,
           count(*) FILTER (
             WHERE m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
               AND m.author_account_id IS DISTINCT FROM acct.id
               AND EXISTS (
                 SELECT 1 FROM public.job_message_mentions AS mm
                 WHERE mm.message_id = m.id AND mm.account_id = acct.id
               )
           ) AS mentioned
    FROM public.job_messages AS m
    LEFT JOIN public.job_message_reads AS r
      ON r.job_id = m.job_id AND r.account_id = acct.id
    WHERE m.deleted_at IS NULL
      AND (
        m.job_id = 'team'
        OR private.fp_is_staff()
        OR m.job_id IN (SELECT private.fp_my_job_ids())
      )
    GROUP BY m.job_id
  ) AS s
  WHERE s.unread > 0;

  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION public.fp_list_job_messages(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_post_job_message(text, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_mark_job_thread_read(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_hide_job_message(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_unread_job_messages() FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fp_list_job_messages(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_post_job_message(text, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_mark_job_thread_read(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_hide_job_message(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_unread_job_messages() TO authenticated;

DO $check$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'job_messages' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'job_message_mentions' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'job_message_reads' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'row security is off on a message table';
  END IF;

  IF has_function_privilege('anon', 'public.fp_list_job_messages(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_post_job_message(text, text, jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_mark_job_thread_read(text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_hide_job_message(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_unread_job_messages()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute a message function';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.fp_list_job_messages(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_post_job_message(text, text, jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_unread_job_messages()', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute a message function';
  END IF;

  IF has_table_privilege('anon', 'public.job_messages', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_messages', 'SELECT')
     OR has_table_privilege('anon', 'public.job_messages', 'INSERT')
     OR has_table_privilege('authenticated', 'public.job_messages', 'INSERT') THEN
    RAISE EXCEPTION 'a client role can reach job_messages directly';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';

COMMIT;
