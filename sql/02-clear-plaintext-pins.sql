-- Live rollout step 2. Do not run this until the new site is up and sign-in works.
-- Do not run this on the test project as part of preparing this file.
-- It removes the leftover plaintext PIN rows. The real codes live as hashes in pin_accounts.
-- Save the SELECT result outside the repo before the DELETE. That result is the only copy of the old digits.

-- 1. Back up first. Run this and keep the result.
SELECT key, value, updated_at
FROM public.settings
WHERE key IN ('admin_pin', 'crew_pins')
ORDER BY key;

-- 2. After that result is saved, run this.
DELETE FROM public.settings
WHERE key IN ('admin_pin', 'crew_pins');
