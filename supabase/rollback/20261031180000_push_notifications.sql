-- Undo phone notifications. Does not drop messages, change their policies,
-- or grant pay columns back or forth.
--
-- TEST PROJECT ONLY (nndjnywtkgxwvxajwztg). Do not run this on live
-- (cngbsmmdfxmerlqnkate).
--
-- Vault rows for the push hook are removed when vault exists. The pg_net
-- extension is left in place.

BEGIN;

DROP TRIGGER IF EXISTS fp_job_messages_push ON public.job_messages;
DROP TRIGGER IF EXISTS fp_direct_messages_push ON public.direct_messages;

DROP FUNCTION IF EXISTS private.fp_push_enqueue();
DROP FUNCTION IF EXISTS public.fp_push_runtime_config();
DROP FUNCTION IF EXISTS public.fp_push_plan(text, uuid);
DROP FUNCTION IF EXISTS private.fp_push_plan(text, uuid);
DROP FUNCTION IF EXISTS private.fp_unread_count(uuid);
DROP FUNCTION IF EXISTS private.fp_crew_account_on_job(uuid, jsonb);
DROP FUNCTION IF EXISTS private.fp_push_line(text);
DROP FUNCTION IF EXISTS public.fp_set_team_push(boolean);
DROP FUNCTION IF EXISTS public.fp_delete_push_subscription(text);
DROP FUNCTION IF EXISTS public.fp_save_push_subscription(text, text, text);
DROP FUNCTION IF EXISTS public.fp_push_status();

DROP TABLE IF EXISTS public.push_subscriptions;
DROP TABLE IF EXISTS public.push_prefs;
DROP TABLE IF EXISTS private.push_config;

DO $vault$
BEGIN
  DELETE FROM vault.secrets
  WHERE name IN ('vapid_private_key', 'vapid_public_key', 'push_webhook_secret', 'push_webhook_url');
EXCEPTION WHEN OTHERS THEN
  NULL;
END;
$vault$;

COMMIT;
