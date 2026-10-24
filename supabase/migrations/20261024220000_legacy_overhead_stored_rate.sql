-- Legacy fills use the stored overhead $/hr, not the current overhead list.
--
-- Apply on the TEST project after
--   supabase/migrations/20261024193000_stamp_prior_wage_and_legacy_burden.sql
-- has already been applied. Do not run this on the live project.
-- Safe to run more than once. It does not update job_records. A stamp already
-- stored, including Helias 42.09 and 33.59, stays as stored.
--
-- For a work date on cs_legacy (before 2026-10-20), overhead per hour is
-- legacyOverheadPerHour on the costing set in effect that day. That figure
-- is 4.83. It is added to the unrounded burden, and the sum is rounded once.
-- The settings.overhead list is not read. On 2026-10-22 that list became the
-- full pool, $86,014. Dividing that list by the old headcount is about
-- $10.34/hr, which this fill does not use.
--
-- Spot check with FUTA 2.70, workers' comp 5.61, SS 6.20, Medicare 1.45,
-- GL 0, 40 hours a week, and overhead 4.83 inside that one round:
--   Seth 2026-10-02, hourly 30.25, benefits 135/mo, PTO 12
--     burden 37.2529 + 4.83 = 42.0829 -> 42.08
--     The stored 42.09 is the same burden plus 4.8330384615 (the old list).
--   Hunter 2026-10-01, hourly 24.00, benefits 0, PTO 10
--     burden 28.7534769231 + 4.83 = 33.5834769231 -> 33.58
--     The stored 33.59 is that burden plus 4.8330384615.
--   Cody in May, note wage 24.00, same card as Hunter -> 33.58, rateEstimated
--     because the prior wage was read from the note.
--   Cody on or after 2026-06-01, hourly 25.20
--     burden 30.1911507692 + 4.83 = 35.0211507692 -> 35.02, not estimated.
-- If legacyOverheadPerHour is missing, the same 4.83 is used and the stamp
-- is marked rateEstimated. A direct-rate day (2026-10-20 on) still takes
-- overhead from that dated costing set (the pool, 15.32 at the seed), not
-- from the overhead list, unless that set's own mode says to use the list.
-- Weekend overtime is still the existing checkbox. This file does not set it.
--
-- To turn the fill off without deleting stored stamps:
--   DROP TRIGGER IF EXISTS fp_stamp_missing_labor ON public.settings;

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('private.fp_fill_labor_stamp(jsonb,text,jsonb,jsonb,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261024170000_stamp_missing_labor_rates.sql before this file. Nothing was changed.';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION private.fp_fill_labor_stamp(
  person jsonb, work_date text, history jsonb, sets jsonb, inactive jsonb, items jsonb
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  idx numeric;
  crew_id text;
  full_name text;
  hourly numeric;
  cur_hourly numeric;
  hrs_wk numeric;
  ss numeric;
  med numeric;
  futa numeric;
  wc numeric;
  gl numeric;
  benefits numeric;
  pto numeric;
  futa_base numeric;
  suta numeric;
  suta_base numeric;
  k401 numeric;
  fees numeric;
  clothing numeric;
  override numeric;
  on_new boolean;
  chosen jsonb;
  entry jsonb;
  version text;
  model boolean;
  hr numeric;
  wage numeric;
  annual numeric;
  divisor numeric;
  direct numeric;
  ot numeric;
  stat_mult numeric;
  oh numeric;
  legacy_oh numeric;
  benefits_hr numeric;
  pto_hr numeric;
  burden numeric;
  e jsonb;
  eff text;
  tax_eff text := '';
  wage_meta jsonb;
  est boolean := false;
  futa_use numeric;
  wc_use numeric;
  all_in numeric;
BEGIN
  IF person IS NULL OR jsonb_typeof(person) <> 'object' THEN
    RETURN person;
  END IF;
  IF private.fp_has_labor_stamp(person) THEN
    RETURN person;
  END IF;

  idx := private.fp_json_num(person -> 'crewIdx');
  IF idx IS NOT NULL AND idx >= 0 AND idx = trunc(idx) THEN
    SELECT c.id::text, c.full_name,
           private.fp_to_num(p.hourly),
           COALESCE(private.fp_to_num(p.hours), 40),
           COALESCE(private.fp_to_num(p.ss), 0),
           COALESCE(private.fp_to_num(p.medicare), 0),
           COALESCE(private.fp_to_num(p.futa), 0),
           COALESCE(private.fp_to_num(p.wc), 0),
           COALESCE(private.fp_to_num(p.gl), 0),
           COALESCE(private.fp_to_num(p.benefits), 0),
           COALESCE(private.fp_to_num(p.pto_days), 0),
           p.futa_wage_base, COALESCE(p.suta_rate, 0), p.suta_wage_base,
           COALESCE(p.k401_match_pct, 0), COALESCE(p.fixed_fees_yr, 0), COALESCE(p.clothing_yr, 0),
           p.field_rate_override,
           (p.futa_wage_base IS NOT NULL OR p.suta_rate IS NOT NULL OR p.suta_wage_base IS NOT NULL
             OR p.k401_match_pct IS NOT NULL OR p.fixed_fees_yr IS NOT NULL OR p.clothing_yr IS NOT NULL
             OR p.field_rate_override IS NOT NULL)
      INTO crew_id, full_name, cur_hourly, hrs_wk, ss, med, futa, wc, gl, benefits, pto,
           futa_base, suta, suta_base, k401, fees, clothing, override, on_new
    FROM public.crew AS c
    JOIN public.crew_private AS p ON p.crew_id = c.id
    WHERE c.sort_order = idx::integer
    ORDER BY c.id
    LIMIT 1;
  END IF;

  IF crew_id IS NULL AND btrim(COALESCE(person ->> 'name', '')) <> '' THEN
    SELECT c.id::text, c.full_name,
           private.fp_to_num(p.hourly),
           COALESCE(private.fp_to_num(p.hours), 40),
           COALESCE(private.fp_to_num(p.ss), 0),
           COALESCE(private.fp_to_num(p.medicare), 0),
           COALESCE(private.fp_to_num(p.futa), 0),
           COALESCE(private.fp_to_num(p.wc), 0),
           COALESCE(private.fp_to_num(p.gl), 0),
           COALESCE(private.fp_to_num(p.benefits), 0),
           COALESCE(private.fp_to_num(p.pto_days), 0),
           p.futa_wage_base, COALESCE(p.suta_rate, 0), p.suta_wage_base,
           COALESCE(p.k401_match_pct, 0), COALESCE(p.fixed_fees_yr, 0), COALESCE(p.clothing_yr, 0),
           p.field_rate_override,
           (p.futa_wage_base IS NOT NULL OR p.suta_rate IS NOT NULL OR p.suta_wage_base IS NOT NULL
             OR p.k401_match_pct IS NOT NULL OR p.fixed_fees_yr IS NOT NULL OR p.clothing_yr IS NOT NULL
             OR p.field_rate_override IS NOT NULL)
      INTO crew_id, full_name, cur_hourly, hrs_wk, ss, med, futa, wc, gl, benefits, pto,
           futa_base, suta, suta_base, k401, fees, clothing, override, on_new
    FROM public.crew AS c
    JOIN public.crew_private AS p ON p.crew_id = c.id
    WHERE lower(btrim(c.full_name)) = lower(btrim(person ->> 'name'))
    ORDER BY c.id
    LIMIT 1;
  END IF;

  IF crew_id IS NULL THEN
    RETURN person;
  END IF;

  chosen := private.fp_rate_set_for_stamp(sets, work_date);
  IF chosen IS NULL THEN
    RETURN person;
  END IF;
  entry := chosen -> 'entry';
  version := chosen ->> 'version';
  model := COALESCE(private.fp_json_num(entry -> 'paidHoursPerYear'), 0) > 0
       AND COALESCE(private.fp_json_num(entry -> 'utilization'), 0) > 0;
  wage_meta := private.fp_wage_for_stamp(history, crew_id, full_name, work_date, cur_hourly);
  hourly := private.fp_json_num(wage_meta -> 'hourly');
  est := COALESCE((wage_meta ->> 'estimated')::boolean, false);
  hr := COALESCE(hourly, 0);
  IF hrs_wk IS NULL OR hrs_wk <= 0 THEN
    hrs_wk := 40;
  END IF;

  -- A day before the direct-rate model: the old all-in stamp only. No directRate,
  -- so it still counts as already stamped and a later save will not rewrite it.
  IF NOT model THEN
    IF hr <= 0 THEN
      RETURN person;
    END IF;
    -- FUTA and workers' comp on the crew row were changed on the direct-rate
    -- cutover. A legacy costing entry can name the percents that were in effect
    -- before that (legacyFutaPct, legacyWcPct). Absent those, the row's percents.
    futa_use := futa;
    wc_use := wc;
    FOR e IN SELECT value FROM jsonb_array_elements(sets) LOOP
      IF jsonb_typeof(e) <> 'object' THEN
        CONTINUE;
      END IF;
      eff := e ->> 'effective';
      IF eff IS NULL OR eff > work_date THEN
        CONTINUE;
      END IF;
      IF (e ? 'legacyFutaPct' OR e ? 'legacyWcPct') AND (tax_eff = '' OR eff >= tax_eff) THEN
        IF e ? 'legacyFutaPct' THEN
          futa_use := COALESCE(private.fp_json_num(e -> 'legacyFutaPct'), futa_use);
        END IF;
        IF e ? 'legacyWcPct' THEN
          wc_use := COALESCE(private.fp_json_num(e -> 'legacyWcPct'), wc_use);
        END IF;
        tax_eff := eff;
      END IF;
    END LOOP;
    benefits_hr := benefits * 12 / (hrs_wk * 52);
    pto_hr := (pto * 8 * hr) / (hrs_wk * 52);
    burden := hr * (1 + ss / 100 + med / 100 + futa_use / 100 + wc_use / 100 + gl / 100) + benefits_hr + pto_hr;
    IF burden <= 0 THEN
      RETURN person;
    END IF;
    -- Stored $/hr on the costing set in effect that day, inside one round
    -- with the burden. The current overhead list is not used: it was replaced
    -- on 2026-10-22 with the full pool (~$86,014), which would price an old
    -- day near $10.34/hr instead of $4.83. Missing figure: the page seed 4.83,
    -- and the stamp is estimated.
    IF entry ? 'legacyOverheadPerHour' AND private.fp_json_num(entry -> 'legacyOverheadPerHour') IS NOT NULL THEN
      legacy_oh := private.fp_json_num(entry -> 'legacyOverheadPerHour');
    ELSE
      legacy_oh := 4.83;
      est := true;
    END IF;
    all_in := round(burden + legacy_oh, 2);
    person := person || jsonb_build_object('burdenedRate', all_in::text);
    IF est THEN
      person := person || jsonb_build_object('rateEstimated', true);
    END IF;
    RETURN person;
  END IF;

  -- Model day, person still on the old burden math: directRate is that burden
  -- (overhead is its own field). Same split the website uses for them.
  IF NOT on_new THEN
    IF hr <= 0 THEN
      RETURN person;
    END IF;
    benefits_hr := benefits * 12 / (hrs_wk * 52);
    pto_hr := (pto * 8 * hr) / (hrs_wk * 52);
    direct := hr * (1 + ss / 100 + med / 100 + futa / 100 + wc / 100 + gl / 100) + benefits_hr + pto_hr;
    stat_mult := 1 + ss / 100 + med / 100 + wc / 100;
    ot := 1.5 * hr * stat_mult;
    oh := private.fp_overhead_per_hour(entry, inactive, items);
    person := person || jsonb_build_object(
      'directRate', private.fp_r2(direct),
      'otRate', private.fp_r2(ot),
      'baseRate', private.fp_r2(hr),
      'statMult', round(stat_mult, 4),
      'overheadRate', private.fp_r2(oh),
      'rateVersion', version,
      'burdenedRate', (round(private.fp_r2(direct) + private.fp_r2(oh), 2))::text
    );
    IF est THEN
      person := person || jsonb_build_object('rateEstimated', true);
    END IF;
    RETURN person;
  END IF;

  IF hr <= 0 AND (override IS NULL OR override <= 0) THEN
    RETURN person;
  END IF;
  wage := hr * COALESCE(private.fp_json_num(entry -> 'paidHoursPerYear'), 0);
  annual := wage
    + wage * ss / 100
    + wage * med / 100
    + wage * wc / 100
    + (CASE WHEN futa_base IS NULL THEN wage ELSE LEAST(wage, futa_base) END) * futa / 100
    + (CASE WHEN suta_base IS NULL THEN wage ELSE LEAST(wage, suta_base) END) * suta / 100
    + wage * k401 / 100
    + fees
    + benefits * 12
    + clothing;
  divisor := COALESCE(private.fp_json_num(entry -> 'paidHoursPerYear'), 0) * COALESCE(private.fp_json_num(entry -> 'utilization'), 0);
  stat_mult := 1 + ss / 100 + med / 100 + wc / 100;
  IF override IS NOT NULL AND override > 0 THEN
    direct := override;
    ot := override;
  ELSE
    direct := CASE WHEN divisor > 0 THEN annual / divisor ELSE 0 END;
    ot := 1.5 * hr * stat_mult;
  END IF;
  oh := private.fp_overhead_per_hour(entry, inactive, items);
  person := person || jsonb_build_object(
    'directRate', private.fp_r2(direct),
    'otRate', private.fp_r2(ot),
    'baseRate', private.fp_r2(hr),
    'statMult', round(stat_mult, 4),
    'overheadRate', private.fp_r2(oh),
    'rateVersion', version,
    'burdenedRate', (round(private.fp_r2(direct) + private.fp_r2(oh), 2))::text
  );
  IF override IS NOT NULL AND override > 0 THEN
    person := person || jsonb_build_object('fieldOverride', true);
  END IF;
  IF est THEN
    person := person || jsonb_build_object('rateEstimated', true);
  END IF;
  RETURN person;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_fill_labor_stamp(jsonb, text, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;

COMMIT;
