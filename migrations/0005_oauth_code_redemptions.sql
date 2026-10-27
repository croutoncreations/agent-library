-- Strongly consistent single-use guard for OAuth authorization codes and refresh rotations.
-- workers-oauth-provider 1.2.1 marks a code used by rewriting its KV grant record, and KV is
-- eventually consistent across locations: two near-simultaneous redemptions in different locations
-- could both read the unused record. A D1 primary-key insert happens before any token is issued,
-- so exactly one redemption of a given code can ever succeed.
CREATE TABLE oauth_code_redemptions (
  code_hash TEXT PRIMARY KEY,
  redeemed_at INTEGER NOT NULL
);
