-- A purchase bonus (購入特典, 早期購入特典) is its own DLsite product with its
-- own files, but the provider declares no relationship to the product it was
-- distributed with. This row attaches the bonus work to that parent product's
-- family by code. It is not an edition: the bonus keeps its own work, edition
-- family, playback and availability, and the parent code never becomes a work.
--
-- status:
--   linked     parent_code names the parent product.
--   unmatched  automatic detection found no single parent.
--   dismissed  a user removed the link; detection no longer runs.
-- origin records whether metadata sync or a user decided the current status.
CREATE TABLE work_purchase_bonus (
  work_id INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  parent_code TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK(status IN ('linked', 'unmatched', 'dismissed')),
  origin TEXT NOT NULL CHECK(origin IN ('detected', 'user')),
  evidence TEXT NOT NULL DEFAULT '',
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((status = 'linked') = (parent_code <> ''))
);

CREATE INDEX idx_work_purchase_bonus_parent_code
  ON work_purchase_bonus(UPPER(parent_code))
  WHERE status = 'linked';
CREATE INDEX idx_fk_work_purchase_bonus_provider_id ON work_purchase_bonus(provider_id);
CREATE INDEX idx_fk_work_purchase_bonus_updated_by_user_id ON work_purchase_bonus(updated_by_user_id);
