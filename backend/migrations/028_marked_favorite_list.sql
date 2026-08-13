ALTER TABLE favorite_list ADD COLUMN kind TEXT NOT NULL DEFAULT 'user' CHECK(kind IN ('marked', 'user'));

-- The historical automatic Favorites list becomes Marked only when it has no
-- explicit membership. Existing non-empty Favorites lists remain user-authored
-- data. System-list names are stored empty so a user can keep an independently
-- named Marked list without colliding with this implementation.
UPDATE favorite_list AS legacy
SET kind = 'marked',
  name = '',
  sort_order = -1,
  updated_at = CURRENT_TIMESTAMP
WHERE legacy.kind = 'user'
  AND legacy.name = 'Favorites'
  AND NOT EXISTS (
    SELECT 1
    FROM favorite_list_item AS item
    WHERE item.list_id = legacy.id
  );

-- Preserve legacy state-only favorites as explicit user-list membership. When
-- an empty automatic Favorites list was converted above, this creates a new
-- ordinary Favorites list for the preserved members.
INSERT INTO favorite_list (user_id, name, sort_order, kind)
SELECT state.user_id,
  'Favorites',
  COALESCE((
    SELECT MAX(existing_list.sort_order) + 1
    FROM favorite_list AS existing_list
    WHERE existing_list.user_id = state.user_id
  ), 0),
  'user'
FROM user_work_state AS state
WHERE state.favorite = 1
  AND NOT EXISTS (
    SELECT 1
    FROM favorite_list_item AS item
    INNER JOIN favorite_list AS list ON list.id = item.list_id
    WHERE list.user_id = state.user_id
      AND list.kind = 'user'
      AND item.work_id = state.work_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM favorite_list AS list
    WHERE list.user_id = state.user_id AND list.name = 'Favorites'
  )
GROUP BY state.user_id;

INSERT OR IGNORE INTO favorite_list_item (list_id, work_id)
SELECT list.id, state.work_id
FROM user_work_state AS state
INNER JOIN favorite_list AS list
  ON list.user_id = state.user_id AND list.name = 'Favorites' AND list.kind = 'user'
WHERE state.favorite = 1
  AND NOT EXISTS (
    SELECT 1
    FROM favorite_list_item AS item
    INNER JOIN favorite_list AS existing_list ON existing_list.id = item.list_id
    WHERE existing_list.user_id = state.user_id
      AND existing_list.kind = 'user'
      AND item.work_id = state.work_id
  );

-- Every account has one system Marked list. Its displayed name is derived
-- from kind, so the collision fallback remains an internal migration detail.
INSERT INTO favorite_list (user_id, name, sort_order, kind)
SELECT account.id,
  '',
  -1,
  'marked'
FROM user_account AS account
WHERE NOT EXISTS (
  SELECT 1
  FROM favorite_list AS list
  WHERE list.user_id = account.id AND list.kind = 'marked'
);

CREATE UNIQUE INDEX idx_favorite_list_one_marked_per_user
  ON favorite_list(user_id)
  WHERE kind = 'marked';

CREATE INDEX idx_favorite_list_user_kind_sort
  ON favorite_list(user_id, kind, sort_order, id);

INSERT OR IGNORE INTO user_work_state (user_id, work_id, listening_status, favorite)
SELECT DISTINCT list.user_id, item.work_id, 'none', 1
FROM favorite_list_item AS item
INNER JOIN favorite_list AS list ON list.id = item.list_id
WHERE list.kind = 'user';

UPDATE user_work_state
SET favorite = CASE WHEN EXISTS (
  SELECT 1
  FROM favorite_list_item AS item
  INNER JOIN favorite_list AS list ON list.id = item.list_id
  WHERE list.user_id = user_work_state.user_id
    AND list.kind = 'user'
    AND item.work_id = user_work_state.work_id
) THEN 1 ELSE 0 END
WHERE favorite <> CASE WHEN EXISTS (
  SELECT 1
  FROM favorite_list_item AS item
  INNER JOIN favorite_list AS list ON list.id = item.list_id
  WHERE list.user_id = user_work_state.user_id
    AND list.kind = 'user'
    AND item.work_id = user_work_state.work_id
) THEN 1 ELSE 0 END;
