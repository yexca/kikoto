package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

type availabilityWatchView struct {
	ID                int64                     `json:"id"`
	Enabled           bool                      `json:"enabled"`
	IntervalMinutes   int                       `json:"intervalMinutes"`
	Action            string                    `json:"action"`
	SourceID          *int64                    `json:"sourceId"`
	ExcludeExtensions []string                  `json:"excludeExtensions"`
	Revision          int                       `json:"revision"`
	Targets           []availabilityWatchTarget `json:"targets"`
}

type availabilityWatchTarget struct {
	ID                int64  `json:"id"`
	WorkCode          string `json:"workCode"`
	State             string `json:"state"`
	NextCheckAt       string `json:"nextCheckAt"`
	LastCheckedAt     string `json:"lastCheckedAt"`
	LastStatus        string `json:"lastStatus"`
	LastError         string `json:"lastError"`
	AvailableSourceID *int64 `json:"availableSourceId"`
	TrackRunID        *int64 `json:"trackRunId"`
	FetchRunID        *int64 `json:"fetchRunId"`
}

type availabilityWatchUpdate struct {
	Enabled           bool     `json:"enabled"`
	IntervalMinutes   int      `json:"intervalMinutes"`
	Action            string   `json:"action"`
	SourceID          *int64   `json:"sourceId"`
	ExcludeExtensions []string `json:"excludeExtensions"`
	TargetCodes       []string `json:"targetCodes"`
}

