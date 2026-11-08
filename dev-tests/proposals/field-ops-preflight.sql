-- Read-only preparation. Do not apply the migration from this file.
-- fp.project_ref is not used here. A typed flag cannot prove the connection.
--
-- Run this only in the SQL editor whose project id is nndjnywtkgxwvxajwztg
-- and whose host is db.nndjnywtkgxwvxajwztg.supabase.co.
-- Stop if the screen shows cngbsmmdfxmerlqnkate.
--
-- Backup before any later apply, from the test project dashboard, not production:
--   storage.buckets row for vehicle-docs (id, public)
--   pg_policies for public.settings and storage.objects
--   routine definitions of private.fp_member, private.fp_role, private.fp_is_staff
--   grants on public.settings
--   the settings.job_docs value, taken by the existing backup, not by a casual select
-- Do not select job rows, document bytes, pins, or audit rows for this check.
--
-- After a later apply, repeat the catalog queries. Expect:
--   fp_field_ops_ready, fp_document_promote, fp_issues_open_unassigned, fp_stop_order_set
--   index job_document_revisions_one_current
--   fp_settings_insert / fp_settings_update without job_docs in the crew list
--   no INSERT privilege for authenticated on job_documents, job_issues, crew_day_order
--   vehicle-docs.public still false
-- Restore, if Will approves the undo, is supabase/rollback/20261108013000_field_ops_review.sql
-- on this same test project. That file drops the new tables. It does not put crew
-- write of job_docs back, and it does not restore a bucket-wide member policy.

SELECT current_database() AS database_name;

SELECT id, public
FROM storage.buckets
WHERE id = 'vehicle-docs';

SELECT polname, polcmd::text
FROM pg_policy pol
JOIN pg_class c ON c.oid = pol.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'storage' AND c.relname = 'objects'
ORDER BY polname;
