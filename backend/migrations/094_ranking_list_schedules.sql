-- kikoto:foreign_keys=off
-- A ranking list is one tracked ranking with its own pull schedule: a DLsite
-- period (24 hours, 7 days, 30 days, one annual year, or all time) or a remote
-- source's popular list. Its variants are the orders it is pulled in: the
-- 30-day release window of the 24-hour, 7-day, and 30-day rankings and the
-- popularity or sales order. Snapshots, entries, and seen state belong to a
-- variant, and a snapshot records until when its order was confirmed. The
-- popular collection workflows pull the ranking lists, so their triggers
-- become lists and the shared ranking refresh schedule becomes each list's own
-- schedule.
--
-- SQLite cannot change these tables' columns and constraints in place, so they
-- are rebuilt. Each list of the earlier chain becomes the variant with its id
-- that matches its release window in popularity order, and the lists of one
-- period join one list, so snapshots, entries, and seen state keep their rows.
-- The manager runs this file with foreign key enforcement off, so references to
-- removed triggers and definitions are cleared here by hand before the final
-- foreign key check.

CREATE TABLE ranking_list_next (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL CHECK(provider IN ('dlsite', 'remote_source')),
  file_source_id INTEGER REFERENCES file_source(id) ON DELETE CASCADE,
  period TEXT NOT NULL DEFAULT '' CHECK(period IN ('', 'day', 'week', 'month', 'year', 'total')),
  -- The ranking year (JST) of an annual list; 0 for every other list.
  year INTEGER NOT NULL DEFAULT 0,
  depth INTEGER NOT NULL DEFAULT 100 CHECK(depth BETWEEN 10 AND 100),
  -- Shown in Rankings and pulled.
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  auto_refresh INTEGER NOT NULL DEFAULT 1 CHECK(auto_refresh IN (0, 1)),
  refresh_interval_minutes INTEGER NOT NULL DEFAULT 1440 CHECK(refresh_interval_minutes BETWEEN 20 AND 43200),
  -- When the list is next due; empty while nothing schedules a pull.
  next_pull_at TEXT,
  -- A requested pull that no run has taken yet: a new list's first pull or
  -- Refresh now.
  pull_requested_at TEXT,
  -- Consecutive failed pulls, which space out the retries.
  failure_count INTEGER NOT NULL DEFAULT 0 CHECK(failure_count >= 0),
  -- An annual list's last pull after its year ended; the list is no longer
  -- scheduled and its history is kept.
  final_at TEXT,
  -- An annual list adds the next year's list when it is finalized.
  follow_current_year INTEGER NOT NULL DEFAULT 1 CHECK(follow_current_year IN (0, 1)),
  last_pulled_at TEXT,
  last_status TEXT NOT NULL DEFAULT '' CHECK(last_status IN ('', 'succeeded', 'partial', 'failed', 'source_unavailable')),
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (provider = 'dlsite' AND file_source_id IS NULL AND period IN ('day', 'week', 'month', 'total') AND year = 0)
    OR (provider = 'dlsite' AND file_source_id IS NULL AND period = 'year' AND year >= 2000)
    OR (provider = 'remote_source' AND file_source_id IS NOT NULL AND period = '' AND year = 0)
  )
);

-- One list per ranking.
CREATE UNIQUE INDEX idx_ranking_list_next_identity
  ON ranking_list_next(provider, COALESCE(file_source_id, 0), period, year);

-- One order a list is pulled in. The 30-day release window exists for the
-- 24-hour, 7-day, and 30-day rankings; sale is the sales order.
CREATE TABLE ranking_variant (
  id INTEGER PRIMARY KEY,
  ranking_list_id INTEGER NOT NULL REFERENCES ranking_list(id) ON DELETE CASCADE,
  release_window TEXT NOT NULL DEFAULT '' CHECK(release_window IN ('', '30d')),
  sort TEXT NOT NULL DEFAULT '' CHECK(sort IN ('', 'sale')),
  last_pulled_at TEXT,
  last_status TEXT NOT NULL DEFAULT '' CHECK(last_status IN ('', 'succeeded', 'failed', 'source_unavailable')),
  last_error TEXT NOT NULL DEFAULT '',
  UNIQUE(ranking_list_id, release_window, sort)
);

