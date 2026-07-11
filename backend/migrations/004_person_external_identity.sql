CREATE TABLE person_external_id (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  provider_id INTEGER NOT NULL REFERENCES metadata_provider(id),
  id_type TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider_id, id_type, external_id)
);

CREATE INDEX idx_person_external_id_person
  ON person_external_id(person_id, provider_id);
