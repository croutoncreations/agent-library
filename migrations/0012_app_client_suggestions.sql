-- App Connect: owner-set default destination for a registered app (docs/app-connect.md#suggested-destination).
-- Both optional; additive and retry-safe (new nullable columns only).
ALTER TABLE app_clients ADD COLUMN suggested_project TEXT;  -- project id or title the consent page pre-selects
ALTER TABLE app_clients ADD COLUMN suggested_folder TEXT;   -- folder name the consent page pre-fills
