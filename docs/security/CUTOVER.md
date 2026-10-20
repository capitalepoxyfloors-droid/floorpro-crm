# CrewBoard security cutover

## For Will (plain English)

Anyone on the internet who has the key baked into the website can currently read and change everything: customer addresses and phones, gate and garage codes, and the PINs. The photo folder is public too.

This change closes that. People still sign in with the same PIN keypad. The server checks the PIN and only then lets the app read data. The PINs are stored scrambled, and the website can no longer download them. Old photos keep working without a one-time rewrite of every job. Nothing about scheduling, day logs, costing, or overtime is meant to change.

Do this on the **test project first** (`docs/security/TEST-CHECKLIST.md`). Do it on the live project on a quiet evening, in the order below. Do not skip the backup.

Everyone will have to enter their PIN once more. After that, the app remembers them for the same 24 hours of use as today.

The manager code was never saved in the database. The page itself contained it. Part of this cutover copies that code into a scrambled form so you are not locked out, and you should set a new manager code the same night.

## Oct 19 changes (after the IT review) — these override the older text below

The branch was rebuilt on current main (`secure-pin-auth-v2`, adds the archived Google Photos tiles). Then:

- **Name first, then PIN.** The sign-in screen lists names. You tap yours, then type your PIN. A phone remembers who signed in last and goes straight to that person's keypad ("Not you?" goes back to the list). Each guess is now against one person instead of everyone at once.
- **Per-person lockout.** 5 wrong PINs in a row locks that one person for 15 minutes. The third lockout within 24 hours holds a crew or office account until the owner taps **🔒 Unlock** on the Security page. The owner's own account is never held, only locked (1 hour on the third lockout), so you can't be shut out for good. There is no longer a global cap, so a stranger can't lock the whole crew out at once. A per-network backstop stays (20 misses in 15 minutes).
- **6-digit codes for owner and office.** Crew stay at 4 digits. The migration still hashes the current 4-digit owner and office codes, and marks them "must change". The first time you or office staff sign in after cutover, the keypad asks for a new 6-digit code (typed twice). That new code **is** the new manager code for cutover night.
- **Alerts.** Every lockout, every spike (20 wrong PINs across all accounts in 15 minutes, at most once an hour), and every first-sign-in code change writes a `security_alert` row to the Audit Log, and shows a red banner on the Dashboard for owner/office until someone taps Dismiss.
- **Crew can only save seven settings entries:** `job_records`, `job_photos`, `job_docs`, `slot_job_map`, `pto_requests`, `material_requests`, `material_notes` (the last two were added Oct 20 after the browser test showed crew job-document uploads and Product Docs tips failing). Crew can never delete a settings row. Owner and office can still save everything except the PIN rows. Until phase 2 moves `job_records` and `job_photos` into their own tables, the Audit Log and the nightly Drive backup are what protect against a bad save from a crew phone.
- **`ops_backups`** gets row security: the owner can read it through the app, nobody else. The bots use the service role and are not affected.
- **Speed fix.** Every policy calls its check as `(select ...)` so Postgres runs it once per query, not once per row.
- **The migration refuses to finish if any table in `public` still has row security off.** It names the table. Add it to the migration and run again. (On Oct 19 live had exactly the 11 tables the migration covers.)
- **PC scripts** use the service_role key from an encrypted file (DPAPI, this Windows user only). See step 8.

## What we chose, and the tradeoffs

**Sign-in.** An Edge Function (`pin-login`) checks the PIN and hands back a normal Supabase login. The keypad does not ask for a name. The server still figures out who it is, owner first, then office, then crew, same as the keypad did.

We did not turn the PIN into the Supabase password. A PIN is only 4 digits, and Supabase refuses passwords shorter than 6 characters. If the browser sent the PIN straight to Auth, anyone could try all 10,000 codes against a public login. The function stores a bcrypt hash the browser cannot read, limits guesses (10 misses from one network address in 15 minutes, 100 misses total), and then creates a real session.

The other approach — a Supabase user whose password is the PIN padded out to 6 characters — is simpler to host but weaker. The PIN would still be the password, and guessing would hit Auth directly. The function is a little more to deploy. That is the cost of keeping a 4-digit keypad.

