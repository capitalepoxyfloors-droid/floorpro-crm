-- Crew cost values from the costing spec (2026-10-20). Run AFTER the crew costing migration.
-- On floorpro-crm-test: fine to run as-is for the acceptance tests.
-- On LIVE: only with Will's OK. The same values can instead be typed into Installers → Edit,
-- which also writes an audit-log entry per person.
--
-- Expected direct rates afterwards (2,080 paid hrs × 90% utilization):
--   Seth 40.27, Brendon 36.65 (spec: 36.66), Will 40.27 (override), Hunter 30.34 with these values.
--   The spec expects Hunter 29.97, which needs about $349/yr of fixed fees + clothing instead of
--   830 + 204. CONFIRM HUNTER'S fixed_fees_yr / clothing_yr / 401k % WITH WILL before using his rate.
-- Cody Faulkner (inactive, out on injury) is left alone.

BEGIN;

-- Everyone with a wage: new WC and FUTA rates, SUTA, wage bases, clothing.
UPDATE public.crew SET
  wc = '3.62',
  futa = '0.60',
  futa_wage_base = 7000,
  suta_rate = 1.848,
  suta_wage_base = 9000,
  clothing_yr = 204
WHERE lower(btrim(full_name)) IN ('seth west', 'brendon bennett', 'hunter schuler');

UPDATE public.crew SET k401_match_pct = 4, fixed_fees_yr = 830 WHERE lower(btrim(full_name)) = 'seth west';
UPDATE public.crew SET k401_match_pct = 4, fixed_fees_yr = 830 WHERE lower(btrim(full_name)) = 'brendon bennett';
UPDATE public.crew SET k401_match_pct = 0, fixed_fees_yr = 830 WHERE lower(btrim(full_name)) = 'hunter schuler'; -- fees: confirm

-- Owner: field hours valued at Seth's direct rate.
UPDATE public.crew SET field_rate_override = 40.27 WHERE is_owner;

COMMIT;
