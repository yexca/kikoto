-- Preserve weighted explanations and the remote scoring inputs for each session.
ALTER TABLE recommendation_snapshot ADD COLUMN affinity_json TEXT NOT NULL DEFAULT '{}'
  CHECK(json_valid(affinity_json));
ALTER TABLE recommendation_snapshot ADD COLUMN diversity_penalty INTEGER NOT NULL DEFAULT 0
  CHECK(diversity_penalty BETWEEN 0 AND 8);
CREATE TABLE recommendation_generation_profile (
  generation_id INTEGER PRIMARY KEY REFERENCES recommendation_generation(id) ON DELETE CASCADE,
  profile_json TEXT NOT NULL CHECK(json_valid(profile_json))
);

-- Remote name matching is frozen with each generation. New sessions must see
-- changed aliases and localized names even when work relations did not change.

CREATE TRIGGER recommendation_revision_profile_person_insert
AFTER INSERT ON person
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_person_update
AFTER UPDATE OF display_name ON person
WHEN OLD.display_name IS NOT NEW.display_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_person_delete
AFTER DELETE ON person
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_person_alias_insert
AFTER INSERT ON person_alias
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_person_alias_update
AFTER UPDATE OF person_id, alias ON person_alias
WHEN OLD.person_id IS NOT NEW.person_id OR OLD.alias IS NOT NEW.alias
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_person_alias_delete
AFTER DELETE ON person_alias
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_party_insert
AFTER INSERT ON party
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_party_update
AFTER UPDATE OF display_name, manual_name, provider_name ON party
WHEN OLD.display_name IS NOT NEW.display_name OR OLD.manual_name IS NOT NEW.manual_name OR OLD.provider_name IS NOT NEW.provider_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_party_delete
AFTER DELETE ON party
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_party_alias_insert
AFTER INSERT ON party_alias
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_party_alias_update
AFTER UPDATE OF party_id, alias ON party_alias
WHEN OLD.party_id IS NOT NEW.party_id OR OLD.alias IS NOT NEW.alias
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_party_alias_delete
AFTER DELETE ON party_alias
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_tag_insert
AFTER INSERT ON tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_tag_update
AFTER UPDATE OF display_name, namespace ON tag
WHEN OLD.display_name IS NOT NEW.display_name OR OLD.namespace IS NOT NEW.namespace
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_tag_delete
AFTER DELETE ON tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_insert
AFTER INSERT ON metadata_tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_update
AFTER UPDATE OF tag_id, dlsite_genre_id, merged_into_tag_id ON metadata_tag
WHEN OLD.tag_id IS NOT NEW.tag_id OR OLD.dlsite_genre_id IS NOT NEW.dlsite_genre_id OR OLD.merged_into_tag_id IS NOT NEW.merged_into_tag_id
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_delete
AFTER DELETE ON metadata_tag
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_name_insert
AFTER INSERT ON metadata_tag_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_name_update
AFTER UPDATE OF tag_id, name ON metadata_tag_name
WHEN OLD.tag_id IS NOT NEW.tag_id OR OLD.name IS NOT NEW.name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_name_delete
AFTER DELETE ON metadata_tag_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_provider_name_insert
AFTER INSERT ON metadata_tag_provider_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_provider_name_update
AFTER UPDATE OF tag_id, name ON metadata_tag_provider_name
WHEN OLD.tag_id IS NOT NEW.tag_id OR OLD.name IS NOT NEW.name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_metadata_tag_provider_name_delete
AFTER DELETE ON metadata_tag_provider_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_dlsite_genre_name_insert
AFTER INSERT ON dlsite_genre_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_dlsite_genre_name_update
AFTER UPDATE OF genre_id, name ON dlsite_genre_name
WHEN OLD.genre_id IS NOT NEW.genre_id OR OLD.name IS NOT NEW.name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;

CREATE TRIGGER recommendation_revision_profile_dlsite_genre_name_delete
AFTER DELETE ON dlsite_genre_name
BEGIN
  UPDATE recommendation_input_revision
  SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
  WHERE id = 1;
END;
