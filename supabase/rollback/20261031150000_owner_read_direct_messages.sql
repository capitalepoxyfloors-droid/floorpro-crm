-- Undoes owner-wide reading of private threads.
-- Puts the direct-message read rule back to sender and recipient only.
-- Does not delete transcripts, job messages, crew pay, or phone columns.
-- Do not run this on live (cngbsmmdfxmerlqnkate) unless that change was applied there.

BEGIN;

DROP FUNCTION IF EXISTS public.fp_list_dm_between(uuid, uuid);
DROP FUNCTION IF EXISTS public.fp_list_all_dm_threads();

DROP POLICY IF EXISTS fp_direct_messages_select ON public.direct_messages;

CREATE POLICY fp_direct_messages_select ON public.direct_messages
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (SELECT private.fp_dm_account_id()) IS NOT NULL
    AND (
      sender_account_id = (SELECT private.fp_dm_account_id())
      OR recipient_account_id = (SELECT private.fp_dm_account_id())
    )
  );

NOTIFY pgrst, 'reload schema';

COMMIT;
