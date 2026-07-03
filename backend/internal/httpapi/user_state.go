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
		ListeningStatus string `json:"listeningStatus"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	status := strings.TrimSpace(payload.ListeningStatus)
	if status == "" {
		status = "none"
	}
	if !validListeningStatus(status) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid listening status"})
		return
	}

	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_work_state (user_id, work_id, listening_status)
		VALUES (?, ?, ?)
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			listening_status = excluded.listening_status,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, workID, status); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, workUserStateResponse{WorkID: workID, ListeningStatus: status})
}

func validListeningStatus(status string) bool {
	switch status {
	case "none", "want_to_listen", "listening", "finished", "relisten", "paused":
		return true
	default:
		return false
	}
}
