-- Owners can read every private thread.
--
-- TEST PROJECT ONLY (nndjnywtkgxwvxajwztg). Do not run this on live
-- (cngbsmmdfxmerlqnkate). Do not re-run 20261031120000_direct_messages.sql.
-- This file only replaces the direct-message read rule and adds two
-- functions. It does not change job_messages, crew pay, phone, or
-- materials_private.
--
-- Opening someone else's thread does not write a read cursor, so it does
-- not mark that thread read for either person in it.
--
-- Rollback for this file only: supabase/rollback/20261031150000_owner_read_direct_messages.sql
-- Full undo of private messages: supabase/rollback/20261031120000_direct_messages.sql

BEGIN;

DROP POLICY IF EXISTS fp_direct_messages_select ON public.direct_messages;

-- Owner may read every live row. Everyone else still sees only rows where
-- they are the sender or the recipient. Office is not an owner.
CREATE POLICY fp_direct_messages_select ON public.direct_messages
  FOR SELECT TO authenticated
  USING (
    deleted_at IS NULL
    AND (
      (SELECT private.fp_role()) = 'owner'
      OR (
        (SELECT private.fp_dm_account_id()) IS NOT NULL
        AND (
          sender_account_id = (SELECT private.fp_dm_account_id())
          OR recipient_account_id = (SELECT private.fp_dm_account_id())
        )
      )
    )
  );

-- Every private thread, for the owner only. Names of the two people, nothing else.
CREATE OR REPLACE FUNCTION public.fp_list_all_dm_threads()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid;
  out jsonb;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_a', s.account_a,
           'label_a', s.label_a,
           'account_b', s.account_b,
           'label_b', s.label_b,
           'mine', s.mine,
           'peer_id', s.peer_id,
           'last_at', s.last_at
         ) ORDER BY s.last_at DESC), '[]'::jsonb)
    INTO out
  FROM (
    SELECT pair.account_a,
           left(coalesce(pa.label, 'Former login'), 120) AS label_a,
           pair.account_b,
           left(coalesce(pb.label, 'Former login'), 120) AS label_b,
           (pair.account_a = me OR pair.account_b = me) AS mine,
           CASE
             WHEN pair.account_a = me THEN pair.account_b
             WHEN pair.account_b = me THEN pair.account_a
             ELSE NULL
           END AS peer_id,
           pair.last_at
    FROM (
      SELECT least(m.sender_account_id, m.recipient_account_id) AS account_a,
             greatest(m.sender_account_id, m.recipient_account_id) AS account_b,
             max(m.created_at) AS last_at
      FROM public.direct_messages AS m
      WHERE m.deleted_at IS NULL
      GROUP BY 1, 2
    ) AS pair
    LEFT JOIN public.pin_accounts AS pa ON pa.id = pair.account_a
    LEFT JOIN public.pin_accounts AS pb ON pb.id = pair.account_b
  ) AS s;

  RETURN out;
END;
$$;

