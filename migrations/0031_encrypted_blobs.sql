-- Encrypted binary objects (docs/encryption.md). Additive; NULL = plaintext. The previous Worker never reads these.
ALTER TABLE uploads ADD COLUMN enc_key_id TEXT DEFAULT NULL;
ALTER TABLE uploads ADD COLUMN enc_header TEXT DEFAULT NULL;
ALTER TABLE revisions ADD COLUMN blob_key_id TEXT DEFAULT NULL;
ALTER TABLE revisions ADD COLUMN blob_header TEXT DEFAULT NULL;