func (s *Server) getAvailabilityWatch(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context(), actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) updateAvailabilityWatch(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	var payload availabilityWatchUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if payload.IntervalMinutes < 5 || payload.IntervalMinutes > 10080 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "intervalMinutes must be between 5 and 10080"})
		return
	}
	switch payload.Action {
	case "monitor", "track":
	case "fetch", "track_fetch":
		if !userHasPermission(actor, "downloads:manage") {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "downloads:manage permission is required"})
			return
		}
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid availability watch action"})
		return
	}
	codes, err := normalizeCustomWorkCodes(payload.TargetCodes, 1000)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if payload.SourceID != nil && *payload.SourceID > 0 {
		source, err := s.loadRemoteSourceForUse(r.Context(), *payload.SourceID)
		if err != nil || !source.Enabled || !isKikoeruSourceType(source.SourceType) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "sourceId must identify an enabled compatible remote source"})
			return
		}
	} else {
		payload.SourceID = nil
	}
	excluded := normalizeExtensionList(payload.ExcludeExtensions)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(r.Context(), `
		INSERT INTO availability_watch (owner_user_id, enabled, interval_minutes, action, source_id, exclude_extensions_json)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(owner_user_id) DO UPDATE SET
			enabled = excluded.enabled, interval_minutes = excluded.interval_minutes, action = excluded.action,
			source_id = excluded.source_id, exclude_extensions_json = excluded.exclude_extensions_json,
			revision = availability_watch.revision + 1, updated_at = CURRENT_TIMESTAMP
	`, actor.ID, payload.Enabled, payload.IntervalMinutes, payload.Action, payload.SourceID, mustJSON(excluded))
	if err != nil {
		writeError(w, err)
		return
	}
	var watchID int64
	if err := tx.QueryRowContext(r.Context(), "SELECT id FROM availability_watch WHERE owner_user_id = ?", actor.ID).Scan(&watchID); err != nil {
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE availability_watch_target
		SET active = 0, state = 'disabled', next_check_at = NULL, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
		WHERE watch_id = ? AND active = 1
	`, watchID); err != nil {
		writeError(w, err)
		return
	}
	for _, code := range codes {
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO availability_watch_target (watch_id, work_code, active, state, next_check_at)
			VALUES (?, ?, 1, 'monitoring', CURRENT_TIMESTAMP)
			ON CONFLICT(watch_id, work_code) DO UPDATE SET
				active = 1, state = 'monitoring', next_check_at = CURRENT_TIMESTAMP,
				last_status = '', last_error = '', available_source_id = NULL,
				track_run_id = NULL, fetch_run_id = NULL, revision = availability_watch_target.revision + 1,
				updated_at = CURRENT_TIMESTAMP
		`, watchID, code); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context(), actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) loadAvailabilityWatch(ctx context.Context, ownerUserID int64) (availabilityWatchView, error) {
	view := availabilityWatchView{IntervalMinutes: 60, Action: "monitor", ExcludeExtensions: []string{"wav"}, Targets: []availabilityWatchTarget{}}
	var enabled bool
	var sourceID sql.NullInt64
	var rawExcluded string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, enabled, interval_minutes, action, source_id, exclude_extensions_json, revision
		FROM availability_watch WHERE owner_user_id = ?
	`, ownerUserID).Scan(&view.ID, &enabled, &view.IntervalMinutes, &view.Action, &sourceID, &rawExcluded, &view.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return view, nil
	}
	if err != nil {
		return view, err
	}
	view.Enabled = enabled
	if sourceID.Valid {
		view.SourceID = &sourceID.Int64
	}
	_ = json.Unmarshal([]byte(rawExcluded), &view.ExcludeExtensions)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, work_code, state, COALESCE(next_check_at, ''), COALESCE(last_checked_at, ''), last_status, last_error,
			available_source_id, track_run_id, fetch_run_id
		FROM availability_watch_target WHERE watch_id = ? AND active = 1
		ORDER BY CASE state WHEN 'ready' THEN 0 WHEN 'action_queued' THEN 0 WHEN 'completed' THEN 0 ELSE 1 END, work_code
	`, view.ID)
	if err != nil {
		return view, err
	}
	defer rows.Close()
	for rows.Next() {
		var target availabilityWatchTarget
		var availableSourceID, trackRunID, fetchRunID sql.NullInt64
		if err := rows.Scan(&target.ID, &target.WorkCode, &target.State, &target.NextCheckAt, &target.LastCheckedAt, &target.LastStatus, &target.LastError, &availableSourceID, &trackRunID, &fetchRunID); err != nil {
			return view, err
		}
		if availableSourceID.Valid {
			target.AvailableSourceID = &availableSourceID.Int64
		}
		if trackRunID.Valid {
			target.TrackRunID = &trackRunID.Int64
		}
		if fetchRunID.Valid {
			target.FetchRunID = &fetchRunID.Int64
		}
		view.Targets = append(view.Targets, target)
	}
	return view, rows.Err()
}

func userHasPermission(user currentUser, permission string) bool {
	for _, item := range user.Permissions {
		if item == permission || item == "system:admin" {
			return true
		}
	}
	return false
}

func normalizeExtensionList(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(value), "."))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}

type dueAvailabilityWatchTarget struct {
	ID, WatchID, OwnerUserID          int64
	WorkCode, Action                  string
	SourceID                          sql.NullInt64
	IntervalMinutes, Revision, Epoch  int
	LastStatus, ExcludeExtensionsJSON string
}

func (s *Server) processAvailabilityWatchTick(ctx context.Context) error {
	if s.cfg.IsDemo() {
		return nil
	}
	if err := s.checkNextAvailabilityWatchTarget(ctx); err != nil {
		return err
	}
	return s.dispatchNextAvailabilityWatchAction(ctx)
}

