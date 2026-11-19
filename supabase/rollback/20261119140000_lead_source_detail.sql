-- Drops leads.source_detail. Does not change leads.source.
-- Any referral names or Other descriptions stored in source_detail are deleted.

BEGIN;

ALTER TABLE public.leads DROP COLUMN IF EXISTS source_detail;

COMMIT;
