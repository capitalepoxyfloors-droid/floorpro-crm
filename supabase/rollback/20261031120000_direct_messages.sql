-- Removes private one-to-one messages.
-- Does not change job_messages, the company thread, settings, crew pay, or
-- audit_log rows already written.
-- Dropping the tables deletes the private transcripts. Take a backup first.
-- Do not run this on live (cngbsmmdfxmerlqnkate) unless a direct-message
-- migration there is being undone.

BEGIN;

DROP FUNCTION IF EXISTS public.fp_list_dm_between(uuid, uuid);
DROP FUNCTION IF EXISTS public.fp_list_all_dm_threads();
DROP FUNCTION IF EXISTS public.fp_hide_direct_message(uuid);
DROP FUNCTION IF EXISTS public.fp_mark_direct_thread_read(uuid);
DROP FUNCTION IF EXISTS public.fp_post_direct_message(uuid, text);
DROP FUNCTION IF EXISTS public.fp_list_direct_messages(uuid);
DROP FUNCTION IF EXISTS public.fp_list_dm_people();

DROP TABLE IF EXISTS public.direct_message_reads;
DROP TABLE IF EXISTS public.direct_messages;

DROP FUNCTION IF EXISTS private.fp_direct_messages_guard();
DROP FUNCTION IF EXISTS private.fp_dm_target(uuid, boolean);
DROP FUNCTION IF EXISTS private.fp_dm_account_id();

NOTIFY pgrst, 'reload schema';

COMMIT;
