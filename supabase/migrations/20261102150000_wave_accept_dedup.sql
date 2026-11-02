-- Stop the Wave sync from adding a second board card for a job that is already here.
--
-- The office PC script (sync-wave-estimates.ps1) is not in this repo. It inserts an
-- 'approved' row into public.jobs, with the estimate stamped as "Wave #123" in notes,
-- whenever that number is not in settings.wave_synced_estimates. It does not look at
-- the card already on the board or in settings.job_records. That is how an accepted
-- estimate became a second card for a job that was already in progress, including when
-- the note still held an older estimate number.
--
-- This trigger runs on every insert into public.jobs, including that script (service
-- role) and a card saved from the page. No edge function is involved.
--
--   (a) The same Wave number is already in a job note, a customer name, or a schedule
--       card: the insert is skipped. Nothing else is changed.
--   (b) The same customer already has an active job, but this estimate number is not
--       on any card: the new Approved card is still created. No existing note, price,
--       or schedule is changed. A notice asks the owner to choose "Replaces #X on
--       <job>" (then that job's note takes the new number and keeps the old one as
--       superseded, and the new card is removed) or "New job card" (leave the card
--       that was just created). If nobody answers, the new card stays.
--   Otherwise the insert goes through, with no notice.
--
-- Running the sync again does not add another card or another "superseded" line.
-- The notice lives in settings.wave_link_notices. Crew cannot read that key, and they
-- cannot read public.jobs. The accepted amount is never written onto the schedule card.
--
-- NEEDS APPROVAL BEFORE LIVE. Applied to the test project only
-- (nndjnywtkgxwvxajwztg). Do not run it on the live project until that approval.
-- Rollback: supabase/rollback/20261102150000_wave_accept_dedup.sql

BEGIN;

