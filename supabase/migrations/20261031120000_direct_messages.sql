-- Private one-to-one messages.
--
-- TEST PROJECT ONLY (nndjnywtkgxwvxajwztg). Do not run this on live
-- (cngbsmmdfxmerlqnkate). It is already applied on the test project.
-- Running it there again fails at CREATE TABLE; use the rollback first
-- if you need to reapply. The website hides the Direct list when these
-- functions are missing, so the page can ship before live has this file.
--
-- This file does not change job_messages, its policies, or any pay column
-- grant. A direct message is a new table. The browser is not granted the
-- table. Row security still limits a later SELECT grant to the sender and
-- the recipient. Owner and office are not given a back door.
--
-- Rollback: supabase/rollback/20261031120000_direct_messages.sql

BEGIN;

CREATE TABLE public.direct_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_account_id uuid NOT NULL,
  recipient_account_id uuid NOT NULL,
  author_label text NOT NULL,
  author_kind text NOT NULL,
  body text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  deleted_by uuid,
  CONSTRAINT direct_messages_not_self CHECK (sender_account_id <> recipient_account_id),
  CONSTRAINT direct_messages_body_len CHECK (char_length(body) BETWEEN 1 AND 2000),
  CONSTRAINT direct_messages_kind CHECK (author_kind IN ('owner', 'office', 'crew'))
);

CREATE INDEX direct_messages_sender_created
  ON public.direct_messages (sender_account_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX direct_messages_recipient_created
  ON public.direct_messages (recipient_account_id, created_at)
  WHERE deleted_at IS NULL;

COMMENT ON TABLE public.direct_messages IS
  'One private thread per pair of logins. Only the sender and recipient may read a row. Bodies are plain text. Pay, rates, and phone numbers are not stored here.';

CREATE TABLE public.direct_message_reads (
  account_id uuid NOT NULL,
  peer_account_id uuid NOT NULL,
  last_read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, peer_account_id),
  CONSTRAINT direct_message_reads_not_self CHECK (account_id <> peer_account_id)
);

COMMENT ON TABLE public.direct_message_reads IS
  'How far one person has read their thread with one other person. A row is visible only to that reader.';

ALTER TABLE public.direct_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.direct_message_reads ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.direct_messages FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.direct_message_reads FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.direct_messages TO service_role;
GRANT ALL ON TABLE public.direct_message_reads TO service_role;

-- The signed-in login's pin_accounts id, or NULL. Granted so a SELECT policy
-- can call it. It returns an id only, never a wage, phone, or PIN hash.
CREATE OR REPLACE FUNCTION private.fp_dm_account_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT p.id
  FROM public.pin_accounts AS p
  WHERE p.auth_user_id = auth.uid()
    AND private.fp_role() IN ('owner', 'office', 'crew')
    AND p.kind = private.fp_role();
$$;

REVOKE ALL ON FUNCTION private.fp_dm_account_id() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION private.fp_dm_account_id() TO authenticated;

-- No INSERT / UPDATE / DELETE policies. A later grant still cannot write, and
-- cannot read a thread the login is not part of. Staff are not exempt.
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

CREATE POLICY fp_direct_message_reads_select ON public.direct_message_reads
  FOR SELECT TO authenticated
  USING (
    account_id = (SELECT private.fp_dm_account_id())
  );

-- The other login, when this person may open that thread.
-- p_allow_inactive keeps a thread readable after a crew PIN is turned off,
-- but only when a message already exists. Posting stays closed.
CREATE OR REPLACE FUNCTION private.fp_dm_target(p_peer uuid, p_allow_inactive boolean)
RETURNS public.pin_accounts
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid;
  acct public.pin_accounts;