-- One thread. The owner may pass any two logins. Anyone else must be one of
-- those two. This function does not write a read cursor.
CREATE OR REPLACE FUNCTION public.fp_list_dm_between(account_a uuid, account_b uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid;
  role text;
  left_id uuid;
  right_id uuid;
  left_label text;
  right_label text;
  watch_only boolean;
  msg jsonb;
  messages jsonb := '[]'::jsonb;
  rec record;
  last_read timestamptz;
  read_ab timestamptz;
  read_ba timestamptz;
  other uuid;
BEGIN
  role := private.fp_role();
  IF role IS NULL OR account_a IS NULL OR account_b IS NULL OR account_a = account_b THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF role IS DISTINCT FROM 'owner' AND me IS DISTINCT FROM account_a AND me IS DISTINCT FROM account_b THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.pin_accounts AS p WHERE p.id = account_a AND p.kind IN ('owner', 'office', 'crew'))
     OR NOT EXISTS (SELECT 1 FROM public.pin_accounts AS p WHERE p.id = account_b AND p.kind IN ('owner', 'office', 'crew')) THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  IF account_a < account_b THEN
    left_id := account_a;
    right_id := account_b;
  ELSE
    left_id := account_b;
    right_id := account_a;
  END IF;

  SELECT left(coalesce(p.label, 'Former login'), 120) INTO left_label
  FROM public.pin_accounts AS p WHERE p.id = left_id;
  SELECT left(coalesce(p.label, 'Former login'), 120) INTO right_label
  FROM public.pin_accounts AS p WHERE p.id = right_id;

  watch_only := role = 'owner' AND me IS DISTINCT FROM left_id AND me IS DISTINCT FROM right_id;
  other := CASE WHEN me = left_id THEN right_id WHEN me = right_id THEN left_id ELSE NULL END;

  IF other IS NOT NULL THEN
    SELECT r.last_read_at INTO last_read
    FROM public.direct_message_reads AS r
    WHERE r.account_id = me AND r.peer_account_id = other;
  END IF;

  SELECT r.last_read_at INTO read_ab
  FROM public.direct_message_reads AS r
  WHERE r.account_id = left_id AND r.peer_account_id = right_id;
  SELECT r.last_read_at INTO read_ba
  FROM public.direct_message_reads AS r
  WHERE r.account_id = right_id AND r.peer_account_id = left_id;

  FOR rec IN
    SELECT s.id, s.body, s.created_at, s.author_label, s.author_kind, s.sender_account_id, s.recipient_account_id
    FROM (
      SELECT m.id, m.body, m.created_at, m.author_label, m.author_kind, m.sender_account_id, m.recipient_account_id
      FROM public.direct_messages AS m
      WHERE m.deleted_at IS NULL
        AND (
          (m.sender_account_id = left_id AND m.recipient_account_id = right_id)
          OR (m.sender_account_id = right_id AND m.recipient_account_id = left_id)
        )
      ORDER BY m.created_at DESC
      LIMIT 300
    ) AS s
    ORDER BY s.created_at ASC
  LOOP
    msg := jsonb_build_object(
      'id', rec.id,
      'body', rec.body,
      'created_at', rec.created_at,
      'author_label', rec.author_label,
      'author_kind', rec.author_kind,
      'author_account_id', rec.sender_account_id,
      'mentions', '[]'::jsonb,
      'seen_by', CASE
        WHEN rec.sender_account_id = left_id AND read_ba IS NOT NULL AND read_ba >= rec.created_at
          THEN jsonb_build_array(right_label)
        WHEN rec.sender_account_id = right_id AND read_ab IS NOT NULL AND read_ab >= rec.created_at
          THEN jsonb_build_array(left_label)
        ELSE '[]'::jsonb
      END,
      'seen_count', CASE
        WHEN rec.sender_account_id = left_id AND read_ba IS NOT NULL AND read_ba >= rec.created_at THEN 1
        WHEN rec.sender_account_id = right_id AND read_ab IS NOT NULL AND read_ab >= rec.created_at THEN 1
        ELSE 0
      END
    );
    messages := messages || jsonb_build_array(msg);
  END LOOP;

  RETURN jsonb_build_object(
    'account_a', left_id,
    'account_b', right_id,
    'label_a', left_label,
    'label_b', right_label,
    'peer_label', left_label || ' · ' || right_label,
    'private', true,
    'watch_only', watch_only,
    'me', me,
    'last_read_at', last_read,
    'can_post', false,
    'can_hide', false,
    'manual_read', true,
    'mention_choices', '[]'::jsonb,
    'messages', messages
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fp_list_all_dm_threads() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_list_dm_between(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_list_all_dm_threads() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_list_dm_between(uuid, uuid) TO authenticated;

DO $check$
DECLARE
  dm_qual text;
  job_qual text;
BEGIN
  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO dm_qual
  FROM pg_policy AS pol
  JOIN pg_class AS c ON c.oid = pol.polrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'direct_messages' AND pol.polname = 'fp_direct_messages_select';
  IF dm_qual IS NULL
     OR dm_qual NOT LIKE '%fp_role%'
     OR dm_qual NOT LIKE '%owner%'
     OR dm_qual NOT LIKE '%sender_account_id%'
     OR dm_qual LIKE '%fp_is_staff%' THEN
    RAISE EXCEPTION 'direct message read rule is not owner-or-participant';
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO job_qual
  FROM pg_policy AS pol
  JOIN pg_class AS c ON c.oid = pol.polrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'job_messages' AND pol.polname = 'fp_job_messages_select';
  IF job_qual IS NULL OR job_qual NOT LIKE '%job_id = ''team''%' OR job_qual LIKE '%direct%' THEN
    RAISE EXCEPTION 'job message read rule changed';
  END IF;

  IF has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT')
     OR has_column_privilege('anon', 'public.crew', 'hourly', 'SELECT')
     OR has_column_privilege('authenticated', 'public.crew', 'phone', 'SELECT')
     OR has_column_privilege('anon', 'public.crew', 'phone', 'SELECT') THEN
    RAISE EXCEPTION 'crew pay or phone is readable';
  END IF;

  IF has_function_privilege('anon', 'public.fp_list_all_dm_threads()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_list_dm_between(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute an owner thread function';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.fp_list_all_dm_threads()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_list_dm_between(uuid, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute an owner thread function';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';

COMMIT;
