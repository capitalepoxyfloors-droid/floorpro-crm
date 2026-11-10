-- Strip per-unit prices from job JSON before a crew login can read it.
--
-- REVIEW ONLY. Do not apply this on the live project from here.
-- It replaces private.fp_secret_key, which fp_crew_read_job_records and the
-- crew job-record save already call. It does not UPDATE, INSERT, or DELETE
-- any stored row. Prices already saved stay saved for the office.
--
-- A read of the stored job_records keys showed unitCost on
-- dayLogs[].materialsUsed[] is the only cost-like key that is not already
-- removed with its parent. amount is the dollar field inside commissions and
-- supplierInvoices (those parents are already removed). It is listed too, so
-- a stray amount on a material line cannot come through either.
-- unit and usageUnit are measures (Lbs, Gallon), not prices, and stay.
--
-- Rollback: supabase/rollback/20261110123000_strip_crew_unit_cost.sql

BEGIN;

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
    'price', 'hourly', 'wage',
    'unitcost', 'amount'
  );
$$;

REVOKE ALL ON FUNCTION private.fp_secret_key(text) FROM PUBLIC;

-- Used only by the check below, then dropped. Not part of the app.
CREATE FUNCTION private.fp_cost_key_hits(j jsonb, cost_keys text[])
RETURNS TABLE (k text)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  WITH RECURSIVE walk AS (
    SELECT j AS node, NULL::text AS k
    UNION ALL
    SELECT child.node, child.k
    FROM walk AS w
    CROSS JOIN LATERAL (
      SELECT e.value AS node, e.key AS k
      FROM jsonb_each(w.node) AS e
      WHERE jsonb_typeof(w.node) = 'object'
      UNION ALL
      SELECT a.value, NULL::text
      FROM jsonb_array_elements(w.node) AS a
      WHERE jsonb_typeof(w.node) = 'array'
    ) AS child
  )
  SELECT lower(walk.k)
  FROM walk
  WHERE lower(coalesce(walk.k, '')) = ANY (cost_keys);
$$;

-- Proves the new list on a sample job, then on the stored job_records row.
-- Read-only: it never writes settings. leftover_cost_keys must be 0.
DO $check$
DECLARE
  fixture jsonb := $json$[
    {
      "customer": "Sample Shop",
      "phone": "314-555-0100",
      "address": "1 Main St",
      "value": "4821.77",
      "displayVal": "$4,821.77",
      "unitCost": 19.41,
      "amount": 88.25,
      "price": 12,
      "hourly": 20,
      "wage": 18,
      "supplierInvoices": [{"vendor": "Acme", "invoiceNum": "100", "amount": 88.25, "description": "Flake"}],
      "commissions": [{"recipient": "Office", "amount": 10, "type": "flat"}],
      "dayLogs": {
        "2026-11-02": {
          "task": "Coat",
          "materialsUsed": [
            {"name": "Flake", "qty": "4", "usageUnit": "Lbs", "unit": "Lbs", "unitCost": 19.41, "price": 3.5, "amount": 77.64}
          ]
        }
      }
    }
  ]$json$::jsonb;
  redacted jsonb;
  raw text;
  n integer;
  bad text;
  cost_keys text[] := ARRAY[
    'unitcost', 'amount', 'value', 'displayval', 'price', 'hourly', 'wage',
    'burdenedrate', 'directrate', 'otrate', 'baserate', 'overheadrate',
    'mileagerate', 'mileageoneway', 'supplierinvoices', 'commissions',
    'prevailingwage', 'prevailingwagerate', 'prevailingwageburden',
    'consumablespct', 'tmlabormarkup', 'tmmaterialmarkup', 'overtimewage', 'cashwages'
  ];
BEGIN
  redacted := private.fp_redact_json(fixture);
  IF redacted #>> '{0,customer}' IS DISTINCT FROM 'Sample Shop'
     OR redacted #>> '{0,phone}' IS DISTINCT FROM '314-555-0100'
     OR redacted #>> '{0,address}' IS DISTINCT FROM '1 Main St'
     OR redacted #>> '{0,dayLogs,2026-11-02,materialsUsed,0,name}' IS DISTINCT FROM 'Flake'
     OR redacted #>> '{0,dayLogs,2026-11-02,materialsUsed,0,qty}' IS DISTINCT FROM '4'
     OR redacted #>> '{0,dayLogs,2026-11-02,materialsUsed,0,unit}' IS DISTINCT FROM 'Lbs'
     OR redacted #>> '{0,dayLogs,2026-11-02,materialsUsed,0,usageUnit}' IS DISTINCT FROM 'Lbs' THEN
    RAISE EXCEPTION 'redact removed a field the crew job card still needs';
  END IF;

  SELECT count(*)::integer, string_agg(DISTINCT hit.k, ', ' ORDER BY hit.k)
    INTO n, bad
  FROM private.fp_cost_key_hits(redacted, cost_keys) AS hit;
  IF n <> 0 THEN
    RAISE EXCEPTION 'sample job still has cost keys after redact: %', bad;
  END IF;

  SELECT s.value INTO raw FROM public.settings AS s WHERE s.key = 'job_records';
  IF raw IS NULL OR btrim(raw) = '' THEN
    RAISE NOTICE 'crew redact check: leftover_cost_keys=0 (no stored job_records; sample passed)';
    RETURN;
  END IF;

  redacted := private.fp_redact_json(raw::jsonb);
  SELECT count(*)::integer, string_agg(DISTINCT hit.k, ', ' ORDER BY hit.k)
    INTO n, bad
  FROM private.fp_cost_key_hits(redacted, cost_keys) AS hit;
  RAISE NOTICE 'crew redact check: leftover_cost_keys=%', n;
  IF n <> 0 THEN
    RAISE EXCEPTION 'stored jobs still expose cost keys after redact: %', bad;
  END IF;
END
$check$;

DROP FUNCTION private.fp_cost_key_hits(jsonb, text[]);

-- Read-only query to run by hand after this file is applied.
-- It does not write. leftover_cost_keys must come back 0.
--
-- WITH RECURSIVE walk AS (
--   SELECT private.fp_redact_json(s.value::jsonb) AS node, NULL::text AS k
--   FROM public.settings AS s
--   WHERE s.key = 'job_records'
--   UNION ALL
--   SELECT child.node, child.k
--   FROM walk AS w
--   CROSS JOIN LATERAL (
--     SELECT e.value AS node, e.key AS k
--     FROM jsonb_each(w.node) AS e
--     WHERE jsonb_typeof(w.node) = 'object'
--     UNION ALL
--     SELECT a.value, NULL::text
--     FROM jsonb_array_elements(w.node) AS a
--     WHERE jsonb_typeof(w.node) = 'array'
--   ) AS child
-- )
-- SELECT count(*) AS leftover_cost_keys
-- FROM walk
-- WHERE lower(coalesce(k, '')) IN (
--   'unitcost', 'amount', 'value', 'displayval', 'price', 'hourly', 'wage',
--   'burdenedrate', 'directrate', 'otrate', 'baserate', 'overheadrate',
--   'mileagerate', 'mileageoneway', 'supplierinvoices', 'commissions',
--   'prevailingwage', 'prevailingwagerate', 'prevailingwageburden',
--   'consumablespct', 'tmlabormarkup', 'tmmaterialmarkup', 'overtimewage', 'cashwages'
-- );

COMMIT;
