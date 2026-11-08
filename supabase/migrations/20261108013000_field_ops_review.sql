-- REVIEW ONLY. Do not apply until Will approves this exact file for floorpro-crm-test.
--
-- The tripwire below reads fp.project_ref, which the operator types with set_config.
-- That value is caller-controlled. It does not prove which database the session is
-- connected to. Someone on the live project can set the same flag and this file will
-- run. Before executing, the SQL runner must show project nndjnywtkgxwvxajwztg and
-- host db.nndjnywtkgxwvxajwztg.supabase.co. Stop if either shows cngbsmmdfxmerlqnkate.
-- The flag only stops a run where the operator forgot to set it.
--
-- Identities this file uses, from the test catalog and the current app:
--   Daily-log jobs are text ids inside settings.job_records. public.jobs.id is a
--   different uuid and is not referenced here.
--   Schedule crew is pin_accounts.crew_idx / scheduled_slots.crew_idx (integer).
--   The signed-in person is pin_accounts.auth_user_id = auth.uid(), checked by
--   private.fp_member(), private.fp_role(), and private.fp_is_staff().
--   Those functions match app_metadata.fp_role and fp_nonce to the pin account.
--   They do not read an editable profile claim.
--   audit_log.created_at already exists on the test catalog (timestamptz, default now()).
--   This file does not alter audit_log and does not read or write its rows.
--
-- What this file changes:
--   New tables for document identity, revisions, document-open history, issues,
--   and one stop-order row per crew and date. No rows are copied from job_docs.
--   Crew can no longer insert or update settings.job_docs. They can still read it.
--   Office write of settings is unchanged. No settings value is updated or deleted.
--   Storage under jobdocs-rev/ and issue-photos/ is no longer covered by the
--   bucket-wide member policy. Other vehicle-docs paths keep that access.
--   There is no delete of a document, a revision, an issue, a stop order, or a file.
--
-- What this file does not change: job_records, clocks, credited hours, crew pay,
-- scheduled_slots, and the existing job_docs JSON.

DO $guard$
DECLARE
  ref text := current_setting('fp.project_ref', true);
BEGIN
  IF ref IS DISTINCT FROM 'nndjnywtkgxwvxajwztg' THEN
    RAISE EXCEPTION 'wrong project refusal';
  END IF;
  IF position('cngbsmmdfxmerlqnkate' IN coalesce(ref, '')) > 0 THEN
    RAISE EXCEPTION 'live project refusal';
  END IF;
END
$guard$;

BEGIN;

CREATE TABLE public.job_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  UNIQUE (created_by, idempotency_key)
);

CREATE TABLE public.job_document_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES public.job_documents (id),
  idempotency_key uuid NOT NULL,
  storage_path text NOT NULL,
  byte_size bigint NOT NULL CHECK (byte_size > 0),
  is_current boolean NOT NULL DEFAULT false,
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  uploaded_by uuid NOT NULL,
  became_current_at timestamptz,
  UNIQUE (document_id, idempotency_key)
);

CREATE UNIQUE INDEX job_document_revisions_one_current
  ON public.job_document_revisions (document_id)
  WHERE is_current;

CREATE TABLE public.job_document_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revision_id uuid NOT NULL REFERENCES public.job_document_revisions (id),
  account_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.job_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id text NOT NULL,
  work_date date NOT NULL,
  note text NOT NULL CHECK (char_length(btrim(note)) BETWEEN 1 AND 2000),
  category text CHECK (category IS NULL OR char_length(category) <= 80),
  photo_path text,
  reporter_account_id uuid NOT NULL,
  idempotency_key uuid NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  owner_label text,
  due_on date,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (reporter_account_id, idempotency_key)
);

CREATE TABLE public.crew_day_order (
  crew_idx integer NOT NULL CHECK (crew_idx >= 0),
  work_date date NOT NULL,
  job_ids text[] NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL,
  PRIMARY KEY (crew_idx, work_date)
);

