package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// lyricsAttributionSettingKey stores whether lyrics files Kikoto writes from
// speech recognition or translation open with a line naming their models.
// The setting applies to files written after it changes; published files keep
// their text.
const lyricsAttributionSettingKey = "lyrics_ai_attribution"

type lyricsAttributionSetting struct {
	Enabled bool `json:"enabled"`
}

func (s *Server) lyricsAttributionEnabled(ctx context.Context) (bool, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", lyricsAttributionSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	var setting lyricsAttributionSetting
	if err := json.Unmarshal([]byte(raw), &setting); err != nil {
		return true, nil
	}
	return setting.Enabled, nil
}

func (s *Server) getLyricsAttribution(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	enabled, err := s.lyricsAttributionEnabled(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lyricsAttributionSetting{Enabled: enabled})
}

func (s *Server) updateLyricsAttribution(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Speech recognition and translation settings are unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var setting lyricsAttributionSetting
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&setting); err != nil {
		writeAPIError(w, 400, "invalid_setting", "Invalid lyrics attribution setting.", false)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO app_setting(key, value_json) VALUES(?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP`, lyricsAttributionSettingKey, mustJSON(setting)); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, setting)
}
