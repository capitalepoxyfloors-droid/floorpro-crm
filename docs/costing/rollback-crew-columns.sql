-- Rollback for supabase/migrations/20261020120000_crew_costing_columns.sql.
-- Drops ONLY the columns that migration added. Existing crew columns (hourly, wc, futa, benefits, ...)
-- are left as they are, including any values typed into them since.
--
-- Do this AFTER putting the old index.html back (git revert of the costing PR): the new page saves
-- these columns and would fail to save crew once they are gone.
-- Day logs keep any directRate/overheadRate stamps; the old page ignores them and reads burdenedRate,
-- which the new page keeps as direct + overhead.
-- The costing_settings row in public.settings is harmless to leave. To remove it as well:
--   DELETE FROM public.settings WHERE key = 'costing_settings';

BEGIN;
ALTER TABLE public.crew
  DROP COLUMN IF EXISTS futa_wage_base,
  DROP COLUMN IF EXISTS suta_rate,
  DROP COLUMN IF EXISTS suta_wage_base,
  DROP COLUMN IF EXISTS k401_match_pct,
  DROP COLUMN IF EXISTS fixed_fees_yr,
  DROP COLUMN IF EXISTS clothing_yr,
  DROP COLUMN IF EXISTS field_rate_override,
  DROP COLUMN IF EXISTS is_owner;
COMMIT;

NOTIFY pgrst, 'reload schema';
