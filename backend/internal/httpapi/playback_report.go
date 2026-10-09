package httpapi

import (
	"github.com/yexca/kikoto/backend/internal/personal"
	"net/http"
)

func (s *Server) recordPlaybackReport(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "playback:use")
	if !ok {
		return
	}
	var payload personal.PlaybackReport
	if !decodePersonalBody(w, r, &payload, 128*1024) {
		return
	}
	result, err := (personal.Store{DB: s.db}).RecordPlaybackReport(r.Context(), user.ID, payload)
	if err != nil {
		writePersonalError(w, err)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, result)
}
