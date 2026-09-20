package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

const metadataOnboardingKey = "metadata_onboarding"

type metadataOnboardingState struct {
	Dismissed bool  `json:"dismissed"`
	RunID     int64 `json:"runId"`
}

type metadataOnboardingView struct {
	Status       string `json:"status"`
	MissingWorks int    `json:"missingWorks"`
	RunID        int64  `json:"runId"`
}

func (s *Server) metadataOnboarding(ctx context.Context) (metadataOnboardingView, error) {
	view := metadataOnboardingView{Status: "hidden"}
	var state metadataOnboardingState
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", metadataOnboardingKey).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return view, err
	}
	if raw != "" {
		if err := json.Unmarshal([]byte(raw), &state); err != nil {
			return view, err
		}
	}
	if state.Dismissed || s.cfg.IsDemo() {
		return view, nil
	}
	if state.RunID > 0 {
		view.RunID = state.RunID
		err := s.db.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", state.RunID).Scan(&view.Status)
		if errors.Is(err, sql.ErrNoRows) {
			return metadataOnboardingView{Status: "hidden"}, nil
		}
		return view, err
	}
	var previouslySynced, scanning, scanned bool
	if err := s.db.QueryRowContext(ctx, `SELECT
		EXISTS (SELECT 1 FROM workflow_run WHERE workflow_code = 'metadata_sync'),
		EXISTS (SELECT 1 FROM workflow_run WHERE workflow_code = 'local_library_scan' AND status IN ('queued', 'running')),
		EXISTS (SELECT 1 FROM workflow_run WHERE workflow_code = 'local_library_scan' AND status IN ('succeeded', 'partial'))
	`).Scan(&previouslySynced, &scanning, &scanned); err != nil {
		return view, err
	}
	if previouslySynced {
		err := s.db.QueryRowContext(ctx, `SELECT id, status FROM workflow_run
			WHERE workflow_code = 'metadata_sync' AND status IN ('queued', 'running') ORDER BY id LIMIT 1`).Scan(&view.RunID, &view.Status)
		if errors.Is(err, sql.ErrNoRows) {
			return view, nil
		}
		return view, err
	}
	if scanning || !scanned {
		view.Status = "waiting"
		return view, nil
	}
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM work
		WHERE EXISTS (SELECT 1 FROM work_folder_location AS folder WHERE folder.work_id = work.id AND folder.state = 'active')
		AND NOT EXISTS (SELECT 1 FROM metadata_snapshot AS snapshot
			JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
			WHERE snapshot.work_id = work.id AND provider.code = 'dlsite')
	`).Scan(&view.MissingWorks); err != nil {
		return view, err
	}
	if view.MissingWorks > 0 {
		view.Status = "ready"
	} else {
		// An empty first scan can be followed by a later folder import.
		view.Status = "waiting"
	}
	return view, nil
}

func (s *Server) getMetadataOnboarding(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	view, err := s.metadataOnboarding(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) dismissMetadataOnboarding(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "demo_read_only", "demo is read only", false)
		return
	}
	s.metadataOnboardingMu.Lock()
	defer s.metadataOnboardingMu.Unlock()
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO app_setting (key, value_json) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, metadataOnboardingKey, mustJSON(metadataOnboardingState{Dismissed: true})); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, metadataOnboardingView{Status: "hidden"})
}

func (s *Server) startMetadataOnboarding(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "demo_read_only", "demo is read only", false)
		return
	}
	s.metadataOnboardingMu.Lock()
	defer s.metadataOnboardingMu.Unlock()
	view, err := s.metadataOnboarding(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if view.Status != "ready" {
		writeJSON(w, http.StatusOK, view)
		return
	}
	run, err := s.enqueueDLsiteMetadataSync(r.Context(), "manual", "first_library_metadata")
	if err != nil {
		writeError(w, err)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO app_setting (key, value_json) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, metadataOnboardingKey, mustJSON(metadataOnboardingState{RunID: run.RunID})); err != nil {
		writeError(w, err)
		return
	}
	// Read the durable run status so even a very fast worker cannot finish
	// between enqueue and subscription without delivering its notification.
	if _, err := tx.ExecContext(r.Context(), `INSERT INTO workflow_notification (user_id, workflow_run_id, notification_type, status)
		SELECT ?, id, 'metadata_onboarding', CASE WHEN status = 'succeeded' THEN 'succeeded'
			WHEN status IN ('partial', 'failed', 'cancelled') THEN 'failed' ELSE 'pending' END
		FROM workflow_run WHERE id = ?
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO NOTHING`, actor.ID, run.RunID); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, metadataOnboardingView{Status: run.Status, RunID: run.RunID})
}
