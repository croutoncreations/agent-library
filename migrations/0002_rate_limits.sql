-- Fixed one-minute windows per key (identity / auth-failure source). Old windows are pruned opportunistically.
CREATE TABLE rate_counters (
  k TEXT NOT NULL,
  win INTEGER NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY (k, win)
);
-- At most one active upload per identity, enforced by the database (not a read-then-write check).
CREATE UNIQUE INDEX uploads_one_active ON uploads(principal_id) WHERE state IN ('pending','receiving','received','sealed');
