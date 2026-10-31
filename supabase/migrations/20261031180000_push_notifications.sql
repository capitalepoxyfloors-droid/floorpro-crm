-- Phone notifications for messages.
--
-- TEST PROJECT ONLY (nndjnywtkgxwvxajwztg). Do not run this on live
-- (cngbsmmdfxmerlqnkate). The website hides the notification button when
-- fp_push_status is missing, and a message insert still succeeds when the
-- push hook is not configured, so the page can ship before live has this file.
--
-- This file does not change job_messages or direct_messages policies, and it
-- does not grant pay, phone, or PIN columns. A new table stores this login's
-- push subscriptions. Row security lets that login manage only its own rows.
--
-- The trigger posts only the table name and the new row id. It does nothing
-- until vault has push_webhook_url and push_webhook_secret. The private key
-- for Web Push stays in vault (vapid_private_key). The public key the browser
-- needs is private.push_config key vapid_public. None of those values belong
-- in this file.
--
-- Rollback: supabase/rollback/20261031180000_push_notifications.sql

BEGIN;

-- pg_net is what the trigger uses to call the push function. A database
-- without that extension (the local tests) still applies this file. Inserts
-- keep working; the trigger just does not call out.
DO $ext$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_net is not available here; message inserts still succeed';
END;
$ext$;

CREATE TABLE private.push_config (
  key text PRIMARY KEY,
  value text NOT NULL,
  CONSTRAINT push_config_key_len CHECK (char_length(key) BETWEEN 1 AND 80),
  CONSTRAINT push_config_value_len CHECK (char_length(value) BETWEEN 1 AND 400)
);

COMMENT ON TABLE private.push_config IS
  'Server settings the signed-in app may read through a function. The Web Push private key is not stored here.';

REVOKE ALL ON TABLE private.push_config FROM PUBLIC, anon, authenticated;

CREATE TABLE public.push_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.pin_accounts (id) ON DELETE CASCADE,
  endpoint text NOT NULL,
  p256dh text NOT NULL,
  auth_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT push_subscriptions_endpoint_len CHECK (char_length(endpoint) BETWEEN 20 AND 2000),
  CONSTRAINT push_subscriptions_endpoint_https CHECK (endpoint LIKE 'https://%'),
  CONSTRAINT push_subscriptions_p256dh_len CHECK (char_length(p256dh) BETWEEN 20 AND 200),
  CONSTRAINT push_subscriptions_auth_len CHECK (char_length(auth_key) BETWEEN 8 AND 200),
  CONSTRAINT push_subscriptions_endpoint_key UNIQUE (endpoint)
);

CREATE INDEX push_subscriptions_account
  ON public.push_subscriptions (account_id);

COMMENT ON TABLE public.push_subscriptions IS
  'Web Push subscriptions for one login. One browser endpoint belongs to one login. The row holds no message text, pay, or phone number.';