func (s *Server) checkNextAvailabilityWatchTarget(ctx context.Context) error {
	var target dueAvailabilityWatchTarget
	err := s.db.QueryRowContext(ctx, `
		SELECT target.id, watch.id, watch.owner_user_id, target.work_code, watch.action, watch.source_id,
			watch.interval_minutes, target.revision, target.availability_epoch, target.last_status, watch.exclude_extensions_json
		FROM availability_watch_target AS target
		INNER JOIN availability_watch AS watch ON watch.id = target.watch_id
		WHERE watch.enabled = 1 AND target.active = 1 AND target.state IN ('monitoring', 'error')
			AND (target.next_check_at IS NULL OR target.next_check_at <= CURRENT_TIMESTAMP)
		ORDER BY COALESCE(target.next_check_at, target.created_at), target.id LIMIT 1
	`).Scan(&target.ID, &target.WatchID, &target.OwnerUserID, &target.WorkCode, &target.Action, &target.SourceID, &target.IntervalMinutes, &target.Revision, &target.Epoch, &target.LastStatus, &target.ExcludeExtensionsJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	onlySourceID := int64(0)
	if target.SourceID.Valid {
		onlySourceID = target.SourceID.Int64
	}
	healthy, err := s.healthyRemoteSourceIDsForAvailability(ctx, onlySourceID)
	if err != nil || len(healthy) == 0 {
		_, updateErr := s.db.ExecContext(ctx, `UPDATE availability_watch_target SET state = 'monitoring', last_error = 'Remote source is unavailable', next_check_at = datetime('now', '+5 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1 AND revision = ?`, target.ID, target.Revision)
		return updateErr
	}
	response, err := s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, target.WorkCode, onlySourceID, healthy, "availability_watch", "availability_watch_poll")
	if err != nil {
		_, updateErr := s.db.ExecContext(ctx, `UPDATE availability_watch_target SET state = 'error', last_error = ?, next_check_at = datetime('now', '+5 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1 AND revision = ?`, "Availability check failed", target.ID, target.Revision)
		return updateErr
	}
	var available *sourceAvailabilitySummary
	for index := range response.Sources {
		if response.Sources[index].Status == "available" {
			available = &response.Sources[index]
			break
		}
	}
	if available == nil {
		modifier := fmt.Sprintf("+%d minutes", target.IntervalMinutes)
		_, err = s.db.ExecContext(ctx, `UPDATE availability_watch_target SET state = 'monitoring', last_checked_at = CURRENT_TIMESTAMP, last_status = 'not_found', last_error = '', next_check_at = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1 AND revision = ?`, modifier, target.ID, target.Revision)
		return err
	}
	epoch := target.Epoch
	if target.LastStatus != "available" {
		epoch++
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `
		UPDATE availability_watch_target SET state = ?, next_check_at = NULL, last_checked_at = CURRENT_TIMESTAMP,
			last_status = 'available', last_error = '', available_source_id = ?, availability_epoch = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND revision = ?
	`, map[bool]string{true: "ready", false: "action_queued"}[target.Action == "monitor"], available.SourceID, epoch, target.ID, target.Revision)
	if err != nil {
		return err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return tx.Commit()
	}
	if target.Action != "monitor" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO availability_watch_outbox (target_id, availability_epoch, action) VALUES (?, ?, ?) ON CONFLICT(target_id, availability_epoch, action) DO NOTHING`, target.ID, epoch, target.Action); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) dispatchNextAvailabilityWatchAction(ctx context.Context) error {
	var outboxID, targetID, ownerUserID, sourceID, trackRunID int64
	var epoch, retryCount int
	var action, code, rawExcluded string
	err := s.db.QueryRowContext(ctx, `
		SELECT outbox.id, target.id, watch.owner_user_id, target.available_source_id, COALESCE(target.track_run_id, 0),
			outbox.availability_epoch, outbox.retry_count, outbox.action, target.work_code, watch.exclude_extensions_json
		FROM availability_watch_outbox AS outbox
		INNER JOIN availability_watch_target AS target ON target.id = outbox.target_id
		INNER JOIN availability_watch AS watch ON watch.id = target.watch_id
		WHERE outbox.status = 'pending' AND (outbox.next_attempt_at IS NULL OR outbox.next_attempt_at <= CURRENT_TIMESTAMP)
			AND target.active = 1 AND target.availability_epoch = outbox.availability_epoch
		ORDER BY outbox.id LIMIT 1
	`).Scan(&outboxID, &targetID, &ownerUserID, &sourceID, &trackRunID, &epoch, &retryCount, &action, &code, &rawExcluded)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	result, err := s.db.ExecContext(ctx, `UPDATE availability_watch_outbox SET status = 'running', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'pending'`, outboxID)
	if err != nil {
		return err
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return nil
	}
	var trackID, fetchID int64
	if (action == "track" || action == "track_fetch") && trackRunID == 0 {
		tracked, runErr := s.runRemoteWorkSync(ctx, sourceID, code, fmt.Sprintf("availability_watch:%d:%d:track", targetID, epoch))
		if runErr != nil {
			return s.retryAvailabilityWatchAction(ctx, outboxID, targetID, retryCount, runErr)
		}
		trackID = tracked.RunID
		if _, err := s.db.ExecContext(ctx, `UPDATE availability_watch_target SET track_run_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND availability_epoch = ?`, trackID, targetID, epoch); err != nil {
			return err
		}
	} else {
		trackID = trackRunID
	}
	if action == "fetch" || action == "track_fetch" {
		var excluded []string
		_ = json.Unmarshal([]byte(rawExcluded), &excluded)
		paths, loadErr := s.availabilityWatchFetchPaths(ctx, sourceID, code, excluded)
		if loadErr != nil {
			return s.retryAvailabilityWatchAction(ctx, outboxID, targetID, retryCount, loadErr)
		}
		fetched, fetchErr := s.enqueueRemoteWorkSave(ctx, sourceID, code, paths, nil, "", fmt.Sprintf("availability-watch:%d:%d:fetch", targetID, epoch), nil, 0, ownerUserID, workflow.JobPriorityBackground)
		if fetchErr != nil {
			return s.retryAvailabilityWatchAction(ctx, outboxID, targetID, retryCount, fetchErr)
		}
		fetchID = fetched.RunID
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE availability_watch_outbox SET status = 'succeeded', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, outboxID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE availability_watch_target SET state = 'completed', track_run_id = COALESCE(NULLIF(?, 0), track_run_id), fetch_run_id = COALESCE(NULLIF(?, 0), fetch_run_id), last_error = '', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND availability_epoch = ?`, trackID, fetchID, targetID, epoch); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) retryAvailabilityWatchAction(ctx context.Context, outboxID, targetID int64, retryCount int, actionErr error) error {
	status := "pending"
	if retryCount >= 2 {
		status = "failed"
	}
	_, err := s.db.ExecContext(ctx, `UPDATE availability_watch_outbox SET status = ?, retry_count = retry_count + 1, next_attempt_at = CASE WHEN ? = 'pending' THEN datetime('now', '+5 minutes') ELSE NULL END, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, status, status, "Action failed", outboxID)
	if err != nil {
		return err
	}
	state := "action_queued"
	if status == "failed" {
		state = "ready"
	}
	_, err = s.db.ExecContext(ctx, `UPDATE availability_watch_target SET state = ?, last_error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, state, "Action failed", targetID)
	if err != nil {
		return err
	}
	return actionErr
}

func (s *Server) availabilityWatchFetchPaths(ctx context.Context, sourceID int64, code string, excludedValues []string) ([]string, error) {
	_, _, tracks, err := s.loadRemoteWorkTracksCached(ctx, sourceID, code)
	if err != nil {
		return nil, err
	}
	excluded := map[string]bool{}
	for _, value := range normalizeExtensionList(excludedValues) {
		excluded[value] = true
	}
	paths := []string{}
	for _, file := range flattenRemoteSaveFiles(tracks) {
		extension := strings.ToLower(strings.TrimPrefix(filepath.Ext(file.Path), "."))
		if !excluded[extension] {
			paths = append(paths, file.Path)
		}
	}
	if len(paths) == 0 {
		return nil, fmt.Errorf("no files remain after extension filtering")
	}
	return paths, nil
}