CREATE OR REPLACE FUNCTION private.fp_wave_extract(notes text, customer text, job_label text, detail text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  n text;
BEGIN
  n := (regexp_match(coalesce(notes, ''), 'Wave #([0-9]+)', 'i'))[1];
  IF n IS NOT NULL THEN RETURN n; END IF;
  n := (regexp_match(coalesce(customer, ''), 'Wave #([0-9]+)', 'i'))[1];
  IF n IS NOT NULL THEN RETURN n; END IF;
  n := (regexp_match(coalesce(job_label, ''), 'Wave #([0-9]+)', 'i'))[1];
  IF n IS NOT NULL THEN RETURN n; END IF;
  n := (regexp_match(coalesce(detail, ''), 'Wave #([0-9]+)', 'i'))[1];
  IF n IS NOT NULL THEN RETURN n; END IF;
  n := (regexp_match(coalesce(customer, ''), '#([0-9]+)[[:space:]]*$'))[1];
  IF n IS NOT NULL THEN RETURN n; END IF;
  n := (regexp_match(coalesce(job_label, ''), '#([0-9]+)[[:space:]]*$'))[1];
  RETURN n;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_text_has_wave(txt text, num text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT num ~ '^[0-9]+$'
    AND coalesce(txt, '') ~* ('(^|[^0-9])(Wave|superseded) #' || num || '([^0-9]|$)');
$$;

CREATE OR REPLACE FUNCTION private.fp_board_status_active(status text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(lower(btrim(status)), '') NOT IN
    ('invoiced', 'lost', 'archived', 'deleted', 'cancelled', 'canceled');
$$;

CREATE OR REPLACE FUNCTION private.fp_name_tokens(name text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT coalesce(array_agg(tok), ARRAY[]::text[])
  FROM (
    SELECT lower(m[1]) AS tok
    FROM regexp_matches(
      regexp_replace(lower(coalesce(name, '')), '#[0-9]+', ' ', 'g'),
      '[[:alpha:]]{3,}',
      'g'
    ) AS m
  ) s
  WHERE tok <> ALL (ARRAY[
    'main','floor','floors','garage','pool','house','epoxy','flake','coating','concrete',
    'polished','polish','phase','room','bath','bathroom','bathrooms','basement','patio',
    'shop','unit','building','commercial','residential','overlay','metallic','urethane',
    'sealer','good','better','best','the','and','for','llc','inc','company','construction',
    'crew','job','new','old','with','from','lane','road','street','drive','avenue',
    'north','south','east','west','suite','lot','apt','apartment'
  ]::text[]);
$$;

-- Same person or company. Exact cleaned name, or a shared word that is not only a
-- first name. "Matt Haeffner" matches "Haeffner - Pool House Garage". "Matt Burger"
-- does not match "Matt Vandeloecht". "Brian Cox" does not match "Brian Adams".
CREATE OR REPLACE FUNCTION private.fp_customer_same(a text, b text)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  na text;
  nb text;
  ta text[];
  tb text[];
  shared text[];
  firsts text[] := ARRAY[
    'matt','mat','john','mike','michael','david','james','robert','chris','jason','brian',
    'steve','steven','mark','paul','jeff','scott','ryan','eric','adam','kevin','daniel',
    'andrew','josh','justin','brandon','hunter','will','william','mary','lisa','sarah',
    'jennifer','amanda','nicole','bob','bill','tom','thomas','rick','gary','tim','joe',
    'jim','dan','ben','sam','alex','tony','greg','doug','ken','kyle','sean','shawn',
    'aaron','peter','jack','nick','luke','jake','cole','drew','ann','anna','amy','kate',
    'katie','laura','emma','olivia','chris','christopher','dan','danny','pat','patrick'
  ];
BEGIN
  na := btrim(regexp_replace(regexp_replace(lower(coalesce(a, '')), '#[0-9]+', ' ', 'g'), '[^a-z0-9]+', ' ', 'g'));
  nb := btrim(regexp_replace(regexp_replace(lower(coalesce(b, '')), '#[0-9]+', ' ', 'g'), '[^a-z0-9]+', ' ', 'g'));
  na := btrim(regexp_replace(na, '\s+', ' ', 'g'));
  nb := btrim(regexp_replace(nb, '\s+', ' ', 'g'));
  IF na = '' OR nb = '' THEN RETURN false; END IF;
  IF na = nb THEN RETURN true; END IF;
  ta := private.fp_name_tokens(a);
  tb := private.fp_name_tokens(b);
  SELECT coalesce(array_agg(DISTINCT t), ARRAY[]::text[]) INTO shared
  FROM unnest(ta) AS t
  WHERE t = ANY (tb);
  IF shared IS NULL OR cardinality(shared) = 0 THEN RETURN false; END IF;
  RETURN EXISTS (SELECT 1 FROM unnest(shared) s WHERE NOT (s = ANY (firsts)));
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_wave_rewrite_note(old_note text, new_num text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
  src text := coalesce(old_note, '');
  current text;
  superseded text[] := ARRAY[]::text[];
  n text;
  tail text;
BEGIN
  IF new_num IS NULL OR new_num !~ '^[0-9]+$' THEN
    RETURN src;
  END IF;
  current := (regexp_match(src, 'Wave #([0-9]+)', 'i'))[1];
  FOR n IN
    SELECT m[1] FROM regexp_matches(src, 'superseded #([0-9]+)', 'gi') AS m
  LOOP
    IF n IS NOT NULL AND n <> new_num AND NOT n = ANY (superseded) THEN
      superseded := superseded || n;
    END IF;
  END LOOP;
  IF current IS NOT NULL AND current <> new_num AND NOT current = ANY (superseded) THEN
    superseded := array_prepend(current, superseded);
  END IF;
  tail := regexp_replace(src, 'Wave #[0-9]+', '', 'gi');
  tail := regexp_replace(tail, 'superseded #[0-9]+', '', 'gi');
  tail := regexp_replace(tail, '[[:space:]]*\|[[:space:]]*', ' | ', 'g');
  tail := regexp_replace(tail, '^([[:space:]]*\|[[:space:]]*)+|([[:space:]]*\|[[:space:]]*)+$', '', 'g');
  tail := regexp_replace(tail, '([[:space:]]*\|[[:space:]]*){2,}', ' | ', 'g');
  tail := btrim(tail);
  RETURN 'Wave #' || new_num
    || coalesce((SELECT string_agg(' | superseded #' || s, '') FROM unnest(superseded) AS s), '')
    || CASE WHEN tail <> '' THEN ' | ' || tail ELSE '' END;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_wave_job_records()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  jobs jsonb;
BEGIN
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN '[]'::jsonb;
  END IF;
  BEGIN
    jobs := raw::jsonb;
    IF jsonb_typeof(jobs) = 'string' THEN
      jobs := (jobs #>> '{}')::jsonb;
    END IF;
    IF jsonb_typeof(jobs) IS DISTINCT FROM 'array' THEN
      RETURN '[]'::jsonb;
    END IF;
    RETURN jobs;
  EXCEPTION WHEN OTHERS THEN
    RETURN '[]'::jsonb;
  END;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_wave_read_state()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  state jsonb;
BEGIN
  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'wave_link_notices' FOR UPDATE;
  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN jsonb_build_object('allow', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;
  BEGIN
    state := raw::jsonb;
    IF jsonb_typeof(state) = 'string' THEN
      state := (state #>> '{}')::jsonb;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    state := NULL;
  END;
  IF state IS NULL OR jsonb_typeof(state) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('allow', '[]'::jsonb, 'notices', '[]'::jsonb);
  END IF;
  IF jsonb_typeof(state->'allow') IS DISTINCT FROM 'array' THEN
    state := state || jsonb_build_object('allow', '[]'::jsonb);
  END IF;
  IF jsonb_typeof(state->'notices') IS DISTINCT FROM 'array' THEN
    state := state || jsonb_build_object('notices', '[]'::jsonb);
  END IF;
  RETURN state;
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_wave_write_state(state jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.settings (key, value)
  VALUES ('wave_link_notices', state::text)
  ON CONFLICT (key) DO UPDATE
    SET value = EXCLUDED.value,
        updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_wave_put_notice(notice jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  state jsonb;
  kept jsonb := '[]'::jsonb;
  elem jsonb;
  i int;
BEGIN
  state := private.fp_wave_read_state();
  FOR i IN 0..coalesce(jsonb_array_length(state->'notices'), 0) - 1 LOOP
    elem := state->'notices'->i;
    IF coalesce(elem->>'id', '') IS DISTINCT FROM coalesce(notice->>'id', '') THEN
      kept := kept || jsonb_build_array(elem);
    END IF;
  END LOOP;
  state := jsonb_set(state, '{notices}', kept || jsonb_build_array(notice));
  PERFORM private.fp_wave_write_state(state);
END;
$$;

CREATE OR REPLACE FUNCTION private.fp_jobs_wave_dedup()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  num text;
  records jsonb;
  elem jsonb;
  jobrec record;
  i int;
  j int;
  hit boolean := false;
  state jsonb;
  allowed boolean := false;
  cands jsonb := '[]'::jsonb;
  matches jsonb := '[]'::jsonb;
  cand jsonb;
  board_id text;
  attached boolean;
  same_count int;
  old_num text;
  accepted text;
  candidates jsonb;
BEGIN
  IF TG_OP IS DISTINCT FROM 'INSERT' THEN
    RETURN NEW;
  END IF;

  num := private.fp_wave_extract(NEW.notes, NEW.customer, NEW.job_label, NEW.detail);
  IF num IS NULL OR num !~ '^[0-9]+$' THEN
    RETURN NEW;
  END IF;

  -- (a) This estimate number is already written down somewhere.
  SELECT EXISTS (
    SELECT 1 FROM public.jobs AS j
    WHERE private.fp_text_has_wave(j.notes, num)
       OR private.fp_text_has_wave(j.customer, num)
       OR private.fp_text_has_wave(j.job_label, num)
       OR private.fp_text_has_wave(j.detail, num)
       OR private.fp_text_has_wave(j.crew, num)
       OR coalesce(j.customer, '') ~ ('#' || num || '[[:space:]]*$')
       OR coalesce(j.job_label, '') ~ ('#' || num || '[[:space:]]*$')
  ) INTO hit;

  records := private.fp_wave_job_records();
  IF NOT hit THEN
    FOR i IN 0..coalesce(jsonb_array_length(records), 0) - 1 LOOP
      elem := records->i;
      IF private.fp_text_has_wave(elem::text, num)
         OR coalesce(elem->>'customer', '') ~ ('#' || num || '[[:space:]]*$')
      THEN
        hit := true;
        EXIT;
      END IF;
    END LOOP;
  END IF;
  IF hit THEN
    RETURN NULL;
  END IF;

  -- The owner already said this estimate is a separate job.
  state := private.fp_wave_read_state();
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(state->'allow') AS e(val)
    WHERE e.val = num
  ) INTO allowed;
  IF allowed THEN
    RETURN NEW;
  END IF;

  -- Active board rows.
  FOR jobrec IN
    SELECT j.id::text AS id, j.customer, j.notes, j.status
    FROM public.jobs AS j
    WHERE private.fp_board_status_active(j.status)
  LOOP
    cands := cands || jsonb_build_array(jsonb_build_object(
      'kind', 'job',
      'jobId', jobrec.id,
      'customer', jobrec.customer,
      'notes', jobrec.notes,
      'status', jobrec.status,
      'recordId', NULL,
      'recordCustomer', NULL,
      'recordValue', NULL
    ));
  END LOOP;

  -- Schedule cards. A card linked to a board row is the same job, not a second match.
  FOR i IN 0..coalesce(jsonb_array_length(records), 0) - 1 LOOP
    elem := records->i;
    IF NOT private.fp_board_status_active(elem->>'status') THEN
      CONTINUE;
    END IF;
    board_id := nullif(btrim(coalesce(elem->>'boardRowId', '')), '');
    attached := false;
    IF board_id IS NOT NULL THEN
      FOR j IN 0..coalesce(jsonb_array_length(cands), 0) - 1 LOOP
        IF cands->j->>'jobId' = board_id THEN
          cands := jsonb_set(
            cands,
            ARRAY[j::text],
            (cands->j) || jsonb_build_object(
              'recordId', elem->>'id',
              'recordCustomer', elem->>'customer',
              'recordValue', elem->>'value'
            )
          );
          attached := true;
          EXIT;
        END IF;
      END LOOP;
      IF attached THEN
        CONTINUE;
      END IF;
      -- Linked board row is invoiced or gone. A closed job does not block a new estimate.
      IF EXISTS (
        SELECT 1 FROM public.jobs AS j
        WHERE j.id::text = board_id
          AND NOT private.fp_board_status_active(j.status)
      ) THEN
        CONTINUE;
      END IF;
    END IF;

    same_count := 0;
    FOR j IN 0..coalesce(jsonb_array_length(cands), 0) - 1 LOOP
      IF private.fp_customer_same(elem->>'customer', cands->j->>'customer') THEN
        same_count := same_count + 1;
        IF same_count = 1 THEN
          cands := jsonb_set(
            cands,
            ARRAY[j::text],
            (cands->j) || jsonb_build_object(
              'recordId', elem->>'id',
              'recordCustomer', elem->>'customer',
              'recordValue', elem->>'value'
            )
          );
        END IF;
      END IF;
    END LOOP;
    IF same_count = 1 THEN
      CONTINUE;
    END IF;
    IF same_count = 0 THEN
      cands := cands || jsonb_build_array(jsonb_build_object(
        'kind', 'schedule',
        'jobId', NULL,
        'customer', elem->>'customer',
        'notes', NULL,
        'status', elem->>'status',
        'recordId', elem->>'id',
        'recordCustomer', elem->>'customer',
        'recordValue', elem->>'value'
      ));
    END IF;
  END LOOP;

  FOR i IN 0..coalesce(jsonb_array_length(cands), 0) - 1 LOOP
    cand := cands->i;
    IF private.fp_customer_same(NEW.customer, cand->>'customer')
       OR (
         nullif(cand->>'recordCustomer', '') IS NOT NULL
         AND private.fp_customer_same(NEW.customer, cand->>'recordCustomer')
       )
    THEN
      matches := matches || jsonb_build_array(cand);
    END IF;
  END LOOP;

  -- No other active job for this customer. The new card is the whole story.
  IF coalesce(jsonb_array_length(matches), 0) = 0 THEN
    RETURN NEW;
  END IF;

  -- Same customer, new estimate number. Create the card (that is the default) and
  -- do not touch the other jobs. The owner can later say this estimate replaces one
  -- of them. A repeat customer with several jobs, such as a GC, keeps every card.
  accepted := nullif(btrim(coalesce(NEW.display_val, '')), '');
  IF accepted IS NULL THEN
    accepted := nullif(btrim(coalesce(NEW.value, '')), '');
  END IF;
  candidates := '[]'::jsonb;
  FOR i IN 0..jsonb_array_length(matches) - 1 LOOP
    cand := matches->i;
    old_num := (regexp_match(coalesce(cand->>'notes', ''), 'Wave #([0-9]+)', 'i'))[1];
    IF old_num IS NULL THEN
      old_num := (regexp_match(coalesce(cand->>'customer', ''), '#([0-9]+)[[:space:]]*$'))[1];
    END IF;
    candidates := candidates || jsonb_build_array(jsonb_build_object(
      'jobId', cand->>'jobId',
      'customer', coalesce(cand->>'recordCustomer', cand->>'customer'),
      'status', cand->>'status',
      'notes', cand->>'notes',
      'waveNum', old_num,
      'recordId', cand->>'recordId',
      'kind', cand->>'kind'
    ));
    EXIT WHEN i >= 7;
  END LOOP;
  PERFORM private.fp_wave_put_notice(jsonb_build_object(
    'id', num,
    'kind', 'choose',
    'estimate', num,
    'at', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'incomingCustomer', NEW.customer,
    'newJobId', NEW.id,
    'acceptedAmount', accepted,
    'candidates', candidates
  ));
  INSERT INTO public.audit_log (actor, action, entity, details)
  VALUES (
    'Wave sync',
    'board_job_created',
    coalesce(NEW.customer, 'Job'),
    'Wave #' || num || ' added as a new card. Existing jobs were not changed.'
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION private.fp_wave_extract(text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_text_has_wave(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_board_status_active(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_name_tokens(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_customer_same(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_wave_rewrite_note(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_wave_job_records() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_wave_read_state() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_wave_write_state(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_wave_put_notice(jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.fp_jobs_wave_dedup() FROM PUBLIC, anon, authenticated;

-- The insert runs as service_role (the office script) or authenticated (the page).
-- The function stays in the private schema, so the API cannot call it.
GRANT EXECUTE ON FUNCTION private.fp_jobs_wave_dedup() TO service_role, authenticated;

DROP TRIGGER IF EXISTS fp_jobs_wave_dedup ON public.jobs;
CREATE TRIGGER fp_jobs_wave_dedup
  BEFORE INSERT ON public.jobs
  FOR EACH ROW
  EXECUTE FUNCTION private.fp_jobs_wave_dedup();

COMMIT;