CREATE TABLE public.push_prefs (
  account_id uuid PRIMARY KEY REFERENCES public.pin_accounts (id) ON DELETE CASCADE,
  team_alerts boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.push_prefs IS
  'Per login. team_alerts is off unless that person turns it on. Job messages, mentions, and direct messages do not use this flag.';

ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_prefs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.push_subscriptions FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.push_prefs FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.push_subscriptions TO service_role;
GRANT ALL ON TABLE public.push_prefs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_subscriptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.push_prefs TO authenticated;

-- A login can read and change only the rows for its own pin account.
-- It cannot see another person's endpoint. Moving a shared phone to a new
-- login is fp_save_push_subscription, which proves this browser holds the
-- subscription and then drops the previous login's row for that endpoint.
CREATE POLICY fp_push_subscriptions_own ON public.push_subscriptions
  FOR ALL TO authenticated
  USING (account_id = (SELECT private.fp_dm_account_id()))
  WITH CHECK (account_id = (SELECT private.fp_dm_account_id()));

CREATE POLICY fp_push_prefs_own ON public.push_prefs
  FOR ALL TO authenticated
  USING (account_id = (SELECT private.fp_dm_account_id()))
  WITH CHECK (account_id = (SELECT private.fp_dm_account_id()));

-- First line of a message, with money amounts and phone numbers removed.
-- Used only as the lock-screen line. Not granted to the browser.
CREATE OR REPLACE FUNCTION private.fp_push_line(p_body text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $fn$
DECLARE
  line text;
BEGIN
  line := split_part(replace(coalesce(p_body, ''), chr(13), ''), chr(10), 1);
  line := regexp_replace(line, '\$\s?[0-9][0-9,]*(?:\.[0-9]{1,2})?', '', 'g');
  line := regexp_replace(line, '(?:\+?1[\s.-]?)?(?:\(?[0-9]{3}\)?[\s.-]?)[0-9]{3}[\s.-][0-9]{4}', '', 'g');
  line := regexp_replace(line, '[0-9]{3}[-.\s][0-9]{4}', '', 'g');
  line := regexp_replace(line, '[0-9]{9,}', '', 'g');
  line := btrim(regexp_replace(line, '\s+', ' ', 'g'));
  IF line = '' THEN
    line := 'New message';
  END IF;
  RETURN left(line, 140);
END;
$fn$;

REVOKE ALL ON FUNCTION private.fp_push_line(text) FROM PUBLIC, anon, authenticated;

-- True when this crew login's directory name is on the job. Does not read pay.
CREATE OR REPLACE FUNCTION private.fp_crew_account_on_job(p_account uuid, p_job jsonb)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  acct public.pin_accounts;
  person text;
BEGIN
  IF p_account IS NULL OR p_job IS NULL OR jsonb_typeof(p_job) <> 'object' THEN
    RETURN false;
  END IF;
  SELECT * INTO acct
  FROM public.pin_accounts AS p
  WHERE p.id = p_account AND p.kind = 'crew';
  IF NOT FOUND OR private.fp_crew_inactive(acct.crew_idx) THEN
    RETURN false;
  END IF;
  SELECT btrim(c.full_name) INTO person
  FROM public.crew AS c
  WHERE c.sort_order = acct.crew_idx
  ORDER BY c.created_at NULLS LAST
  LIMIT 1;
  IF person IS NULL OR person = '' THEN
    person := btrim(acct.label);
  END IF;
  RETURN private.fp_name_on_job(p_job, person);
END;
$fn$;

REVOKE ALL ON FUNCTION private.fp_crew_account_on_job(uuid, jsonb) FROM PUBLIC, anon, authenticated;

-- Unread team + job + direct messages for one login. Not the caller's JWT.
CREATE OR REPLACE FUNCTION private.fp_unread_count(p_account uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  acct public.pin_accounts;
  job_n integer := 0;
  dm_n integer := 0;
BEGIN
  SELECT * INTO acct FROM public.pin_accounts AS p WHERE p.id = p_account;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  SELECT count(*) INTO job_n
  FROM public.job_messages AS m
  LEFT JOIN public.job_message_reads AS r
    ON r.account_id = acct.id AND r.job_id = m.job_id
  WHERE m.deleted_at IS NULL
    AND m.author_account_id IS DISTINCT FROM acct.id
    AND m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz)
    AND (
      m.job_id = 'team'
      OR (
        acct.kind IN ('owner', 'office')
        AND private.fp_job_record(m.job_id) IS NOT NULL
      )
      OR (
        acct.kind = 'crew'
        AND private.fp_crew_account_on_job(acct.id, private.fp_job_record(m.job_id))
      )
    );

  SELECT count(*) INTO dm_n
  FROM public.direct_messages AS m
  LEFT JOIN public.direct_message_reads AS r
    ON r.account_id = acct.id AND r.peer_account_id = m.sender_account_id
  WHERE m.deleted_at IS NULL
    AND m.recipient_account_id = acct.id
    AND m.created_at > coalesce(r.last_read_at, '-infinity'::timestamptz);

  RETURN least(coalesce(job_n, 0) + coalesce(dm_n, 0), 99);
END;
$fn$;

REVOKE ALL ON FUNCTION private.fp_unread_count(uuid) FROM PUBLIC, anon, authenticated;

-- Who should get a push for one new row, and the lock-screen text.
-- Direct message: the recipient only.
-- Mention: the mentioned person.
-- Job thread: assigned crew, plus owner and office.
-- Company thread: nobody, unless that person turned team alerts on.
-- A mention on the company thread still notifies that person.
-- The sender is never included. Granted only to service_role below.
CREATE OR REPLACE FUNCTION private.fp_push_plan(p_table text, p_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  author uuid;
  author_label text;
  raw_body text;
  job_id text;
  peer uuid;
  open_kind text;
  job jsonb;
  out jsonb;
BEGIN
  IF p_id IS NULL OR p_table NOT IN ('direct_messages', 'job_messages') THEN
    RETURN '[]'::jsonb;
  END IF;

  IF p_table = 'direct_messages' THEN
    SELECT m.sender_account_id, m.recipient_account_id, m.author_label, m.body
      INTO author, peer, author_label, raw_body
    FROM public.direct_messages AS m
    WHERE m.id = p_id AND m.deleted_at IS NULL;
    IF NOT FOUND OR peer IS NULL OR peer = author THEN
      RETURN '[]'::jsonb;
    END IF;
    open_kind := 'dm';
    job_id := NULL;
    job := NULL;
  ELSE
    SELECT m.author_account_id, m.author_label, m.body, m.job_id
      INTO author, author_label, raw_body, job_id
    FROM public.job_messages AS m
    WHERE m.id = p_id AND m.deleted_at IS NULL;
    IF NOT FOUND THEN
      RETURN '[]'::jsonb;
    END IF;
    peer := NULL;
    IF job_id = 'team' THEN
      open_kind := 'team';
      job := NULL;
    ELSE
      open_kind := 'job';
      job := private.fp_job_record(job_id);
      IF job IS NULL THEN
        RETURN '[]'::jsonb;
      END IF;
    END IF;
  END IF;

  IF btrim(coalesce(author_label, '')) = '' THEN
    author_label := 'Someone';
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account_id', s.id,
           'title', left(btrim(author_label), 80),
           'body', private.fp_push_line(raw_body),
           'open', open_kind,
           'job', CASE WHEN open_kind = 'job' THEN job_id ELSE NULL END,
           'peer', CASE WHEN open_kind = 'dm' THEN author ELSE NULL END,
           'tag', 'm:' || p_id::text,
           'badge', private.fp_unread_count(s.id),
           'subscriptions', (
             SELECT coalesce(jsonb_agg(jsonb_build_object(
                      'id', sub.id,
                      'endpoint', sub.endpoint,
                      'p256dh', sub.p256dh,
                      'auth_key', sub.auth_key
                    )), '[]'::jsonb)
             FROM (
               SELECT id, endpoint, p256dh, auth_key
               FROM public.push_subscriptions
               WHERE account_id = s.id
               ORDER BY updated_at DESC
               LIMIT 8
             ) AS sub
           )
         )), '[]'::jsonb)
    INTO out
  FROM (
    SELECT id
    FROM (
      SELECT p.id
      FROM public.pin_accounts AS p
      WHERE p_table = 'direct_messages'
        AND p.id = peer
        AND p.kind IN ('owner', 'office', 'crew')
        AND (p.kind <> 'crew' OR NOT private.fp_crew_inactive(p.crew_idx))
        AND p.id IS DISTINCT FROM author
      UNION
      SELECT p.id
      FROM public.pin_accounts AS p
      WHERE p_table = 'job_messages'
        AND job_id IS DISTINCT FROM 'team'
        AND p.kind IN ('owner', 'office')
        AND p.id IS DISTINCT FROM author
      UNION
      SELECT p.id
      FROM public.pin_accounts AS p
      WHERE p_table = 'job_messages'
        AND job_id IS DISTINCT FROM 'team'
        AND p.kind = 'crew'
        AND NOT private.fp_crew_inactive(p.crew_idx)
        AND p.id IS DISTINCT FROM author
        AND private.fp_crew_account_on_job(p.id, job)
      UNION
      SELECT p.id
      FROM public.job_message_mentions AS mm
      JOIN public.pin_accounts AS p ON p.id = mm.account_id
      WHERE p_table = 'job_messages'
        AND mm.message_id = p_id
        AND p.id IS DISTINCT FROM author
        AND p.kind IN ('owner', 'office', 'crew')
        AND (p.kind <> 'crew' OR NOT private.fp_crew_inactive(p.crew_idx))
        AND (
          job_id = 'team'
          OR p.kind IN ('owner', 'office')
          OR private.fp_crew_account_on_job(p.id, job)
        )
      UNION
      SELECT p.id
      FROM public.push_prefs AS prefs
      JOIN public.pin_accounts AS p ON p.id = prefs.account_id
      WHERE p_table = 'job_messages'
        AND job_id = 'team'
        AND prefs.team_alerts
        AND p.id IS DISTINCT FROM author
        AND p.kind IN ('owner', 'office', 'crew')
        AND (p.kind <> 'crew' OR NOT private.fp_crew_inactive(p.crew_idx))
    ) AS ids
    LIMIT 100
  ) AS s;

  RETURN out;
