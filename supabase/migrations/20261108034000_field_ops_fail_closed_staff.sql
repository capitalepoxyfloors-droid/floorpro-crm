-- Correction applied after 20261108013000_field_ops_review.sql.
-- This file does not replace that history. It only tightens the new wrappers.
--
-- On floorpro-crm-test, with no pin session:
--   private.fp_member() is false
--   private.fp_role() is null
--   private.fp_is_staff() is null
--   NOT private.fp_is_staff() is null, so IF NOT staff does not raise
--   private.fp_is_staff() IS NOT TRUE is true, so the check raises
--
-- No tables, policies, or grants are changed.

CREATE OR REPLACE FUNCTION public.fp_document_access_history(p_document uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF private.fp_is_staff() IS NOT TRUE THEN
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

CREATE OR REPLACE FUNCTION public.fp_document_history(p_document uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF private.fp_is_staff() IS NOT TRUE THEN
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

CREATE OR REPLACE FUNCTION public.fp_documents_for_job(p_job text)
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
  IF private.fp_job_record(p_job) IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF private.fp_is_staff() IS NOT TRUE AND private.fp_crew_sees_job(p_job) IS NOT TRUE THEN
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
  IF private.fp_is_staff() IS NOT TRUE THEN
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
  IF private.fp_is_staff() IS NOT TRUE THEN
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
  IF private.fp_is_staff() IS NOT TRUE THEN
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
  IF private.fp_is_staff() IS NOT TRUE THEN
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

CREATE OR REPLACE FUNCTION public.fp_issues_open_unassigned()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF private.fp_is_staff() IS NOT TRUE THEN
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
  IF private.fp_is_staff() IS NOT TRUE AND private.fp_crew_sees_job(p_job) IS NOT TRUE THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF private.fp_is_staff() IS TRUE AND private.fp_job_record(p_job) IS NULL THEN
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
  IF private.fp_is_staff() IS NOT TRUE THEN
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
      IF private.fp_stop_member(p_idx, p_date, item) IS NOT TRUE THEN
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

REVOKE ALL ON FUNCTION private.fp_stop_order_write(integer, date, text[], bigint) FROM PUBLIC, anon, authenticated;