CREATE OR REPLACE FUNCTION private.fp_actor()
RETURNS TABLE (account_id uuid, kind text, label text, crew_idx integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id, p.kind, p.label, p.crew_idx
  FROM public.pin_accounts AS p
  WHERE p.auth_user_id = auth.uid()
    AND private.fp_member();
$$;

-- private.fp_job_record(p_job_id text) already exists on the test database.
-- Do not replace it. These helpers call that function. Replacing it fails
-- because the parameter name differs, and the existing body is the job lookup.

CREATE OR REPLACE FUNCTION private.fp_crew_sees_job(p_job text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_idx integer := private.fp_crew_idx();
  rec jsonb := private.fp_job_record(p_job);
  raw text;
  map jsonb;
  pair record;
  day jsonb;
  person jsonb;
BEGIN
  IF v_idx IS NULL OR rec IS NULL THEN
    RETURN false;
  END IF;
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'slot_job_map';
  IF raw IS NOT NULL AND btrim(raw) <> '' THEN
    BEGIN
      map := raw::jsonb;
    EXCEPTION WHEN others THEN
      map := NULL;
    END;
  END IF;
  IF map IS NOT NULL AND jsonb_typeof(map) = 'object' THEN
    FOR pair IN SELECT key, value FROM jsonb_each_text(map) LOOP
      IF pair.value = p_job AND split_part(pair.key, '_', 1) = v_idx::text THEN
        RETURN true;
      END IF;
    END LOOP;
  END IF;
  IF rec -> 'dayLogs' IS NOT NULL AND jsonb_typeof(rec -> 'dayLogs') = 'object' THEN
    FOR day IN SELECT value FROM jsonb_each(rec -> 'dayLogs') LOOP
      IF jsonb_typeof(day -> 'crewPresent') = 'array' THEN
        FOR person IN SELECT value FROM jsonb_array_elements(day -> 'crewPresent') LOOP
          IF coalesce(person ->> 'crewIdx', '') ~ '^-?[0-9]+$'
             AND (person ->> 'crewIdx')::integer = v_idx THEN
            RETURN true;
          END IF;
        END LOOP;
      END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_revision_path_is_current(p_path text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.job_document_revisions AS r
    WHERE r.storage_path = p_path
      AND r.is_current
  );
$$;

REVOKE ALL ON FUNCTION private.fp_actor() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_crew_sees_job(text) FROM PUBLIC, anon, authenticated;
CREATE OR REPLACE FUNCTION private.fp_actor_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT a.account_id FROM private.fp_actor() AS a;
$$;

CREATE OR REPLACE FUNCTION private.fp_self_crew_idx()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT private.fp_crew_idx();
$$;

REVOKE ALL ON FUNCTION private.fp_revision_path_is_current(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_actor_id() FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_self_crew_idx() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.fp_revision_path_is_current(text) TO authenticated;
GRANT EXECUTE ON FUNCTION private.fp_actor_id() TO authenticated;
GRANT EXECUTE ON FUNCTION private.fp_self_crew_idx() TO authenticated;
GRANT EXECUTE ON FUNCTION private.fp_crew_sees_job(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fp_field_ops_ready()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  RETURN jsonb_build_object('documents', true, 'issues', true, 'stop_order', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_documents_for_job(p_job text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  staff boolean := private.fp_is_staff();
BEGIN
  IF private.fp_job_record(p_job) IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NOT staff AND NOT private.fp_crew_sees_job(p_job) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'document_id', d.id,
      'title', d.title,
      'revision_id', r.id,
      'uploaded_at', r.uploaded_at,
      'byte_size', r.byte_size
    ) ORDER BY d.title, d.id)
    FROM public.job_documents AS d
    JOIN public.job_document_revisions AS r
      ON r.document_id = d.id AND r.is_current
    WHERE d.job_id = p_job
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_document_create(p_job text, p_title text, p_key uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid;
  existing public.job_documents%ROWTYPE;
  new_id uuid;
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF p_key IS NULL OR private.fp_job_record(p_job) IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT a.account_id INTO actor FROM private.fp_actor() AS a;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT * INTO existing
  FROM public.job_documents AS d
  WHERE d.created_by = actor AND d.idempotency_key = p_key;
  IF existing.id IS NOT NULL THEN
    IF existing.job_id IS DISTINCT FROM p_job OR existing.title IS DISTINCT FROM btrim(p_title) THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN existing.id;
  END IF;
  INSERT INTO public.job_documents (job_id, title, idempotency_key, created_by)
  VALUES (p_job, btrim(p_title), p_key, actor)
  RETURNING id INTO new_id;
  RETURN new_id;
EXCEPTION
  WHEN unique_violation THEN
    SELECT * INTO existing
    FROM public.job_documents AS d
    WHERE d.created_by = actor AND d.idempotency_key = p_key;
    IF existing.job_id IS DISTINCT FROM p_job OR existing.title IS DISTINCT FROM btrim(p_title) THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN existing.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_document_stage_revision(
  p_document uuid,
  p_key uuid,
  p_path text,
  p_bytes bigint
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid;
  existing uuid;
  doc_job text;
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT a.account_id INTO actor FROM private.fp_actor() AS a;
  IF actor IS NULL OR p_key IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT d.job_id INTO doc_job FROM public.job_documents AS d WHERE d.id = p_document;
  IF doc_job IS NULL OR private.fp_job_record(doc_job) IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF p_path IS DISTINCT FROM ('jobdocs-rev/' || p_document::text || '/' || p_key::text) THEN
    RAISE EXCEPTION 'bad path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects AS o
    WHERE o.bucket_id = 'vehicle-docs' AND o.name = p_path
  ) THEN
    RAISE EXCEPTION 'upload missing';
  END IF;
  SELECT r.id INTO existing
  FROM public.job_document_revisions AS r
  WHERE r.document_id = p_document
    AND r.idempotency_key = p_key
    AND r.storage_path = p_path
    AND r.byte_size = p_bytes;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_document_revisions AS r
    WHERE r.document_id = p_document AND r.idempotency_key = p_key
  ) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;
  INSERT INTO public.job_document_revisions (
    document_id, idempotency_key, storage_path, byte_size, is_current, uploaded_by
  ) VALUES (
    p_document, p_key, p_path, p_bytes, false, actor
  ) RETURNING id INTO existing;
  RETURN existing;
EXCEPTION
  WHEN unique_violation THEN
    SELECT r.id INTO existing
    FROM public.job_document_revisions AS r
    WHERE r.document_id = p_document
      AND r.idempotency_key = p_key
      AND r.storage_path = p_path
      AND r.byte_size = p_bytes;
    IF existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN existing;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_document_promote(
  p_document uuid,
  p_revision uuid,
  p_expected uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  current_id uuid;
  staged public.job_document_revisions%ROWTYPE;
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  PERFORM 1 FROM public.job_documents AS d WHERE d.id = p_document FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT r.id INTO current_id
  FROM public.job_document_revisions AS r
  WHERE r.document_id = p_document AND r.is_current
  FOR UPDATE;
  SELECT * INTO staged
  FROM public.job_document_revisions AS r
  WHERE r.id = p_revision AND r.document_id = p_document
  FOR UPDATE;
  IF staged.id IS NULL OR staged.byte_size IS NULL OR staged.byte_size < 1 THEN
    RAISE EXCEPTION 'upload missing';
  END IF;
  IF staged.storage_path IS DISTINCT FROM ('jobdocs-rev/' || p_document::text || '/' || staged.idempotency_key::text) THEN
    RAISE EXCEPTION 'bad path';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM storage.objects AS o
    WHERE o.bucket_id = 'vehicle-docs' AND o.name = staged.storage_path
  ) THEN
    RAISE EXCEPTION 'upload missing';
  END IF;
  IF staged.is_current AND current_id = staged.id THEN
    RETURN staged.id;
  END IF;
  IF current_id IS DISTINCT FROM p_expected THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  UPDATE public.job_document_revisions
  SET is_current = false
  WHERE document_id = p_document AND is_current;
  UPDATE public.job_document_revisions
  SET is_current = true, became_current_at = now()
  WHERE id = p_revision AND document_id = p_document AND is_current = false;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'stale_revision';
  END IF;
  RETURN p_revision;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_document_history(p_document uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'revision_id', r.id,
      'uploaded_at', r.uploaded_at,
      'byte_size', r.byte_size,
      'is_current', r.is_current,
      'became_current_at', r.became_current_at
    ) ORDER BY r.uploaded_at, r.id)
    FROM public.job_document_revisions AS r
    WHERE r.document_id = p_document
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_document_open(p_revision uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid;
  rev public.job_document_revisions%ROWTYPE;
  doc_job text;
BEGIN
  SELECT a.account_id INTO actor FROM private.fp_actor() AS a;
  IF actor IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT * INTO rev FROM public.job_document_revisions AS r WHERE r.id = p_revision;
  IF rev.id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT d.job_id INTO doc_job FROM public.job_documents AS d WHERE d.id = rev.document_id;
  IF private.fp_is_staff() THEN
    NULL;
  ELSIF private.fp_role() = 'crew' AND rev.is_current AND private.fp_crew_sees_job(doc_job) THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'not allowed';
  END IF;
  INSERT INTO public.job_document_access (revision_id, account_id) VALUES (rev.id, actor);
  RETURN rev.storage_path;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_document_access_history(p_document uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'opened_at', a.opened_at,
      'account_id', a.account_id,
      'revision_id', a.revision_id
    ) ORDER BY a.opened_at DESC)
    FROM public.job_document_access AS a
    JOIN public.job_document_revisions AS r ON r.id = a.revision_id
    WHERE r.document_id = p_document
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_issue_create(
  p_job text,
  p_date date,
  p_note text,
  p_category text,
  p_key uuid,
  p_photo text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid;
  existing uuid;
BEGIN
  SELECT a.account_id INTO actor FROM private.fp_actor() AS a;
  IF actor IS NULL OR p_key IS NULL OR p_date IS NULL OR btrim(coalesce(p_note, '')) = '' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NOT private.fp_is_staff() AND NOT private.fp_crew_sees_job(p_job) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF private.fp_is_staff() AND private.fp_job_record(p_job) IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF p_photo IS NOT NULL AND p_photo IS DISTINCT FROM ('issue-photos/' || actor::text || '/' || p_key::text) THEN
    RAISE EXCEPTION 'bad path';
  END IF;
  IF p_photo IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM storage.objects AS o
    WHERE o.bucket_id = 'vehicle-docs' AND o.name = p_photo
  ) THEN
    RAISE EXCEPTION 'upload missing';
  END IF;
  SELECT i.id INTO existing
  FROM public.job_issues AS i
  WHERE i.reporter_account_id = actor
    AND i.idempotency_key = p_key
    AND i.job_id = p_job
    AND i.work_date = p_date
    AND i.note = btrim(p_note)
    AND i.category IS NOT DISTINCT FROM NULLIF(btrim(coalesce(p_category, '')), '')
    AND i.photo_path IS NOT DISTINCT FROM p_photo;
  IF existing IS NOT NULL THEN
    RETURN existing;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.job_issues AS i
    WHERE i.reporter_account_id = actor AND i.idempotency_key = p_key
  ) THEN
    RAISE EXCEPTION 'idempotency_conflict';
  END IF;
  INSERT INTO public.job_issues (
    job_id, work_date, note, category, photo_path, reporter_account_id, idempotency_key
  ) VALUES (
    p_job, p_date, btrim(p_note), NULLIF(btrim(coalesce(p_category, '')), ''), p_photo, actor, p_key
  ) RETURNING id INTO existing;
  RETURN existing;
EXCEPTION
  WHEN unique_violation THEN
    SELECT i.id INTO existing
    FROM public.job_issues AS i
    WHERE i.reporter_account_id = actor
      AND i.idempotency_key = p_key
      AND i.job_id = p_job
      AND i.work_date = p_date
      AND i.note = btrim(p_note)
      AND i.category IS NOT DISTINCT FROM NULLIF(btrim(coalesce(p_category, '')), '')
      AND i.photo_path IS NOT DISTINCT FROM p_photo;
    IF existing IS NULL THEN
      RAISE EXCEPTION 'idempotency_conflict';
    END IF;
    RETURN existing;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_issues_open_unassigned()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  RETURN coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'id', i.id,
      'job_id', i.job_id,
      'work_date', i.work_date,
      'note', i.note,
      'category', i.category,
      'created_at', i.created_at
    ) ORDER BY i.created_at, i.id)
    FROM public.job_issues AS i
    WHERE i.status = 'open' AND i.owner_label IS NULL
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_issue_update(
  p_issue uuid,
  p_status text,
  p_owner text,
  p_due date
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('open', 'resolved') THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  UPDATE public.job_issues
  SET status = coalesce(p_status, status),
      owner_label = CASE WHEN p_owner IS NULL THEN owner_label ELSE NULLIF(btrim(p_owner), '') END,
      due_on = coalesce(p_due, due_on)
  WHERE id = p_issue;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  RETURN p_issue;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_stop_order_read(p_idx integer, p_date date)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  row public.crew_day_order%ROWTYPE;
BEGIN
  IF private.fp_is_staff() THEN
    NULL;
  ELSIF private.fp_role() = 'crew' AND private.fp_crew_idx() = p_idx THEN
    NULL;
  ELSE
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT * INTO row FROM public.crew_day_order AS o
  WHERE o.crew_idx = p_idx AND o.work_date = p_date;
  IF row.crew_idx IS NULL THEN
    RETURN jsonb_build_object('revision', 0, 'job_ids', '[]'::jsonb);
  END IF;
  RETURN jsonb_build_object(
    'revision', row.revision,
    'job_ids', to_jsonb(row.job_ids)
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_stop_member(p_idx integer, p_date date, p_job text)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rec jsonb := private.fp_job_record(p_job);
  day_key text := to_char(p_date, 'YYYY-MM-DD');
  day jsonb;
  person jsonb;
  named boolean := false;
  on_log boolean := false;
  pair record;
  raw text;
  map jsonb;
BEGIN
  IF p_idx IS NULL OR p_idx < 0 OR rec IS NULL OR p_date IS NULL THEN
    RETURN false;
  END IF;
  IF NOT (
    (rec ->> 'startDate') IS NOT NULL
    AND (rec ->> 'endDate') IS NOT NULL
    AND day_key >= (rec ->> 'startDate')
    AND day_key <= (rec ->> 'endDate')
  ) AND NOT (
    jsonb_typeof(rec -> 'extraDays') = 'array'
    AND (rec -> 'extraDays') ? day_key
  ) THEN
    RETURN false;
  END IF;
  day := rec -> 'dayLogs' -> day_key;
  IF day IS NOT NULL AND jsonb_typeof(day -> 'crewPresent') = 'array' THEN
    FOR person IN SELECT value FROM jsonb_array_elements(day -> 'crewPresent') LOOP
      IF coalesce(person ->> 'crewIdx', '') ~ '^-?[0-9]+$'
         OR btrim(coalesce(person ->> 'name', '')) <> '' THEN
        named := true;
      END IF;
      IF coalesce(person ->> 'crewIdx', '') ~ '^-?[0-9]+$'
         AND (person ->> 'crewIdx')::integer = p_idx THEN
        on_log := true;
      END IF;
    END LOOP;
  END IF;
  IF named THEN
    RETURN on_log;
  END IF;
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'slot_job_map';
  IF raw IS NOT NULL AND btrim(raw) <> '' THEN
    BEGIN
      map := raw::jsonb;
    EXCEPTION WHEN others THEN
      map := NULL;
    END;
  END IF;
  IF map IS NULL OR jsonb_typeof(map) <> 'object' THEN
    RETURN false;
  END IF;
  FOR pair IN SELECT key, value FROM jsonb_each_text(map) LOOP
    IF pair.value = p_job AND split_part(pair.key, '_', 1) = p_idx::text THEN
      RETURN true;
    END IF;
  END LOOP;
  RETURN false;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_stop_member(integer, date, text) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION private.fp_stop_order_write(
  p_idx integer,
  p_date date,
  p_ids text[],
  p_expected bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  actor uuid;
  clean text[] := '{}';
  item text;
  new_rev bigint;
BEGIN
  IF NOT private.fp_is_staff() THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT a.account_id INTO actor FROM private.fp_actor() AS a;
  IF actor IS NULL OR p_idx IS NULL OR p_idx < 0 OR p_date IS NULL OR p_expected IS NULL OR p_expected < 0 THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.pin_accounts AS p
    WHERE p.kind = 'crew' AND p.crew_idx = p_idx
  ) AND NOT EXISTS (
    SELECT 1 FROM public.scheduled_slots AS s WHERE s.crew_idx = p_idx
  ) AND NOT EXISTS (
    SELECT 1 FROM public.crew AS c WHERE c.sort_order = p_idx
  ) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF p_ids IS NOT NULL THEN
    FOREACH item IN ARRAY p_ids LOOP
      IF item IS NULL OR btrim(item) = '' OR item = ANY (clean) THEN
        RAISE EXCEPTION 'bad stop';
      END IF;
      IF NOT private.fp_stop_member(p_idx, p_date, item) THEN
        RAISE EXCEPTION 'not allowed';
      END IF;
      clean := clean || item;
    END LOOP;
  END IF;
  IF p_expected = 0 THEN
    INSERT INTO public.crew_day_order (crew_idx, work_date, job_ids, revision, updated_by)
    VALUES (p_idx, p_date, clean, 1, actor)
    ON CONFLICT (crew_idx, work_date) DO NOTHING
    RETURNING revision INTO new_rev;
    IF new_rev IS NULL THEN
      RAISE EXCEPTION 'stale_order';
    END IF;
    RETURN new_rev;
  END IF;
  UPDATE public.crew_day_order
  SET job_ids = clean,
      revision = revision + 1,
      updated_at = now(),
      updated_by = actor
  WHERE crew_idx = p_idx AND work_date = p_date AND revision = p_expected
  RETURNING revision INTO new_rev;
  IF new_rev IS NULL THEN
    RAISE EXCEPTION 'stale_order';
  END IF;
  RETURN new_rev;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_stop_order_set(
  p_idx integer,
  p_date date,
  p_ids text[],
  p_expected bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.fp_stop_order_write(p_idx, p_date, p_ids, p_expected);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_stop_order_reset(
  p_idx integer,
  p_date date,
  p_expected bigint
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  RETURN private.fp_stop_order_write(p_idx, p_date, '{}'::text[], p_expected);
END;
$$;

REVOKE ALL ON FUNCTION private.fp_stop_order_write(integer, date, text[], bigint) FROM PUBLIC, anon, authenticated;

REVOKE ALL ON TABLE public.job_documents FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.job_document_revisions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.job_document_access FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.job_issues FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.crew_day_order FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.fp_field_ops_ready() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_documents_for_job(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_document_create(text, text, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_document_stage_revision(uuid, uuid, text, bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_document_promote(uuid, uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_document_history(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_document_open(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_document_access_history(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_issue_create(text, date, text, text, uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_issues_open_unassigned() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_issue_update(uuid, text, text, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_stop_order_read(integer, date) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_stop_order_set(integer, date, text[], bigint) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_stop_order_reset(integer, date, bigint) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fp_field_ops_ready() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_documents_for_job(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_document_create(text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_document_stage_revision(uuid, uuid, text, bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_document_promote(uuid, uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_document_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_document_open(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_document_access_history(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_issue_create(text, date, text, text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_issues_open_unassigned() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_issue_update(uuid, text, text, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_stop_order_read(integer, date) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_stop_order_set(integer, date, text[], bigint) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_stop_order_reset(integer, date, bigint) TO authenticated;

ALTER TABLE public.job_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_document_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_document_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.job_issues ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew_day_order ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fp_job_documents_staff ON public.job_documents;
CREATE POLICY fp_job_documents_staff ON public.job_documents
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_is_staff()));
DROP POLICY IF EXISTS fp_job_documents_crew ON public.job_documents;
CREATE POLICY fp_job_documents_crew ON public.job_documents
  FOR SELECT TO authenticated
  USING (
    (SELECT private.fp_role()) = 'crew'
    AND private.fp_crew_sees_job(job_id)
  );

DROP POLICY IF EXISTS fp_job_revisions_staff ON public.job_document_revisions;
CREATE POLICY fp_job_revisions_staff ON public.job_document_revisions
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_is_staff()));
DROP POLICY IF EXISTS fp_job_revisions_crew_current ON public.job_document_revisions;
CREATE POLICY fp_job_revisions_crew_current ON public.job_document_revisions
  FOR SELECT TO authenticated
  USING (
    is_current
    AND (SELECT private.fp_role()) = 'crew'
    AND EXISTS (
      SELECT 1 FROM public.job_documents AS d
      WHERE d.id = document_id AND private.fp_crew_sees_job(d.job_id)
    )
  );

DROP POLICY IF EXISTS fp_job_doc_access_staff ON public.job_document_access;
CREATE POLICY fp_job_doc_access_staff ON public.job_document_access
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_is_staff()));

DROP POLICY IF EXISTS fp_job_issues_staff ON public.job_issues;
CREATE POLICY fp_job_issues_staff ON public.job_issues
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_is_staff()));
DROP POLICY IF EXISTS fp_job_issues_crew_own ON public.job_issues;
CREATE POLICY fp_job_issues_crew_own ON public.job_issues
  FOR SELECT TO authenticated
  USING (
    (SELECT private.fp_role()) = 'crew'
    AND reporter_account_id = private.fp_actor_id()
  );

DROP POLICY IF EXISTS fp_stop_order_staff ON public.crew_day_order;
CREATE POLICY fp_stop_order_staff ON public.crew_day_order
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_is_staff()));
DROP POLICY IF EXISTS fp_stop_order_crew_own ON public.crew_day_order;
CREATE POLICY fp_stop_order_crew_own ON public.crew_day_order
  FOR SELECT TO authenticated
  USING (
    (SELECT private.fp_role()) = 'crew'
    AND crew_idx = private.fp_self_crew_idx()
  );

-- Crew lose write access to the old document blob. Office write is unchanged.
-- The stored JSON is not modified.
DROP POLICY IF EXISTS fp_settings_insert ON public.settings;
DROP POLICY IF EXISTS fp_settings_update ON public.settings;
CREATE POLICY fp_settings_insert ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_is_staff())
      OR (
        (SELECT private.fp_role()) = 'crew'
        AND key IN (
          'job_photos', 'slot_job_map',
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
          'job_photos', 'slot_job_map',
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
          'job_photos', 'slot_job_map',
          'material_requests', 'material_notes'
        )
      )
    )
  );

-- The test catalog shows storage.buckets.public = false for vehicle-docs.
-- This file does not change that flag. Old rows still store /object/public/ URLs.
-- Table policies do not make those URLs private. Signed-in members can still read
-- the old jobdocs/ objects. Crew can no longer write or delete that prefix.
DROP POLICY IF EXISTS "vehicle-docs authenticated all" ON storage.objects;
CREATE POLICY "vehicle-docs member read except new prefixes"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_member())
    AND name NOT LIKE 'jobdocs-rev/%'
    AND name NOT LIKE 'issue-photos/%'
  );
CREATE POLICY "vehicle-docs staff write except new prefixes"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_is_staff())
    AND name NOT LIKE 'jobdocs-rev/%'
    AND name NOT LIKE 'issue-photos/%'
  )
  WITH CHECK (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_is_staff())
    AND name NOT LIKE 'jobdocs-rev/%'
    AND name NOT LIKE 'issue-photos/%'
  );
CREATE POLICY "vehicle-docs crew write except job docs"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_role()) = 'crew'
    AND name NOT LIKE 'jobdocs/%'
    AND name NOT LIKE 'jobdocs-rev/%'
    AND name NOT LIKE 'issue-photos/%'
  );
CREATE POLICY "vehicle-docs crew update except job docs"
  ON storage.objects
  FOR UPDATE
  TO authenticated
  USING (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_role()) = 'crew'
    AND name NOT LIKE 'jobdocs/%'
    AND name NOT LIKE 'jobdocs-rev/%'
    AND name NOT LIKE 'issue-photos/%'
  )
  WITH CHECK (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_role()) = 'crew'
    AND name NOT LIKE 'jobdocs/%'
    AND name NOT LIKE 'jobdocs-rev/%'
    AND name NOT LIKE 'issue-photos/%'
  );