END;
$fn$;

REVOKE ALL ON FUNCTION private.fp_push_plan(text, uuid) FROM PUBLIC, anon, authenticated;

-- service_role calls this. The browser cannot. It returns the same plan.
CREATE OR REPLACE FUNCTION public.fp_push_plan(p_table text, p_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
  SELECT private.fp_push_plan(p_table, p_id);
$fn$;

REVOKE ALL ON FUNCTION public.fp_push_plan(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fp_push_plan(text, uuid) TO service_role;

-- Web Push private key and the webhook secret. service_role only.
-- The browser function fp_push_status returns the public key, never these.
CREATE OR REPLACE FUNCTION public.fp_push_runtime_config()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  pub text;
  priv text;
  hook text;
BEGIN
  SELECT c.value INTO pub FROM private.push_config AS c WHERE c.key = 'vapid_public';
  BEGIN
    SELECT s.decrypted_secret INTO priv
    FROM vault.decrypted_secrets AS s
    WHERE s.name = 'vapid_private_key';
    SELECT s.decrypted_secret INTO hook
    FROM vault.decrypted_secrets AS s
    WHERE s.name = 'push_webhook_secret';
  EXCEPTION WHEN OTHERS THEN
    priv := NULL;
    hook := NULL;
  END;
  RETURN jsonb_build_object(
    'public_key', pub,
    'private_key', priv,
    'webhook_secret', hook
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fp_push_runtime_config() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fp_push_runtime_config() TO service_role;

CREATE OR REPLACE FUNCTION public.fp_push_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  me uuid;
  pub text;
  alerts boolean := false;
  endpoints jsonb;
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  SELECT c.value INTO pub FROM private.push_config AS c WHERE c.key = 'vapid_public';
  SELECT prefs.team_alerts INTO alerts
  FROM public.push_prefs AS prefs
  WHERE prefs.account_id = me;
  SELECT coalesce(jsonb_agg(s.endpoint ORDER BY s.updated_at DESC), '[]'::jsonb)
    INTO endpoints
  FROM (
    SELECT endpoint, updated_at
    FROM public.push_subscriptions
    WHERE account_id = me
    ORDER BY updated_at DESC
    LIMIT 20
  ) AS s;
  RETURN jsonb_build_object(
    'ready', coalesce(pub, '') <> '',
    'public_key', pub,
    'team_alerts', coalesce(alerts, false),
    'endpoints', endpoints
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.fp_push_status() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_push_status() TO authenticated;

CREATE OR REPLACE FUNCTION public.fp_save_push_subscription(endpoint text, p256dh text, auth_key text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  me uuid;
  ep text := btrim(coalesce(endpoint, ''));
  key_p text := btrim(coalesce(p256dh, ''));
  key_a text := btrim(coalesce(auth_key, ''));
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF ep !~ '^https://' OR char_length(ep) < 20 OR char_length(ep) > 2000
     OR char_length(key_p) < 20 OR char_length(key_p) > 200
     OR char_length(key_a) < 8 OR char_length(key_a) > 200 THEN
    RAISE EXCEPTION 'not allowed';
  END IF;

  DELETE FROM public.push_subscriptions AS s
  WHERE s.endpoint = ep AND s.account_id <> me;

  INSERT INTO public.push_subscriptions (account_id, endpoint, p256dh, auth_key, updated_at)
  VALUES (me, ep, key_p, key_a, clock_timestamp())
  ON CONFLICT ON CONSTRAINT push_subscriptions_endpoint_key
  DO UPDATE SET
    account_id = EXCLUDED.account_id,
    p256dh = EXCLUDED.p256dh,
    auth_key = EXCLUDED.auth_key,
    updated_at = EXCLUDED.updated_at;

  RETURN jsonb_build_object('ok', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fp_save_push_subscription(text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_save_push_subscription(text, text, text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fp_delete_push_subscription(endpoint text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  me uuid;
  ep text := btrim(coalesce(endpoint, ''));
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL OR ep = '' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  DELETE FROM public.push_subscriptions AS s
  WHERE s.endpoint = ep AND s.account_id = me;
  RETURN jsonb_build_object('ok', true);
END;
$fn$;

REVOKE ALL ON FUNCTION public.fp_delete_push_subscription(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_delete_push_subscription(text) TO authenticated;

CREATE OR REPLACE FUNCTION public.fp_set_team_push(enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  me uuid;
BEGIN
  IF private.fp_role() IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  me := private.fp_dm_account_id();
  IF me IS NULL THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  INSERT INTO public.push_prefs (account_id, team_alerts, updated_at)
  VALUES (me, coalesce(enabled, false), clock_timestamp())
  ON CONFLICT (account_id) DO UPDATE
    SET team_alerts = EXCLUDED.team_alerts,
        updated_at = EXCLUDED.updated_at;
  RETURN jsonb_build_object('ok', true, 'team_alerts', coalesce(enabled, false));
END;
$fn$;

REVOKE ALL ON FUNCTION public.fp_set_team_push(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_set_team_push(boolean) TO authenticated;

-- After insert, tell the push function. A failure here must not block the
-- message. The body of the message is not sent in this request.
CREATE OR REPLACE FUNCTION private.fp_push_enqueue()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  hook_url text;
  hook_secret text;
BEGIN
  BEGIN
    SELECT s.decrypted_secret INTO hook_url
    FROM vault.decrypted_secrets AS s
    WHERE s.name = 'push_webhook_url';
    SELECT s.decrypted_secret INTO hook_secret
    FROM vault.decrypted_secrets AS s
    WHERE s.name = 'push_webhook_secret';
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;
  IF coalesce(hook_url, '') = '' OR coalesce(hook_secret, '') = '' THEN
    RETURN NEW;
  END IF;
  IF hook_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/send-push$' THEN
    RETURN NEW;
  END IF;
  BEGIN
    PERFORM net.http_post(
      url := hook_url,
      body := jsonb_build_object('table', TG_TABLE_NAME, 'id', NEW.id),
      params := '{}'::jsonb,
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-push-secret', hook_secret
      ),
      timeout_milliseconds := 15000
    );
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;
  RETURN NEW;
END;
$fn$;

REVOKE ALL ON FUNCTION private.fp_push_enqueue() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER fp_job_messages_push
  AFTER INSERT ON public.job_messages
  FOR EACH ROW EXECUTE FUNCTION private.fp_push_enqueue();

CREATE TRIGGER fp_direct_messages_push
  AFTER INSERT ON public.direct_messages
  FOR EACH ROW EXECUTE FUNCTION private.fp_push_enqueue();

DO $check$
BEGIN
  IF has_function_privilege('anon', 'public.fp_push_runtime_config()', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fp_push_runtime_config()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_push_plan(text, uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.fp_push_plan(text, uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'push secrets would be exposed to the browser';
  END IF;
  IF NOT has_function_privilege('service_role', 'public.fp_push_plan(text, uuid)', 'EXECUTE')
     OR NOT has_function_privilege('service_role', 'public.fp_push_runtime_config()', 'EXECUTE') THEN
    RAISE EXCEPTION 'push sender cannot read its config';
  END IF;
  IF NOT has_function_privilege('authenticated', 'public.fp_push_status()', 'EXECUTE') THEN
    RAISE EXCEPTION 'signed-in users cannot turn on notifications';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class AS c
    JOIN pg_namespace AS n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = 'push_subscriptions' AND c.relrowsecurity
  ) THEN
    RAISE EXCEPTION 'push subscriptions are missing row security';
  END IF;
END;
$check$;

COMMIT;
