-- Localized genre name learning. A targeted lookup asks DLsite for one known
-- work in a preferred locale only to learn the names of that work's genres.
-- Each answered request is recorded so the same work and locale are never
-- requested again; failed requests are not recorded and stay retryable.
CREATE TABLE dlsite_genre_name_request (
  work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE,
  language TEXT NOT NULL CHECK(language IN ('zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  outcome TEXT NOT NULL CHECK(outcome IN ('learned', 'no_names', 'not_found')),
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(work_id, language)
) WITHOUT ROWID;

-- A genre and locale that answered lookups did not name. After repeated
-- attempts, or when no unrequested work carries the genre, the combination is
-- exhausted and no longer selected.
CREATE TABLE dlsite_genre_name_gap (
  genre_id INTEGER NOT NULL CHECK(genre_id > 0),
  language TEXT NOT NULL CHECK(language IN ('zh-cn', 'zh-tw', 'en-us', 'ko-kr')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  exhausted INTEGER NOT NULL DEFAULT 0 CHECK(exhausted IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(genre_id, language)
) WITHOUT ROWID;
