-- Crew cost values from the costing spec (2026-10-20). Run AFTER the crew costing migration.
-- On floorpro-crm-test: fine to run as-is for the acceptance tests.
-- On LIVE: only with Will's OK. The same values can instead be typed into Installers → Edit,
-- which also writes an audit-log entry per person.
--
-- Values per the CFO's rates workbook (burdened_rates_final.xlsx, rev 2, 10/20/2026):
--   fixed_fees_yr = 401(k) admin share + payroll-service share: Seth/Brendon 674.25 + 156.27 = 830.52,
--   Hunter (not in the 401k yet) 156.27; clothing 204.48 each; 401(k) match 4% (Hunter 0 until enrolled).
--   When Hunter enrolls: k401_match_pct 4 and fixed_fees_yr 661.96 (admin split 4 ways + payroll fee).
-- Expected direct rates at WC 3.62% (2,080 paid hrs × 90% utilization):
--   Seth 40.27, Brendon 36.65, Hunter 29.98 (31.31 once enrolled), Will 40.27 (override).
-- Cody Faulkner (inactive, out on injury) gets Hunter's no-401k values so his past hours re-cost with
-- the same formula the CFO used ($31.48 at WC 3.70%). Inactive still keeps him out of the overhead divisor.
-- Will (owner): same WC/FUTA rates as everyone else; his field hours use field_rate_override.

BEGIN;

-- Everyone with a wage: new WC and FUTA rates, SUTA, wage bases, clothing.
UPDATE public.crew SET
  wc = '3.62',
  futa = '0.60',
  futa_wage_base = 7000,
  suta_rate = 1.848,
  suta_wage_base = 9000,
  clothing_yr = 204.48
WHERE lower(btrim(full_name)) IN ('seth west', 'brendon bennett', 'hunter schuler', 'cody faulkner');

UPDATE public.crew SET k401_match_pct = 4, fixed_fees_yr = 830.52 WHERE lower(btrim(full_name)) = 'seth west';
UPDATE public.crew SET k401_match_pct = 4, fixed_fees_yr = 830.52 WHERE lower(btrim(full_name)) = 'brendon bennett';
UPDATE public.crew SET k401_match_pct = 0, fixed_fees_yr = 156.27 WHERE lower(btrim(full_name)) = 'hunter schuler'; -- not in the 401k yet
UPDATE public.crew SET k401_match_pct = 0, fixed_fees_yr = 156.27 WHERE lower(btrim(full_name)) = 'cody faulkner';  -- inactive; for re-costing his past hours

-- Owner: field hours valued at Seth's direct rate.
UPDATE public.crew SET field_rate_override = 40.27, wc = '3.62', futa = '0.60' WHERE is_owner;

COMMIT;
