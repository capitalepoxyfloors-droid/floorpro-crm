-- PROPOSAL ONLY. Do not run this against production and do not add it as a migration.
--
-- public.scheduled_slots has accumulated more than one row for the same crew
-- member, calendar date, and job. The app now skips that insert and shows the
-- group once. This index is the later database backstop, for review after the
-- extra rows are merged by hand.
--
-- job_type is stored as "<type>:<YYYY-MM-DD>". That suffix is the calendar
-- date. week_offset is left out of the key on purpose: a daylight-time Monday
-- used to be saved one week early, so two rows for one date can disagree on it.
-- label is the job name. Together with crew_idx and job_type this is
-- (crew member, date, job type, job name).
--
-- Building the index will fail while duplicate (crew_idx, job_type, label)
-- groups still exist. Clean those up first. Rows with a NULL label are not
-- covered (Postgres treats NULLs as distinct in a unique index).

CREATE UNIQUE INDEX IF NOT EXISTS scheduled_slots_crew_date_job_uidx
  ON public.scheduled_slots (crew_idx, job_type, label);
