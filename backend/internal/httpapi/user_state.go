package httpapi

import (
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
}

func (s *Server) updateWorkUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
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
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	var currentStatus string
	var currentFavorite int
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COALESCE(listening_status, 'none'), COALESCE(favorite, 0)
		FROM user_work_state
		WHERE user_id = ? AND work_id = ?
	`, user.ID, workID).Scan(&currentStatus, &currentFavorite); err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeError(w, err)
		return
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
	favorite := currentFavorite != 0
	if payload.Favorite != nil {
		favorite = *payload.Favorite
	}
	favoriteValue := 0
	if favorite {
		favoriteValue = 1
	}

	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			listening_status = excluded.listening_status,
			favorite = excluded.favorite,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, workID, status, favoriteValue); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, workUserStateResponse{WorkID: workID, ListeningStatus: status, Favorite: favorite})
}

func validListeningStatus(status string) bool {
	switch status {
	case "none", "want_to_listen", "listening", "finished", "relisten", "paused":
		return true
	default:
		return false
	}
}