**Who can see data.** Row security is on for every app table. The anonymous key can do nothing. A normal Auth signup can do nothing either: policies only allow a token whose `app_metadata.fp_role` is owner, office, or crew, and whose user is still linked to a PIN record. People cannot set `app_metadata` themselves. Anyone who signed in through the keypad can do what the app already does today, including crew, because Crew View loads jobs, schedules, and day logs. Payroll and leads are still hidden in the crew menu. They are not hidden from a crew member who knows how to call the API, because the app already downloads that data for them. PIN rows are hidden from every signed-in user, including the owner. Only the `pin-admin` function (service role, owner session required) can change them. Only owner and office can change who is inactive. Marking someone inactive, clearing their PIN, or removing office staff deletes that Auth user and signs out every session, so the old refresh token stops working.

**Photos.** The `vehicle-docs` bucket becomes private. The app reads the file path out of the public URL already saved in JSON and requests a 12-hour signed link when it draws the picture. Saved job records are not rewritten.

**Accounts.** There is no separate import. The first time a PIN is accepted, the function creates that person's Supabase Auth user and remembers them. Changing a PIN keeps that same user. It deletes that user's rows in `auth.sessions` and `auth.refresh_tokens` (the service-role function `fp_revoke_sessions`), then stores a new nonce. The old refresh token cannot mint another access token. An access token already in hand fails the nonce check, including on the PIN admin function, until it expires. You do not create users by hand in the dashboard. If a crew member has no name on file, the label is Crew 1 for the first position, Crew 2 for the next. The position number stored on schedules is unchanged.

**Public signups.** Disabling signups is a manual dashboard step. Nothing in the SQL file can flip it. Do it by hand, and do not turn off the Email provider while you are there (that is a different switch and would block PIN sign-in).

1. Open the project in the Supabase dashboard.
2. In the left sidebar, click **Authentication**.
3. Click **Sign In / Providers**. The item may be labeled **Providers**. The address ends in `/auth/providers`.
4. Find the section titled **User Signups**, at the top of that page, above the list of providers.
5. Turn **off** the switch labeled **Allow new users to sign up**. The line under it says that new users will not be able to sign up. Supabase’s docs say that with this off, only existing users can sign in.
6. On that same card, leave **Allow anonymous sign-ins** off.
7. Click **Save changes**. That button shows up after the switch changes. The change is not saved until you click it.

`pin-login` does not use the public signup form. It creates the person with the admin API first, then signs that existing user in, so the first PIN login still works after the switch. Prove it on the test project: turn the switch off, save, then sign in with a PIN that has never been used.

## What was checked here, and what was not

Checked on this branch. The live project was not modified.

- The live project was only read, before this change. Row security is off on leads, jobs, materials, crew, pto_blocks, scheduled_slots, settings, and audit_log. Vehicles already had row security with a policy that allowed everyone. The photo bucket policy allowed the anon key. There is no `admin_pin` row. `crew_pins` and `office_users` exist. `google_photos_synced` does not contain website file links.
- The migration was applied, in one transaction, to a local PostgreSQL 16 database with the same table names. Hashes from `crypt()` match bcryptjs, which is what the Edge Function uses. The anon role cannot read or insert jobs, settings, or photos. A token with no app-issued role cannot read jobs. A linked crew token can read a job and a normal setting, cannot see the PIN rows, cannot change who is inactive, and is denied the hash table. An owner token can change who is inactive. A crew token for someone marked inactive, or whose login was unlinked, cannot read jobs. If the manager code was not saved first, the migration stops and leaves nothing behind. The migration does not try to turn row security on for `storage.objects` (that line is not allowed on Supabase; it is already on).
- On that same local database, `fp_revoke_sessions` run as `service_role` deletes only that user's session, both of their refresh tokens (including one with no session id), and the MFA claim on that session. The other user's session and refresh token stay. `anon` and `authenticated` get permission denied. The existing app tests still pass, including payroll and the whole-day overtime checkbox.
- On floorpro-crm-test only, the Auth tables were read and then the same function was installed. A throwaway user with one session, two refresh tokens (one of them not tied to a session), and one MFA claim was created. The function removed those rows and left the other 5 sessions and 6 refresh tokens. The throwaway user was then deleted. `anon` and `authenticated` cannot execute the function. `service_role` can. It is owned by `postgres` and is `SECURITY DEFINER`. Refresh tokens on that project are 12 characters, which is the value GoTrue looks up. The three settings write policies were replaced so `auth.jwt()` is inside `(select ...)`. After that, the performance advisor no longer lists those policies. This was not a browser sign-in, and pin-admin was not redeployed from here, so a real refresh-token HTTP call after a PIN change still belongs on the test checklist.
- The page script parses.

