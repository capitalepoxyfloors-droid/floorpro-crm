-- CrewBoard / FloorPro: turn on row security, hash sign-in PINs, and make the
-- photo bucket private.
--
-- Apply on floorpro-crm-test first. Do not run this on the live project until
-- docs/security/CUTOVER.md says so.
--
-- This file does not delete the plaintext PIN rows in public.settings. Row
-- security hides them from the anon and authenticated keys so the previous app
-- can be restored quickly. A later, optional wipe is in
-- docs/security/wipe-plaintext-pins.sql.
--
-- Refuses to run unless settings.admin_pin is exactly 4 digits. The live
-- database does not have that row today (the page used a built-in fallback).
-- Run docs/security/00-save-owner-pin.sql first.

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

-- Sign-in records. The browser is not granted access. Only the Edge Functions,
-- which use the service role, can read the hashes.
CREATE TABLE IF NOT EXISTS public.pin_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('owner', 'office', 'crew')),
  crew_idx integer,
  office_id text,
  label text NOT NULL,
  pin_hash text NOT NULL,
  auth_user_id uuid UNIQUE,
  email text UNIQUE,
  -- Bumped when a PIN changes so an old access token stops matching.
  session_nonce integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pin_accounts_kind_shape CHECK (
    (kind = 'owner' AND crew_idx IS NULL AND office_id IS NULL)
    OR (kind = 'crew' AND crew_idx IS NOT NULL AND office_id IS NULL)
    OR (kind = 'office' AND office_id IS NOT NULL AND crew_idx IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS pin_accounts_one_owner
  ON public.pin_accounts (kind) WHERE kind = 'owner';
CREATE UNIQUE INDEX IF NOT EXISTS pin_accounts_crew_idx
  ON public.pin_accounts (crew_idx) WHERE kind = 'crew';
CREATE UNIQUE INDEX IF NOT EXISTS pin_accounts_office_id
  ON public.pin_accounts (office_id) WHERE kind = 'office';

CREATE TABLE IF NOT EXISTS public.pin_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ip text NOT NULL,
  ok boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pin_attempts_created_at ON public.pin_attempts (created_at);

ALTER TABLE public.pin_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pin_attempts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.pin_accounts FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.pin_attempts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.pin_accounts TO service_role;
GRANT ALL ON TABLE public.pin_attempts TO service_role;

DO $$
DECLARE
  seq regclass;
BEGIN
  SELECT pg_get_serial_sequence('public.pin_attempts', 'id')::regclass INTO seq;
  IF seq IS NOT NULL THEN
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', seq);
  END IF;
END $$;

-- Hash the PINs that are already in settings. Plaintext stays in settings for
-- a fast rollback, but the policies below stop every client key from reading it.
DO $$
DECLARE
  v_pin text;
  v_crew jsonb;
  v_office jsonb;
  v_item jsonb;
  v_key text;
  v_val text;
BEGIN
  IF EXISTS (SELECT 1 FROM public.pin_accounts WHERE kind = 'owner') THEN
    RAISE EXCEPTION 'pin_accounts already has an owner. Refusing to hash PINs again.';
  END IF;

  SELECT btrim(value) INTO v_pin FROM public.settings WHERE key = 'admin_pin';
  IF v_pin IS NULL OR v_pin !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'No usable admin_pin in settings. It must be exactly 4 digits (the keypad submits at 4). Run docs/security/00-save-owner-pin.sql first so the owner is not locked out.';
  END IF;

  INSERT INTO public.pin_accounts (kind, label, pin_hash)
  VALUES ('owner', 'Will Bradford', extensions.crypt(v_pin, extensions.gen_salt('bf', 8)));

  SELECT CASE WHEN value IS NULL OR btrim(value) = '' THEN NULL ELSE value::jsonb END
    INTO v_crew
  FROM public.settings WHERE key = 'crew_pins';

  IF v_crew IS NOT NULL THEN
    IF jsonb_typeof(v_crew) <> 'object' THEN
      RAISE EXCEPTION 'settings.crew_pins is not a JSON object.';
    END IF;
    FOR v_key, v_val IN SELECT * FROM jsonb_each_text(v_crew)
    LOOP
      IF v_val IS NULL OR btrim(v_val) = '' THEN
        CONTINUE;
      END IF;
      IF v_key !~ '^[0-9]+$' OR btrim(v_val) !~ '^[0-9]{4}$' THEN
        RAISE EXCEPTION 'crew_pins has an entry this migration will not guess at (index %). PINs must be exactly 4 digits.', v_key;
      END IF;
      INSERT INTO public.pin_accounts (kind, crew_idx, label, pin_hash)
      VALUES (
        'crew',
        v_key::int,
        COALESCE(
          (SELECT full_name FROM public.crew WHERE sort_order = v_key::int ORDER BY created_at NULLS LAST LIMIT 1),
          'Crew ' || (v_key::int + 1)
        ),
        extensions.crypt(btrim(v_val), extensions.gen_salt('bf', 8))
      );
    END LOOP;
  END IF;

  SELECT CASE WHEN value IS NULL OR btrim(value) = '' THEN NULL ELSE value::jsonb END
    INTO v_office
  FROM public.settings WHERE key = 'office_users';

  IF v_office IS NOT NULL THEN
    IF jsonb_typeof(v_office) <> 'array' THEN
      RAISE EXCEPTION 'settings.office_users is not a JSON array.';
    END IF;
    FOR v_item IN SELECT value FROM jsonb_array_elements(v_office)
    LOOP
      v_val := btrim(COALESCE(v_item->>'pin', ''));
      IF v_val = '' THEN
        CONTINUE;
      END IF;
      IF v_val !~ '^[0-9]{4}$' THEN
        RAISE EXCEPTION 'An office PIN is not exactly 4 digits. Fix office_users before migrating.';
      END IF;
      IF COALESCE(v_item->>'id', '') = '' OR COALESCE(v_item->>'name', '') = '' THEN
        RAISE EXCEPTION 'An office user is missing an id or a name.';
      END IF;
      INSERT INTO public.pin_accounts (kind, office_id, label, pin_hash)
      VALUES (
        'office',
        v_item->>'id',
        v_item->>'name',
        extensions.crypt(v_val, extensions.gen_salt('bf', 8))
      );
    END LOOP;
  END IF;
END $$;

-- POLICIES ONLY BELOW THIS LINE.
-- Safe to run again after a rollback. It does not hash PINs a second time.
-- Replace the wide-open vehicle policies (they applied to everyone, including anon).
DROP POLICY IF EXISTS anon_all_vehicles ON public.vehicles;
DROP POLICY IF EXISTS anon_all_vehicle_maintenance ON public.vehicle_maintenance;
DROP POLICY IF EXISTS fp_auth_all ON public.vehicles;
DROP POLICY IF EXISTS fp_auth_all ON public.vehicle_maintenance;

-- A random Auth signup is "authenticated" but has no fp_role. Users cannot write
-- app_metadata themselves. private.fp_member() also requires the token's user id
-- to still be linked to a pin_accounts row, with the same nonce the login issued.
-- Turn off public signups as well (see docs/security/CUTOVER.md). That is a
-- dashboard setting, not something this file can force.
CREATE SCHEMA IF NOT EXISTS private;

CREATE OR REPLACE FUNCTION private.fp_crew_inactive(idx integer)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  js jsonb;
BEGIN
  SELECT value INTO raw FROM public.settings WHERE key = 'crew_inactive';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN false;
  END IF;
  BEGIN
    js := raw::jsonb;
  EXCEPTION WHEN others THEN
    RETURN false;
  END;
  IF jsonb_typeof(js) <> 'object' THEN
    RETURN false;
  END IF;
  RETURN js ? idx::text;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_member()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pin_accounts AS p
    WHERE p.auth_user_id = auth.uid()
      AND p.kind IN ('owner', 'office', 'crew')
      AND p.kind = COALESCE(auth.jwt() -> 'app_metadata' ->> 'fp_role', '')
      AND (auth.jwt() -> 'app_metadata' -> 'fp_nonce') = to_jsonb(p.session_nonce)
      AND (
        p.kind <> 'crew'
        OR NOT private.fp_crew_inactive(p.crew_idx)
      )
  );
$$;

REVOKE ALL ON FUNCTION private.fp_crew_inactive(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION private.fp_member() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.fp_crew_inactive(integer) TO authenticated;
GRANT EXECUTE ON FUNCTION private.fp_member() TO authenticated;
REVOKE ALL ON SCHEMA private FROM PUBLIC;
GRANT USAGE ON SCHEMA private TO authenticated;

-- Changing a PIN has to delete that user's Auth sessions. There is no
-- admin logout route: POST /auth/v1/admin/users/{id}/logout returns 404.
-- Bumping app_metadata.fp_nonce is not enough on its own. A leftover refresh
-- token is exchanged for a new access token that already contains the new nonce.
-- auth.refresh_tokens.user_id is varchar, not uuid. Deleting auth.sessions
-- cascades refresh tokens that point at a session, and MFA claims. The
-- explicit refresh_tokens delete also removes rows whose session_id is null.
-- This function stays owned by postgres (the SQL editor role). That role
-- bypasses row security, which auth.sessions has enabled with no policies.
-- Do not change the owner. anon and authenticated cannot execute it.
CREATE OR REPLACE FUNCTION public.fp_revoke_sessions(target_user uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF target_user IS NULL THEN
    RAISE EXCEPTION 'missing user';
  END IF;
  DELETE FROM auth.refresh_tokens WHERE user_id = target_user::text;
  DELETE FROM auth.sessions WHERE user_id = target_user;
END;
$$;

REVOKE ALL ON FUNCTION public.fp_revoke_sessions(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.fp_revoke_sessions(uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fp_revoke_sessions(uuid) TO service_role;

-- Authenticated app users can keep doing what the app does today.
-- anon has no policy. A signed-in user with no app-issued fp_role has none either.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leads', 'jobs', 'materials', 'crew', 'pto_blocks', 'scheduled_slots',
    'vehicles', 'vehicle_maintenance'
  ]
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS fp_auth_all ON public.%I', t);
    EXECUTE format(
      'CREATE POLICY fp_auth_all ON public.%I FOR ALL TO authenticated USING (private.fp_member()) WITH CHECK (private.fp_member())',
      t
    );
  END LOOP;
END $$;

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fp_audit_select ON public.audit_log;
DROP POLICY IF EXISTS fp_audit_insert ON public.audit_log;
-- Crew still writes audit rows (the insert asks the row back, which needs SELECT).
-- The Audit Log page stays owner/office in the app. A crew token can also read it
-- through the API; hiding it here would make crew audit inserts fail.
CREATE POLICY fp_audit_select ON public.audit_log
  FOR SELECT TO authenticated
  USING (private.fp_member());
CREATE POLICY fp_audit_insert ON public.audit_log
  FOR INSERT TO authenticated
  WITH CHECK (private.fp_member());

ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS fp_settings_select ON public.settings;
DROP POLICY IF EXISTS fp_settings_insert ON public.settings;
DROP POLICY IF EXISTS fp_settings_update ON public.settings;
DROP POLICY IF EXISTS fp_settings_delete ON public.settings;

-- PIN rows stay in the table for rollback, but no client role can see or change them.
-- crew_inactive can be read by the app (so inactive people drop off the schedule)
-- but only an owner or office token can write it. Crew cannot un-deactivate themselves.
CREATE POLICY fp_settings_select ON public.settings
  FOR SELECT TO authenticated
  USING (
    private.fp_member()
    AND key <> 'admin_pin' AND key <> 'crew_pins' AND key <> 'office_users'
  );

CREATE POLICY fp_settings_insert ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (
    private.fp_member()
    AND key <> 'admin_pin' AND key <> 'crew_pins' AND key <> 'office_users'
    AND (
      key <> 'crew_inactive'
      OR ((select auth.jwt()) -> 'app_metadata' ->> 'fp_role') IN ('owner', 'office')
    )
  );

CREATE POLICY fp_settings_update ON public.settings
  FOR UPDATE TO authenticated
  USING (
    private.fp_member()
    AND key <> 'admin_pin' AND key <> 'crew_pins' AND key <> 'office_users'
    AND (
      key <> 'crew_inactive'
      OR ((select auth.jwt()) -> 'app_metadata' ->> 'fp_role') IN ('owner', 'office')
    )
  )
  WITH CHECK (
    private.fp_member()
    AND key <> 'admin_pin' AND key <> 'crew_pins' AND key <> 'office_users'
    AND (
      key <> 'crew_inactive'
      OR ((select auth.jwt()) -> 'app_metadata' ->> 'fp_role') IN ('owner', 'office')
    )
  );

CREATE POLICY fp_settings_delete ON public.settings
  FOR DELETE TO authenticated
  USING (
    private.fp_member()
    AND key <> 'admin_pin' AND key <> 'crew_pins' AND key <> 'office_users'
    AND (
      key <> 'crew_inactive'
      OR ((select auth.jwt()) -> 'app_metadata' ->> 'fp_role') IN ('owner', 'office')
    )
  );

-- Photos. Existing JSON keeps the old public URL strings. The app derives the
-- path from that string and asks for a signed URL. No data rewrite.
INSERT INTO storage.buckets (id, name, public)
VALUES ('vehicle-docs', 'vehicle-docs', false)
ON CONFLICT (id) DO UPDATE SET public = false;

-- storage.objects is not owned by the migration role (error 42501). Row security
-- is already on for that table on Supabase. Do not ALTER it here.
DROP POLICY IF EXISTS "vehicle-docs anon all" ON storage.objects;
DROP POLICY IF EXISTS "vehicle-docs authenticated all" ON storage.objects;

CREATE POLICY "vehicle-docs authenticated all"
  ON storage.objects
  FOR ALL
  TO authenticated
  USING (bucket_id = 'vehicle-docs' AND private.fp_member())
  WITH CHECK (bucket_id = 'vehicle-docs' AND private.fp_member());

-- So pin-admin can call fp_revoke_sessions as soon as this section is applied.
NOTIFY pgrst, 'reload schema';
