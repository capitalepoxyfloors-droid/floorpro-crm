# Test checklist (floorpro-crm-test first)

Project: **floorpro-crm-test** (`nndjnywtkgxwvxajwztg`). Do not run this list against the live project.

Use a copy of the new `index.html` pointed at the test project: set `SUPABASE_URL` and `SUPABASE_KEY` to the test project's URL and anon key, and open the file locally. Do not commit that edit.

## Setup

1. Dashboard → SQL: run `docs/security/00-save-owner-pin.sql` with a manager code you will remember (exactly 4 digits — the old code; you'll be made to pick a 6-digit one at first sign-in). On a copy of live data there is no saved manager code until you do this. If any saved crew or office PIN is not 4 digits, change it to 4 digits before the migration.
2. This project already ran the Oct 9 migration, and the Oct 19 version adds columns above the policies line. So run `docs/security/full-reset.sql` first, then the **whole** `supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql`. It should finish without an error. If it stops with "Row security is still off on: …", add that table to the migration.
3. Deploy functions from this repo (JWT check **off** for pin-login only):

   ```bash
   supabase link --project-ref nndjnywtkgxwvxajwztg
   supabase functions deploy pin-login --no-verify-jwt
   supabase functions deploy pin-admin
   ```

4. In a private browser window, try to open this without signing in (it should fail or return `[]`):

   `https://nndjnywtkgxwvxajwztg.supabase.co/rest/v1/leads?select=id&limit=1`

   with the test anon key as both `apikey` and `Authorization: Bearer`. Same for `settings?key=eq.crew_pins`, `ops_backups?select=*`, and a public photo URL (`/storage/v1/object/public/vehicle-docs/...`). Public photo URLs should no longer load.
5. Security Advisor (Dashboard → Advisors): zero row-security errors, and the performance advisor does not list the `fp_*` policies for per-row `auth` calls.

## Sign-in

6. Fresh browser (no saved sign-in): the screen lists names, owner first, then office, then crew. Inactive crew are not listed. The list response (`{"action":"roster"}`) contains only id, kind, label, pin_len — no hashes, no lock info.
7. Owner first sign-in: tap Will, type the old 4-digit code → asked for a new 6-digit code, twice. Mismatched second entry starts the new code over. A new code that begins with the old one is refused. After it's accepted, the full sidebar opens (Owner). Sign out → the keypad comes back on Will with 6 dots. The old 4-digit code no longer works. Audit Log + Dashboard banner show "Code changed to 6 digits on first sign-in".
8. Office first sign-in: same 6-digit prompt. Then the full app, corner shows their name and Office, and Security is missing from the menu.
9. Crew: tap a crew name, 4 dots, their PIN opens Crew View only. Tapping other sidebar items does nothing. The phone goes straight to that name next time; "Not you? Pick a different name" goes back to the list.
9a. **Lockout.** Wrong PIN 4 times → "not recognized". 5th → "locked for 15 more minutes"; the right PIN is refused while locked. Another person signs in normally meanwhile (no crew-wide lockout). Audit Log + Dashboard banner show the lock. Security page shows **🔒 Unlock** on that row; tapping it lets the right PIN in at once.
9b. Third lockout inside 24 hours on a crew account → "Ask Will to unlock it", stays locked past 15 minutes until Unlock. Do the same on the owner: never held, 1 hour on the third.
9c. **Spike + header.** 20 wrong PINs spread across accounts in 15 minutes → one "Failed sign-in spike" alert, not 20. Send a request with your own `X-Forwarded-For: 1.2.3.4` header: note whether the per-network backstop counts it under 1.2.3.4 (if so, the backstop is spoofable; the per-person lock is what matters).
10. An inactive crew member is not on the list, and a direct pin-login call with their account id is refused.
11. Sign out returns to the keypad. Refresh keeps you in for the same session. After you sign out, refresh shows the keypad.
12. Security page: crew rows say "PIN on file" or "No PIN". A 5-digit crew code is rejected; a 4-digit one works. Manager code and office PINs must be 6 digits. Saving a new crew PIN, then signing out, works with the new PIN and fails with the old one; a new PIN also clears any lockout. In Authentication → Users, that person is still one user. Their old tab cannot keep loading jobs. Clearing a PIN blocks that person.
12b. PIN change signs the other session out. Stay signed in as a crew member in one browser. In another, as the owner, set a new PIN for that person. In the first browser, reloading jobs must fail, `pin-admin` (`whoami`) with the old access token must return 401, and the old refresh token at `POST /auth/v1/token?grant_type=refresh_token` must not return a new access token. Same for the manager code from a second owner session.
12c. Add an office person (6-digit PIN, name must not match anyone else on the list), sign in as them, remove them as the owner. Their open tab cannot save or reload data.
12d. Turn off public signups by hand: **Authentication → Sign In / Providers** → **User Signups** → switch off **Allow new users to sign up** → **Save changes**. Leave Email enabled and anonymous sign-ins off. A never-used crew PIN still signs in. `POST /auth/v1/signup` is rejected.
12e. Mark a test crew member inactive. Their name leaves the list, their open tab cannot load jobs, and they cannot write `crew_inactive`. Reactivate and confirm they're back.

## Screens (owner)

Do one small save on each, then refresh and confirm it stuck.

13. Dashboard loads (and the security banner Dismiss button clears it for everyone).
14. Install schedule: add a test slot and delete it. Drag a bar to another day and back.
15. Sales schedule.
16. Jobs board and a job card. Daily log: add a note, a crew-day chip, and confirm the whole-day OT checkbox still behaves as before (weekend OT rules unchanged — do not "fix" them).
17. Job photos: an existing photo still appears (it may take a moment). An archived photo shows the "Archived to Google Photos" tile. Upload a new one, open it full size, delete the test photo.
18. Job documents and sales-scope photos: open one existing file.
19. Leads pipeline: open a lead. Addresses and phones still show.
20. Materials, including a product sheet open.
21. Crew / installers: pay fields still load.
22. PTO on the schedule, and PTO requests (approve, deny, send back).
23. Job costing and the costing summary page.
24. Payroll. Spot-check one person's hours against what you expect. Do not change overtime rules.
25. Vehicles: open a document.
26. Audit log shows the sign-in or the PIN change you just made.
27. Settings you actually use (holidays, menu order, mileage rate, overhead) still save.

## Screens (crew) — watch for any red "Save failed"

28. Crew view, all 4 weeks. Their jobs, day chips, and PTO show as before.
29. Tap a job on their schedule that has no job card yet (writes `slot_job_map`). Open a job they are on. Day log saves (`job_records`). A photo already on the job displays. Upload and delete a test photo (`job_photos`).
30. Submit a PTO request and edit it while pending (`pto_requests`). Submit a material request (`material_requests`).
31. Product docs open.
32. They cannot reach Payroll, Leads, or Security through the menu.
33. With the crew access token, through the API: writing any other settings key (e.g. `overhead`) is refused, deleting any settings row removes nothing, and `ops_backups` returns no rows.

## Office PC and cloud jobs

34. With the test project's service key saved the same way (or a temporary copy of the scripts pointed at test): `backup-data-to-drive.ps1` writes a JSON snapshot; `backup-storage-to-drive.ps1` lists and downloads from the private bucket.
35. Wave sync: run `sync-wave-estimates.ps1` once with the service key; it reads settings/jobs/leads without errors. Press the Jobs-page Wave sync button and run `wave-sync-watcher.ps1` by hand; `wave_sync_request_done` updates.
36. photo-jobs dry runs: `photo-jobs.ps1 -Action sync`, `-Action cleanup`, `-Action restore -PhotoId <an archived id>` (all without `-Live`) report normally against the private bucket.

## After you are done with the test project

37. You can leave row security on there. To put the test project back, run `docs/security/rollback.sql` and use the old `index.html`.
