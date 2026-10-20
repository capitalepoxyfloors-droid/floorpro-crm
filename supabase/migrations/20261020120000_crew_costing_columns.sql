-- CrewBoard costing change (PR A): per-person cost fields for the direct labor rate.
--
-- ADDS COLUMNS ONLY. Nothing is dropped, renamed or retyped, and job_records is not touched.
-- Every new numeric column is nullable: NULL means "not filled in" (counts as 0, and a NULL
-- wage base means no cap). Until any of them is filled in for a person, the app keeps using
-- the old burden math for that person.
--
-- Order: run this BEFORE deploying the matching index.html. The app saves a crew member as a
-- full row, and that save fails while these columns don't exist.
-- Rollback: docs/costing/rollback-crew-columns.sql (drops only these columns).
--
-- Row security: the crew table's existing fp_auth_all policy covers the new columns. Crew can
-- read them through the API (same as the existing pay columns); the app keeps them out of Crew View.

BEGIN;

ALTER TABLE public.crew
  ADD COLUMN IF NOT EXISTS futa_wage_base      numeric NULL,
  ADD COLUMN IF NOT EXISTS suta_rate           numeric NULL,
  ADD COLUMN IF NOT EXISTS suta_wage_base      numeric NULL,
  ADD COLUMN IF NOT EXISTS k401_match_pct      numeric NULL,
  ADD COLUMN IF NOT EXISTS fixed_fees_yr       numeric NULL,
  ADD COLUMN IF NOT EXISTS clothing_yr         numeric NULL,
  ADD COLUMN IF NOT EXISTS field_rate_override numeric NULL,
  ADD COLUMN IF NOT EXISTS is_owner            boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.crew.futa_wage_base      IS 'FUTA applies to wages up to this amount per year. NULL = no cap.';
COMMENT ON COLUMN public.crew.suta_rate           IS 'SUTA rate, percent (e.g. 1.848). NULL = 0.';
COMMENT ON COLUMN public.crew.suta_wage_base      IS 'SUTA applies to wages up to this amount per year. NULL = no cap.';
COMMENT ON COLUMN public.crew.k401_match_pct      IS '401(k) employer match, percent of wages. NULL = 0.';
COMMENT ON COLUMN public.crew.fixed_fees_yr       IS 'Fixed per-person fees, dollars per year. NULL = 0.';
COMMENT ON COLUMN public.crew.clothing_yr         IS 'Clothing, dollars per year. NULL = 0.';
COMMENT ON COLUMN public.crew.field_rate_override IS 'Direct labor $/hr used instead of the formula (e.g. the owner). NULL = use the formula.';
COMMENT ON COLUMN public.crew.is_owner            IS 'Owner: left out of the overhead divisor. Set by the app or this migration, never inferred from role text.';

-- Backfill: Will is the owner. Matched by name once, here; the app uses is_owner from now on.
UPDATE public.crew SET is_owner = true
WHERE lower(btrim(full_name)) = 'will bradford' AND is_owner = false;

DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM public.crew WHERE is_owner;
  IF n <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one owner row (Will Bradford) after the backfill, found %. Nothing was changed.', n;
  END IF;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