-- Every schedule that pulled a ranking becomes a source of its list: each list
-- of the earlier chain with the shared ranking refresh schedule's switch and
-- interval, and each popular collection trigger.
CREATE TEMP TABLE ranking_schedule_source (
  provider TEXT NOT NULL,
  file_source_id INTEGER,
  period TEXT NOT NULL,
  year INTEGER NOT NULL,
  -- The id of a list of the earlier chain; empty for a trigger.
  list_id INTEGER,
  depth INTEGER NOT NULL,
  shown INTEGER NOT NULL,
  automatic INTEGER NOT NULL,
  minutes INTEGER,
  last_pulled_at TEXT,
  created_at TEXT
);

INSERT INTO ranking_schedule_source (
  provider, file_source_id, period, year, list_id, depth, shown, automatic, minutes, last_pulled_at, created_at
)
SELECT list.provider, list.file_source_id, list.period, 0, list.id, list.depth, list.enabled,
  COALESCE(refresh.enabled, 1), refresh.minutes, list.last_pulled_at, list.created_at
FROM ranking_list AS list
LEFT JOIN (
  SELECT trigger.enabled AS enabled,
    CASE WHEN json_valid(trigger.schedule_json)
      THEN CAST(json_extract(trigger.schedule_json, '$.intervalMinutes') AS INTEGER) END AS minutes
  FROM workflow_trigger AS trigger
  INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
  WHERE definition.code = 'ranking_refresh' AND trigger.trigger_type = 'schedule'
  ORDER BY trigger.id
  LIMIT 1
) AS refresh ON true;

-- A DLsite popular collection trigger names the list of its period, also when
-- it was limited to new releases, or of its annual year up to the year in
-- progress in Japan. A Startup trigger has no interval of its own.
INSERT INTO ranking_schedule_source (provider, file_source_id, period, year, depth, shown, automatic, minutes)
SELECT 'dlsite', NULL, collection.period,
  CASE WHEN collection.period = 'year' THEN collection.year ELSE 0 END,
  100, collection.enabled, collection.enabled,
  CASE WHEN collection.trigger_type = 'schedule' THEN collection.minutes END
FROM (
  SELECT trigger.trigger_type, trigger.enabled,
    CASE WHEN json_valid(trigger.schedule_json)
      THEN CAST(json_extract(trigger.schedule_json, '$.intervalMinutes') AS INTEGER) END AS minutes,
    CASE WHEN json_valid(trigger.config_json)
      THEN LOWER(TRIM(COALESCE(json_extract(trigger.config_json, '$.period'), ''))) ELSE '' END AS period,
    CASE WHEN json_valid(trigger.config_json)
      THEN CAST(COALESCE(json_extract(trigger.config_json, '$.year'), 0) AS INTEGER) ELSE 0 END AS year
  FROM workflow_trigger AS trigger
  INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
  WHERE definition.code = 'dlsite_popular_collection' AND trigger.trigger_type IN ('schedule', 'startup')
) AS collection
WHERE collection.period IN ('day', 'week', 'month')
  OR (collection.period = 'year'
    AND collection.year BETWEEN 2000 AND CAST(strftime('%Y', 'now', '+9 hours') AS INTEGER));

-- A remote popular collection trigger names the popular list of its source,
-- with its limit as the depth, at least 10 places. A trigger whose source no
-- longer exists or is no longer a compatible remote source names no list.
INSERT INTO ranking_schedule_source (provider, file_source_id, period, year, depth, shown, automatic, minutes)
SELECT 'remote_source', source.id, '', 0,
  MIN(100, MAX(10, COALESCE(collection.depth, 100))),
  collection.enabled, collection.enabled,
  CASE WHEN collection.trigger_type = 'schedule' THEN collection.minutes END
FROM (
  SELECT trigger.trigger_type, trigger.enabled,
    CASE WHEN json_valid(trigger.schedule_json)
      THEN CAST(json_extract(trigger.schedule_json, '$.intervalMinutes') AS INTEGER) END AS minutes,
    CASE WHEN json_valid(trigger.config_json)
      THEN CAST(json_extract(trigger.config_json, '$.sourceId') AS INTEGER) END AS source_id,
    CASE WHEN json_valid(trigger.config_json)
      THEN CAST(json_extract(trigger.config_json, '$.limit') AS INTEGER) END AS depth
  FROM workflow_trigger AS trigger
  INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
  WHERE definition.code = 'remote_popular_collection' AND trigger.trigger_type IN ('schedule', 'startup')
) AS collection
INNER JOIN file_source AS source ON source.id = collection.source_id
WHERE source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178');

