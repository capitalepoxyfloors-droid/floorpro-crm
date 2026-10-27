-- Removes public.fp_patch_job_records. Does not change settings rows.
-- The website keeps saving through its re-read-and-patch fallback when this
-- function is gone.

BEGIN;

REVOKE ALL ON FUNCTION public.fp_patch_job_records(jsonb) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.fp_patch_job_records(jsonb);
DROP FUNCTION IF EXISTS private.fp_json_same(jsonb, jsonb);

COMMIT;
