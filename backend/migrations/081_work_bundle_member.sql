-- An official bundle (コンプリートパック, セット, 総集編) is its own DLsite
-- product that contains works also sold on their own. A row names one member
-- of the bundle by code. Neither code has to be a work, and the relationship is
-- not an edition: the bundle and each member keep their own work, edition
-- family, playback and availability.
--
-- status:
--   linked     the member belongs to the bundle.
--   dismissed  a user removed a detected member; detection does not add it again.
-- origin records whether metadata sync or a user decided the current status.
-- Codes are stored in upper case.
CREATE TABLE work_bundle_member (
  bundle_code TEXT NOT NULL CHECK(bundle_code <> '' AND bundle_code = UPPER(bundle_code)),
  member_code TEXT NOT NULL CHECK(member_code <> '' AND member_code = UPPER(member_code)),
  position INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK(status IN ('linked', 'dismissed')),
  origin TEXT NOT NULL CHECK(origin IN ('detected', 'user')),
  updated_by_user_id INTEGER REFERENCES user_account(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(bundle_code, member_code),
  CHECK(bundle_code <> member_code)
);

CREATE INDEX idx_work_bundle_member_member_code
  ON work_bundle_member(member_code)
  WHERE status = 'linked';
CREATE INDEX idx_fk_work_bundle_member_updated_by_user_id ON work_bundle_member(updated_by_user_id);

-- A bundle's search document holds its members' codes and the titles of the
-- members in the library, so membership and member changes queue the bundle.
CREATE TRIGGER work_search_bundle_member_insert
AFTER INSERT ON work_bundle_member
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT id FROM work WHERE UPPER(primary_code) = NEW.bundle_code
    AND id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_bundle_member_delete
AFTER DELETE ON work_bundle_member
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT id FROM work WHERE UPPER(primary_code) = OLD.bundle_code
    AND id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_bundle_member_update
AFTER UPDATE OF bundle_code, member_code, status ON work_bundle_member
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT id FROM work WHERE UPPER(primary_code) IN (OLD.bundle_code, NEW.bundle_code)
    AND id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_bundle_member_work_insert
AFTER INSERT ON work
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT bundle.id
  FROM work_bundle_member AS member
  INNER JOIN work AS bundle ON UPPER(bundle.primary_code) = member.bundle_code
  WHERE member.status = 'linked' AND member.member_code = UPPER(NEW.primary_code)
    AND bundle.id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_bundle_member_work_delete
AFTER DELETE ON work
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT bundle.id
  FROM work_bundle_member AS member
  INNER JOIN work AS bundle ON UPPER(bundle.primary_code) = member.bundle_code
  WHERE member.status = 'linked' AND member.member_code = UPPER(OLD.primary_code)
    AND bundle.id NOT IN (SELECT work_id FROM work_search_dirty);
END;

CREATE TRIGGER work_search_bundle_member_work_update
AFTER UPDATE OF primary_code, title ON work
WHEN OLD.primary_code IS NOT NEW.primary_code OR OLD.title IS NOT NEW.title
BEGIN
  INSERT INTO work_search_dirty (work_id)
  SELECT DISTINCT bundle.id
  FROM work_bundle_member AS member
  INNER JOIN work AS bundle ON UPPER(bundle.primary_code) = member.bundle_code
  WHERE member.status = 'linked' AND member.member_code IN (UPPER(OLD.primary_code), UPPER(NEW.primary_code))
    AND bundle.id NOT IN (SELECT work_id FROM work_search_dirty);
END;