-- A source without an interval of its own takes its kind's default, and every
-- interval moves into its kind's range.
UPDATE ranking_schedule_source
SET minutes = CASE
  WHEN provider = 'remote_source' THEN MIN(10080, MAX(60, COALESCE(minutes, 1440)))
  WHEN period = 'day' THEN MIN(1440, MAX(20, COALESCE(minutes, 60)))
  WHEN period = 'week' THEN MIN(10080, MAX(60, COALESCE(minutes, 360)))
  WHEN period = 'month' THEN MIN(10080, MAX(360, COALESCE(minutes, 1440)))
  ELSE MIN(43200, MAX(1440, COALESCE(minutes, 10080)))
END;

-- The sources of one ranking join one list, independent of the order they are
-- read in. The list keeps the smallest id of its lists of the earlier chain
-- and the most places. It is shown unless such a list was hidden and no
-- enabled trigger names it. It is pulled automatically when any of its sources
-- was, at the shortest interval among those, or among all of its sources when
-- none was. An annual list of a past year is pulled once and does not continue
-- with the next year. Lists that keep an id are added first, so the others'
-- new ids cannot take one of theirs.
INSERT INTO ranking_list_next (
  id, provider, file_source_id, period, year, depth, enabled, auto_refresh, refresh_interval_minutes,
  follow_current_year, last_pulled_at, last_status, last_error, created_at
)
SELECT MIN(source.list_id), source.provider, MAX(source.file_source_id), source.period, source.year,
  MAX(source.depth),
  CASE WHEN MIN(source.list_id) IS NULL THEN 1 ELSE MAX(source.shown) END,
  CASE WHEN source.period = 'year' AND source.year < CAST(strftime('%Y', 'now', '+9 hours') AS INTEGER)
    THEN 0 ELSE MAX(source.automatic) END,
  COALESCE(MIN(CASE WHEN source.automatic = 1 THEN source.minutes END), MIN(source.minutes)),
  CASE WHEN source.period = 'year' AND source.year < CAST(strftime('%Y', 'now', '+9 hours') AS INTEGER)
    THEN 0 ELSE 1 END,
  MAX(source.last_pulled_at), '', '', COALESCE(MIN(source.created_at), CURRENT_TIMESTAMP)
FROM ranking_schedule_source AS source
GROUP BY source.provider, COALESCE(source.file_source_id, 0), source.period, source.year
HAVING MIN(source.list_id) IS NOT NULL;

INSERT INTO ranking_list_next (
  provider, file_source_id, period, year, depth, enabled, auto_refresh, refresh_interval_minutes,
  follow_current_year, last_pulled_at, last_status, last_error, created_at
)
SELECT source.provider, MAX(source.file_source_id), source.period, source.year,
  MAX(source.depth),
  1,
  CASE WHEN source.period = 'year' AND source.year < CAST(strftime('%Y', 'now', '+9 hours') AS INTEGER)
    THEN 0 ELSE MAX(source.automatic) END,
  COALESCE(MIN(CASE WHEN source.automatic = 1 THEN source.minutes END), MIN(source.minutes)),
  CASE WHEN source.period = 'year' AND source.year < CAST(strftime('%Y', 'now', '+9 hours') AS INTEGER)
    THEN 0 ELSE 1 END,
  MAX(source.last_pulled_at), '', '', COALESCE(MIN(source.created_at), CURRENT_TIMESTAMP)
FROM ranking_schedule_source AS source
GROUP BY source.provider, COALESCE(source.file_source_id, 0), source.period, source.year
HAVING MIN(source.list_id) IS NULL;

DROP TABLE ranking_schedule_source;

INSERT INTO ranking_variant (id, ranking_list_id, release_window, sort, last_pulled_at, last_status, last_error)
SELECT list.id, joined.id, list.release_window, '', list.last_pulled_at, list.last_status, list.last_error
FROM ranking_list AS list
INNER JOIN ranking_list_next AS joined
  ON joined.provider = list.provider
  AND COALESCE(joined.file_source_id, 0) = COALESCE(list.file_source_id, 0)
  AND joined.period = list.period AND joined.year = 0;

