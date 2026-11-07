-- Removes the credited-hours guard. Does not change settings.job_records.
-- Credits already stored, including any server-stamped actor and time, stay
-- as they were at rollback. Restore the job_records backup if that stamp
-- itself has to be undone.

BEGIN;

DROP TRIGGER IF EXISTS fp_audit_reject_forged_credit ON public.audit_log;
DROP FUNCTION IF EXISTS private.fp_audit_reject_forged_credit();
DROP TRIGGER IF EXISTS fp_settings_guard_credits ON public.settings;
DROP FUNCTION IF EXISTS private.fp_settings_guard_credits();
DROP FUNCTION IF EXISTS private.fp_guard_job_records(text, text);
DROP FUNCTION IF EXISTS private.fp_guard_day_logs(jsonb, jsonb, text, text, text);
DROP FUNCTION IF EXISTS private.fp_seal_credit_list(jsonb, jsonb, text, text);
DROP FUNCTION IF EXISTS private.fp_credit_signature(text);
DROP FUNCTION IF EXISTS private.fp_credit_canonical(jsonb);
DROP FUNCTION IF EXISTS private.fp_credit_body(jsonb);
DROP FUNCTION IF EXISTS private.fp_credit_tenths(jsonb);
DROP FUNCTION IF EXISTS private.fp_credit_identity(jsonb);
DROP FUNCTION IF EXISTS private.fp_credit_actor();

COMMIT;