BEGIN
  me := private.fp_dm_account_id();
  IF me IS NULL OR p_peer IS NULL OR p_peer = me THEN
    RETURN NULL;
  END IF;
  SELECT * INTO acct
  FROM public.pin_accounts AS p
  WHERE p.id = p_peer
    AND p.kind IN ('owner', 'office', 'crew');
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF acct.kind = 'crew' AND private.fp_crew_inactive(acct.crew_idx) THEN
    IF NOT p_allow_inactive THEN
      RETURN NULL;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM public.direct_messages AS m
      WHERE m.deleted_at IS NULL
        AND (
          (m.sender_account_id = me AND m.recipient_account_id = p_peer)
          OR (m.sender_account_id = p_peer AND m.recipient_account_id = me)
        )
    ) THEN
      RETURN NULL;
    END IF;
  END IF;
  RETURN acct;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_dm_target(uuid, boolean) FROM PUBLIC, anon, authenticated;

-- Block body edits. The owner may hide a message once, and only a message
-- they are part of. Hard delete is refused for every role.
CREATE OR REPLACE FUNCTION private.fp_direct_messages_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  me uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.sender_account_id IS DISTINCT FROM OLD.sender_account_id
     OR NEW.recipient_account_id IS DISTINCT FROM OLD.recipient_account_id
     OR NEW.author_label IS DISTINCT FROM OLD.author_label
     OR NEW.author_kind IS DISTINCT FROM OLD.author_kind
     OR NEW.body IS DISTINCT FROM OLD.body
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
     OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by THEN
    me := private.fp_dm_account_id();
    IF private.fp_role() IS DISTINCT FROM 'owner'
       OR OLD.deleted_at IS NOT NULL
       OR me IS NULL
       OR (me IS DISTINCT FROM OLD.sender_account_id AND me IS DISTINCT FROM OLD.recipient_account_id) THEN
      RAISE EXCEPTION 'not allowed';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_direct_messages_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER fp_direct_messages_guard
  BEFORE UPDATE OR DELETE ON public.direct_messages
  FOR EACH ROW EXECUTE FUNCTION private.fp_direct_messages_guard();

