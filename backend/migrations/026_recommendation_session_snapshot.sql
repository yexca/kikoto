CREATE TABLE recommendation_input_revision (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO recommendation_input_revision (id, revision) VALUES (1, 0);

CREATE TABLE recommendation_user_revision (
  user_id INTEGER PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO recommendation_user_revision (user_id, revision)
SELECT id, 0 FROM user_account;

CREATE TABLE recommendation_generation (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  algorithm_version TEXT NOT NULL,
  config_json TEXT NOT NULL,
  input_revision INTEGER NOT NULL CHECK(input_revision >= 0),
  user_revision INTEGER NOT NULL CHECK(user_revision >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recommendation_generation_user_created
  ON recommendation_generation(user_id, created_at DESC, id DESC);

CREATE TABLE recommendation_snapshot (
  generation_id INTEGER NOT NULL REFERENCES recommendation_generation(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  listening_status TEXT NOT NULL DEFAULT 'none'
    CHECK(listening_status IN ('none', 'want_to_listen', 'listening', 'finished', 'relisten', 'paused')),
  favorite INTEGER NOT NULL DEFAULT 0 CHECK(favorite IN (0, 1)),
  positive_tag_matches INTEGER NOT NULL DEFAULT 0 CHECK(positive_tag_matches >= 0),
  positive_voice_matches INTEGER NOT NULL DEFAULT 0 CHECK(positive_voice_matches >= 0),
  positive_circle_matches INTEGER NOT NULL DEFAULT 0 CHECK(positive_circle_matches >= 0),
  negative_tag_matches INTEGER NOT NULL DEFAULT 0 CHECK(negative_tag_matches >= 0),
  negative_voice_matches INTEGER NOT NULL DEFAULT 0 CHECK(negative_voice_matches >= 0),
  negative_circle_matches INTEGER NOT NULL DEFAULT 0 CHECK(negative_circle_matches >= 0),
  score INTEGER NOT NULL CHECK(score BETWEEN 0 AND 100),
  PRIMARY KEY(generation_id, work_id)
);

CREATE INDEX idx_recommendation_snapshot_work_generation
  ON recommendation_snapshot(work_id, generation_id);

CREATE TABLE recommendation_snapshot_state (
  user_id INTEGER PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  current_generation_id INTEGER REFERENCES recommendation_generation(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE recommendation_client_session (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 64),
  generation_id INTEGER REFERENCES recommendation_generation(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, session_id)
);

CREATE INDEX idx_recommendation_client_session_generation
  ON recommendation_client_session(generation_id);

CREATE TRIGGER recommendation_revision_work_insert
AFTER INSERT ON work
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_delete
AFTER DELETE ON work
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_tag_insert
AFTER INSERT ON work_tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_tag_update
AFTER UPDATE ON work_tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_tag_delete
AFTER DELETE ON work_tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_tag_namespace_update
AFTER UPDATE OF namespace ON tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_credit_insert
AFTER INSERT ON work_credit
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_credit_update
AFTER UPDATE ON work_credit
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_credit_delete
AFTER DELETE ON work_credit
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_party_insert
AFTER INSERT ON work_party
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_party_update
AFTER UPDATE ON work_party
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_work_party_delete
AFTER DELETE ON work_party
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_config_insert
AFTER INSERT ON app_setting
WHEN NEW.key = 'recommendation_config'
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_config_update
AFTER UPDATE OF value_json ON app_setting
WHEN NEW.key = 'recommendation_config' AND NEW.value_json <> OLD.value_json
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_config_delete
AFTER DELETE ON app_setting
WHEN OLD.key = 'recommendation_config'
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_user_state_insert
AFTER INSERT ON user_work_state
BEGIN
  INSERT INTO recommendation_user_revision (user_id, revision, updated_at)
  VALUES (NEW.user_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = recommendation_user_revision.revision + 1,
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER recommendation_revision_user_state_update
AFTER UPDATE OF listening_status, favorite ON user_work_state
BEGIN
  INSERT INTO recommendation_user_revision (user_id, revision, updated_at)
  VALUES (NEW.user_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = recommendation_user_revision.revision + 1,
    updated_at = CURRENT_TIMESTAMP;
END;

CREATE TRIGGER recommendation_revision_user_state_delete
AFTER DELETE ON user_work_state
BEGIN
  UPDATE recommendation_user_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE user_id = OLD.user_id;
END;
