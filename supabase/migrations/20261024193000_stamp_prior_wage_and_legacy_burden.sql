-- Prior wage before the first pay change, and the pre-2026-10-20 all-in.
--
-- A database that already applied this file does not re-run it. Apply
-- supabase/migrations/20261024220000_legacy_overhead_stored_rate.sql there.
-- That file is the one that switches a pre-model fill to the stored
-- legacyOverheadPerHour inside one round (Seth 42.08, Hunter 33.58).
--
-- Apply on the TEST project (floorpro-crm-test) after
--   supabase/migrations/20261024170000_stamp_missing_labor_rates.sql
-- has already been applied. Do not run this on the live project.
-- Safe to run more than once. It does not update job_records, so a stamp
-- already stored (including Helias Polishing Phase 3) stays byte for byte.
--
-- 1. Hourly before the first recorded pay change.
--    A pay_change on or before the work date still wins, and its rate is the
--    new wage. A date before every pay_change uses a structured old-wage
--    field on the earliest change (oldRate, previousRate, priorRate, fromRate,
--    old_rate, previous) when one is present. That stamp is not estimated.
--    Otherwise the first dollar amount in a note that says the wage was the
--    previous one ("Previous wage was $24.00") is used, and the stamp gets
--    rateEstimated true. If that note has no amount, the current hourly is
--    used and still marked estimated. No history at all: the current hourly,
--    not estimated. Crew reads still strip rateEstimated with the other wage keys.
--
-- 2. Why a stripped pre-model day did not match the stored all-in.
--    Through 2026-10-19 the page wrote one round of
--      burden + (itemized overhead total / active weekly hours x 52).
--    The owner was in that divisor. Inactive people were not. There was no
--    90% utilization and no separate overhead pool. FUTA was 2.70% and
--    workers' comp was 5.61%. On 2026-10-20 those two percents became 0.60
--    and 3.62 for Seth, Brendon, and Hunter, and the page stopped folding
--    overhead into the burden.
--    The function from 20261024170000 used the percents now on crew_private
--    and added the flat legacyOverheadPerHour 4.83 after rounding the burden
--    to cents. That is Seth 40.85 and Hunter 32.60. The itemized overhead
--    (4.833) with those same current percents rounds to the same two numbers,
--    so the flat constant alone does not explain the gap. The stored 42.09
--    and 33.59 are the older list (40210.88 / 8320 = 4.8330384615) inside
--    one round. They were not a bad stamp. This fill does not recompute that
--    list. It adds the stored legacyOverheadPerHour, 4.83, inside the same
--    single round: unrounded burden + 4.83, then round to cents. That is
--    Seth 42.08 and Hunter 33.58. Cody at the note wage 24.00 is 33.58,
--    marked estimated. Cody at 25.20 on or after 2026-06-01 is 35.02 and is
--    not estimated. If legacyOverheadPerHour is missing, the same 4.83 is
--    used and the stamp is marked estimated. The current overhead list is
--    not consulted.
--    This file writes legacyFutaPct 2.70 and legacyWcPct 5.61 onto the
--    costing history entry that already has legacyOverheadPerHour, when
--    those two keys are absent. Days on the direct-rate model still use
--    that model's overhead pool.
--
-- 3. The stamp guard.
--    set_config(..., true) lived for the whole transaction, so a second
--    job_records save in that transaction skipped the stamp. The trigger now
--    returns immediately only when pg_trigger_depth() > 1, which is a nested
--    call inside the stamp itself. The next statement is depth 1 and stamps.
--    Weekend overtime is still the existing checkbox. This file does not set it.
--
-- To turn the fill off without deleting stored stamps:
--   DROP TRIGGER IF EXISTS fp_stamp_missing_labor ON public.settings;

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.crew_private') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261024140000_role_split_rls.sql before this file (crew_private is missing). Nothing was changed.';
  END IF;
  IF to_regprocedure('private.fp_fill_labor_stamp(jsonb,text,jsonb,jsonb,jsonb,jsonb)') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261024170000_stamp_missing_labor_rates.sql before this file. Nothing was changed.';
  END IF;
END
$guard$;

