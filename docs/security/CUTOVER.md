# CrewBoard security cutover

## For Will (plain English)

Anyone on the internet who has the key baked into the website can currently read and change everything: customer addresses and phones, gate and garage codes, and the PINs. The photo folder is public too.

This change closes that. People still sign in with the same PIN keypad. The server checks the PIN and only then lets the app read data. The PINs are stored scrambled, and the website can no longer download them. Old photos keep working without a one-time rewrite of every job. Nothing about scheduling, day logs, costing, or overtime is meant to change.

Do this on the **test project first** (`docs/security/TEST-CHECKLIST.md`). Do it on the live project on a quiet evening, in the order below. Do not skip the backup.

Everyone will have to enter their PIN once more. After that, the app remembers them for the same 24 hours of use as today.

The manager code was never saved in the database. The page itself contained it. Part of this cutover copies that code into a scrambled form so you are not locked out, and you should set a new manager code the same night.

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

The Drive script `backup-data-to-drive.ps1` can no longer use the anon key after step 3. Run it **before** the migration if you want one more JSON snapshot, while the anon key still works. After cutover it reads `SUPABASE_SERVICE_ROLE_KEY` from the environment on that PC.

**Restore:** in an emergency, create a new Supabase project and load `floorpro-live-before-rls.sql`, or use the dashboard's point-in-time restore. For a bad policy rather than bad data, you do not need this file — use the rollback in step 9, which is faster. Use the dump if rows were damaged.

### 2. Save the current manager code

Run `docs/security/00-save-owner-pin.sql` in the SQL editor after replacing the placeholder with the code you type on the keypad today. That code is the one that was built into the page, because it was never saved on the server. Do not commit the filled-in file.

### 3. Apply the migration

Paste `supabase/migrations/20261009143000_rls_pin_auth_private_storage.sql` into the SQL editor and run it once.

If it stops with "No usable admin_pin", step 2 did not stick. Fix that and run this again.

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
  -H "Content-Type: application/json" -d '{"pin":"0000"}'
```

You want "not recognized", not a missing-function error.

### 5. Accounts

You do not create crew in the dashboard. Step 3 already scrambled every PIN that was on file. Each person's Auth user is created the first time that PIN is accepted. After the site is up, sign in once as the owner so you know your code works before anyone else needs it.

Then turn off public signups by hand. This is not part of the SQL. In the dashboard: **Authentication → Sign In / Providers** (the address ends in `/auth/providers`) → section **User Signups** → turn off **Allow new users to sign up** → click **Save changes**. Leave the Email provider enabled, and leave **Allow anonymous sign-ins** off. Sign in again with a crew PIN that has not been used yet. That proves the first-login account create still works with public signups off. A random person using the public signup page should get an error, and even a signup that already happened cannot read jobs.

### 6. Deploy the website

Merge this branch to `main` only after the test checklist passed and steps 3–4 succeeded on live. GitHub Pages deploys on that push. Hard-refresh (Ctrl+Shift+R) after a minute.

If the keypad says it cannot reach the server, the functions from step 4 are not live yet. The old site is already replaced, so fix the functions before going home. Rollback is step 9 if you need the old site back in a few minutes.

### 7. Smoke test

Owner signs in. Open schedule, one job, one existing photo, payroll. Change the manager code on the Security page the same night (the old one was in the public page source). Sign out and back in with the new code.

Tell crew: the app will ask for their PIN again. Same PIN. If they were in the middle of a day log, finish the save before you start step 3, or after you finish step 6.

### 8. Other programs that used the anon key

- **Wave sync.** The Jobs button only writes a flag. A watcher on the office PC reads it. The comment in the app says that watcher runs every couple of minutes. After step 3 the anon key cannot see `settings`, so Wave import stops until that watcher sends the **service_role** key (kept on that PC, never in the website). Confirm where that script lives. This repo does not contain it.
- **Google Photos.** Settings has `google_photos_album_id` and `google_photos_synced`. They are Google ids, not links to our files, and this repo never reads them. Making the bucket private does not rewrite them. If a separate sync downloads photos by the old public link, that download will fail and needs a signed URL or the service role. In-app photos do not.
- **backup-data-to-drive.ps1** now requires `SUPABASE_SERVICE_ROLE_KEY` in the environment.

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
2. Put the new service_role key in the Wave watcher and in `SUPABASE_SERVICE_ROLE_KEY` for the backup script.
3. Redeploy is not usually required for the functions; they read the project key from Supabase. Sign in once to confirm. If pin-login returns a configuration error, redeploy both functions.
4. Everyone enters their PIN again.

Until you do this, the old anon key is still inside the previous website and this page, but row security stops it from reading data. Rotation is what makes the leaked key useless even if row security were turned off by mistake.

### Later, optional

`docs/security/wipe-plaintext-pins.sql` blanks the old PIN rows. Do not run it on cutover night. Your backup from step 1 will still contain them.

`docs/security/full-reset.sql` drops the PIN tables and deletes the keypad Auth users. Do not run it on cutover night.

## Open questions

1. Where is the Wave watcher, and is it using the anon key? It will stop at step 3 until it uses the service role.
2. Is anything outside this repo still uploading job photos to Google Photos by public URL?
3. Crew and office can still read the same tables the owner can, once signed in, because that is what the app loads today. Say if crew should be blocked from leads, payroll figures, or gate codes at the database — that would be a follow-up and can change Crew View.
4. PINs are exactly 4 digits, matching the keypad. A 4-digit PIN is still guessable by a patient attacker who can use many networks. The rate limit slows that down.
