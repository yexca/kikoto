package httpapi

import (
	"errors"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/workcode"
)

// errCustomWorkUnsupported refuses a provider or remote-source action on a
// custom work. Its KT code exists on no provider or remote source, so the
// action could only fail or send the code to services that cannot know it.
var errCustomWorkUnsupported = errors.New("custom works have no provider metadata or remote sources")

func writeCustomWorkUnsupported(w http.ResponseWriter) {
	writeAPIError(w, http.StatusConflict, "custom_work_unsupported", errCustomWorkUnsupported.Error(), false)
}

// refuseCustomWorkCode writes a conflict and reports true for a custom work code.
func refuseCustomWorkCode(w http.ResponseWriter, code string) bool {
	if !workcode.IsCustom(code) {
		return false
	}
	writeCustomWorkUnsupported(w)
	return true
}

// refuseCustomWork writes a conflict and reports true when the work is a
// custom work. A missing work is left to the caller's own not-found handling.
func (s *Server) refuseCustomWork(w http.ResponseWriter, r *http.Request, workID int64) bool {
	var code string
	if err := s.db.QueryRowContext(r.Context(), "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		return false
	}
	return refuseCustomWorkCode(w, code)
}
