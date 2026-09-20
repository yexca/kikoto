CREATE TABLE user_preference (
  user_id INTEGER PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  directory_routing_rules TEXT,
  recommendation_config TEXT,
  recommendation_threshold INTEGER CHECK (recommendation_threshold BETWEEN 1 AND 100)
);
