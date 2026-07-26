CREATE TABLE recommendation_event (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  work_id INTEGER REFERENCES work(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK(event_type IN ('impression', 'open', 'play', 'positive_mark', 'paused_mark', 'reshuffle')),
  context_id TEXT NOT NULL DEFAULT '',
  algorithm_version TEXT NOT NULL DEFAULT '',
  seed INTEGER NOT NULL DEFAULT 0,
  rank INTEGER NOT NULL DEFAULT 0,
  score INTEGER NOT NULL DEFAULT 0 CHECK(score BETWEEN 0 AND 100),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_recommendation_event_user_created
  ON recommendation_event(user_id, created_at DESC, id DESC);

CREATE INDEX idx_recommendation_event_type_created
  ON recommendation_event(event_type, created_at DESC, id DESC);