-- Every list has each order its ranking offers.
INSERT INTO ranking_variant (ranking_list_id, release_window, sort)
SELECT list.id, combination.release_window, combination.sort
FROM ranking_list_next AS list
INNER JOIN (
  SELECT '' AS release_window, '' AS sort, 0 AS dated
  UNION ALL SELECT '', 'sale', 0
  UNION ALL SELECT '30d', '', 1
  UNION ALL SELECT '30d', 'sale', 1
) AS combination
  ON (list.provider = 'remote_source' AND combination.release_window = '' AND combination.sort = '')
  OR (list.provider = 'dlsite' AND (combination.dated = 0 OR list.period IN ('day', 'week', 'month')))
WHERE true
ON CONFLICT DO NOTHING;

-- A scheduled list is next due one interval after its last pull. A shown list
-- asks for a pull now, so its new variants fill in.
UPDATE ranking_list_next
SET next_pull_at = datetime(COALESCE(last_pulled_at, CURRENT_TIMESTAMP), '+' || refresh_interval_minutes || ' minutes')
WHERE auto_refresh = 1;

UPDATE ranking_list_next
SET pull_requested_at = CURRENT_TIMESTAMP
WHERE enabled = 1;

DROP TABLE ranking_list;
ALTER TABLE ranking_list_next RENAME TO ranking_list;
DROP INDEX idx_ranking_list_next_identity;

CREATE UNIQUE INDEX idx_ranking_list_identity
  ON ranking_list(provider, COALESCE(file_source_id, 0), period, year);
CREATE INDEX idx_fk_ranking_list_file_source_id ON ranking_list(file_source_id);
CREATE INDEX idx_fk_ranking_variant_list ON ranking_variant(ranking_list_id);

-- Snapshots belong to a variant. confirmed_until is the latest pull that
-- returned the snapshot's order; a pull with an unchanged order moves it
-- forward instead of adding a snapshot.
CREATE TABLE ranking_snapshot_next (
  id INTEGER PRIMARY KEY,
  ranking_variant_id INTEGER NOT NULL REFERENCES ranking_variant(id) ON DELETE CASCADE,
  pulled_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_until TEXT,
  workflow_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  item_count INTEGER NOT NULL,
  content_hash TEXT NOT NULL
);

-- An earlier snapshot was confirmed when it was pulled; the latest one by its
-- former list's last successful pull.
INSERT INTO ranking_snapshot_next (id, ranking_variant_id, pulled_at, confirmed_until, workflow_run_id, item_count, content_hash)
SELECT snapshot.id, snapshot.ranking_list_id, snapshot.pulled_at,
  CASE WHEN NOT EXISTS (
    SELECT 1 FROM ranking_snapshot AS newer
    WHERE newer.ranking_list_id = snapshot.ranking_list_id
      AND (newer.pulled_at > snapshot.pulled_at OR (newer.pulled_at = snapshot.pulled_at AND newer.id > snapshot.id))
  ) THEN MAX(snapshot.pulled_at, COALESCE(variant.last_pulled_at, snapshot.pulled_at)) ELSE snapshot.pulled_at END,
  snapshot.workflow_run_id, snapshot.item_count, snapshot.content_hash
FROM ranking_snapshot AS snapshot
INNER JOIN ranking_variant AS variant ON variant.id = snapshot.ranking_list_id;

DROP TABLE ranking_snapshot;
ALTER TABLE ranking_snapshot_next RENAME TO ranking_snapshot;

CREATE INDEX idx_ranking_snapshot_variant_pulled ON ranking_snapshot(ranking_variant_id, pulled_at DESC, id DESC);
CREATE INDEX idx_fk_ranking_snapshot_workflow_run_id ON ranking_snapshot(workflow_run_id);

-- Per variant and code: the display text the ranking carries and statistics
-- derived from the variant's snapshots.
CREATE TABLE ranking_entry_next (
  ranking_variant_id INTEGER NOT NULL REFERENCES ranking_variant(id) ON DELETE CASCADE,
  primary_code TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  maker_name TEXT NOT NULL DEFAULT '',
  remote_work_id INTEGER NOT NULL DEFAULT 0,
  remote_cover_url TEXT NOT NULL DEFAULT '',
  first_seen_at TEXT NOT NULL,
  streak_started_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  best_rank INTEGER NOT NULL,
  appearances INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY(ranking_variant_id, primary_code)
);

