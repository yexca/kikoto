-- kikoto:foreign_keys=off
-- Availability Watch only monitors: Track and Fetch of an available work are
-- started by hand from the Watch view, and a Fetch chooses its own extension
-- exclusion. A stored Track or Fetch action becomes monitor, the action column
-- accepts only monitor, and the stored exclusion is dropped.

CREATE TABLE availability_watch_next (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  configured_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  action TEXT NOT NULL DEFAULT 'monitor' CHECK(action = 'monitor'),
  source_id INTEGER REFERENCES file_source(id) ON DELETE SET NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO availability_watch_next (id, configured_by_user_id, action, source_id, revision, created_at, updated_at)
SELECT id, configured_by_user_id, 'monitor', source_id, revision, created_at, updated_at
FROM availability_watch;

DROP TABLE availability_watch;
ALTER TABLE availability_watch_next RENAME TO availability_watch;

CREATE INDEX idx_fk_availability_watch_source_id ON availability_watch(source_id);
CREATE INDEX idx_fk_availability_watch_configured_by_user_id ON availability_watch(configured_by_user_id);

-- An available target stays ready whether or not a Track or Fetch was
-- started; its run references say what was started.
UPDATE availability_watch_target
SET state = 'ready'
WHERE state IN ('action_queued', 'completed');
