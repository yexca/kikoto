-- A smart list rule sorts its tags into three groups: a work carries every
-- required tag, at least one tag of the any group when that group has tags,
-- and no excluded tag. The included tags of an "all" rule become required
-- tags and those of an "any" rule become the any group, so every list keeps
-- the works it matched. The group lives on each condition, so the per-list
-- rule row that held the all-or-any switch is dropped.
CREATE TABLE favorite_list_smart_tag_next (
  list_id INTEGER NOT NULL REFERENCES favorite_list(id) ON DELETE CASCADE,
  tag_kind TEXT NOT NULL CHECK(tag_kind IN ('metadata', 'user')),
  tag_id INTEGER NOT NULL CHECK(tag_id > 0),
  mode TEXT NOT NULL CHECK(mode IN ('require', 'any', 'exclude')),
  PRIMARY KEY(list_id, tag_kind, tag_id)
);

INSERT INTO favorite_list_smart_tag_next (list_id, tag_kind, tag_id, mode)
SELECT condition.list_id, condition.tag_kind, condition.tag_id,
  CASE
    WHEN condition.mode = 'exclude' THEN 'exclude'
    WHEN rule.include_match = 'any' THEN 'any'
    ELSE 'require'
  END
FROM favorite_list_smart_tag AS condition
LEFT JOIN favorite_list_smart_rule AS rule ON rule.list_id = condition.list_id
ORDER BY condition.rowid;

DROP TABLE favorite_list_smart_tag;
ALTER TABLE favorite_list_smart_tag_next RENAME TO favorite_list_smart_tag;

CREATE INDEX idx_favorite_list_smart_tag_user_tag
  ON favorite_list_smart_tag(tag_id)
  WHERE tag_kind = 'user';

DROP TABLE favorite_list_smart_rule;
