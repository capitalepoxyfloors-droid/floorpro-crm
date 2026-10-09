-- Fast rollback for the CrewBoard security change. Run in the Supabase SQL editor.
-- Then put the previous website back (revert the app commit and let GitHub Pages deploy).
--
-- This puts the database back to "the anon key can read and write everything" and
-- makes the photo bucket public again. The plaintext PIN rows in settings are still
-- there, so the old keypad works with the codes from cutover night.
--
-- Codes changed in the new Security page after cutover are NOT copied back.
-- Those people keep the previous code until you set it again in the old app.
--
-- This script does not drop public.pin_accounts, public.pin_attempts, the private
-- helper functions, public.fp_revoke_sessions, or the Auth users created by PIN
-- sign-in. Those leftovers do not affect the old website. Leave them.
--
-- To turn the new protections back on the same night, re-apply ONLY the section of
-- supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql that starts at
-- the line "-- POLICIES ONLY BELOW THIS LINE." Do not run the whole migration again.
-- The top of that file hashes PINs and stops if an owner row already exists.
--
-- docs/security/full-reset.sql removes the PIN tables and those Auth users. That is
-- not this rollback. Do not run it when you only need the old site back tonight.

ALTER TABLE public.leads DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.jobs DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.materials DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.crew DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.pto_blocks DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.scheduled_slots DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_log DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fp_auth_all ON public.leads;
DROP POLICY IF EXISTS fp_auth_all ON public.jobs;
DROP POLICY IF EXISTS fp_auth_all ON public.materials;
DROP POLICY IF EXISTS fp_auth_all ON public.crew;
DROP POLICY IF EXISTS fp_auth_all ON public.pto_blocks;
DROP POLICY IF EXISTS fp_auth_all ON public.scheduled_slots;
DROP POLICY IF EXISTS fp_auth_all ON public.vehicles;
DROP POLICY IF EXISTS fp_auth_all ON public.vehicle_maintenance;
DROP POLICY IF EXISTS fp_audit_select ON public.audit_log;
DROP POLICY IF EXISTS fp_audit_insert ON public.audit_log;
DROP POLICY IF EXISTS fp_settings_select ON public.settings;
DROP POLICY IF EXISTS fp_settings_insert ON public.settings;
DROP POLICY IF EXISTS fp_settings_update ON public.settings;
DROP POLICY IF EXISTS fp_settings_delete ON public.settings;

-- Vehicles already had row security, with a policy that allowed everyone.
ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vehicle_maintenance ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS anon_all_vehicles ON public.vehicles;
DROP POLICY IF EXISTS anon_all_vehicle_maintenance ON public.vehicle_maintenance;
CREATE POLICY anon_all_vehicles ON public.vehicles FOR ALL USING (true) WITH CHECK (true);
CREATE POLICY anon_all_vehicle_maintenance ON public.vehicle_maintenance FOR ALL USING (true) WITH CHECK (true);

UPDATE storage.buckets SET public = true WHERE id = 'vehicle-docs';
DROP POLICY IF EXISTS "vehicle-docs authenticated all" ON storage.objects;
DROP POLICY IF EXISTS "vehicle-docs anon all" ON storage.objects;
CREATE POLICY "vehicle-docs anon all"
  ON storage.objects
  FOR ALL
  TO anon
  USING (bucket_id = 'vehicle-docs')
  WITH CHECK (bucket_id = 'vehicle-docs');
