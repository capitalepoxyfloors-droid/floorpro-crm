-- Removes the Wave-accept dedup trigger. Does not delete jobs, notices, or schedule cards.
-- A notice already stored in settings.wave_link_notices is left in place.

BEGIN;

DROP TRIGGER IF EXISTS fp_jobs_wave_dedup ON public.jobs;

REVOKE ALL ON FUNCTION private.fp_jobs_wave_dedup() FROM PUBLIC, anon, authenticated, service_role;
DROP FUNCTION IF EXISTS private.fp_jobs_wave_dedup();
DROP FUNCTION IF EXISTS private.fp_wave_put_notice(jsonb);
DROP FUNCTION IF EXISTS private.fp_wave_write_state(jsonb);
DROP FUNCTION IF EXISTS private.fp_wave_read_state();
DROP FUNCTION IF EXISTS private.fp_wave_job_records();
DROP FUNCTION IF EXISTS private.fp_wave_rewrite_note(text, text);
DROP FUNCTION IF EXISTS private.fp_customer_same(text, text);
DROP FUNCTION IF EXISTS private.fp_name_tokens(text);
DROP FUNCTION IF EXISTS private.fp_board_status_active(text);
DROP FUNCTION IF EXISTS private.fp_text_has_wave(text, text);
DROP FUNCTION IF EXISTS private.fp_wave_extract(text, text, text, text);

COMMIT;