Not checked, and still required on **floorpro-crm-test** before the live evening:

- Redeploy `pin-admin` from this branch, then change a PIN and confirm the other browser's refresh token is rejected (checklist step 11b). The database function is already installed on the test project. Redeploy is what makes pin-admin call it and reject a stale nonce.
- Clicking through every screen in `TEST-CHECKLIST.md`.
- Opening an existing photo and uploading a new one against the private bucket.
- The Wave watcher on the office PC, and any Google Photos sync that lives outside this repo.

The live project (`cngbsmmdfxmerlqnkate`) was not modified.

## Evening order (live)

Live project ref: `cngbsmmdfxmerlqnkate`. Have the SQL editor and a terminal ready. Plan on the website being the old one until step 6.

### 1. Backup first

In the Supabase dashboard: **Database → Backups → Download a backup** if the plan allows, or use the SQL backup / point-in-time restore your plan includes.

Also take a logical copy you can restore yourself:

```bash
supabase db dump --project-ref cngbsmmdfxmerlqnkate -f floorpro-live-before-rls.sql
```

That file contains customer data and the old PINs. Keep it off GitHub and off the website.

The Drive script `backup-data-to-drive.ps1` can no longer use the anon key after step 3. Run it **before** the migration if you want one more JSON snapshot, while the anon key still works. After cutover it reads the service_role key from the encrypted file set up in step 8a.

**Restore:** in an emergency, create a new Supabase project and load `floorpro-live-before-rls.sql`, or use the dashboard's point-in-time restore. For a bad policy rather than bad data, you do not need this file — use the rollback in step 9, which is faster. Use the dump if rows were damaged.

### 2. Save the current manager code

Run `docs/security/00-save-owner-pin.sql` in the SQL editor after replacing the placeholder with the code you type on the keypad today. That code is the one that was built into the page, because it was never saved on the server. Do not commit the filled-in file.

### 3. Apply the migration

Paste `supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql` into the SQL editor and run it once.

If it stops with "No usable admin_pin", step 2 did not stick. Fix that and run this again.

If it stops with "Row security is still off on: …", a table was added since this file was written. Add it to the migration (and to `rollback.sql`), then run again. Nothing was applied.

From this moment the old website cannot load data. Do not stop for the night between this step and the website deploy.

The photo bucket is private after this step, but Supabase’s CDN can keep serving a public URL it already cached. In a private browser window, open one old public photo link. If the picture still loads, wait (often about an hour) and try that same link again before you decide the switch failed. A hard refresh of the app does not clear that cache.

If the migration stops because a saved PIN is not exactly 4 digits, that code could not be typed on the keypad anyway (it sends the code at 4 digits). Change that PIN to 4 digits in the old app, then run the migration again. The whole file rolls back when it stops, so a failed run does not leave row security half-on.

### 4. Deploy the functions

```bash
supabase link --project-ref cngbsmmdfxmerlqnkate
supabase functions deploy pin-login --no-verify-jwt
supabase functions deploy pin-admin
```

`pin-login` must have JWT verification turned off. It is the door people knock on before they have a login. `pin-admin` keeps JWT verification on.

Quick check (replace the anon key):

```bash
curl -s -X POST "https://cngbsmmdfxmerlqnkate.supabase.co/functions/v1/pin-login" \
  -H "apikey: ANON_KEY" -H "Authorization: Bearer ANON_KEY" \
  -H "Content-Type: application/json" -d '{"action":"roster"}'
```

You want a list of names (no PINs), not a missing-function error.

### 5. Accounts

You do not create crew in the dashboard. Step 3 already scrambled every PIN that was on file. Each person's Auth user is created the first time that PIN is accepted. After the site is up, sign in once as the owner so you know your code works before anyone else needs it.

