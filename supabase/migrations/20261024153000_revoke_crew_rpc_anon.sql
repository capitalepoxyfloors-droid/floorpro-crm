-- Lock the four crew job and PTO functions to signed-in users.
--
-- Run this on a project that already applied
-- supabase/migrations/20261024140000_role_split_rls.sql. A fresh apply of that
-- file already includes these statements. This file is the piece to run when
-- that version is already recorded and will not run again.
--
-- Creating a function in public on Supabase grants EXECUTE to anon as well as
-- to PUBLIC. Revoking from PUBLIC does not remove the anon grant, so the
-- advisor still lists the functions as callable with the anon key. Each
-- function already refuses a caller who is not crew. This removes the grant.
--
-- Safe to run more than once. It does not change rows, policies, or columns.

BEGIN;

REVOKE ALL ON FUNCTION public.fp_crew_read_job_records() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_write_job_records(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_read_pto_requests() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_write_pto_requests(jsonb) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fp_crew_read_job_records() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_write_job_records(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_read_pto_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_write_pto_requests(jsonb) TO authenticated;

DO $check$
BEGIN
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
