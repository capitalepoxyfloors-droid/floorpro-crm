-- DO NOT RUN until the forward file was applied on floorpro-crm-test and Will approves the undo.
-- This drops only the tables and functions created by
-- supabase/migrations/20261108013000_field_ops_review.sql.
-- If those tables already hold rows, dropping them removes those new rows.
-- It does not delete settings, job_docs, job_records, clocks, credits, storage
-- objects, or audit_log rows.
--
-- fp.project_ref is typed by the operator. It does not prove the connected project.
-- Confirm the runner shows nndjnywtkgxwvxajwztg before executing.
--
-- This undo does not put job_docs back on the crew write list. Restoring that
-- write would reopen the settings gap. Office still writes settings through
-- private.fp_is_staff(). Crew photo paths outside jobdocs/ stay writable.
-- It does not restore a bucket-wide FOR ALL policy, so leftover jobdocs-rev
-- and issue-photos objects are not handed back to every member.

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
DROP POLICY IF EXISTS "vehicle-docs member read except new prefixes" ON storage.objects;
DROP POLICY IF EXISTS "vehicle-docs staff write except new prefixes" ON storage.objects;
DROP POLICY IF EXISTS "vehicle-docs crew write except job docs" ON storage.objects;
DROP POLICY IF EXISTS "vehicle-docs crew update except job docs" ON storage.objects;
DROP POLICY IF EXISTS "vehicle-docs crew delete except job docs" ON storage.objects;

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
DROP FUNCTION IF EXISTS public.fp_document_create(text, text, uuid);
DROP FUNCTION IF EXISTS public.fp_documents_for_job(text);
DROP FUNCTION IF EXISTS public.fp_field_ops_ready();
DROP FUNCTION IF EXISTS private.fp_stop_order_write(integer, date, text[], bigint);
DROP FUNCTION IF EXISTS private.fp_stop_member(integer, date, text);
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
