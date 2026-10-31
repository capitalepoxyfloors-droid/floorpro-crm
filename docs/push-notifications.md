# Phone notifications (test project)

Notifications are wired for the test project only (`nndjnywtkgxwvxajwztg`). The live project (`cngbsmmdfxmerlqnkate`) is not changed. The published page keeps working when `fp_push_status` is missing: the button stays hidden and messages still send.

## Try it on a phone

The site and the service worker have to be the same installed app, at `/floorpro-crm/`.

1. On the phone, open `https://capitalepoxyfloors-droid.github.io/floorpro-crm/?env=test`
2. The sign-in screen says **Test project**. Sign in with a test PIN.
3. Open **Team** (crew: the Team button on Crew View). Tap **Turn on notifications** once and allow them.
4. Company-thread alerts stay off until that person checks the box on the same card. Direct messages, job-thread posts, and @mentions do not use that box.

That address serves the page that is on `main`. This branch is what adds the button and `sw.js`. Until it is merged, the test database is ready and the published page does not show the button yet.

### Android

Chrome can turn notifications on from the browser. You can also install CrewBoard (menu → Install app / Add to Home screen). The icon badge is the unread total of team, job, and direct messages.

### iPhone

Web Push works only from the Home Screen icon, on iOS 16.4 or newer.

1. Open the test link in Safari (not from an old icon).
2. Tap **Share**, then **Add to Home Screen**.
3. Open CrewBoard from that new icon. The sign-in screen must still say **Test project**. If it does not, delete the icon and add it again from the test link.
4. Sign in, open Team, and tap **Turn on notifications**.

The test manifest uses `start_url` `/floorpro-crm/?env=test` and `scope` `/floorpro-crm/`, so the icon opens the test project. The normal manifest (no `?env=test`) stays the live app.

Tapping a notification opens that thread: a direct message, a job thread, or the company thread.

## What a notification contains

The sender's name and the first line of the message. Dollar amounts, phone numbers, and long numbers are left off the lock screen. Pay, PINs, and phone numbers from the directory are not included.

## Undo the test database

`supabase/rollback/20261031180000_push_notifications.sql` on the test project only. It drops the push tables, functions, and triggers, and the vault rows named `vapid_private_key`, `vapid_public_key`, `push_webhook_secret`, and `push_webhook_url`. It does not drop messages or change who can see pay.
