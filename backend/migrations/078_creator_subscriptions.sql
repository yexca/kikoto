-- Creator subscriptions replace scheduled follow presets. The presets keep
-- their manual runs under catalog sync names, a subscription records which
-- circle, series, or voice actor an account wants new releases for, and one
-- system schedule refreshes every subscribed catalog and then checks
-- Availability Watch.

UPDATE workflow_definition SET code = 'circle_catalog_sync', updated_at = CURRENT_TIMESTAMP WHERE code = 'circle_follow';
UPDATE workflow_definition SET code = 'series_catalog_sync', updated_at = CURRENT_TIMESTAMP WHERE code = 'series_follow';
UPDATE workflow_definition SET code = 'voice_catalog_sync', updated_at = CURRENT_TIMESTAMP WHERE code = 'voice_follow';
UPDATE workflow_run SET workflow_code = 'circle_catalog_sync' WHERE workflow_code = 'circle_follow';
UPDATE workflow_run SET workflow_code = 'series_catalog_sync' WHERE workflow_code = 'series_follow';
UPDATE workflow_run SET workflow_code = 'voice_catalog_sync' WHERE workflow_code = 'voice_follow';

-- A series subscription names its circle and the provider series id, because
-- a full catalog refresh recreates party_series rows.
CREATE TABLE creator_subscription (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('circle', 'series', 'voice')),
  party_id INTEGER REFERENCES party(id) ON DELETE CASCADE,
  series_title_id TEXT NOT NULL DEFAULT '',
  person_id INTEGER REFERENCES person(id) ON DELETE CASCADE,
  watch_availability INTEGER NOT NULL DEFAULT 0 CHECK(watch_availability IN (0, 1)),
  activated_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (subject_kind = 'circle' AND party_id IS NOT NULL AND series_title_id = '' AND person_id IS NULL)
    OR (subject_kind = 'series' AND party_id IS NOT NULL AND series_title_id <> '' AND person_id IS NULL)
    OR (subject_kind = 'voice' AND person_id IS NOT NULL AND party_id IS NULL AND series_title_id = '')
  )
);

CREATE UNIQUE INDEX idx_creator_subscription_party
  ON creator_subscription(user_id, party_id, series_title_id) WHERE party_id IS NOT NULL;
CREATE UNIQUE INDEX idx_creator_subscription_person
  ON creator_subscription(user_id, person_id) WHERE person_id IS NOT NULL;
CREATE INDEX idx_fk_creator_subscription_party_id ON creator_subscription(party_id);
CREATE INDEX idx_fk_creator_subscription_person_id ON creator_subscription(person_id);

-- Catalog codes already accounted for. A code outside this set is new once
-- the circle or voice actor has an active subscription.
CREATE TABLE party_release_seen (
  party_id INTEGER NOT NULL REFERENCES party(id) ON DELETE CASCADE,
  primary_code TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(party_id, primary_code)
);

CREATE TABLE person_release_seen (
  person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
  primary_code TEXT NOT NULL,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(person_id, primary_code)
);

CREATE TABLE user_release_feed_item (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  primary_code TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK(event_type IN ('released', 'edition', 'available')),
  subject_kind TEXT NOT NULL CHECK(subject_kind IN ('circle', 'series', 'voice', 'watch')),
  party_id INTEGER REFERENCES party(id) ON DELETE SET NULL,
  series_title_id TEXT NOT NULL DEFAULT '',
  person_id INTEGER REFERENCES person(id) ON DELETE SET NULL,
  workflow_run_id INTEGER REFERENCES workflow_run(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, primary_code, event_type)
);

CREATE INDEX idx_user_release_feed_item_user_created ON user_release_feed_item(user_id, created_at DESC, id DESC);
CREATE INDEX idx_fk_user_release_feed_item_party_id ON user_release_feed_item(party_id);
CREATE INDEX idx_fk_user_release_feed_item_person_id ON user_release_feed_item(person_id);
CREATE INDEX idx_fk_user_release_feed_item_workflow_run_id ON user_release_feed_item(workflow_run_id);

