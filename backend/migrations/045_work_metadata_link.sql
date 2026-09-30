-- A user-declared metadata source for a work whose own provider product is no
-- longer published, such as a bonus edition later sold under another code.
-- Metadata sync requests source_code and stores the result on work_id; it does
-- not create a work, edition, alias, or file availability for source_code.
CREATE TABLE work_metadata_link (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id) ON DELETE CASCADE,
  source_code TEXT NOT NULL CHECK(source_code <> ''),
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, provider_id)
);

CREATE INDEX idx_fk_work_metadata_link_provider_id ON work_metadata_link(provider_id);
CREATE INDEX idx_fk_work_metadata_link_updated_by_user_id ON work_metadata_link(updated_by_user_id);
