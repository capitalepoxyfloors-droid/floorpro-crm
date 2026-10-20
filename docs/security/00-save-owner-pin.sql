-- Run this in the Supabase SQL editor BEFORE the migration.
-- The live database has no admin_pin row. The app has been accepting the manager
-- code that was written into the page. Type that same code below, run this once,
-- and do not commit this file after you fill it in.
--
-- Replace only the digits. Keep the quotes. The code must be exactly 4 digits,
-- the same length the keypad accepts.

INSERT INTO public.settings (key, value)
VALUES ('admin_pin', 'REPLACE_WITH_THE_CODE_YOU_TYPE_TODAY')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();
