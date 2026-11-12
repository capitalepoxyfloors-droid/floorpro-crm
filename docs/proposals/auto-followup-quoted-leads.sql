-- PROPOSAL ONLY. Do not run this against production and do not add it as a migration.
--
-- CrewBoard moves an Estimate Sent lead to Follow-Up after 7 days. That used to
-- happen in the browser for every office, PM, and agent sign-in, and the audit
-- row was filed under that person. The page now does it only when the owner
-- account is signed in, changes only the stage, and only while the lead is
-- still quoted.
--
-- A clock in the database would not depend on someone opening the app. It does
-- not fit without a migration: the 7-day timer is not a column. It lives in
-- settings.value for key 'lead_quoted_dates', as JSON
-- { "<lead id or name>": "<ISO time>" }. The function below reads that JSON,
-- updates leads.stage, writes an audit row as System, and clears timers that
-- are done or no longer apply. Scheduling it also needs pg_cron (or an outside
-- scheduler calling the function). Neither is applied by this change.
--
-- Hourly is enough. The 7-day mark does not need to be exact to the minute.
--   SELECT cron.schedule(
--     'fp-auto-followup-quoted-leads',
--     '15 * * * *',
--     $$SELECT private.fp_auto_followup_quoted_leads()$$
--   );

CREATE OR REPLACE FUNCTION private.fp_auto_followup_quoted_leads()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  raw text;
  timers jsonb;
  key text;
  started timestamptz;
  lead_name text;
  moved integer := 0;
  next_timers jsonb := '{}'::jsonb;
BEGIN
  SELECT s.value INTO raw
  FROM public.settings AS s
  WHERE s.key = 'lead_quoted_dates'
  FOR UPDATE;

  IF raw IS NULL OR btrim(raw) = '' THEN
    RETURN 0;
  END IF;
  timers := raw::jsonb;
  IF jsonb_typeof(timers) IS DISTINCT FROM 'object' THEN
    RETURN 0;
  END IF;

  FOR key IN SELECT jsonb_object_keys(timers) LOOP
    BEGIN
      started := (timers ->> key)::timestamptz;
    EXCEPTION WHEN others THEN
      started := NULL;
    END;

    SELECT l.name INTO lead_name
    FROM public.leads AS l
    WHERE l.id::text = key
      AND l.stage = 'quoted';

    IF lead_name IS NULL THEN
      -- Already moved or archived: drop the timer. A key that is not a lead
      -- id at all (an older name key) is left alone.
      IF EXISTS (SELECT 1 FROM public.leads AS l WHERE l.id::text = key) THEN
        CONTINUE;
      END IF;
      next_timers := next_timers || jsonb_build_object(key, timers -> key);
      CONTINUE;
    END IF;

    IF started IS NOT NULL AND started <= (now() - interval '7 days') THEN
      UPDATE public.leads
         SET stage = 'followup'
       WHERE id::text = key
         AND stage = 'quoted';
      IF FOUND THEN
        moved := moved + 1;
        INSERT INTO public.audit_log (actor, action, entity, details)
        VALUES (
          'System – auto Follow-Up after 7 days: ' || lead_name,
          'lead_updated',
          lead_name,
          'Stage: followup'
        );
      END IF;
    ELSE
      next_timers := next_timers || jsonb_build_object(key, timers -> key);
    END IF;
  END LOOP;

  UPDATE public.settings
     SET value = next_timers::text
   WHERE key = 'lead_quoted_dates';

  RETURN moved;
END;
$$;
