# Live rollout: messages, then the cleanup

Do not run any of this until Will says go. Nothing here has been run on live (`cngbsmmdfxmerlqnkate`). The test project is `nndjnywtkgxwvxajwztg`.

Take a database backup before the SQL. Keep it outside the repo.

## Merge order

1. Merge PR #11 (`cursor/job-messaging-c11c`) into `main` first.
2. Then merge PR #12 (`cursor/crewboard-cleanup-c11c`).

PR #12 is based on the messaging branch, not on `main`. After #11 is on `main`, retarget #12 to `main` so the review shows only the cleanup.

If #11 is squash-merged, the cleanup branch still contains the old messaging commits. Rebase #12 onto `main` before retargeting, or GitHub will try to bring those messaging commits in a second time. A normal merge of #11 does not need that rebase. Retarget, then merge #12.

GitHub Pages ships whatever is on `main`. Merge #12 only when the database steps below are done or in progress with someone watching, because the new page calls the message functions.

## Database, in order

1. `sql/01-job-messages.sql` — the only messaging migration from PR #11. Run it once. If it fails partway, run `supabase/rollback/20261028170000_job_messages.sql` before a second try.
2. Deploy the edge functions (below) before asking anyone to change a PIN.
3. `sql/02-clear-plaintext-pins.sql` — run the SELECT, save it outside the repo, then run the DELETE. Do this only after an owner, an office person, and a crew member have signed in on the new site. Deleting those rows means a database rollback cannot restore the old typed codes. Hashed sign-in keeps working.

## Edge functions to redeploy

Live has the same two functions as test. Redeploy both, in this order, from the PR #12 tree (it contains the duplicate-PIN check):

1. `pin-login` with JWT verification off (`--no-verify-jwt`). Sign-in has no token yet.
2. `pin-admin` with JWT verification on (the default).

```powershell
supabase functions deploy pin-login --no-verify-jwt --use-api --project-ref cngbsmmdfxmerlqnkate
supabase functions deploy pin-admin --use-api --project-ref cngbsmmdfxmerlqnkate
```

No other edge function is part of this rollout.

## Smoke test after deploy

Use the live site after a hard refresh.

- Owner signs in with the manager code and lands on the dashboard. Payroll opens.
- Office signs in and can open the office pages. They cannot open Security settings.
- Crew signs in and lands on Crew View. Sign out is the way back. Payroll does not open. The job value stays hidden.
- On the company Team thread, post a short line and see it come back.
- On a job the crew member is on, post a short line and see it come back. A job they are not on does not open.
- Set a throwaway PIN to a code someone else already has. It is refused with "That PIN is already in use, pick another." Put the throwaway PIN back, or remove that test person, before anyone else needs the list.
