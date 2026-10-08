package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
)

// maxLyricsAssignmentChanges bounds one save so a single request cannot hold
// the write transaction for an unbounded media tree.
const maxLyricsAssignmentChanges = 2000

// lyricsAssignmentChange sets or clears the library-level lyrics file of one
// audio media item. A null lyrics id clears the assignment.
type lyricsAssignmentChange struct {
	AudioMediaItemID  int64  `json:"audioMediaItemId"`
	LyricsMediaItemID *int64 `json:"lyricsMediaItemId"`
}

type lyricsAssignmentRequestError struct {
	status  int
	message string
}

func (err lyricsAssignmentRequestError) Error() string {
	return err.message
}

func (s *Server) setWorkLyricsAssignments(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	var payload struct {
		Assignments []lyricsAssignmentChange `json:"assignments"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := validateLyricsAssignmentChanges(payload.Assignments); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	familyWorkIDs, err := s.lyricsAssignmentFamily(r.Context(), workID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	if err := s.applyLyricsAssignmentChanges(r.Context(), user.ID, familyWorkIDs, payload.Assignments); err != nil {
		var requestErr lyricsAssignmentRequestError
		if errors.As(err, &requestErr) {
			writeJSON(w, requestErr.status, map[string]string{"error": requestErr.message})
			return
		}
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workId": workID, "assignments": payload.Assignments})
}

func validateLyricsAssignmentChanges(changes []lyricsAssignmentChange) error {
	if len(changes) == 0 {
		return errors.New("assignments are required")
	}
	if len(changes) > maxLyricsAssignmentChanges {
		return fmt.Errorf("at most %d assignments can be saved at once", maxLyricsAssignmentChanges)
	}
	seen := make(map[int64]bool, len(changes))
	for _, change := range changes {
		if change.AudioMediaItemID <= 0 || (change.LyricsMediaItemID != nil && *change.LyricsMediaItemID <= 0) {
			return errors.New("assignment media item ids must be positive")
		}
		if seen[change.AudioMediaItemID] {
			return errors.New("each audio media item can be assigned only once")
		}
		seen[change.AudioMediaItemID] = true
	}
	return nil
}

// lyricsAssignmentFamily returns the works whose media the requested work's
// detail can show: the work itself and every edition of its family.
func (s *Server) lyricsAssignmentFamily(ctx context.Context, workID int64) (map[int64]bool, error) {
	var code string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		return nil, err
	}
	ids, err := s.familyWorkIDsForCode(ctx, code)
	if err != nil {
		return nil, err
	}
	family := map[int64]bool{workID: true}
	for _, id := range ids {
		family[id] = true
	}
	return family, nil
}

func (s *Server) applyLyricsAssignmentChanges(ctx context.Context, userID int64, familyWorkIDs map[int64]bool, changes []lyricsAssignmentChange) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, change := range changes {
		if err := applyLyricsAssignmentChange(ctx, tx, userID, familyWorkIDs, change); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func applyLyricsAssignmentChange(ctx context.Context, tx *sql.Tx, userID int64, familyWorkIDs map[int64]bool, change lyricsAssignmentChange) error {
	var audioWorkID int64
	var audioKind string
	if err := tx.QueryRowContext(ctx, "SELECT work_id, kind FROM media_item WHERE id = ?", change.AudioMediaItemID).Scan(&audioWorkID, &audioKind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lyricsAssignmentRequestError{status: http.StatusNotFound, message: "media item not found"}
		}
		return err
	}
	if audioKind != "audio" || !familyWorkIDs[audioWorkID] {
		return lyricsAssignmentRequestError{status: http.StatusBadRequest, message: "lyrics assignments must target audio media of this work"}
	}
	if change.LyricsMediaItemID == nil {
		_, err := tx.ExecContext(ctx, "DELETE FROM media_lyrics_assignment WHERE audio_media_item_id = ?", change.AudioMediaItemID)
		return err
	}
	lyricsID := *change.LyricsMediaItemID
	var lyricsWorkID int64
	var lyricsKind, lyricsPath string
	if err := tx.QueryRowContext(ctx, `
		SELECT item.work_id, item.kind, COALESCE((
			SELECT location.path
			FROM media_file_location AS location
			WHERE location.media_item_id = item.id AND location.availability = 'available'
			ORDER BY location.id
			LIMIT 1
		), item.title)
		FROM media_item AS item
		WHERE item.id = ?
	`, lyricsID).Scan(&lyricsWorkID, &lyricsKind, &lyricsPath); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return lyricsAssignmentRequestError{status: http.StatusNotFound, message: "media item not found"}
		}
		return err
	}
	if lyricsID == change.AudioMediaItemID || !isLyricsMediaKind(lyricsKind, lyricsPath) || lyricsWorkID != audioWorkID {
		return lyricsAssignmentRequestError{status: http.StatusBadRequest, message: "lyrics assignments must link audio and text media from the same work"}
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO media_lyrics_assignment (audio_media_item_id, lyrics_media_item_id, origin, assigned_by_user_id)
		VALUES (?, ?, 'manual', ?)
		ON CONFLICT(audio_media_item_id) DO UPDATE SET
			lyrics_media_item_id = excluded.lyrics_media_item_id,
			origin = excluded.origin,
			assigned_by_user_id = excluded.assigned_by_user_id,
			updated_at = CURRENT_TIMESTAMP
	`, change.AudioMediaItemID, lyricsID, nullableUserID(userID))
	return err
}