INSERT INTO ranking_entry_next (
  ranking_variant_id, primary_code, title, maker_name, remote_work_id, remote_cover_url,
  first_seen_at, streak_started_at, last_seen_at, best_rank, appearances
)
SELECT entry.ranking_list_id, entry.primary_code, entry.title, entry.maker_name, entry.remote_work_id,
  entry.remote_cover_url, entry.first_seen_at, entry.streak_started_at, entry.last_seen_at, entry.best_rank,
  entry.appearances
FROM ranking_entry AS entry
INNER JOIN ranking_variant AS variant ON variant.id = entry.ranking_list_id;

DROP TABLE ranking_entry;
ALTER TABLE ranking_entry_next RENAME TO ranking_entry;

-- The snapshot each account last looked at, per variant.
CREATE TABLE user_ranking_state_next (
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  ranking_variant_id INTEGER NOT NULL REFERENCES ranking_variant(id) ON DELETE CASCADE,
  seen_snapshot_id INTEGER REFERENCES ranking_snapshot(id) ON DELETE SET NULL,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, ranking_variant_id)
);

INSERT INTO user_ranking_state_next (user_id, ranking_variant_id, seen_snapshot_id, seen_at)
SELECT state.user_id, state.ranking_list_id, state.seen_snapshot_id, state.seen_at
FROM user_ranking_state AS state
INNER JOIN ranking_variant AS variant ON variant.id = state.ranking_list_id;

DROP TABLE user_ranking_state;
ALTER TABLE user_ranking_state_next RENAME TO user_ranking_state;

CREATE INDEX idx_fk_user_ranking_state_variant ON user_ranking_state(ranking_variant_id);
CREATE INDEX idx_fk_user_ranking_state_snapshot ON user_ranking_state(seen_snapshot_id);

-- The converted triggers and the shared ranking refresh schedule are removed.
-- Their runs stay in Activity without a trigger. The two popular collection
-- definitions stay; the ranking refresh definition is removed.
CREATE TEMP TABLE retired_ranking_trigger AS
SELECT trigger.id
FROM workflow_trigger AS trigger
INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
WHERE definition.code IN ('dlsite_popular_collection', 'remote_popular_collection', 'ranking_refresh');

UPDATE workflow_run SET trigger_id = NULL WHERE trigger_id IN (SELECT id FROM retired_ranking_trigger);
DELETE FROM filesystem_trigger_state WHERE trigger_id IN (SELECT id FROM retired_ranking_trigger);
DELETE FROM legacy_workflow_trigger_migration WHERE new_trigger_id IN (SELECT id FROM retired_ranking_trigger);
DELETE FROM workflow_trigger WHERE id IN (SELECT id FROM retired_ranking_trigger);
DROP TABLE retired_ranking_trigger;

UPDATE workflow_run SET workflow_definition_id = NULL
WHERE workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = 'ranking_refresh');
DELETE FROM workflow_definition WHERE code = 'ranking_refresh';

-- Collections still queued or running when the upgrade starts are stopped:
-- their workers no longer exist. Tags they added stay with their owners.
UPDATE workflow_job
SET status = 'cancelled',
  error_message = 'Stopped by the upgrade: this workflow pulls Rankings lists.',
  locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
WHERE worker_type IN ('dlsite_popular_collection', 'remote_popular_collection', 'ranking_refresh')
  AND status IN ('queued', 'running');

UPDATE workflow_node_run
SET status = 'cancelled', finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
WHERE status IN ('queued', 'running')
  AND workflow_run_id IN (
    SELECT id FROM workflow_run
    WHERE workflow_code IN ('dlsite_popular_collection', 'remote_popular_collection', 'ranking_refresh')
      AND status IN ('queued', 'running')
  );

UPDATE workflow_run
SET status = 'cancelled', finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
WHERE workflow_code IN ('dlsite_popular_collection', 'remote_popular_collection', 'ranking_refresh')
  AND status IN ('queued', 'running');

-- The ranking pulls whose list schedules are not settled yet: queued and
-- running pulls and the few finished ones still to be settled. The workflow
-- coordinator reads it on every tick instead of the whole job history.
CREATE INDEX idx_workflow_job_ranking_unsettled ON workflow_job(id)
  WHERE worker_type = 'ranking_pull'
    AND COALESCE(json_extract(checkpoint_json, '$.rankingScheduleSettled'), 0) = 0;