CREATE TABLE user_release_feed_state (
  user_id INTEGER PRIMARY KEY REFERENCES user_account(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Enabled follow triggers become subscriptions of their owners. Their
-- catalogs were already pulled, so a subscription whose catalog has a
-- successful pull starts with that catalog as its baseline.
CREATE TEMP TABLE follow_trigger_target (
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL
);

WITH RECURSIVE split(user_id, kind, item, rest) AS (
  SELECT CAST(json_extract(trigger.config_json, '$.userId') AS INTEGER),
    CASE definition.code WHEN 'circle_catalog_sync' THEN 'circle' ELSE 'series' END,
    '',
    REPLACE(COALESCE(json_extract(
      trigger.config_json,
      CASE definition.code WHEN 'circle_catalog_sync' THEN '$.inputs.circleId' ELSE '$.inputs.seriesId' END
    ), ''), ' ', '') || ','
  FROM workflow_trigger AS trigger
  INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
  WHERE definition.code IN ('circle_catalog_sync', 'series_catalog_sync')
    AND trigger.enabled = 1
    AND json_valid(trigger.config_json)
  UNION ALL
  SELECT user_id, kind, UPPER(substr(rest, 1, instr(rest, ',') - 1)), substr(rest, instr(rest, ',') + 1)
  FROM split
  WHERE rest <> ''
)
INSERT INTO follow_trigger_target (user_id, kind, target)
SELECT DISTINCT user_id, kind, item FROM split WHERE item <> '' AND user_id IS NOT NULL;

INSERT INTO follow_trigger_target (user_id, kind, target)
SELECT DISTINCT CAST(json_extract(trigger.config_json, '$.userId') AS INTEGER), 'voice',
  CAST(CAST(json_extract(trigger.config_json, '$.inputs.personId') AS INTEGER) AS TEXT)
FROM workflow_trigger AS trigger
INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
WHERE definition.code = 'voice_catalog_sync'
  AND trigger.enabled = 1
  AND json_valid(trigger.config_json)
  AND json_extract(trigger.config_json, '$.userId') IS NOT NULL
  AND json_extract(trigger.config_json, '$.inputs.personId') IS NOT NULL;

INSERT INTO creator_subscription (user_id, subject_kind, party_id, series_title_id, activated_at)
SELECT DISTINCT target.user_id, 'circle', external.party_id, '',
  CASE WHEN EXISTS (
    SELECT 1 FROM party_catalog_refresh_state AS state
    WHERE state.party_id = external.party_id AND state.provider_code = 'dlsite' AND state.last_success_at IS NOT NULL
  ) THEN CURRENT_TIMESTAMP END
FROM follow_trigger_target AS target
INNER JOIN user_account AS account ON account.id = target.user_id
INNER JOIN party_external_id AS external
  ON external.id_type = 'maker_id' AND UPPER(external.external_id) = target.target
INNER JOIN metadata_provider AS provider ON provider.id = external.provider_id AND provider.code = 'dlsite'
WHERE target.kind = 'circle'
ON CONFLICT DO NOTHING;

-- A series whose circle the same account subscribes to is already covered.
INSERT INTO creator_subscription (user_id, subject_kind, party_id, series_title_id, activated_at)
SELECT DISTINCT target.user_id, 'series', series.party_id, UPPER(series.title_id),
  CASE WHEN EXISTS (
    SELECT 1 FROM party_catalog_refresh_state AS state
    WHERE state.party_id = series.party_id AND state.provider_code = 'dlsite' AND state.last_success_at IS NOT NULL
  ) THEN CURRENT_TIMESTAMP END
FROM follow_trigger_target AS target
INNER JOIN user_account AS account ON account.id = target.user_id
INNER JOIN party_series AS series ON UPPER(series.title_id) = target.target
WHERE target.kind = 'series'
  AND NOT EXISTS (
    SELECT 1 FROM creator_subscription AS circle
    WHERE circle.user_id = target.user_id AND circle.subject_kind = 'circle' AND circle.party_id = series.party_id
  )
ON CONFLICT DO NOTHING;

INSERT INTO creator_subscription (user_id, subject_kind, person_id, activated_at)
SELECT DISTINCT target.user_id, 'voice', person.id,
  CASE WHEN EXISTS (
    SELECT 1 FROM voice_catalog_refresh_state AS state
    WHERE state.person_id = person.id AND state.last_success_at IS NOT NULL
  ) THEN CURRENT_TIMESTAMP END
FROM follow_trigger_target AS target
INNER JOIN user_account AS account ON account.id = target.user_id
INNER JOIN person ON CAST(person.id AS TEXT) = target.target
WHERE target.kind = 'voice'
ON CONFLICT DO NOTHING;

DROP TABLE follow_trigger_target;

INSERT OR IGNORE INTO party_release_seen (party_id, primary_code)
SELECT item.party_id, UPPER(item.primary_code)
FROM party_catalog_item AS item
WHERE item.party_id IN (
  SELECT party_id FROM creator_subscription WHERE party_id IS NOT NULL AND activated_at IS NOT NULL
);

INSERT OR IGNORE INTO person_release_seen (person_id, primary_code)
SELECT item.person_id, UPPER(item.primary_code)
FROM voice_catalog_item AS item
WHERE item.person_id IN (
  SELECT person_id FROM creator_subscription WHERE person_id IS NOT NULL AND activated_at IS NOT NULL
);

DELETE FROM workflow_trigger
WHERE workflow_definition_id IN (
  SELECT id FROM workflow_definition WHERE code IN ('circle_catalog_sync', 'series_catalog_sync', 'voice_catalog_sync')
);

-- The subscription schedule takes over the Availability Watch interval. It
-- checks the watch on each refresh unless the watch was configured without an
-- enabled schedule. Startup plans its first run.
INSERT INTO workflow_definition (code, display_name, description, definition_json, scope, editable)
VALUES (
  'creator_subscription_refresh',
  'Refresh subscriptions',
  'Refresh subscribed circle and voice actor catalogs, sync the metadata of new works, add them to subscribers'' feeds, and check Availability Watch.',
  '{"nodes":[{"id":"catalogs","type":"creator_catalogs","displayName":"Refresh subscribed catalogs"},{"id":"metadata","type":"sync_metadata","displayName":"Sync new work metadata"},{"id":"feed","type":"release_feed","displayName":"Add new works to feeds"},{"id":"watch","type":"dispatch_child_workflows","displayName":"Check Availability Watch"}]}',
  'system',
  0
)
ON CONFLICT(code) DO NOTHING;

INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json)
SELECT definition.id, 'schedule', 'Subscription refresh', 1,
  json_object('intervalMinutes', interval.minutes),
  json_object('availabilityWatch', CASE
    WHEN NOT EXISTS (SELECT 1 FROM availability_watch) OR interval.from_watch = 1 THEN json('true')
    ELSE json('false')
  END)
FROM workflow_definition AS definition
CROSS JOIN (
  SELECT COALESCE((
    SELECT MIN(MAX(CAST(json_extract(trigger.schedule_json, '$.intervalMinutes') AS INTEGER), 60), 10080)
    FROM workflow_trigger AS trigger
    INNER JOIN workflow_definition AS watch ON watch.id = trigger.workflow_definition_id
    WHERE watch.code = 'availability_watch' AND trigger.trigger_type = 'schedule' AND trigger.enabled = 1
      AND json_valid(trigger.schedule_json)
    ORDER BY trigger.id
    LIMIT 1
  ), 1440) AS minutes,
  EXISTS (
    SELECT 1
    FROM workflow_trigger AS trigger
    INNER JOIN workflow_definition AS watch ON watch.id = trigger.workflow_definition_id
    WHERE watch.code = 'availability_watch' AND trigger.trigger_type = 'schedule' AND trigger.enabled = 1
  ) AS from_watch
) AS interval
WHERE definition.code = 'creator_subscription_refresh';

DELETE FROM workflow_trigger
WHERE workflow_definition_id IN (SELECT id FROM workflow_definition WHERE code = 'availability_watch');
