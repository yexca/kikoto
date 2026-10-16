-- kikoto:foreign_keys=off
-- A smart favorite list holds the works that match a saved tag rule, plus the
-- works its owner adds by hand, minus the rule matches its owner removes.
-- SQLite cannot change the kind CHECK constraint in place, so favorite_list is
-- rebuilt. Every list keeps its id, so favorite_list_item rows stay attached;
-- the manager runs this file with foreign key enforcement off so dropping the
-- old table does not cascade, then checks every reference.
CREATE TABLE favorite_list_next (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES user_account(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  kind TEXT NOT NULL DEFAULT 'user' CHECK(kind IN ('marked', 'user', 'smart')),
  icon TEXT NOT NULL DEFAULT '',
  UNIQUE(user_id, name)
);

INSERT INTO favorite_list_next (id, user_id, name, description, sort_order, created_at, updated_at, kind, icon)
SELECT id, user_id, name, description, sort_order, created_at, updated_at, kind, icon
FROM favorite_list;

DROP TABLE favorite_list;
ALTER TABLE favorite_list_next RENAME TO favorite_list;

CREATE UNIQUE INDEX idx_favorite_list_one_marked_per_user
  ON favorite_list(user_id)
  WHERE kind = 'marked';

CREATE INDEX idx_favorite_list_user_kind_sort
  ON favorite_list(user_id, kind, sort_order, id);

-- The rule of a smart list. include_match decides whether a work needs every
-- included tag or any one of them.
CREATE TABLE favorite_list_smart_rule (
  list_id INTEGER PRIMARY KEY REFERENCES favorite_list(id) ON DELETE CASCADE,
  include_match TEXT NOT NULL DEFAULT 'all' CHECK(include_match IN ('all', 'any')),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- A rule condition names a shared metadata tag or one of the owner's personal
-- tags. tag_id has no foreign key on purpose: a deleted or hidden tag matches
-- no work, which is exactly what the condition then means, so the condition
-- stays visible in the editor instead of silently changing the list.
CREATE TABLE favorite_list_smart_tag (
  list_id INTEGER NOT NULL REFERENCES favorite_list(id) ON DELETE CASCADE,
  tag_kind TEXT NOT NULL CHECK(tag_kind IN ('metadata', 'user')),
  tag_id INTEGER NOT NULL CHECK(tag_id > 0),
  mode TEXT NOT NULL CHECK(mode IN ('include', 'exclude')),
  PRIMARY KEY(list_id, tag_kind, tag_id)
);

CREATE INDEX idx_favorite_list_smart_tag_user_tag
  ON favorite_list_smart_tag(tag_id)
  WHERE tag_kind = 'user';

-- Rule matches the owner removed from the list by hand.
CREATE TABLE favorite_list_smart_exclusion (
  list_id INTEGER NOT NULL REFERENCES favorite_list(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(list_id, work_id)
);

CREATE INDEX idx_favorite_list_smart_exclusion_work
  ON favorite_list_smart_exclusion(work_id);

-- Rule matches the owner has already seen. A current match outside this set
-- is a new work of the list.
CREATE TABLE favorite_list_smart_seen (
  list_id INTEGER NOT NULL REFERENCES favorite_list(id) ON DELETE CASCADE,
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(list_id, work_id)
);

CREATE INDEX idx_favorite_list_smart_seen_work
  ON favorite_list_smart_seen(work_id);
