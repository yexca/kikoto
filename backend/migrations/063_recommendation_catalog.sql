-- Shared, incrementally versioned recommendation inputs. Old per-user scores
-- remain derived cache and are reclaimed in bounded background batches.
ALTER TABLE work ADD COLUMN recommendation_explore_key INTEGER NOT NULL DEFAULT 0;
UPDATE work SET recommendation_explore_key = (id * 1103515245 + 12345) % 2147483647;
CREATE INDEX idx_work_recommendation_explore ON work(recommendation_explore_key, id);

CREATE TABLE recommendation_catalog_epoch (
  id INTEGER PRIMARY KEY,
  work_count INTEGER NOT NULL DEFAULT 0 CHECK(work_count >= 0),
  published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0, 1)),
  changed INTEGER NOT NULL DEFAULT 0 CHECK(changed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE recommendation_catalog_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  published_epoch INTEGER REFERENCES recommendation_catalog_epoch(id),
  building_epoch INTEGER REFERENCES recommendation_catalog_epoch(id)
);
INSERT INTO recommendation_catalog_state(id) VALUES (1);
CREATE TABLE recommendation_catalog_dirty (
  work_id INTEGER PRIMARY KEY,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE recommendation_name_dirty (
  kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  retry_after INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(kind, entity_id)
);
CREATE TABLE recommendation_catalog_work (
  work_id INTEGER NOT NULL,
  primary_code TEXT NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  features_json TEXT NOT NULL CHECK(json_valid(features_json)),
  PRIMARY KEY(work_id, valid_from)
);
CREATE INDEX idx_recommendation_catalog_work_history ON recommendation_catalog_work(valid_to);
CREATE TABLE recommendation_catalog_entity (
  kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  work_id INTEGER NOT NULL,
  explore_key INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  PRIMARY KEY(kind, entity_id, work_id, valid_from)
);
CREATE INDEX idx_recommendation_catalog_entity_recall
  ON recommendation_catalog_entity(kind, entity_id, explore_key, work_id, valid_from, valid_to);
CREATE INDEX idx_recommendation_catalog_entity_work ON recommendation_catalog_entity(work_id, valid_to);
CREATE INDEX idx_recommendation_catalog_entity_history ON recommendation_catalog_entity(valid_to);
CREATE TABLE recommendation_catalog_frequency (
  kind TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  work_count INTEGER NOT NULL CHECK(work_count >= 0),
  PRIMARY KEY(kind, entity_id, valid_from)
);
CREATE INDEX idx_recommendation_catalog_frequency_history ON recommendation_catalog_frequency(valid_to);
CREATE TABLE recommendation_catalog_name (
  kind TEXT NOT NULL,
  source_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  valid_from INTEGER NOT NULL,
  valid_to INTEGER,
  PRIMARY KEY(kind, source_id, name, valid_from)
);
CREATE INDEX idx_recommendation_catalog_name_lookup ON recommendation_catalog_name(kind, name, valid_from, valid_to, entity_id);
CREATE INDEX idx_recommendation_catalog_name_entity ON recommendation_catalog_name(kind, entity_id, valid_from, valid_to, name);
CREATE INDEX idx_recommendation_catalog_name_history ON recommendation_catalog_name(valid_to);

ALTER TABLE recommendation_generation ADD COLUMN catalog_epoch INTEGER REFERENCES recommendation_catalog_epoch(id);
ALTER TABLE recommendation_generation ADD COLUMN ready INTEGER NOT NULL DEFAULT 0 CHECK(ready IN (0, 1));
CREATE INDEX idx_recommendation_generation_inputs
  ON recommendation_generation(user_id, algorithm_version, catalog_epoch, user_revision, ready, config_json);
CREATE INDEX idx_user_work_state_recommendation_feedback
  ON user_work_state(user_id, work_id) WHERE listening_status <> 'none' OR favorite = 1;
CREATE TABLE recommendation_generation_state (
  generation_id INTEGER NOT NULL REFERENCES recommendation_generation(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL,
  primary_code TEXT NOT NULL,
  listening_status TEXT NOT NULL,
  favorite INTEGER NOT NULL CHECK(favorite IN (0, 1)),
  PRIMARY KEY(generation_id, work_id)
);
CREATE INDEX idx_recommendation_generation_state_lane ON recommendation_generation_state(generation_id, listening_status, work_id);
CREATE TABLE recommendation_query_context (
  id TEXT PRIMARY KEY CHECK(length(id) = 64),
  generation_id INTEGER NOT NULL REFERENCES recommendation_generation(id) ON DELETE CASCADE,
  seed INTEGER NOT NULL,
  direction TEXT NOT NULL,
  candidate_count INTEGER NOT NULL CHECK(candidate_count BETWEEN 0 AND 2000),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_recommendation_query_context_generation ON recommendation_query_context(generation_id, created_at, id);
CREATE TABLE recommendation_query_candidate (
  context_id TEXT NOT NULL REFERENCES recommendation_query_context(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL,
  primary_code TEXT NOT NULL,
  rank INTEGER NOT NULL CHECK(rank BETWEEN 1 AND 500),
  signals_json TEXT NOT NULL CHECK(json_valid(signals_json)),
  PRIMARY KEY(context_id, work_id),
  UNIQUE(context_id, rank)
);
CREATE TABLE recommendation_query_checkpoint (
  context_id TEXT NOT NULL REFERENCES recommendation_query_context(id) ON DELETE CASCADE,
  lane TEXT NOT NULL,
  exact_rank INTEGER NOT NULL,
  tail_rank INTEGER NOT NULL,
  explore_key INTEGER NOT NULL,
  work_id INTEGER NOT NULL,
  membership_revision TEXT NOT NULL,
  PRIMARY KEY(context_id, lane, exact_rank, tail_rank)
);

INSERT INTO recommendation_catalog_dirty(work_id) SELECT id FROM work;
INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', id FROM tag WHERE namespace IN ('dlsite', 'metadata');
INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'voice', id FROM person;
INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'circle', id FROM party;

CREATE TRIGGER recommendation_catalog_work_insert AFTER INSERT ON work BEGIN
  UPDATE work SET recommendation_explore_key = (NEW.id * 1103515245 + 12345) % 2147483647 WHERE id = NEW.id;
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (NEW.id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;
CREATE TRIGGER recommendation_catalog_work_delete AFTER DELETE ON work BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (OLD.id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_tag_insert AFTER INSERT ON work_tag BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (NEW.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_tag_update AFTER UPDATE ON work_tag BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (OLD.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (NEW.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_tag_delete AFTER DELETE ON work_tag BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (OLD.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_credit_insert AFTER INSERT ON work_credit BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (NEW.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_credit_update AFTER UPDATE ON work_credit BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (OLD.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (NEW.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_credit_delete AFTER DELETE ON work_credit BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (OLD.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_party_insert AFTER INSERT ON work_party BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (NEW.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_party_update AFTER UPDATE ON work_party BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (OLD.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (NEW.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_catalog_work_party_delete AFTER DELETE ON work_party BEGIN
  INSERT INTO recommendation_catalog_dirty(work_id) VALUES (OLD.work_id) ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_tag_insert AFTER INSERT ON tag BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_catalog_dirty(work_id) SELECT work_id FROM work_tag WHERE tag_id = NEW.id ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_tag_update AFTER UPDATE ON tag BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_catalog_dirty(work_id) SELECT work_id FROM work_tag WHERE tag_id = OLD.id ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_catalog_dirty(work_id) SELECT work_id FROM work_tag WHERE tag_id = NEW.id ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_tag_delete AFTER DELETE ON tag BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_catalog_dirty(work_id) SELECT work_id FROM work_tag WHERE tag_id = OLD.id ON CONFLICT(work_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_insert AFTER INSERT ON person BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_update AFTER UPDATE ON person BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_delete AFTER DELETE ON person BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_alias_insert AFTER INSERT ON person_alias BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', NEW.person_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_alias_update AFTER UPDATE ON person_alias BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', OLD.person_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', NEW.person_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_person_alias_delete AFTER DELETE ON person_alias BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('voice', OLD.person_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_party_insert AFTER INSERT ON party BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_party_update AFTER UPDATE ON party BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', NEW.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_party_delete AFTER DELETE ON party BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', OLD.id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_party_alias_insert AFTER INSERT ON party_alias BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', NEW.party_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_party_alias_update AFTER UPDATE ON party_alias BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', OLD.party_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', NEW.party_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_party_alias_delete AFTER DELETE ON party_alias BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('circle', OLD.party_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_name_insert AFTER INSERT ON metadata_tag_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', NEW.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_name_update AFTER UPDATE ON metadata_tag_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', OLD.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', NEW.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_name_delete AFTER DELETE ON metadata_tag_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', OLD.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_provider_name_insert AFTER INSERT ON metadata_tag_provider_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', NEW.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_provider_name_update AFTER UPDATE ON metadata_tag_provider_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', OLD.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', NEW.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_provider_name_delete AFTER DELETE ON metadata_tag_provider_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) VALUES ('tag', OLD.tag_id) ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_insert AFTER INSERT ON metadata_tag BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', id FROM tag WHERE namespace IN ('dlsite', 'metadata') ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_genre_insert AFTER INSERT ON dlsite_genre_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', tag_id FROM metadata_tag WHERE dlsite_genre_id = NEW.genre_id ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_update AFTER UPDATE ON metadata_tag BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', id FROM tag WHERE namespace IN ('dlsite', 'metadata') ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_genre_update AFTER UPDATE ON dlsite_genre_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', tag_id FROM metadata_tag WHERE dlsite_genre_id = OLD.genre_id ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
  INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', tag_id FROM metadata_tag WHERE dlsite_genre_id = NEW.genre_id ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_metadata_tag_delete AFTER DELETE ON metadata_tag BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', id FROM tag WHERE namespace IN ('dlsite', 'metadata') ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;

CREATE TRIGGER recommendation_names_genre_delete AFTER DELETE ON dlsite_genre_name BEGIN
  INSERT INTO recommendation_name_dirty(kind, entity_id) SELECT 'tag', tag_id FROM metadata_tag WHERE dlsite_genre_id = OLD.genre_id ON CONFLICT(kind, entity_id) DO UPDATE SET retry_count = 0, retry_after = 0;
END;
