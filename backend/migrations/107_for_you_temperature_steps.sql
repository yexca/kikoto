-- The For you temperature is a step from 1 (closest to what the account
-- likes) to 5 (furthest from it); NULL is the default, 3. The saved Safe,
-- Balanced, and Adventurous become 1, 3, and 5, which draw as before. No other
-- table references user_preference, so the rebuild runs with foreign keys on.

CREATE TABLE user_preference_next (
  user_id INTEGER PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  directory_routing_rules TEXT,
  recommendation_config TEXT,
  recommendation_threshold INTEGER CHECK (recommendation_threshold BETWEEN 1 AND 100),
  metadata_languages TEXT,
  time_zone TEXT,
  for_you_temperature INTEGER CHECK (for_you_temperature BETWEEN 1 AND 5)
);

INSERT INTO user_preference_next (
  user_id, directory_routing_rules, recommendation_config, recommendation_threshold,
  metadata_languages, time_zone, for_you_temperature
)
SELECT
  user_id, directory_routing_rules, recommendation_config, recommendation_threshold,
  metadata_languages, time_zone,
  CASE for_you_temperature WHEN 'safe' THEN 1 WHEN 'balanced' THEN 3 WHEN 'adventurous' THEN 5 END
FROM user_preference;

DROP TABLE user_preference;
ALTER TABLE user_preference_next RENAME TO user_preference;

CREATE INDEX idx_fk_user_preference_user_id ON user_preference(user_id);
