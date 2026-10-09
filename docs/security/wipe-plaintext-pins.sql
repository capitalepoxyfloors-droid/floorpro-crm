-- OPTIONAL. Do not run on cutover night.
-- Run only after the new sign-in has worked for a few days and you have a backup
-- you are willing to keep (that backup still contains the old plaintext PINs).
-- After this, a database rollback cannot restore the old keypad codes.
-- People can still sign in with the hashed PINs.

UPDATE public.settings
SET value = '', updated_at = now()
WHERE key IN ('admin_pin', 'crew_pins', 'office_users');
