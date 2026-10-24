-- Undo CrewBoard phase 2 role-split row security.
--
-- Run this in the SQL editor on the SAME project where
-- supabase/migrations/20261024140000_role_split_rls.sql was applied.
-- Put the previous website back in the same step. This file re-opens the raw
-- API: a crew token can read wages and prices again, even if the new website
-- still hides them on screen.
--
-- What this file does NOT do:
--   It does not delete crew_private or materials_private, and it does not
--   delete any copied pay or price row.
--   It does not drop the original columns (they were never dropped).
--   It does not drop the crew job-record / PTO functions or the sync triggers.
--   Those stay so the copied rows are still there if you apply the forward
--   file again. Applying the forward file copies the original columns over
--   the private rows again.
--   It does not give the anon key EXECUTE on those functions. They stay
--   limited to signed-in users.
--
-- After this file, signed-in crew can read and write the same tables they
-- could after phase 1. Owner and office are unchanged from phase 1.

BEGIN;

-- Table-level grants put every column, including pay and price, back on the
-- API role. anon gets the same grants it had before phase 2. Row security
-- still hides the rows from anon (phase 1 policies below).
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.materials TO anon, authenticated;

DROP POLICY IF EXISTS fp_crew_select ON public.crew;
DROP POLICY IF EXISTS fp_crew_write ON public.crew;
DROP POLICY IF EXISTS fp_crew_update ON public.crew;
DROP POLICY IF EXISTS fp_crew_delete ON public.crew;
DROP POLICY IF EXISTS fp_auth_all ON public.crew;
CREATE POLICY fp_auth_all ON public.crew
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_materials_select ON public.materials;
DROP POLICY IF EXISTS fp_materials_write ON public.materials;
DROP POLICY IF EXISTS fp_materials_insert ON public.materials;
DROP POLICY IF EXISTS fp_materials_update ON public.materials;
DROP POLICY IF EXISTS fp_materials_delete ON public.materials;
DROP POLICY IF EXISTS fp_auth_all ON public.materials;
CREATE POLICY fp_auth_all ON public.materials
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_jobs_staff ON public.jobs;
DROP POLICY IF EXISTS fp_auth_all ON public.jobs;
CREATE POLICY fp_auth_all ON public.jobs
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_leads_staff ON public.leads;
DROP POLICY IF EXISTS fp_auth_all ON public.leads;
CREATE POLICY fp_auth_all ON public.leads
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_vehicles_staff ON public.vehicles;
DROP POLICY IF EXISTS fp_auth_all ON public.vehicles;
CREATE POLICY fp_auth_all ON public.vehicles
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_vehicle_maint_staff ON public.vehicle_maintenance;
DROP POLICY IF EXISTS fp_auth_all ON public.vehicle_maintenance;
CREATE POLICY fp_auth_all ON public.vehicle_maintenance
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_slots_member ON public.scheduled_slots;
DROP POLICY IF EXISTS fp_auth_all ON public.scheduled_slots;
CREATE POLICY fp_auth_all ON public.scheduled_slots
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_pto_member ON public.pto_blocks;
DROP POLICY IF EXISTS fp_auth_all ON public.pto_blocks;
CREATE POLICY fp_auth_all ON public.pto_blocks
  FOR ALL TO authenticated
  USING ((SELECT private.fp_member()))
  WITH CHECK ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_audit_select ON public.audit_log;
CREATE POLICY fp_audit_select ON public.audit_log
  FOR SELECT TO authenticated
  USING ((SELECT private.fp_member()));

DROP POLICY IF EXISTS fp_settings_select ON public.settings;
DROP POLICY IF EXISTS fp_settings_insert ON public.settings;
DROP POLICY IF EXISTS fp_settings_update ON public.settings;
DROP POLICY IF EXISTS fp_settings_delete ON public.settings;
CREATE POLICY fp_settings_select ON public.settings
  FOR SELECT TO authenticated
  USING (
    (SELECT private.fp_member())
    AND key NOT IN ('admin_pin', 'crew_pins', 'office_users')
  );
CREATE POLICY fp_settings_insert ON public.settings
  FOR INSERT TO authenticated
  WITH CHECK (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_role()) IN ('owner', 'office')
      OR ((SELECT private.fp_role()) = 'crew'
          AND key IN ('job_records', 'job_photos', 'job_docs', 'slot_job_map', 'pto_requests', 'material_requests', 'material_notes'))
    )
  );
CREATE POLICY fp_settings_update ON public.settings
  FOR UPDATE TO authenticated
  USING (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_role()) IN ('owner', 'office')
      OR ((SELECT private.fp_role()) = 'crew'
          AND key IN ('job_records', 'job_photos', 'job_docs', 'slot_job_map', 'pto_requests', 'material_requests', 'material_notes'))
    )
  )
  WITH CHECK (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (
      (SELECT private.fp_role()) IN ('owner', 'office')
      OR ((SELECT private.fp_role()) = 'crew'
          AND key IN ('job_records', 'job_photos', 'job_docs', 'slot_job_map', 'pto_requests', 'material_requests', 'material_notes'))
    )
  );
CREATE POLICY fp_settings_delete ON public.settings
  FOR DELETE TO authenticated
  USING (
    key NOT IN ('admin_pin', 'crew_pins', 'office_users')
    AND (SELECT private.fp_role()) IN ('owner', 'office')
  );

-- Keep the crew functions callable by signed-in users only. Restoring the
-- old table grants must not hand these functions back to the anon key.
REVOKE ALL ON FUNCTION public.fp_crew_read_job_records() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_write_job_records(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_read_pto_requests() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.fp_crew_write_pto_requests(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_crew_read_job_records() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_write_job_records(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_read_pto_requests() TO authenticated;
GRANT EXECUTE ON FUNCTION public.fp_crew_write_pto_requests(jsonb) TO authenticated;

DO $check$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'crew' AND column_name = 'hourly'
  ) AND NOT has_column_privilege('authenticated', 'public.crew', 'hourly', 'SELECT') THEN
    RAISE EXCEPTION 'rollback did not restore SELECT on public.crew.hourly';
  END IF;
  IF to_regclass('public.crew_private') IS NULL THEN
    RAISE EXCEPTION 'rollback removed public.crew_private; the copied pay rows must stay';
  END IF;
  IF to_regclass('public.materials_private') IS NULL THEN
    RAISE EXCEPTION 'rollback removed public.materials_private; the copied prices must stay';
  END IF;
  IF has_function_privilege('anon', 'public.fp_crew_read_job_records()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_crew_write_job_records(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_crew_read_pto_requests()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.fp_crew_write_pto_requests(jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'rollback left anon able to execute a crew job or PTO function';
  END IF;
END
$check$;

COMMIT;

NOTIFY pgrst, 'reload schema';
