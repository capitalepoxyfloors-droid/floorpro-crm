-- Removes job messages and the Team thread.
-- Does not change settings, job records, or audit_log rows already written.
-- Dropping the tables deletes the transcript. Take a backup first on live.
-- Do not run this on live unless a message migration there is being undone.

BEGIN;

DROP FUNCTION IF EXISTS public.fp_unread_job_messages();
DROP FUNCTION IF EXISTS public.fp_hide_job_message(uuid);
DROP FUNCTION IF EXISTS public.fp_mark_job_thread_read(text);
DROP FUNCTION IF EXISTS public.fp_post_job_message(text, text, jsonb);
DROP FUNCTION IF EXISTS public.fp_list_job_messages(text);

DROP FUNCTION IF EXISTS private.fp_mention_choices(text);
DROP FUNCTION IF EXISTS private.fp_message_audit(text, text, text, text);
DROP FUNCTION IF EXISTS private.fp_can_message(text);
DROP FUNCTION IF EXISTS private.fp_job_record(text);
DROP FUNCTION IF EXISTS private.fp_message_actor();
DROP FUNCTION IF EXISTS private.fp_my_job_ids();
DROP FUNCTION IF EXISTS private.fp_name_on_job(jsonb, text);

DROP TABLE IF EXISTS public.job_message_mentions;
DROP TABLE IF EXISTS public.job_message_reads;
DROP TABLE IF EXISTS public.job_messages;

DROP FUNCTION IF EXISTS private.fp_job_messages_guard();

COMMIT;
