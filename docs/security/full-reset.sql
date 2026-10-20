-- Full reset of the PIN-auth objects. This is not the minute-scale rollback.
--
-- Use rollback.sql when you need the old website working again tonight.
-- Use this file only when you want the PIN tables and the keypad Auth users gone,
-- for example before running the migration from the top on a project that already
-- ran it once. App data (jobs, leads, crew, settings, photos) is not dropped.
-- Plaintext PIN rows in settings are not changed.
--
-- After this, a fresh run of the whole migration file can hash the settings PINs
-- again. To turn protections back on without hashing again, do not use this file.
-- Re-apply only the POLICIES section of the migration instead.
--
-- The private.fp_* functions are dropped with CASCADE because every fp_* row-security
-- policy (tables and the vehicle-docs storage policy) calls them. CASCADE drops those
-- policies too, while row security stays ON for the tables. So after this file nobody
-- but the service role can read app data until the whole migration is run again (or
-- rollback.sql is run to go back to the old open access). Run them back to back.

DO $$
BEGIN
  IF to_regclass('public.pin_accounts') IS NOT NULL THEN
    DELETE FROM auth.users
    WHERE id IN (
      SELECT auth_user_id FROM public.pin_accounts WHERE auth_user_id IS NOT NULL
    )
       OR coalesce(email, '') LIKE '%@pin.floorpro.invalid';
  ELSE
    DELETE FROM auth.users
    WHERE coalesce(email, '') LIKE '%@pin.floorpro.invalid';
  END IF;
END $$;

DROP TABLE IF EXISTS public.pin_attempts;
DROP TABLE IF EXISTS public.pin_accounts;

DROP FUNCTION IF EXISTS private.fp_crew_inactive(integer) CASCADE;
DROP FUNCTION IF EXISTS public.fp_revoke_sessions(uuid);
DROP FUNCTION IF EXISTS private.fp_role() CASCADE;
DROP FUNCTION IF EXISTS public.fp_pin_fail(uuid);
DROP FUNCTION IF EXISTS private.fp_member() CASCADE;