CREATE POLICY "vehicle-docs crew delete except job docs"
  ON storage.objects
  FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_role()) = 'crew'
    AND name NOT LIKE 'jobdocs/%'
    AND name NOT LIKE 'jobdocs-rev/%'
    AND name NOT LIKE 'issue-photos/%'
  );

CREATE POLICY "jobdocs-rev staff insert"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'vehicle-docs'
    AND name ~ '^jobdocs-rev/[0-9a-fA-F-]{36}/[0-9a-fA-F-]{36}$'
    AND (SELECT private.fp_is_staff())
  );
CREATE POLICY "jobdocs-rev staff select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'vehicle-docs'
    AND name LIKE 'jobdocs-rev/%'
    AND (SELECT private.fp_is_staff())
  );
CREATE POLICY "jobdocs-rev crew current select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'vehicle-docs'
    AND name LIKE 'jobdocs-rev/%'
    AND (SELECT private.fp_role()) = 'crew'
    AND private.fp_revision_path_is_current(name)
  );

CREATE POLICY "issue-photos staff select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'vehicle-docs'
    AND name LIKE 'issue-photos/%'
    AND (SELECT private.fp_is_staff())
  );
CREATE POLICY "issue-photos crew insert own"
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'vehicle-docs'
    AND (SELECT private.fp_role()) = 'crew'
    AND name LIKE ('issue-photos/' || private.fp_actor_id()::text || '/%')
  );

DO $check$
BEGIN
  IF has_table_privilege('anon', 'public.job_documents', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_documents', 'INSERT')
     OR has_table_privilege('authenticated', 'public.job_issues', 'INSERT')
     OR has_table_privilege('authenticated', 'public.crew_day_order', 'UPDATE') THEN
    RAISE EXCEPTION 'direct table grant is still open';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'settings'
      AND policyname IN ('fp_settings_insert', 'fp_settings_update')
      AND (coalesce(qual, '') ILIKE '%job_docs%' OR coalesce(with_check, '') ILIKE '%job_docs%')
  ) THEN
    RAISE EXCEPTION 'crew can still write job_docs';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';

COMMIT;
