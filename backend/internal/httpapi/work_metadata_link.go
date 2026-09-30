package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

// workMetadataLink is a user-declared DLsite product whose metadata is stored
// on this work. It never identifies another work or file availability.
type workMetadataLink struct {
	SourceCode string `json:"sourceCode"`
	URL        string `json:"url"`
	UpdatedAt  string `json:"updatedAt"`
}

type workMetadataLinkResponse struct {
	Link *workMetadataLink          `json:"link"`
	Sync *workMetadataSyncRunResult `json:"sync,omitempty"`
}

func (s *Server) setWorkMetadataLink(w http.ResponseWriter, r *http.Request) {
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
		SourceCode string `json:"sourceCode"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json body"})
		return
	}
	sourceCode := normalizeDLsiteCode(payload.SourceCode)
	if sourceCode == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return
	}
	var primaryCode string
	if err := s.db.QueryRowContext(r.Context(), "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&primaryCode); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	if strings.EqualFold(strings.TrimSpace(primaryCode), sourceCode) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "a work cannot use its own code as a metadata link"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO work_metadata_link (work_id, provider_id, source_code, updated_by_user_id)
		SELECT ?, id, ?, ? FROM metadata_provider WHERE code = 'dlsite'
		ON CONFLICT(work_id, provider_id) DO UPDATE SET
			source_code = excluded.source_code,
			updated_by_user_id = excluded.updated_by_user_id,
			updated_at = CURRENT_TIMESTAMP
	`, workID, sourceCode, nullableUserID(user.ID)); err != nil {
		writeError(w, err)
		return
	}
	link, err := s.loadWorkMetadataLink(r.Context(), workID)
	if err != nil {
		writeError(w, err)
		return
	}
	response := workMetadataLinkResponse{Link: link}
	if userHasPermission(user, "metadata:sync") {
		// A new link is an explicit request for the linked product, so it
		// rechecks a work whose own product was recorded as not found.
		result, err := s.enqueueWorkMetadataSyncWithOptions(r.Context(), workID, true)
		if err != nil {
			writeError(w, err)
			return
		}
		response.Sync = &result
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) deleteWorkMetadataLink(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if !s.workIDExists(r.Context(), workID) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	// Stored metadata stays until the next synchronization of the work's own
	// product, like any other retained provider snapshot.
	if _, err := s.db.ExecContext(r.Context(), `DELETE FROM work_metadata_link
		WHERE work_id = ? AND provider_id IN (SELECT id FROM metadata_provider WHERE code = 'dlsite')`, workID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workMetadataLinkResponse{})
}

func (s *Server) loadWorkMetadataLink(ctx context.Context, workID int64) (*workMetadataLink, error) {
	var link workMetadataLink
	err := s.db.QueryRowContext(ctx, `SELECT link.source_code, link.updated_at
		FROM work_metadata_link AS link
		JOIN metadata_provider AS provider ON provider.id = link.provider_id
		WHERE link.work_id = ? AND provider.code = 'dlsite'`, workID).Scan(&link.SourceCode, &link.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	link.URL = s.dlsiteURL(link.SourceCode)
	return &link, nil
}

func nullableUserID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}