-- Hourly for a stamp, and whether that hourly was inferred.
-- A pay_change on or before the work date wins (its rate is the new wage).
-- A work date before every pay_change uses a structured old-wage field on the
-- earliest change when one exists. Otherwise a dollar amount in that note
-- ("Previous wage was $24.00") is used and marked estimated. If the note has
-- no amount either, the current hourly is used and still marked estimated,
-- so a date before the first change is not silently today's wage.
-- No history at all: the current hourly, not estimated.
CREATE OR REPLACE FUNCTION private.fp_wage_for_stamp(
  history jsonb, crew_id text, full_name text, work_date text, current_hourly numeric
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  keys text[];
  k text;
  ev jsonb;
  ord integer := 0;
  best_date text;
  best_ord integer := -1;
  best_rate numeric;
  first_date text;
  first_ord integer := 2147483647;
  first_ev jsonb;
  rate numeric;
  ev_date text;
  prior numeric;
  note text;
  neu numeric;
  amt numeric;
  m text[];
BEGIN
  keys := ARRAY[
    'id_' || COALESCE(crew_id, ''),
    'name_' || lower(regexp_replace(COALESCE(full_name, ''), '\s+', '_', 'g'))
  ];
  FOREACH k IN ARRAY keys LOOP
    IF history IS NULL OR jsonb_typeof(history -> k -> 'events') <> 'array' THEN
      CONTINUE;
    END IF;
    FOR ev IN SELECT value FROM jsonb_array_elements(history -> k -> 'events') LOOP
      ord := ord + 1;
      IF jsonb_typeof(ev) <> 'object' OR ev ->> 'type' IS DISTINCT FROM 'pay_change' THEN
        CONTINUE;
      END IF;
      ev_date := ev ->> 'date';
      rate := private.fp_json_num(ev -> 'rate');
      IF ev_date IS NULL OR rate IS NULL OR rate <= 0 THEN
        CONTINUE;
      END IF;
      IF ev_date <= work_date AND (best_date IS NULL OR ev_date > best_date OR (ev_date = best_date AND ord >= best_ord)) THEN
        best_date := ev_date;
        best_ord := ord;
        best_rate := rate;
      END IF;
      IF first_date IS NULL OR ev_date < first_date OR (ev_date = first_date AND ord < first_ord) THEN
        first_date := ev_date;
        first_ord := ord;
        first_ev := ev;
      END IF;
    END LOOP;
  END LOOP;

  IF best_rate IS NOT NULL THEN
    RETURN jsonb_build_object('hourly', best_rate, 'estimated', false);
  END IF;

  IF first_ev IS NOT NULL THEN
    prior := COALESCE(
      private.fp_json_num(first_ev -> 'oldRate'),
      private.fp_json_num(first_ev -> 'previousRate'),
      private.fp_json_num(first_ev -> 'priorRate'),
      private.fp_json_num(first_ev -> 'fromRate'),
      private.fp_json_num(first_ev -> 'old_rate'),
      private.fp_json_num(first_ev -> 'previous')
    );
    IF prior IS NOT NULL AND prior > 0 THEN
      RETURN jsonb_build_object('hourly', prior, 'estimated', false);
    END IF;
    note := COALESCE(first_ev ->> 'note', '');
    neu := private.fp_json_num(first_ev -> 'rate');
    IF note ~* '(previous|prior|old|\ywas\y|from)' THEN
      FOR m IN SELECT regexp_matches(note, '\$?\s*([0-9]+(?:\.[0-9]+)?)', 'g') LOOP
        amt := m[1]::numeric;
        IF amt > 0 AND (neu IS NULL OR amt IS DISTINCT FROM neu) THEN
          RETURN jsonb_build_object('hourly', amt, 'estimated', true);
        END IF;
      END LOOP;
    END IF;
    IF current_hourly IS NOT NULL AND current_hourly > 0 THEN
      RETURN jsonb_build_object('hourly', current_hourly, 'estimated', true);
    END IF;
    RETURN jsonb_build_object('hourly', NULL, 'estimated', true);
  END IF;

  IF current_hourly IS NOT NULL AND current_hourly > 0 THEN
    RETURN jsonb_build_object('hourly', current_hourly, 'estimated', false);
  END IF;
  RETURN jsonb_build_object('hourly', NULL, 'estimated', false);
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_hourly_on_date(
  history jsonb, crew_id text, full_name text, work_date text, current_hourly numeric
) RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT private.fp_json_num(private.fp_wage_for_stamp(history, crew_id, full_name, work_date, current_hourly) -> 'hourly');
$$;

-- Kept so a database that already created this function still replaces cleanly.
-- Labor stamps do not call it. A pre-model fill uses legacyOverheadPerHour
-- on the costing set, not this list.
CREATE OR REPLACE FUNCTION private.fp_legacy_item_overhead(inactive jsonb, items jsonb)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  pool numeric;
  hrs numeric;
BEGIN
  SELECT COALESCE(sum(
    CASE WHEN it ->> 'period' = 'mo' THEN COALESCE(private.fp_json_num(it -> 'amount'), 0) * 12
         ELSE COALESCE(private.fp_json_num(it -> 'amount'), 0) END
  ), 0)
    INTO pool
  FROM jsonb_array_elements(COALESCE(items, '[]'::jsonb)) AS it;
  IF pool <= 0 THEN
    RETURN NULL;
  END IF;
  SELECT COALESCE(sum(COALESCE(private.fp_to_num(p.hours), 40) * 52), 0)
    INTO hrs
  FROM public.crew AS c
  JOIN public.crew_private AS p ON p.crew_id = c.id
  WHERE COALESCE(private.fp_to_num(p.hourly), 0) > 0
    AND NOT (COALESCE(inactive, '{}'::jsonb) ? c.sort_order::text);
  IF hrs > 0 THEN
    RETURN pool / hrs;
  END IF;
  RETURN NULL;
END;
$$;

-- One person on one work date. Returns the same object when there is nothing to add.
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

CREATE OR REPLACE FUNCTION private.fp_stamp_missing_labor()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.key IS DISTINCT FROM 'job_records' THEN
    RETURN NEW;
  END IF;
  -- Depth 1 is this call. A nested settings write inside the stamp would be
  -- deeper and must not stamp again. The next statement in the same transaction
  -- is a new call at depth 1, so it still stamps.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;
  BEGIN
    NEW.value := private.fp_stamp_job_records_text(NEW.value);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'labor stamp skipped: %', SQLERRM;
  END;
  RETURN NEW;
END;
$$;

-- Keys inside job JSON that are prices, wage stamps, or costing flags.
-- Compared case-insensitively. Customer phone and address are not in this list:
-- the crew job card shows them so the crew can get to the job.
CREATE OR REPLACE FUNCTION private.fp_secret_key(k text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT lower(coalesce(k, '')) IN (
    'value', 'displayval', 'supplierinvoices',
    'mileagerate', 'mileageoneway',
    'prevailingwage', 'prevailingwagerate', 'prevailingwageburden',
    'burdenedrate', 'directrate', 'otrate', 'baserate', 'statmult',
    'overheadrate', 'rateversion', 'fieldoverride', 'rateestimated',
    'overtimewage', 'cashwages',
    'consumablespct', 'consumablespctset',
    'costcategory', 'costlinkid', 'commissions',
    'tmjob', 'tmlabormarkup', 'tmmaterialmarkup',
    'price', 'hourly', 'wage'
  );
$$;


-- FUTA 2.70% and workers' comp 5.61% were the card rates before 2026-10-20.
-- Only a history entry that already carries legacyOverheadPerHour is updated,
-- and only when both percents are absent. A pool-only entry is left alone.
-- This does not read or write job_records.
CREATE OR REPLACE FUNCTION private.fp_note_legacy_payroll_taxes()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  js jsonb;
  hist jsonb;
BEGIN
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'costing_settings';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN;
  END IF;
  BEGIN
    js := raw::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'costing_settings is not JSON; legacy payroll percents were not added';
    RETURN;
  END;
  IF jsonb_typeof(js -> 'history') <> 'array' THEN
    RETURN;
  END IF;
  SELECT jsonb_agg(
    CASE
      WHEN jsonb_typeof(elem) = 'object'
       AND (elem ? 'legacyOverheadPerHour')
       AND NOT (elem ? 'legacyFutaPct')
       AND NOT (elem ? 'legacyWcPct')
      THEN elem || jsonb_build_object('legacyFutaPct', 2.70, 'legacyWcPct', 5.61)
      ELSE elem
    END
    ORDER BY ord
  )
    INTO hist
  FROM jsonb_array_elements(js -> 'history') WITH ORDINALITY AS t(elem, ord);
  IF hist IS NULL OR hist IS NOT DISTINCT FROM (js -> 'history') THEN
    RETURN;
  END IF;
  UPDATE public.settings AS s
  SET value = jsonb_set(js, '{history}', hist)::text
  WHERE s.key = 'costing_settings';
END;
$$;


REVOKE ALL ON FUNCTION private.fp_wage_for_stamp(jsonb, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_hourly_on_date(jsonb, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_legacy_item_overhead(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_fill_labor_stamp(jsonb, text, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_stamp_missing_labor() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_note_legacy_payroll_taxes() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_secret_key(text) FROM PUBLIC;

DROP TRIGGER IF EXISTS fp_stamp_missing_labor ON public.settings;
CREATE TRIGGER fp_stamp_missing_labor
  BEFORE INSERT OR UPDATE ON public.settings
  FOR EACH ROW
  WHEN (NEW.key = 'job_records')
  EXECUTE FUNCTION private.fp_stamp_missing_labor();

SELECT private.fp_note_legacy_payroll_taxes();

COMMIT;