Then turn off public signups by hand. This is not part of the SQL. In the dashboard: **Authentication → Sign In / Providers** (the address ends in `/auth/providers`) → section **User Signups** → turn off **Allow new users to sign up** → click **Save changes**. Leave the Email provider enabled, and leave **Allow anonymous sign-ins** off. Sign in again with a crew PIN that has not been used yet. That proves the first-login account create still works with public signups off. A random person using the public signup page should get an error, and even a signup that already happened cannot read jobs.

### 6. Deploy the website

Merge this branch to `main` only after the test checklist passed and steps 3–4 succeeded on live. GitHub Pages deploys on that push. Hard-refresh (Ctrl+Shift+R) after a minute.

If the keypad says it cannot reach the server, the functions from step 4 are not live yet. The old site is already replaced, so fix the functions before going home. Rollback is step 9 if you need the old site back in a few minutes.

### 7. Smoke test

Owner signs in: tap your name, type the old 4-digit code, and the keypad asks for a new 6-digit code twice. That is the new manager code (the old one was in the public page source). Open schedule, one job, one existing photo, payroll. Sign out and back in with the new code. Office staff (including the Grok bot's office sign-in, if it uses one) get the same 6-digit prompt the first time.

Tell crew: the app will ask them to tap their name, then their PIN. Same PIN tonight; ask them to change it that week (owner sets it on the Security page). If they were in the middle of a day log, finish the save before you start step 3, or after you finish step 6.

### 8. Other programs that used the anon key

Do 8a and 8b any day **before** cutover night. The service key works with the old site too, so nothing breaks early.

**Done Oct 19, ~10 PM:** key saved with `-FromCli` (never displayed), switch script run, Wave Sync Watcher task run by hand afterward (result 0, normal log line), `wave-sync-watcher.ps1` run by hand, photo-jobs sync + cleanup dry runs HTTP 200, and the branch's two backup scripts run with the key (all 11 tables incl. 2,090 audit rows; storage mirror 209/209). Steps 34–36 of the test checklist are covered by this.

**8a. Save the key once:** `C:\Users\Will Bradford\tools\supabase-cli\save-service-key.ps1` (paste the legacy `service_role` key) or `save-service-key.ps1 -FromCli` (fetches it with the saved CLI token, no pasting). It refuses anything that isn't this project's service_role key, and checks it can read the database.

**8b. Switch the PC scripts:** `switch-pc-scripts-to-service-key.ps1` (same folder). It changes the one key line in `FloorPro Automation\sync-wave-estimates.ps1` and `wave-sync-watcher.ps1` (keeps `.pre-cutover` copies), and moves the retired photo scripts (`sync-photos-to-google.ps1`, `cleanup-old-photos.ps1`, `restore-archived-photos.ps1`) and the one-off `seed-wave-numbers.ps1` into `FloorPro Automation\retired`. `-Undo` puts it all back.

Everything on the office PC that talks to Supabase (checked Oct 19):

| Scheduled task / script | After cutover |
|---|---|
| FloorPro Wave Sync (daily) and FloorPro Wave Sync Watcher (hourly) → `sync-wave-estimates.ps1` | service key via 8b. It reads/writes `settings`, `jobs` **and `leads`**. |
| `wave-sync-watcher.ps1` (the Jobs-page sync button) | service key via 8b. Note: no task runs this file today — the "Watcher" task runs the full sync hourly instead. Separate bug. |
| FloorPro CRM - Nightly Data Backup → `floorpro-crm\backup-data-to-drive.ps1` | service key; switches when this branch is merged to main (step 6). The branch version backs up all 11 tables (main's only 7 — no audit_log, vehicles, vehicle_maintenance, ops_backups) and pages past Supabase's 1000-row cap (audit_log is already 2,090). PIN tables are left out on purpose. |
| FloorPro CRM - Nightly Storage Backup → `floorpro-crm\backup-storage-to-drive.ps1` | same. Was missing from git; now tracked on this branch. |
| Google Photos Sync / Photo Cleanup tasks (disabled) | retired; the `photo-jobs` cloud function does this with the service role and needs no change. Restore = `tools\supabase-cli\photo-jobs.ps1 -Action restore`. |
| Claude Code sessions fixing live data | use the same encrypted key file. |
| Sales / Mechanic / Operations / IT bots | their own Supabase management connectors (bypass row security). Grok ops bot: IT is confirming whether it signs in to CrewBoard; if so, it gets the name + 6-digit flow. |

The two backup scripts run from the `Desktop\floorpro-crm` folder itself (and so does the git post-commit hook). Keep that folder on `main`. Branch work lives in `Desktop\floorpro-crm-secure`.

**Google Photos.** `google_photos_synced` / `google_photos_items` hold Google ids and filenames, not links to our files. photo-jobs reads and writes Storage with the service role through the non-public endpoints, so the private bucket doesn't affect sync, cleanup, or restore.

### 9. Rollback (minutes)

1. Run `docs/security/rollback.sql` in the SQL editor. The anon key works again. The bucket is public again.
2. Revert the website commit and push `main` so GitHub Pages serves the old page. Hard-refresh.
3. Sign in with the manager code from step 2 (or the new one only if you did not change it). Codes changed in the new Security page after cutover are not put back into the old store. Set those again in the old Security page if you need them.

After this rollback the anon key can read `settings` again, including `admin_pin`, `crew_pins`, and `office_users`. Those plaintext codes were left in the table so the old keypad still works. Treat them as exposed again. Change the manager code in the old Security page the same night.

`rollback.sql` leaves `pin_accounts`, `pin_attempts`, the private helper functions, `fp_revoke_sessions`, and the Auth users from PIN sign-in in place. That is intentional. The old website does not use them.

Edge Functions can stay. The old page does not call them.

To turn the new protections back on the same night without hashing PINs again, run the migration **from the line that says `POLICIES ONLY BELOW THIS LINE`** through the end, then put the new website back. Do not run the whole migration a second time. The top of the file stops if an owner PIN row already exists. That policies section does not turn row security on for `storage.objects`. It is already on, and the migration role is not allowed to change that.

`docs/security/full-reset.sql` deletes those Auth users and drops the PIN tables. Run it only when you want a clean slate before applying the migration from the top. It is not part of the minute-scale rollback.

### 10. Rotate the JWT secret (last, not required to close the hole)

Do this only after step 7 worked. Dashboard → Project Settings → API → JWT secret → generate a new one (the current Supabase UI may call this rotating the signing key).

That invalidates the anon key, the service_role key, and every signed-in session. It does **not** invalidate photo signed URLs (those use a separate storage key).

Then:

1. Copy the new anon key into `SUPABASE_KEY` in `index.html` and push `main` again.
2. Run `tools\supabase-cli\save-service-key.ps1` again with the new service_role key (the PC scripts and backups all read that one file).
3. Redeploy is not usually required for the functions; they read the project key from Supabase. Sign in once to confirm. If pin-login returns a configuration error, redeploy both functions.
4. Everyone enters their PIN again.

Until you do this, the old anon key is still inside the previous website and this page, but row security stops it from reading data. Rotation is what makes the leaked key useless even if row security were turned off by mistake.

### Later, optional

`docs/security/wipe-plaintext-pins.sql` blanks the old PIN rows. Do not run it on cutover night. Your backup from step 1 will still contain them.

`docs/security/full-reset.sql` drops the PIN tables and deletes the keypad Auth users. Do not run it on cutover night.

## Open questions

1. ~~Wave watcher~~ — answered Oct 19, see step 8.
2. ~~Google Photos by public URL~~ — no; photo-jobs uses the service role.
3. **Phase 2 (about a week after cutover):** crew can still *read* every table and settings key once signed in (pay, crew personal info, costing, leads, audit log). Split policies by role so crew get jobs, schedule, day logs, photos and materials only. Moving pay and `job_records` / `job_photos` out of shared settings keys is part of that.
4. ~~4-digit guessing~~ — name-first + per-person lockout + 6-digit owner/office (Oct 19).
5. The per-network backstop reads the first `X-Forwarded-For` value. Check on the test project whether a caller can set that header themselves (test checklist step 9c). It's only a backstop now; the per-person lockout doesn't depend on it.
