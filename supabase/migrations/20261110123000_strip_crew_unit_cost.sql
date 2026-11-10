-- Hide per-unit prices from a crew login.
--
-- APPLY 20261110120000_preserve_secret_array_fields.sql FIRST.
-- That file keeps stored unitCost on the matching material line and adds
-- unitCost and amount to the secret list. This file refuses to run without
-- that merge. Applying only this file would erase stored unitCost the next
-- time a crew member saves a job.
--
-- If the preserve file is already applied, this file sets the same secret
-- list again and checks that a crew read of the stored jobs has no cost keys.
-- It does not UPDATE, INSERT, or DELETE any stored row.
--
-- unit and usageUnit are measures (Lbs, Gallon), not prices, and stay.
--
-- To undo both files, run
-- supabase/rollback/20261110120000_preserve_secret_array_fields.sql
-- Do not roll this file back by itself after the preserve file is applied.

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('private.fp_merge_secret_array(jsonb,jsonb,text)') IS NULL THEN
    RAISE EXCEPTION 'Apply supabase/migrations/20261110120000_preserve_secret_array_fields.sql first. Hiding unitCost without that merge would erase stored material costs on the next crew save.';
  END IF;
END
$guard$;

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