-- People this login may open a private thread with. Labels and an unread
-- count only. No phone, wage, or PIN hash.
CREATE OR REPLACE FUNCTION public.fp_list_dm_people()
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
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_id', s.id,
           'label', s.label,
           'kind', s.kind,
           'unread', s.unread
         ) ORDER BY (s.unread > 0) DESC, s.kind_ord, s.label), '[]'::jsonb)
    INTO out
  FROM (
    SELECT p.id,
           left(p.label, 120) AS label,
           p.kind,
           CASE p.kind WHEN 'owner' THEN 0 WHEN 'office' THEN 1 ELSE 2 END AS kind_ord,
           (
             SELECT count(*)
             FROM public.direct_messages AS m
             WHERE m.deleted_at IS NULL
               AND m.sender_account_id = p.id
               AND m.recipient_account_id = me
               AND m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
           ) AS unread
    FROM public.pin_accounts AS p
    LEFT JOIN public.direct_message_reads AS r
      ON r.account_id = me AND r.peer_account_id = p.id
    WHERE p.id <> me
      AND p.kind IN ('owner', 'office', 'crew')
      AND (
        p.kind <> 'crew'
        OR NOT private.fp_crew_inactive(p.crew_idx)
        OR EXISTS (
          SELECT 1 FROM public.direct_messages AS m
          WHERE m.deleted_at IS NULL
            AND (
              (m.sender_account_id = me AND m.recipient_account_id = p.id)
              OR (m.sender_account_id = p.id AND m.recipient_account_id = me)
            )
        )
      )
  ) AS s;

  RETURN out;
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_list_direct_messages(peer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid;
  peer public.pin_accounts;
  msg jsonb;
  messages jsonb := '[]'::jsonb;
  rec record;
  last_read timestamptz;
  peer_read timestamptz;
  can_post boolean;
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  peer := private.fp_dm_target(peer_id, true);
  IF me IS NULL OR peer.id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  can_post := NOT (peer.kind = 'crew' AND private.fp_crew_inactive(peer.crew_idx));

  SELECT r.last_read_at INTO last_read
  FROM public.direct_message_reads AS r
  WHERE r.account_id = me AND r.peer_account_id = peer.id;

  SELECT r.last_read_at INTO peer_read
  FROM public.direct_message_reads AS r
  WHERE r.account_id = peer.id AND r.peer_account_id = me;

  FOR rec IN
    SELECT s.id, s.body, s.created_at, s.author_label, s.author_kind, s.sender_account_id
    FROM (
      SELECT m.id, m.body, m.created_at, m.author_label, m.author_kind, m.sender_account_id
      FROM public.direct_messages AS m
      WHERE m.deleted_at IS NULL
        AND (
          (m.sender_account_id = me AND m.recipient_account_id = peer.id)
          OR (m.sender_account_id = peer.id AND m.recipient_account_id = me)
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
        WHEN rec.sender_account_id = me AND peer_read IS NOT NULL AND peer_read >= rec.created_at
          THEN jsonb_build_array(left(peer.label, 120))
        ELSE '[]'::jsonb
      END,
      'seen_count', CASE
        WHEN rec.sender_account_id = me AND peer_read IS NOT NULL AND peer_read >= rec.created_at THEN 1
        ELSE 0
      END
    );
    messages := messages || jsonb_build_array(msg);
  END LOOP;

  RETURN jsonb_build_object(
    'peer_id', peer.id,
    'peer_label', left(peer.label, 120),
    'private', true,
    'me', me,
    'last_read_at', last_read,
    'can_post', can_post,
    'can_hide', private.fp_role() = 'owner',
    'manual_read', false,
    'mention_choices', '[]'::jsonb,
    'messages', messages
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_post_direct_message(peer_id uuid, body text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_body text := btrim(coalesce(body, ''));
  me_id uuid;
  me public.pin_accounts;
  peer public.pin_accounts;
  new_id uuid;
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me_id := private.fp_dm_account_id();
  IF me_id IS NULL OR v_body = '' OR char_length(v_body) > 2000 THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT * INTO me FROM public.pin_accounts AS p WHERE p.id = me_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  peer := private.fp_dm_target(peer_id, false);
  IF peer.id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  INSERT INTO public.direct_messages (sender_account_id, recipient_account_id, author_label, author_kind, body)
  VALUES (me.id, peer.id, left(me.label, 120), me.kind, v_body)
  RETURNING id INTO new_id;

  INSERT INTO public.direct_message_reads (account_id, peer_account_id, last_read_at)
  VALUES (me.id, peer.id, clock_timestamp())
  ON CONFLICT ON CONSTRAINT direct_message_reads_pkey
  DO UPDATE SET last_read_at = EXCLUDED.last_read_at;

  PERFORM private.fp_message_audit(me.label, 'dm_posted', left(peer.label, 120), 'private');

  RETURN jsonb_build_object('ok', true, 'id', new_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_mark_direct_thread_read(peer_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid;
  peer public.pin_accounts;
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  peer := private.fp_dm_target(peer_id, true);
  IF me IS NULL OR peer.id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  INSERT INTO public.direct_message_reads (account_id, peer_account_id, last_read_at)
  VALUES (me, peer.id, clock_timestamp())
  ON CONFLICT ON CONSTRAINT direct_message_reads_pkey
  DO UPDATE SET last_read_at = EXCLUDED.last_read_at;
  RETURN jsonb_build_object('ok', true, 'peer_id', peer.id);
END;
$$;

CREATE OR REPLACE FUNCTION public.fp_hide_direct_message(message_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  me uuid;
  rec public.direct_messages;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL OR message_id IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT * INTO rec FROM public.direct_messages WHERE id = message_id;
  IF NOT FOUND OR rec.deleted_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true);
  END IF;
  IF me IS DISTINCT FROM rec.sender_account_id AND me IS DISTINCT FROM rec.recipient_account_id THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  UPDATE public.direct_messages
     SET deleted_at = clock_timestamp(), deleted_by = me
   WHERE id = message_id;
  PERFORM private.fp_message_audit(
    (SELECT left(p.label, 120) FROM public.pin_accounts AS p WHERE p.id = me),
    'dm_hidden',
    rec.id::text,
    'private'
  );
  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fp_list_dm_people() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_list_direct_messages(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_post_direct_message(uuid, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_mark_direct_thread_read(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_hide_direct_message(uuid) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.fp_list_dm_people() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_list_direct_messages(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_post_direct_message(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_mark_direct_thread_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_hide_direct_message(uuid) TO authenticated;

DO $check$
DECLARE
  job_qual text;
  dm_qual text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'direct_messages' AND c.relrowsecurity
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'direct_message_reads' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'row security is off on a direct message table';
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO dm_qual
  FROM pg_policy AS pol
  JOIN pg_class AS c ON c.oid = pol.polrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'direct_messages' AND pol.polname = 'fp_direct_messages_select';
  IF dm_qual IS NULL
     OR dm_qual NOT LIKE '%sender_account_id%'
     OR dm_qual NOT LIKE '%recipient_account_id%'
     OR dm_qual LIKE '%fp_is_staff%' THEN
    RAISE EXCEPTION 'direct message read rule is not limited to the two people';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_policy AS pol
    JOIN pg_class AS c ON c.oid = pol.polrelid
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN ('direct_messages', 'direct_message_reads')
      AND pol.polcmd <> 'r'
  ) THEN
    RAISE EXCEPTION 'a direct message table has a write policy';
  END IF;

  SELECT pg_get_expr(pol.polqual, pol.polrelid) INTO job_qual
  FROM pg_policy AS pol
  JOIN pg_class AS c ON c.oid = pol.polrelid
  JOIN pg_namespace AS n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relname = 'job_messages' AND pol.polname = 'fp_job_messages_select';
  IF job_qual IS NULL
     OR job_qual NOT LIKE '%job_id = ''team''%'
     OR job_qual LIKE '%direct%' THEN
    RAISE EXCEPTION 'job message read rule changed';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
    WHERE n.nspname = 'private' AND p.proname = 'fp_message_audit'
  ) THEN
    RAISE EXCEPTION 'job messages must be installed first';
  END IF;

  IF has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT')
     OR has_column_privilege('anon', 'public.crew', 'hourly', 'SELECT')
     OR has_column_privilege('authenticated', 'public.crew', 'phone', 'SELECT')
     OR has_column_privilege('anon', 'public.crew', 'phone', 'SELECT') THEN
    RAISE EXCEPTION 'crew pay or phone is readable';
  END IF;

  IF has_function_privilege('anon', 'public.fp_list_dm_people()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_list_direct_messages(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_post_direct_message(uuid, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_mark_direct_thread_read(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_hide_direct_message(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon can execute a direct message function';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.fp_list_dm_people()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_list_direct_messages(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.fp_post_direct_message(uuid, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'authenticated cannot execute a direct message function';
  END IF;

  IF has_table_privilege('anon', 'public.direct_messages', 'SELECT')
     OR has_table_privilege('authenticated', 'public.direct_messages', 'SELECT')
     OR has_table_privilege('anon', 'public.direct_messages', 'INSERT')
     OR has_table_privilege('authenticated', 'public.direct_messages', 'INSERT')
     OR has_table_privilege('anon', 'public.direct_message_reads', 'SELECT')
     OR has_table_privilege('authenticated', 'public.direct_message_reads', 'SELECT') THEN
    RAISE EXCEPTION 'a client role can reach direct_messages directly';
  END IF;

  IF has_table_privilege('anon', 'public.job_messages', 'SELECT')
     OR has_table_privilege('authenticated', 'public.job_messages', 'SELECT') THEN
    RAISE EXCEPTION 'a client role can reach job_messages directly';
  END IF;
END
$check$;

NOTIFY pgrst, 'reload schema';

COMMIT;
