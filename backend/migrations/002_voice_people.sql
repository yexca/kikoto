CREATE TABLE IF NOT EXISTS person (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  sort_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(display_name)
);

CREATE TABLE IF NOT EXISTS person_alias (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(person_id, alias)
);

CREATE TABLE IF NOT EXISTS work_credit (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  provider_id INTEGER REFERENCES metadata_provider(id),
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS idx_work_credit_person
  ON work_credit(person_id, role);

CREATE TABLE IF NOT EXISTS user_person_state (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  rating INTEGER,
  note TEXT NOT NULL DEFAULT '',
  favorite INTEGER NOT NULL DEFAULT 0,
  last_viewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, person_id)
);

CREATE TABLE IF NOT EXISTS user_person_tag (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS user_person_tag_assignment (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  user_person_tag_id INTEGER NOT NULL REFERENCES user_person_tag(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, person_id, user_person_tag_id)
);
