# Test checklist (floorpro-crm-test first)

Project: **floorpro-crm-test** (`nndjnywtkgxwvxajwztg`). Do not run this list against the live project.

Use a copy of the new `index.html` pointed at the test project: set `SUPABASE_URL` and `SUPABASE_KEY` to the test project's URL and anon key, and open the file locally. Do not commit that edit.

## Setup

1. Dashboard → SQL: run `docs/security/00-save-owner-pin.sql` with a manager code you will remember (exactly 4 digits). On a copy of live data there is no saved manager code until you do this. If any saved crew or office PIN is not 4 digits, change it to 4 digits before the migration. The keypad cannot type a longer code.
2. Run `supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql` in the SQL editor. It should finish without an error. If this project already has `pin_accounts` from an earlier run, do not run the whole file again (it stops because the owner row exists). Run from the line `-- POLICIES ONLY BELOW THIS LINE.` through the end. That re-applies policies and installs `fp_revoke_sessions`. Then redeploy `pin-admin`.
3. Deploy functions from this repo (JWT check **off** for pin-login only):

   ```bash
   supabase link --project-ref nndjnywtkgxwvxajwztg
   supabase functions deploy pin-login --no-verify-jwt
   supabase functions deploy pin-admin
   ```

4. In a private browser window, try to open this without signing in (it should fail or return `[]`):

   `https://nndjnywtkgxwvxajwztg.supabase.co/rest/v1/leads?select=id&limit=1`

   with the test anon key as both `apikey` and `Authorization: Bearer`. Same for `settings?key=eq.crew_pins` and a public photo URL (`/storage/v1/object/public/vehicle-docs/...`). Public photo URLs should no longer load.

## Sign-in

5. Wrong PIN shakes the keypad and does not open the app.
6. Owner / manager code opens the full sidebar. Name shows Will Bradford, role Owner.
7. A crew PIN opens Crew View only. Tapping other sidebar items does nothing. The person chip matches that PIN, not whoever was picked last time.
8. An office PIN opens the full app, the corner shows their name and Office, and Security is missing from the menu.
9. An inactive crew member's PIN is rejected.
10. Sign out returns to the keypad. Refresh keeps you in for the same session. After you sign out, refresh shows the keypad.
11. Security page: crew rows say "PIN on file" or "No PIN" and the box is empty. A 5-digit code is rejected. Saving a new 4-digit crew PIN, then signing out, works with the new PIN and fails with the old one. In Authentication → Users, that person is still one user, not a second account. Their old tab cannot keep loading jobs. Clearing a PIN (empty box + Save + confirm) blocks that person, and their old tab cannot load jobs either.
11b. PIN change signs the other session out. Stay signed in as a crew member in one browser (or keep that browser's refresh token). In another browser, as the owner, set a new 4-digit PIN for that same person. In the first browser, reloading jobs must fail, and calling `pin-admin` (`whoami` or `list`) with the old access token must return 401. Using the old refresh token at `POST /auth/v1/token?grant_type=refresh_token` must not return a new access token. Do the same for the manager code: change it from a second owner session, and the first owner session's refresh token must die the same way. The person is still one Auth user.
12. Add an office person, sign in as them, remove them as the owner. Their open tab cannot save or reload data. Reload shows the keypad.
12b. Turn off public signups by hand: **Authentication → Sign In / Providers** (address ends in `/auth/providers`) → **User Signups** → switch off **Allow new users to sign up** → **Save changes**. Leave Email enabled and **Allow anonymous sign-ins** off. Sign in with a crew PIN that has never been used. It should still open Crew View. A public signup (`POST /auth/v1/signup`) should be rejected. If a signup from before the switch still has a token, `GET /rest/v1/jobs` with that token returns nothing.
12c. Mark a test crew member inactive. Their PIN is rejected. Their already-open tab cannot load jobs, and they cannot turn themselves back on by writing `settings` key `crew_inactive`. Reactivate them and confirm the PIN works again.

## Screens (owner)

Do one small save on each, then refresh and confirm it stuck.

13. Dashboard loads.
14. Install schedule: open a slot, change nothing harmful if you can avoid it; or add a test slot and delete it.
15. Sales schedule.
16. Jobs board and a job card. Daily log: add a note, a crew-day chip, and confirm the whole-day OT checkbox still behaves as before (weekend OT rules unchanged — do not "fix" them).
17. Job photos: an existing photo still appears (it may take a moment). Upload a new one, open it full size, delete the test photo.
18. Job documents and sales-scope photos: open one existing file.
19. Leads pipeline: open a lead. Addresses and phones still show.
20. Materials, including a product sheet open.
21. Crew / installers: pay fields still load. Marking someone inactive still blocks their PIN (try it on a test person and turn them back on).
22. PTO on the schedule, and PTO requests.
23. Job costing and the costing summary page.
24. Payroll. Spot-check one person's hours against what you expect. Do not change overtime rules.
25. Vehicles: open a document.
26. Audit log shows the sign-in or the PIN change you just made.
27. Settings you actually use (holidays, menu order) still save.

## Screens (crew)

28. Crew view, all 4 weeks. Their jobs, day chips, and PTO show as before.
29. Open a job they are on. Day log saves. A photo already on the job displays. Upload and delete a test photo.
30. Product docs open.
31. They cannot reach Payroll, Leads, or Security through the menu.

## After you are done with the test project

32. You can leave row security on there. To put the test project back, run `docs/security/rollback.sql` and use the old `index.html`.
