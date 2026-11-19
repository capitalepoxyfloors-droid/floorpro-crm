-- Extra words for two lead sources: who referred them, or a short description
-- of Other. The chosen option stays in leads.source so a monthly export can
-- group on that column. This file only adds a nullable column.
--
-- It does not change any existing source value, and it does not add a
-- NOT NULL or a CHECK. Old rows stay exactly as they are, including
-- "Wave", "Facebook / Social", "Other", "Google / Website", and blanks.
--
-- Row security is unchanged. Owner and office can already read and write
-- leads. Crew cannot. A new column on this table does not open that up.
-- Table grants already cover columns added later, so this file grants nothing.
--
-- Apply on the test project (nndjnywtkgxwvxajwztg) first.
-- Do not run this on the live project (cngbsmmdfxmerlqnkate) until the
-- page that writes source_detail is ready to ship.
-- Rollback: supabase/rollback/20261119140000_lead_source_detail.sql

BEGIN;

ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS source_detail text;

COMMENT ON COLUMN public.leads.source_detail IS
  'Who referred this lead, or a short description when source is Other. Null for every other source. Not a replacement for leads.source.';

COMMIT;
