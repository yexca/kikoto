package httpapi

import (
	"context"
	"net/http"
)

// recordLibraryEnabledSetting turns the Record library on for the instance.
// It is off until an administrator turns it on in System -> Library.
const recordLibraryEnabledSetting = "record_library_enabled"

func (s *Server) recordLibraryEnabled(ctx context.Context) bool {
	return s.settingBoolContext(ctx, recordLibraryEnabledSetting, false)
}

// whenRecordLibraryEnabled answers every Record route with 404 while the
// Record library is off. Turning it off keeps its indexed folders, assets,
// progress, and thumbnails for when it is turned on again.
func (s *Server) whenRecordLibraryEnabled(handler http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.recordLibraryEnabled(r.Context()) {
			writeAPIError(w, http.StatusNotFound, "record_library_disabled", "The record library is turned off.", false)
			return
		}
		handler(w, r)
	}
}
