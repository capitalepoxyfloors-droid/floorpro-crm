-- Fill a missing labor stamp when job_records is saved.
--
-- Apply on the TEST project after both of these have been applied:
--   supabase/migrations/20261024140000_role_split_rls.sql
--   supabase/migrations/20261024153000_revoke_crew_rpc_anon.sql
-- Do not run this on the live project from here. Safe to run more than once.
--
-- What it does:
--   A BEFORE trigger on public.settings, for the job_records row only, writes the
--   wage stamp onto a crewPresent entry that has no stamp at all. It runs as the
--   table owner, so a crew save (the crew job-records function) and a direct SQL
--   save get a stamp immediately. Crew still cannot read crew_private or the
--   stamp: the crew read strips those keys.
--   The same pass runs once, below, over the job_records row already stored, so
--   days saved before this file are filled without anyone opening the office view.
--
-- Which rate:
--   The hourly is the latest crew_history pay_change on or before the work date
--   (keys id_<crew id> and name_<full name>). A date before every pay_change uses
--   a structured old-wage field on the earliest change when one exists. Otherwise
--   a dollar amount in that note ("Previous wage was $24.00") is used and the
--   stamp is marked rateEstimated. If the note has no amount, the current hourly
--   is used and still marked estimated. No history at all: the current hourly,
--   not estimated. SS, Medicare, benefits, and the field-rate override are not in
--   the history; they come from the current crew_private row. FUTA and workers'
--   comp on a pre-model day come from legacyFutaPct / legacyWcPct on the costing
--   entry in effect that day, else the row. The pre-model all-in is one round of
--   burden plus legacyOverheadPerHour on the costing set in effect that day
--   (4.83 on cs_legacy). The current overhead list is not used. If that field
--   is missing, the page seed 4.83 is used and the stamp is marked estimated.
--   Model days get directRate, otRate, baseRate,
--   statMult, overheadRate, rateVersion, and burdenedRate from the costing entry
--   in effect on the work date (the latest entry when none is in effect yet).
--   The owner's field_rate_override is the direct rate. This does not set
--   overtimeWage. Weekend overtime stays the checkbox the office already uses.
--
-- A database that already applied an earlier copy of this file does not
-- re-run it. After 20261024193000, apply
-- supabase/migrations/20261024220000_legacy_overhead_stored_rate.sql
-- That file replaces the stamp function and does not rewrite a job_records
-- row that already has a stamp.
--
-- What it refuses to change:
--   An entry that already has a directRate or a burdenedRate, including a legacy
--   all-in rate or a rate Operations typed in SQL. Those stay as stored, even when
--   the same person has a different rate on another job. A future work date is
--   left alone. Prevailing-wage and cash days are not rewritten into a different
--   kind of day; the stamp is the person's own rate, and the costing screen still
--   prices prevailing wage and cash first.
--
-- This file does not change who can read crew_private. Owner and office already
-- can (policy fp_crew_private_staff). The SQL editor runs as the table owner and
-- bypasses row security. service_role already has full rights on crew_private.
-- Nothing here deletes a row or drops a column.
--
-- It also replaces public.fp_crew_write_job_records. The earlier copy used a
-- variable named found, which hides the special FOUND flag. Saving a job id the
-- server did not have yet then tried to insert job_records a second time and
-- failed. The replacement uses matched for the job id. Privileges stay
-- signed-in users only.
--
-- To turn the fill off without deleting stored stamps:
--   DROP TRIGGER IF EXISTS fp_stamp_missing_labor ON public.settings;

BEGIN;

DO $guard$
BEGIN
  IF to_regclass('public.crew_private') IS NULL THEN
    RAISE EXCEPTION 'Apply 20261024140000_role_split_rls.sql before this file (crew_private is missing). Nothing was changed.';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION private.fp_to_num(t text)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF t IS NULL OR btrim(t) = '' THEN
    RETURN NULL;
  END IF;
  IF btrim(t) !~ '^-?[0-9]+(\.[0-9]+)?$' THEN
    RETURN NULL;
  END IF;
  RETURN btrim(t)::numeric;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_json_num(j jsonb)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
