-- Puts the crew price-key list back to the list from
-- 20261024193000_stamp_prior_wage_and_legacy_burden.sql.
-- Does not change settings.job_records.

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
    'price', 'hourly', 'wage'
  );
$$;

REVOKE ALL ON FUNCTION private.fp_secret_key(text) FROM PUBLIC;

COMMIT;
