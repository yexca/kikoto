-- A personal rating is one to five stars; anything else, including the 0 that
-- imports used for "unrated", is stored as no rating.
UPDATE user_work_state
SET rating = NULL
WHERE rating IS NOT NULL AND (rating < 1 OR rating > 5);

-- Ratings are recommendation feedback, so a changed rating advances the
-- account's recommendation revision like a changed mark.
DROP TRIGGER recommendation_revision_user_state_update;

CREATE TRIGGER recommendation_revision_user_state_update
AFTER UPDATE OF listening_status, favorite, rating ON user_work_state
WHEN OLD.listening_status IS NOT NEW.listening_status
  OR OLD.favorite IS NOT NEW.favorite
  OR OLD.rating IS NOT NEW.rating
BEGIN
  INSERT INTO recommendation_user_revision (user_id, revision, updated_at)
  VALUES (NEW.user_id, 1, CURRENT_TIMESTAMP)
  ON CONFLICT(user_id) DO UPDATE SET
    revision = recommendation_user_revision.revision + 1,
    updated_at = CURRENT_TIMESTAMP;
END;

DROP INDEX idx_user_work_state_recommendation_feedback;

CREATE INDEX idx_user_work_state_recommendation_feedback
  ON user_work_state(user_id, work_id)
  WHERE listening_status <> 'none' OR favorite = 1 OR rating IS NOT NULL;
