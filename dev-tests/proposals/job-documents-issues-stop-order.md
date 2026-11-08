# Proposal only. Do not apply.

This file is not a migration. Nothing here has been run on floorpro-crm-test or on the live project. The app does not use it.

Reviewed against the current app and the role-split settings policies. Sources named in the design: Ops and Helias for documents, the Business Coach for the foreman brief, and the Chief of Staff for issues.

## What already exists

Job documents are one list per job in the settings key `job_docs`: `{ id, date, name, path, url, size }`. There is no document name separate from the file name, no current revision, and no history. A file is added to that list only after the storage upload returns success, then the whole list is saved. A failed save leaves the previous list on the server. A second upload of the same file name becomes another row. The list sorts by calendar date, not by the new bytes, so two uploads on the same day do not reliably open the newest after a reload. Office can delete a document. Crew can read `job_docs`, and the settings policy also lets a crew session insert and update that key. Hiding the delete button does not remove that write.

There is no job-issue record, no Open or Unassigned list, and no "Issue recorded" action.

Stop order is not a column on `scheduled_slots`. The test screen lists the day's jobs in name order. It does not save an order and it does not change the schedule.

No-work is one flag on the whole day log for that job. It keeps the clocks already typed, including a second person on the same log, and it does not change another job. The audit insert can store the actor name plus the date, the stop, and the people listed on that log. This repo's migrations do not define an `audit_log.created_at` column, so a recorded time is not proven from here. Crew cannot read the audit log. The flag cannot be limited to one person. That is not the designed per-person no-work, and it stays blocked.

## What would have to exist before those screens are real

Do not store revisions or issues inside `job_records` or `job_docs`. Crew can already write both, and a whole-blob save can race.

```sql
-- NOT APPLIED. Review only.

create table public.job_documents (
  id uuid primary key default gen_random_uuid(),
  job_id text not null,
  title text not null,
  created_at timestamptz not null default now()
);

create table public.job_document_revisions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.job_documents(id),
  storage_path text not null,
  byte_size bigint not null,
  uploaded_at timestamptz not null default now(),
  uploaded_by text not null,
  became_current_at timestamptz
);

create table public.job_issues (
  id uuid primary key default gen_random_uuid(),
  job_id text not null,
  work_date date not null,
  note text not null,
  category text,
  photo_path text,
  reporter text not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  owner text,
  due_on date,
  created_at timestamptz not null default now()
);

create table public.crew_day_stop_order (
  crew_idx int not null,
  work_date date not null,
  stop_key text not null,
  position int not null,
  updated_at timestamptz not null default now(),
  primary key (crew_idx, work_date, stop_key)
);
```

Access still has to be written to match `private.fp_is_staff()` and `private.fp_role()` before any of this is applied. The intended split is: office manages documents, revisions, issues, and stop order; crew can read the current document only; crew cannot delete a document or a revision; a revision becomes current only when `became_current_at` is set after a successful upload; a failed upload inserts nothing. Issue capture for crew stays off until office can read the open, unassigned list from the same table. The confirmation, when that exists, is "Issue recorded" and only after the insert succeeds. It does not say the office was notified.

No messages, drafts, or publishing are part of this proposal.
