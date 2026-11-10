-- Do not run this after 20261110120000_preserve_secret_array_fields.sql.
-- That file's rollback puts the merge and the secret list back together.
-- Running only this rollback would stop treating unitCost as secret while the
-- new merge is still installed, and a crew save that no longer sends unitCost
-- would erase the stored prices.

BEGIN;

DO $guard$
BEGIN
  IF to_regprocedure('private.fp_merge_secret_array(jsonb,jsonb,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Run supabase/rollback/20261110120000_preserve_secret_array_fields.sql instead. Rolling back only the secret list would let a crew save drop stored unitCost.';
  END IF;
END
$guard$;

-- The preserve migration was not applied, so this file's apply guard never
-- changed the database. There is nothing to undo.

COMMIT;
