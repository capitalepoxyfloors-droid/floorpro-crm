-- DO NOT RUN until the forward file was applied on floorpro-crm-test and Will approves the undo.
-- This drops only the tables and functions created by
-- supabase/migrations/20261108013000_field_ops_review.sql.
-- If those tables already hold rows, dropping them removes those new rows.
-- It does not delete settings, job_docs, job_records, clocks, credits, storage
-- objects, or audit_log rows.
--
-- Same project guard as the forward file. Set it in this session first:
--   SELECT set_config('fp.project_ref', 'nndjnywtkgxwvxajwztg', false);

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

DROP POLICY IF EXISTS "issue-photos crew insert own" ON storage.objects;
DROP POLICY IF EXISTS "issue-photos staff select" ON storage.objects;
DROP POLICY IF EXISTS "jobdocs-rev crew current select" ON storage.objects;
DROP POLICY IF EXISTS "jobdocs-rev staff select" ON storage.objects;
DROP POLICY IF EXISTS "jobdocs-rev staff insert" ON storage.objects;
DROP POLICY IF EXISTS "vehicle-docs member except field revisions" ON storage.objects;

CREATE POLICY "vehicle-docs authenticated all"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (bucket_id = 'vehicle-docs' AND (SELECT private.fp_member()))
  WITH CHECK (bucket_id = 'vehicle-docs' AND (SELECT private.fp_member()));

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

DROP FUNCTION IF EXISTS public.fp_stop_order_reset(integer, date, bigint);
DROP FUNCTION IF EXISTS public.fp_stop_order_set(integer, date, text[], bigint);
DROP FUNCTION IF EXISTS public.fp_stop_order_read(integer, date);
DROP FUNCTION IF EXISTS public.fp_issue_update(uuid, text, text, date);
DROP FUNCTION IF EXISTS public.fp_issues_open_unassigned();
DROP FUNCTION IF EXISTS public.fp_issue_create(text, date, text, text, uuid, text);
DROP FUNCTION IF EXISTS public.fp_document_access_history(uuid);
DROP FUNCTION IF EXISTS public.fp_document_open(uuid);
DROP FUNCTION IF EXISTS public.fp_document_history(uuid);
DROP FUNCTION IF EXISTS public.fp_document_promote(uuid, uuid, uuid);
DROP FUNCTION IF EXISTS public.fp_document_stage_revision(uuid, uuid, text, bigint);
DROP FUNCTION IF EXISTS public.fp_document_create(text, text);
DROP FUNCTION IF EXISTS public.fp_documents_for_job(text);
DROP FUNCTION IF EXISTS public.fp_field_ops_ready();
DROP FUNCTION IF EXISTS private.fp_stop_order_write(integer, date, text[], bigint);
DROP FUNCTION IF EXISTS private.fp_self_crew_idx();
DROP FUNCTION IF EXISTS private.fp_actor_id();
DROP FUNCTION IF EXISTS private.fp_revision_path_is_current(text);
DROP FUNCTION IF EXISTS private.fp_crew_sees_job(text);
DROP FUNCTION IF EXISTS private.fp_job_record(text);
DROP FUNCTION IF EXISTS private.fp_settings_json(text);
DROP FUNCTION IF EXISTS private.fp_actor();

DROP TABLE IF EXISTS public.crew_day_order;
DROP TABLE IF EXISTS public.job_issues;
DROP TABLE IF EXISTS public.job_document_access;
DROP TABLE IF EXISTS public.job_document_revisions;
DROP TABLE IF EXISTS public.job_documents;

NOTIFY pgrst, 'reload schema';

COMMIT;
