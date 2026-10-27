-- Exclusive upload finalization (build-upload-fixes.mjs; security review 2026-10-23). Additive only: three new columns
-- (nullable or defaulted). The previous Worker keeps working on this schema (it never reads or writes them).
-- finalize_token: random token of the finisher that currently holds the finalization lease of a sealed upload; the
--   revision insert and the upload's publication are fenced on it.
-- finalize_until: lease expiry (ms since epoch). Cleanup never fails a sealed upload while its lease is live.
-- final_writes: final-object R2 writes in flight (raised before the put, lowered when it settles; only while the lease
--   of a sealed upload is held). Cleanup purges a failed upload's final object only at 0, so no late write survives.
-- Retry: applied as one unit with its d1_migrations row (see 0010_version_history.sql).
ALTER TABLE uploads ADD COLUMN finalize_token TEXT;
ALTER TABLE uploads ADD COLUMN finalize_until INTEGER;
ALTER TABLE uploads ADD COLUMN final_writes INTEGER NOT NULL DEFAULT 0;
