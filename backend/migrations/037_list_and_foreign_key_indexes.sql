-- Library pages read works in created_at or release_date order and stop after
-- one page. These indexes let SQLite walk that order instead of sorting every
-- matching work first. Ascending release order places works without a date
-- last, so it reads a separate index on the same null grouping expression.

CREATE INDEX idx_work_created_at
  ON work(created_at, id);

CREATE INDEX idx_work_release_date
  ON work(release_date, created_at, id);

CREATE INDEX idx_work_release_date_nulls_last
  ON work(release_date IS NULL, release_date, created_at, id);

-- Exact-code search, work deletion cascades, and account session cleanup look
-- these rows up by a column that no existing unique key leads with.

CREATE INDEX idx_work_external_id_work
  ON work_external_id(work_id);

CREATE INDEX idx_favorite_list_item_work
  ON favorite_list_item(work_id);

CREATE INDEX idx_user_session_user
  ON user_session(user_id);

CREATE INDEX idx_user_session_expires_at
  ON user_session(expires_at);
