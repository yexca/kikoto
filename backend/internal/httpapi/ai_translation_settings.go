package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

// translationSettingKey stores whether finished Translate with AI items are
// accepted automatically. Auto-accept is on by default: every finished item
// takes the same acceptance path a reviewer takes, as its requester, and an
// item that acceptance refuses fails with the refusal as its code. With
// auto-accept off, finished items wait for review.
const translationSettingKey = "translation_settings"

type translationSettings struct {
	AutoAccept bool `json:"autoAccept"`
}

func (s *Server) translationSettings(ctx context.Context) (translationSettings, error) {
	settings := translationSettings{AutoAccept: true}
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", translationSettingKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	if err := json.Unmarshal([]byte(raw), &settings); err != nil {
		return translationSettings{AutoAccept: true}, nil
	}
	return settings, nil
}

func (s *Server) getTranslationSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	settings, err := s.translationSettings(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) updateTranslationSettings(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var settings translationSettings
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&settings); err != nil {
		writeAPIError(w, 400, "invalid_setting", "Invalid translation settings.", false)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO app_setting(key, value_json) VALUES(?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP`, translationSettingKey, mustJSON(settings)); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

// autoAcceptTranslationItem accepts a finished item when auto-accept is on,
// as the account that sends it again, or else as its requester. A refusal
// fails the item with its code; the run's other items continue either way.
func (s *Server) autoAcceptTranslationItem(ctx context.Context, id int64, by *currentUser) error {
	ctx = context.WithoutCancel(ctx)
	settings, err := s.translationSettings(ctx)
	if err != nil || !settings.AutoAccept {
		return err
	}
	items, err := loadTranslationItems(ctx, s.db, "item.id = ?", id)
	if err != nil || len(items) == 0 || items[0].State != "ready" {
		return err
	}
	code := "permission_changed"
	userID := items[0].UserID
	if by != nil {
		userID = by.ID
	}
	actor, err := s.accountStore.LoadByID(ctx, userID)
	if err == nil && userID != 0 {
		s.translationReviewMu.Lock()
		code, err = s.acceptTranslationItem(ctx, actor, id)
		s.translationReviewMu.Unlock()
		if err != nil {
			slog.Warn("translation auto-accept failed", "item", id, "error", err)
			code = "accept_failed"
		}
	}
	if code == "" || code == "already_handled" {
		return nil
	}
	if code == "permission_denied" {
		code = "permission_changed"
	}
	_, err = s.db.ExecContext(ctx, `UPDATE translation_item SET state = 'failed', failure_code = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND state IN ('ready', 'invalid')`, code, id)
	return err
}