BEGIN
  IF j IS NULL OR jsonb_typeof(j) = 'null' THEN
    RETURN NULL;
  END IF;
  IF jsonb_typeof(j) NOT IN ('number', 'string') THEN
    RETURN NULL;
  END IF;
  RETURN private.fp_to_num(j #>> '{}');
END;
$$;

-- A saved directRate or burdenedRate, including 0. A blank string is not a stamp.
CREATE OR REPLACE FUNCTION private.fp_has_labor_stamp(c jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT private.fp_json_num(c -> 'directRate') IS NOT NULL
      OR private.fp_json_num(c -> 'burdenedRate') IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION private.fp_r2(n numeric)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT round(COALESCE(n, 0), 2);
$$;

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

-- Rate set for a stamp. The entry in effect on the work date, or the latest entry
-- when none is in effect yet. version matches the website: the entry id, else
-- effective#index in the history array.
CREATE OR REPLACE FUNCTION private.fp_rate_set_for_stamp(sets jsonb, work_date text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  i integer;
  e jsonb;
  eff text;
  best jsonb;
  best_eff text;
  best_i integer := -1;
  latest jsonb;
  latest_eff text;
  latest_i integer := -1;
BEGIN
  IF sets IS NULL OR jsonb_typeof(sets) <> 'array' THEN
    RETURN NULL;
  END IF;
  FOR i, e IN
    SELECT (t.ord - 1)::integer, t.value
    FROM jsonb_array_elements(sets) WITH ORDINALITY AS t(value, ord)
  LOOP
    IF jsonb_typeof(e) <> 'object' THEN
      CONTINUE;
    END IF;
    eff := e ->> 'effective';
    IF eff IS NULL OR eff !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      CONTINUE;
    END IF;
    IF latest IS NULL OR eff > latest_eff OR (eff = latest_eff AND i > latest_i) THEN
      latest := e;
      latest_eff := eff;
      latest_i := i;
    END IF;
    IF eff <= work_date AND (best IS NULL OR eff > best_eff OR (eff = best_eff AND i > best_i)) THEN
      best := e;
      best_eff := eff;
      best_i := i;
    END IF;
  END LOOP;
  IF best IS NULL THEN
    best := latest;
    best_eff := latest_eff;
    best_i := latest_i;
  END IF;
  IF best IS NULL THEN
    RETURN NULL;
  END IF;
  RETURN jsonb_build_object(
    'entry', best,
    'version', COALESCE(NULLIF(best ->> 'id', ''), best_eff || '#' || best_i::text)
  );
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_overhead_per_hour(entry jsonb, inactive jsonb, items jsonb)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  paid numeric;
  util numeric;
  pool numeric;
  n integer;
  hrs numeric;
  ex_owner boolean;
BEGIN
  IF entry IS NULL OR jsonb_typeof(entry) <> 'object' THEN
    RETURN 0;
  END IF;
  paid := private.fp_json_num(entry -> 'paidHoursPerYear');
  util := private.fp_json_num(entry -> 'utilization');
  IF paid IS NULL OR paid <= 0 OR util IS NULL OR util <= 0 THEN
    RETURN COALESCE(private.fp_json_num(entry -> 'legacyOverheadPerHour'), 0);
  END IF;
  ex_owner := COALESCE((entry ->> 'excludeOwnerFromDivisor')::boolean, true);
  IF entry ->> 'overheadMode' = 'items' THEN
    SELECT COALESCE(sum(
      CASE WHEN it ->> 'period' = 'mo' THEN COALESCE(private.fp_json_num(it -> 'amount'), 0) * 12
           ELSE COALESCE(private.fp_json_num(it -> 'amount'), 0) END
    ), 0)
      INTO pool
    FROM jsonb_array_elements(COALESCE(items, '[]'::jsonb)) AS it;
  ELSE
    pool := COALESCE(private.fp_json_num(entry -> 'overheadPool'), 0);
  END IF;
  SELECT count(*) INTO n
  FROM public.crew AS c
  JOIN public.crew_private AS p ON p.crew_id = c.id
  WHERE COALESCE(private.fp_to_num(p.hourly), 0) > 0
    AND NOT (ex_owner AND COALESCE(p.is_owner, false))
    AND NOT (COALESCE(inactive, '{}'::jsonb) ? c.sort_order::text);
  hrs := n * paid * util;
  IF hrs > 0 THEN
    RETURN pool / hrs;
  END IF;
  RETURN 0;
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

-- Returns the original text when nothing needed a stamp, so a save that is already
-- stamped does not rewrite the stored JSON.
CREATE OR REPLACE FUNCTION private.fp_stamp_job_records_text(raw text)
RETURNS text
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  js jsonb;
  jobs jsonb := '[]'::jsonb;
  job jsonb;
  logs jsonb;
  new_logs jsonb;
  day_key text;
  day_val jsonb;
  new_crew jsonb;
  person jsonb;
  stamped jsonb;
  changed boolean := false;
  today text;
  history jsonb;
  costing jsonb;
  inactive jsonb;
  items jsonb;
  sets jsonb;
BEGIN
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN raw;
  END IF;
  BEGIN
    js := raw::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN raw;
  END;
  IF jsonb_typeof(js) <> 'array' THEN
    RETURN raw;
  END IF;

  BEGIN
    today := to_char((timezone('America/Chicago', pg_catalog.now()))::date, 'YYYY-MM-DD');
  EXCEPTION WHEN OTHERS THEN
    today := to_char(current_date, 'YYYY-MM-DD');
  END;

  SELECT s.value::jsonb INTO history FROM public.settings AS s WHERE s.key = 'crew_history';
  SELECT s.value::jsonb INTO costing FROM public.settings AS s WHERE s.key = 'costing_settings';
  SELECT s.value::jsonb INTO inactive FROM public.settings AS s WHERE s.key = 'crew_inactive';
  SELECT s.value::jsonb INTO items FROM public.settings AS s WHERE s.key = 'overhead';
  IF history IS NULL OR jsonb_typeof(history) <> 'object' THEN
    history := '{}'::jsonb;
  END IF;
  IF inactive IS NULL OR jsonb_typeof(inactive) <> 'object' THEN
    inactive := '{}'::jsonb;
  END IF;
  IF items IS NULL OR jsonb_typeof(items -> 'items') <> 'array' THEN
    items := '[]'::jsonb;
  ELSE
    items := items -> 'items';
  END IF;
  sets := costing -> 'history';
  IF sets IS NULL OR jsonb_typeof(sets) <> 'array' THEN
    RETURN raw;
  END IF;

  FOR job IN SELECT value FROM jsonb_array_elements(js) LOOP
    IF jsonb_typeof(job) <> 'object' OR jsonb_typeof(job -> 'dayLogs') <> 'object' THEN
      jobs := jobs || jsonb_build_array(job);
      CONTINUE;
    END IF;
    new_logs := '{}'::jsonb;
    FOR day_key, day_val IN SELECT * FROM jsonb_each(job -> 'dayLogs') LOOP
      IF day_key > today
         OR day_key !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
         OR jsonb_typeof(day_val) <> 'object'
         OR jsonb_typeof(day_val -> 'crewPresent') <> 'array' THEN
        new_logs := new_logs || jsonb_build_object(day_key, day_val);
        CONTINUE;
      END IF;
      new_crew := '[]'::jsonb;
      FOR person IN SELECT value FROM jsonb_array_elements(day_val -> 'crewPresent') LOOP
        IF jsonb_typeof(person) = 'object' AND NOT private.fp_has_labor_stamp(person) THEN
          stamped := private.fp_fill_labor_stamp(person, day_key, history, sets, inactive, items);
          IF stamped IS DISTINCT FROM person THEN
            changed := true;
            person := stamped;
          END IF;
        END IF;
        new_crew := new_crew || jsonb_build_array(person);
      END LOOP;
      new_logs := new_logs || jsonb_build_object(day_key, jsonb_set(day_val, '{crewPresent}', new_crew, true));
    END LOOP;
    jobs := jobs || jsonb_build_array(jsonb_set(job, '{dayLogs}', new_logs, true));
  END LOOP;

  IF NOT changed THEN
    RETURN raw;
  END IF;
  RETURN jobs::text;
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

REVOKE ALL ON FUNCTION private.fp_to_num(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_json_num(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_has_labor_stamp(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_r2(numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_wage_for_stamp(jsonb, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_hourly_on_date(jsonb, text, text, text, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_legacy_item_overhead(jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_rate_set_for_stamp(jsonb, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_overhead_per_hour(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_fill_labor_stamp(jsonb, text, jsonb, jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_stamp_job_records_text(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_stamp_missing_labor() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS fp_stamp_missing_labor ON public.settings;
CREATE TRIGGER fp_stamp_missing_labor
  BEFORE INSERT OR UPDATE ON public.settings
  FOR EACH ROW
  WHEN (NEW.key = 'job_records')
  EXECUTE FUNCTION private.fp_stamp_missing_labor();

-- A crew save of a job the server does not have yet must update the existing
-- job_records row, not insert a second one. See the header.
CREATE OR REPLACE FUNCTION public.fp_crew_write_job_records(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  server jsonb;
  result jsonb;
  elem jsonb;
  s jsonb;
  rebuilt jsonb;
  jid text;
  matched boolean;
BEGIN
  IF private.fp_role() IS DISTINCT FROM 'crew' THEN
    RAISE EXCEPTION 'not allowed';
  END IF;
  IF payload IS NULL OR jsonb_typeof(payload) <> 'array' THEN
    RAISE EXCEPTION 'job_records payload must be a JSON array';
  END IF;

  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records' FOR UPDATE;
  IF raw IS NULL OR btrim(raw) = '' THEN
    server := '[]'::jsonb;
  ELSE
    server := raw::jsonb;
  END IF;
  IF jsonb_typeof(server) <> 'array' THEN
    RAISE EXCEPTION 'job_records is damaged';
  END IF;

  result := server;
  FOR elem IN SELECT value FROM jsonb_array_elements(payload) LOOP
    IF jsonb_typeof(elem) <> 'object' THEN
      CONTINUE;
    END IF;
    jid := elem ->> 'id';
    IF jid IS NULL OR jid = '' THEN
      CONTINUE;
    END IF;
    matched := false;
    rebuilt := '[]'::jsonb;
    FOR s IN SELECT value FROM jsonb_array_elements(result) LOOP
      IF s ->> 'id' = jid THEN
        rebuilt := rebuilt || jsonb_build_array(private.fp_overlay_json(s, elem));
        matched := true;
      ELSE
        rebuilt := rebuilt || jsonb_build_array(s);
      END IF;
    END LOOP;
    IF NOT matched THEN
      rebuilt := rebuilt || jsonb_build_array(private.fp_redact_json(elem));
    END IF;
    result := rebuilt;
  END LOOP;

  UPDATE public.settings SET value = result::text WHERE key = 'job_records';
  IF NOT FOUND THEN
    INSERT INTO public.settings (key, value) VALUES ('job_records', result::text);
  END IF;
  RETURN private.fp_redact_json(result);
END;
$$;

REVOKE ALL ON FUNCTION public.fp_crew_write_job_records(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fp_crew_write_job_records(jsonb) TO authenticated;

-- Fill stamps already missing on the stored row. Entries that have a rate are
-- returned unchanged, and the text is left as-is when nothing was missing.
UPDATE public.settings
   SET value = value
 WHERE key = 'job_records'
   AND value IS NOT NULL
   AND btrim(value) <> '';

COMMIT;
