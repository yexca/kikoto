package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

type workUserStateResponse struct {
	WorkID          int64  `json:"workId"`
	ListeningStatus string `json:"listeningStatus"`
	Favorite        bool   `json:"favorite"`
	UserRating      *int   `json:"userRating"`
}

func (s *Server) updateWorkUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM work WHERE id = ?", workID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}

	var payload struct {
		ListeningStatus *string `json:"listeningStatus"`
		Favorite        *bool   `json:"favorite"`
		// Absent keeps the rating; null clears it.
		UserRating json.RawMessage `json:"userRating"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if payload.Favorite != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "use favorite lists to change list membership"})
		return
	}
	var currentStatus string
	var currentFavorite int
	var currentRating sql.NullInt64
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COALESCE(listening_status, 'none'), COALESCE(favorite, 0), rating
		FROM user_work_state
		WHERE user_id = ? AND work_id = ?
	`, user.ID, workID).Scan(&currentStatus, &currentFavorite, &currentRating); err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeError(w, err)
		return
	}
	rating := validUserRating(currentRating)
	if len(payload.UserRating) > 0 {
		next, ok := parseUserRating(payload.UserRating)
		if !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "userRating must be a whole number from 1 to 5 or null"})
			return
		}
		rating = next
	}
	status := strings.TrimSpace(currentStatus)
	if payload.ListeningStatus != nil {
		status = strings.TrimSpace(*payload.ListeningStatus)
	}
	if status == "" {
		status = "none"
	}
	if !validListeningStatus(status) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid listening status"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite, rating)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			listening_status = excluded.listening_status,
			rating = excluded.rating,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, workID, status, currentFavorite, rating); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workUserStateResponse{WorkID: workID, ListeningStatus: status, Favorite: currentFavorite != 0, UserRating: rating})
}

// validUserRating reads a stored rating, treating anything outside one to five
// stars as unrated.
func validUserRating(value sql.NullInt64) *int {
	if !value.Valid || value.Int64 < 1 || value.Int64 > 5 {
		return nil
	}
	rating := int(value.Int64)
	return &rating
}

func parseUserRating(raw json.RawMessage) (*int, bool) {
	if string(raw) == "null" {
		return nil, true
	}
	var rating int
	if err := json.Unmarshal(raw, &rating); err != nil || rating < 1 || rating > 5 {
		return nil, false
	}
	return &rating, true
}

type favoriteWorksQuery struct {
	Page       int
	PageSize   int
	ListID     int64
	Sort       string
	Direction  string
	RandomSeed int64
	SourceIDs  []int64
	// NewOnly narrows a smart list to its new works.
	NewOnly bool
}

func (s *Server) requireWorkExists(ctx context.Context, workID int64) error {
	var exists int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM work WHERE id = ?", workID).Scan(&exists)
}

func validListeningStatus(status string) bool {
	switch status {
	case "none", "want_to_listen", "listening", "finished", "relisten", "paused":
		return true
	default:
		return false
	}
}
