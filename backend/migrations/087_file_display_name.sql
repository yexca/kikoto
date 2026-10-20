-- The name the directory shows for a local file in one metadata language. It
-- never renames the file: playback order, lyrics matching, downloads and file
-- management use the real name, and a viewer whose languages have no name sees
-- the real one. The name has no extension; the file keeps its own.
CREATE TABLE media_item_display_name (
  media_item_id INTEGER NOT NULL REFERENCES media_item(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK(language IN ('ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(media_item_id, language)
) WITHOUT ROWID;

CREATE INDEX idx_fk_media_item_display_name_updated_by_user_id ON media_item_display_name(updated_by_user_id);

-- The name the directory shows for a folder inside a work's folders, by its
-- path below the work folder. Copies of a work in several folders share it, as
-- files at the same path share one media item.
CREATE TABLE work_folder_display_name (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK(path <> ''),
  language TEXT NOT NULL CHECK(language IN ('ja-jp', 'zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 255),
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, path, language)
) WITHOUT ROWID;

CREATE INDEX idx_fk_work_folder_display_name_updated_by_user_id ON work_folder_display_name(updated_by_user_id);
