-- Review gating: proposal text lives in R2, like version text (migration 0028). Additive: one nullable column.
-- A text proposal stores its bytes at text/<project>/<artifact>/<proposal id> and names the key here; approving the
-- proposal points the new version's body_key at the same object (nothing is copied). proposals.body stays for rows
-- written before this column. The previous Worker never reads this column or the proposals table.
ALTER TABLE proposals ADD COLUMN body_key TEXT;
