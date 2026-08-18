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

const availabilityWatchID int64 = 1

var errAvailabilityWatchRunActive = errors.New("an Availability Watch run is already active")

type availabilityWatchView struct {
	ID                int64                     `json:"id"`
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

type availabilityWatchConfigUpdate struct {
	Action            string   `json:"action"`
	SourceID          *int64   `json:"sourceId"`
	ExcludeExtensions []string `json:"excludeExtensions"`
}

type availabilityWatchTargetsUpdate struct {
	TargetCodes []string `json:"targetCodes"`
}

type availabilityWatchRunResult struct {
	RunID               int64    `json:"runId"`
	JobID               int64    `json:"jobId"`
	Status              string   `json:"status"`
	TargetCount         int      `json:"targetCount"`
	Checked             int      `json:"checked"`
	Ready               int      `json:"ready"`
	Dispatched          int      `json:"dispatched"`
	NewlyAvailableCodes []string `json:"newlyAvailableCodes"`
	ReadyCodes          []string `json:"readyCodes"`
	Failures            []string `json:"failures"`
}

type availabilityWatchTargetSnapshot struct {
	ID       int64  `json:"id"`
	WorkCode string `json:"workCode"`
	State    string `json:"state"`
	Revision int    `json:"revision"`
}

type availabilityWatchJobPayload struct {
	RequestedByUserID int64                             `json:"requestedByUserId"`
	SourceID          int64                             `json:"sourceId"`
	Action            string                            `json:"action"`
	ExcludeExtensions []string                          `json:"excludeExtensions"`
	Targets           []availabilityWatchTargetSnapshot `json:"targets"`
}

type availabilityWatchExecutionTarget struct {
	State             string
	Revision          int
	LastStatus        string
	Epoch             int
	AvailableSourceID int64
	Active            bool
}

type availabilityWatchExecution struct {
	result           availabilityWatchRunResult
	readySeen        map[string]bool
	dispatchFailures int
}

func (s *Server) getAvailabilityWatch(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context())
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
	var payload availabilityWatchConfigUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := validateAvailabilityWatchAction(actor, payload.Action); err != nil {
		status := http.StatusBadRequest
		if availabilityWatchActionRequiresDownloads(payload.Action) {
			status = http.StatusForbidden
		}
		writeJSON(w, status, map[string]string{"error": err.Error()})
		return
	}
	if err := s.validateAvailabilityWatchSource(r.Context(), payload.SourceID); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if payload.SourceID == nil || *payload.SourceID <= 0 {
		payload.SourceID = nil
	}
	excluded := normalizeExtensionList(payload.ExcludeExtensions)
	if err := s.persistAvailabilityWatchConfig(r.Context(), actor.ID, payload, excluded); err != nil {
		writeError(w, err)
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) updateAvailabilityWatchTargets(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	var payload availabilityWatchTargetsUpdate
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	codes, err := normalizeCustomWorkCodes(payload.TargetCodes, 1000)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.persistAvailabilityWatchTargets(r.Context(), actor.ID, codes); err != nil {
		writeError(w, err)
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) deleteAvailabilityWatchTarget(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	targetID, err := parseInt64PathValue(r, "id")
	if err != nil || targetID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Availability Watch target id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		UPDATE availability_watch_target
		SET active = 0, state = 'disabled', next_check_at = NULL,
			revision = revision + 1, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND watch_id = ? AND active = 1
	`, targetID, availabilityWatchID)
	if err != nil {
		writeError(w, err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "Availability Watch target not found"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) trackAvailabilityWatchTarget(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	targetID, err := parseInt64PathValue(r, "id")
	if err != nil || targetID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid Availability Watch target id"})
		return
	}
	var code string
	var sourceID sql.NullInt64
	err = s.db.QueryRowContext(r.Context(), `
		SELECT work_code, available_source_id
		FROM availability_watch_target
		WHERE id = ? AND watch_id = ? AND active = 1
			AND state IN ('ready', 'action_queued', 'completed')
	`, targetID, availabilityWatchID).Scan(&code, &sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "ready Availability Watch target not found"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if !sourceID.Valid || sourceID.Int64 <= 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "the available source is no longer known"})
		return
	}
	result, err := s.enqueueRemoteWorkTrack(r.Context(), actor.ID, sourceID.Int64, code, "availability_watch_manual_track")
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		UPDATE availability_watch_target
		SET state = 'completed', track_run_id = ?, last_error = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND watch_id = ? AND active = 1
	`, result.RunID, targetID, availabilityWatchID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) runAvailabilityWatch(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "workflows:run")
	if !ok {
		return
	}
	view, err := s.loadAvailabilityWatch(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	if view.ID == 0 {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "configure Availability Watch before running it"})
		return
	}
	if err := validateAvailabilityWatchAction(actor, view.Action); err != nil {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.enqueueAvailabilityWatch(r.Context(), actor.ID, workflowRunTrigger{Type: "manual", Reason: "manual_run"})
	if errors.Is(err, errAvailabilityWatchRunActive) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func validateAvailabilityWatchAction(actor currentUser, action string) error {
	switch action {
	case "monitor", "track":
		return nil
	case "fetch", "track_fetch":
		if !userHasPermission(actor, "downloads:manage") {
			return fmt.Errorf("downloads:manage permission is required")
		}
		return nil
	default:
		return fmt.Errorf("invalid Availability Watch action")
	}
}

func availabilityWatchActionRequiresDownloads(action string) bool {
	return action == "fetch" || action == "track_fetch"
}

func (s *Server) validateAvailabilityWatchSource(ctx context.Context, sourceID *int64) error {
	if sourceID == nil || *sourceID <= 0 {
		return nil
	}
	source, err := s.loadRemoteSourceForUse(ctx, *sourceID)
	if err != nil || !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		return fmt.Errorf("sourceId must identify an enabled compatible remote source")
	}
	return nil
}

func (s *Server) persistAvailabilityWatchConfig(ctx context.Context, userID int64, payload availabilityWatchConfigUpdate, excluded []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO availability_watch (id, configured_by_user_id, action, source_id, exclude_extensions_json)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			configured_by_user_id = excluded.configured_by_user_id,
			action = excluded.action,
			source_id = excluded.source_id,
			exclude_extensions_json = excluded.exclude_extensions_json,
			revision = availability_watch.revision + 1,
			updated_at = CURRENT_TIMESTAMP
	`, availabilityWatchID, userID, payload.Action, payload.SourceID, mustJSON(excluded)); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger
		SET config_json = json_object('userId', ?), updated_at = CURRENT_TIMESTAMP
		WHERE workflow_definition_id = (
			SELECT id FROM workflow_definition WHERE code = 'availability_watch'
		) AND trigger_type = 'schedule'
	`, userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) persistAvailabilityWatchTargets(ctx context.Context, userID int64, codes []string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO availability_watch (id, configured_by_user_id)
		VALUES (?, ?)
		ON CONFLICT(id) DO NOTHING
	`, availabilityWatchID, userID); err != nil {
		return err
	}
	for _, code := range codes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO availability_watch_target (watch_id, work_code, active, state, next_check_at)
			VALUES (?, ?, 1, 'monitoring', CURRENT_TIMESTAMP)
			ON CONFLICT(watch_id, work_code) DO UPDATE SET
				active = 1,
				state = CASE WHEN availability_watch_target.active = 0 THEN 'monitoring' ELSE availability_watch_target.state END,
				next_check_at = CASE WHEN availability_watch_target.active = 0 THEN CURRENT_TIMESTAMP ELSE availability_watch_target.next_check_at END,
				last_status = CASE WHEN availability_watch_target.active = 0 THEN '' ELSE availability_watch_target.last_status END,
				last_error = CASE WHEN availability_watch_target.active = 0 THEN '' ELSE availability_watch_target.last_error END,
				available_source_id = CASE WHEN availability_watch_target.active = 0 THEN NULL ELSE availability_watch_target.available_source_id END,
				track_run_id = CASE WHEN availability_watch_target.active = 0 THEN NULL ELSE availability_watch_target.track_run_id END,
				fetch_run_id = CASE WHEN availability_watch_target.active = 0 THEN NULL ELSE availability_watch_target.fetch_run_id END,
				revision = availability_watch_target.revision + CASE WHEN availability_watch_target.active = 0 THEN 1 ELSE 0 END,
				updated_at = CASE WHEN availability_watch_target.active = 0 THEN CURRENT_TIMESTAMP ELSE availability_watch_target.updated_at END
		`, availabilityWatchID, code); err != nil {
			return err
		}
	}
	if len(codes) == 0 {
		_, err = tx.ExecContext(ctx, `
			UPDATE availability_watch_target
			SET active = 0, state = 'disabled', next_check_at = NULL,
				revision = revision + 1, updated_at = CURRENT_TIMESTAMP
			WHERE watch_id = ? AND active = 1
		`, availabilityWatchID)
	} else {
		args := []any{availabilityWatchID}
		placeholders := make([]string, len(codes))
		for index, code := range codes {
			placeholders[index] = "?"
			args = append(args, code)
		}
		_, err = tx.ExecContext(ctx, `
			UPDATE availability_watch_target
			SET active = 0, state = 'disabled', next_check_at = NULL,
				revision = revision + 1, updated_at = CURRENT_TIMESTAMP
			WHERE watch_id = ? AND active = 1 AND work_code NOT IN (`+strings.Join(placeholders, ",")+`)
		`, args...)
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) loadAvailabilityWatch(ctx context.Context) (availabilityWatchView, error) {
	view := availabilityWatchView{Action: "monitor", ExcludeExtensions: []string{"wav"}, Targets: []availabilityWatchTarget{}}
	var sourceID sql.NullInt64
	var rawExcluded string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, action, source_id, exclude_extensions_json, revision
		FROM availability_watch WHERE id = ?
	`, availabilityWatchID).Scan(&view.ID, &view.Action, &sourceID, &rawExcluded, &view.Revision)
	if errors.Is(err, sql.ErrNoRows) {
		return view, nil
	}
	if err != nil {
		return view, err
	}
	if sourceID.Valid {
		view.SourceID = &sourceID.Int64
	}
	_ = json.Unmarshal([]byte(rawExcluded), &view.ExcludeExtensions)
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, work_code, state, COALESCE(next_check_at, ''), COALESCE(last_checked_at, ''),
			last_status, last_error, available_source_id, track_run_id, fetch_run_id
		FROM availability_watch_target
		WHERE watch_id = ? AND active = 1
		ORDER BY CASE state WHEN 'ready' THEN 0 WHEN 'action_queued' THEN 0 WHEN 'completed' THEN 0 ELSE 1 END, work_code
	`, availabilityWatchID)
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

func (s *Server) enqueueAvailabilityWatch(ctx context.Context, userID int64, trigger workflowRunTrigger) (availabilityWatchRunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var action, rawExcluded string
	var sourceID sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT action, source_id, exclude_extensions_json
		FROM availability_watch WHERE id = ?
	`, availabilityWatchID).Scan(&action, &sourceID, &rawExcluded); err != nil {
		return availabilityWatchRunResult{}, err
	}
	var activeRuns int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM workflow_run
		WHERE workflow_code = 'availability_watch' AND status IN ('queued', 'running')
	`).Scan(&activeRuns); err != nil {
		return availabilityWatchRunResult{}, err
	}
	if activeRuns > 0 {
		return availabilityWatchRunResult{}, errAvailabilityWatchRunActive
	}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, work_code, state, revision
		FROM availability_watch_target
		WHERE watch_id = ? AND active = 1
		ORDER BY id
		LIMIT 1000
	`, availabilityWatchID)
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	targets := []availabilityWatchTargetSnapshot{}
	for rows.Next() {
		var target availabilityWatchTargetSnapshot
		if err := rows.Scan(&target.ID, &target.WorkCode, &target.State, &target.Revision); err != nil {
			_ = rows.Close()
			return availabilityWatchRunResult{}, err
		}
		targets = append(targets, target)
	}
	if err := rows.Close(); err != nil {
		return availabilityWatchRunResult{}, err
	}
	var excluded []string
	_ = json.Unmarshal([]byte(rawExcluded), &excluded)
	payload := availabilityWatchJobPayload{RequestedByUserID: userID, Action: action, ExcludeExtensions: normalizeExtensionList(excluded), Targets: targets}
	if sourceID.Valid {
		payload.SourceID = sourceID.Int64
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "availability_watch", "Availability Watch", "Monitor a shared pool of work codes and dispatch configured actions when a remote source becomes available.", availabilityWatchDefinition())
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	result := availabilityWatchRunResult{Status: "queued", TargetCount: len(targets), NewlyAvailableCodes: []string{}, ReadyCodes: []string{}, Failures: []string{}}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "availability_watch", "Availability Watch", "queued", trigger.Type, trigger.Reason, map[string]any{
		"source_id": payload.SourceID, "action": payload.Action, "target_count": len(targets),
	}, result)
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return availabilityWatchRunResult{}, err
		}
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "targets", NodeType: "select_works", DisplayName: "Snapshot monitoring pool", Position: 1,
		Status: "succeeded", Output: map[string]any{"target_count": len(targets)},
	}); err != nil {
		return availabilityWatchRunResult{}, err
	}
	checkNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "check", NodeType: "check_source_availability", DisplayName: "Check source availability", Position: 2,
		Status: "queued", Input: map[string]any{"source_id": payload.SourceID, "target_count": len(targets)},
	})
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "ready", NodeType: "filter_candidates", DisplayName: "Filter ready works", Position: 3, Status: "queued"},
		{NodeID: "dispatch", NodeType: "dispatch_child_workflows", DisplayName: "Dispatch configured action", Position: 4, Status: "queued", Input: map[string]any{"action": payload.Action}},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return availabilityWatchRunResult{}, err
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: checkNodeID, WorkerType: "availability_watch", Status: "queued",
		Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: "availability:watch", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: false, MaxRetries: 1, ProgressTotal: len(targets),
	})
	if err != nil {
		return availabilityWatchRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return availabilityWatchRunResult{}, err
	}
	result.RunID = runID
	result.JobID = jobID
	return result, nil
}

func availabilityWatchDefinition() map[string]any {
	return map[string]any{"nodes": []map[string]string{
		{"id": "targets", "type": "select_works", "displayName": "Monitoring pool"},
		{"id": "check", "type": "check_source_availability", "displayName": "Check source availability"},
		{"id": "ready", "type": "filter_candidates", "displayName": "Ready pool"},
		{"id": "dispatch", "type": "dispatch_child_workflows", "displayName": "Dispatch configured action"},
	}}
}

func (s *Server) executeAvailabilityWatchJob(ctx context.Context, job workflowJobRecord) error {
	var payload availabilityWatchJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch snapshot is invalid")
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	healthy, healthErr := s.healthyRemoteSourceIDsForAvailability(ctx, payload.SourceID)
	if healthErr != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch source health check failed")
		return healthErr
	}
	execution := availabilityWatchExecution{
		result: availabilityWatchRunResult{
			RunID: job.RunID, JobID: job.ID, Status: "succeeded", TargetCount: len(payload.Targets),
			NewlyAvailableCodes: []string{}, ReadyCodes: []string{}, Failures: []string{},
		},
		readySeen: map[string]bool{},
	}
	for index, snapshot := range payload.Targets {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.executeAvailabilityWatchTarget(ctx, job, payload, snapshot, healthy, &execution); err != nil {
			return err
		}
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "checking", execution.result, index+1, len(payload.Targets))
	}
	execution.result.Ready = len(execution.result.ReadyCodes)
	if len(execution.result.Failures) > 0 {
		execution.result.Status = "partial"
	}
	if err := s.finishAvailabilityWatchJob(ctx, job, nodeIDs, execution.result, execution.dispatchFailures); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch run could not be finalized")
		return err
	}
	return nil
}

func (s *Server) executeAvailabilityWatchTarget(
	ctx context.Context,
	job workflowJobRecord,
	payload availabilityWatchJobPayload,
	snapshot availabilityWatchTargetSnapshot,
	healthy map[int64]bool,
	execution *availabilityWatchExecution,
) error {
	target, err := s.loadAvailabilityWatchExecutionTarget(ctx, snapshot.ID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch target state could not be loaded")
		return err
	}
	if !target.Active || target.Revision != snapshot.Revision {
		return nil
	}
	code := strings.ToUpper(strings.TrimSpace(snapshot.WorkCode))
	if availabilityWatchTargetNeedsCheck(target.State) {
		ready, err := s.checkAvailabilityWatchExecutionTarget(ctx, job, payload, snapshot.ID, code, healthy, &target, &execution.result)
		if err != nil || !ready {
			return err
		}
	}
	execution.recordReady(code, target.State)
	return s.dispatchReadyAvailabilityWatchTarget(ctx, job, payload, snapshot.ID, code, target, execution)
}

func availabilityWatchTargetNeedsCheck(state string) bool {
	return state == "monitoring" || state == "error"
}

func (s *Server) checkAvailabilityWatchExecutionTarget(
	ctx context.Context,
	job workflowJobRecord,
	payload availabilityWatchJobPayload,
	targetID int64,
	code string,
	healthy map[int64]bool,
	target *availabilityWatchExecutionTarget,
	result *availabilityWatchRunResult,
) (bool, error) {
	result.Checked++
	if len(healthy) == 0 {
		result.Failures = append(result.Failures, code+": no healthy remote source")
		_ = s.updateAvailabilityWatchTargetError(ctx, targetID, target.Revision, "Remote source is unavailable")
		return false, nil
	}
	response, err := s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, code, payload.SourceID, healthy, "availability_watch", "workflow_run")
	if err != nil {
		result.Failures = append(result.Failures, code+": availability check failed")
		_ = s.updateAvailabilityWatchTargetError(ctx, targetID, target.Revision, "Availability check failed")
		return false, nil
	}
	available := firstAvailableSource(response)
	if available == nil {
		if err := s.updateAvailabilityWatchTargetNotFound(ctx, targetID, target.Revision); err != nil {
			_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch result could not be saved")
			return false, err
		}
		return false, nil
	}
	if target.LastStatus != "available" {
		target.Epoch++
		result.NewlyAvailableCodes = append(result.NewlyAvailableCodes, code)
	}
	if err := s.updateAvailabilityWatchTargetReady(ctx, targetID, target.Revision, available.SourceID, target.Epoch); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch result could not be saved")
		return false, err
	}
	target.State = "ready"
	target.AvailableSourceID = available.SourceID
	return true, nil
}

func (execution *availabilityWatchExecution) recordReady(code string, state string) {
	if state != "ready" && state != "action_queued" && state != "completed" {
		return
	}
	if execution.readySeen[code] {
		return
	}
	execution.readySeen[code] = true
	execution.result.ReadyCodes = append(execution.result.ReadyCodes, code)
}

func (s *Server) dispatchReadyAvailabilityWatchTarget(
	ctx context.Context,
	job workflowJobRecord,
	payload availabilityWatchJobPayload,
	targetID int64,
	code string,
	target availabilityWatchExecutionTarget,
	execution *availabilityWatchExecution,
) error {
	if target.State != "ready" || payload.Action == "monitor" {
		return nil
	}
	trackRunID, fetchRunID, err := s.dispatchAvailabilityWatchTarget(ctx, payload, targetID, code, target.AvailableSourceID, target.Epoch)
	if err != nil {
		execution.dispatchFailures++
		execution.result.Failures = append(execution.result.Failures, code+": configured action could not be queued")
		_, _ = s.db.ExecContext(ctx, `UPDATE availability_watch_target SET state = 'ready', last_error = 'Action failed', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND active = 1`, targetID)
		return nil
	}
	execution.result.Dispatched++
	_, err = s.db.ExecContext(ctx, `
		UPDATE availability_watch_target
		SET state = 'completed', track_run_id = COALESCE(NULLIF(?, 0), track_run_id),
			fetch_run_id = COALESCE(NULLIF(?, 0), fetch_run_id), last_error = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1
	`, trackRunID, fetchRunID, targetID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, "Availability Watch dispatch state could not be saved")
	}
	return err
}

func (s *Server) loadAvailabilityWatchExecutionTarget(ctx context.Context, targetID int64) (availabilityWatchExecutionTarget, error) {
	var target availabilityWatchExecutionTarget
	var nullableSourceID sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT state, revision, last_status, availability_epoch, available_source_id, active
		FROM availability_watch_target WHERE id = ? AND watch_id = ?
	`, targetID, availabilityWatchID).Scan(
		&target.State, &target.Revision, &target.LastStatus, &target.Epoch, &nullableSourceID, &target.Active,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return availabilityWatchExecutionTarget{}, nil
	}
	if err != nil {
		return availabilityWatchExecutionTarget{}, err
	}
	if nullableSourceID.Valid {
		target.AvailableSourceID = nullableSourceID.Int64
	}
	return target, nil
}

func (s *Server) updateAvailabilityWatchTargetError(ctx context.Context, targetID int64, revision int, message string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE availability_watch_target
		SET state = 'error', last_checked_at = CURRENT_TIMESTAMP, last_status = 'error',
			last_error = ?, next_check_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND revision = ?
	`, message, targetID, revision)
	return err
}

func (s *Server) updateAvailabilityWatchTargetNotFound(ctx context.Context, targetID int64, revision int) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE availability_watch_target
		SET state = 'monitoring', last_checked_at = CURRENT_TIMESTAMP, last_status = 'not_found',
			last_error = '', available_source_id = NULL, next_check_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND revision = ?
	`, targetID, revision)
	return err
}

func (s *Server) updateAvailabilityWatchTargetReady(ctx context.Context, targetID int64, revision int, sourceID int64, epoch int) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE availability_watch_target
		SET state = 'ready', last_checked_at = CURRENT_TIMESTAMP, last_status = 'available',
			last_error = '', available_source_id = ?, availability_epoch = ?, next_check_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND active = 1 AND revision = ?
	`, sourceID, epoch, targetID, revision)
	return err
}

func firstAvailableSource(response sourceAvailabilityResponse) *sourceAvailabilitySummary {
	for index := range response.Sources {
		if response.Sources[index].Status == "available" {
			return &response.Sources[index]
		}
	}
	return nil
}

func (s *Server) dispatchAvailabilityWatchTarget(ctx context.Context, payload availabilityWatchJobPayload, targetID int64, code string, sourceID int64, epoch int) (int64, int64, error) {
	if sourceID <= 0 {
		return 0, 0, fmt.Errorf("available source is unknown")
	}
	trackRunID := int64(0)
	if payload.Action == "track" || payload.Action == "track_fetch" {
		tracked, err := s.enqueueRemoteWorkTrack(ctx, payload.RequestedByUserID, sourceID, code, fmt.Sprintf("availability_watch:%d:%d:track", targetID, epoch))
		if err != nil {
			return 0, 0, err
		}
		trackRunID = tracked.RunID
	}
	fetchRunID := int64(0)
	if payload.Action == "fetch" || payload.Action == "track_fetch" {
		paths, err := s.availabilityWatchFetchPaths(ctx, sourceID, code, payload.ExcludeExtensions)
		if err != nil {
			return trackRunID, 0, err
		}
		fetched, err := s.enqueueRemoteWorkSave(ctx, sourceID, code, paths, nil, "", fmt.Sprintf("availability-watch:%d:%d:fetch", targetID, epoch), nil, 0, payload.RequestedByUserID, workflow.JobPriorityBackground)
		if err != nil {
			return trackRunID, 0, err
		}
		fetchRunID = fetched.RunID
	}
	return trackRunID, fetchRunID, nil
}

func (s *Server) finishAvailabilityWatchJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, result availabilityWatchRunResult, dispatchFailures int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	errorMessage := strings.Join(result.Failures, "\n")
	checkStatus := "succeeded"
	if len(result.Failures) > dispatchFailures {
		checkStatus = "partial"
	}
	dispatchStatus := "succeeded"
	if dispatchFailures > 0 {
		dispatchStatus = "partial"
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, checkStatus, mustJSON(map[string]any{"checked": result.Checked, "failures": result.Failures}), errorMessage, nodeIDs["check"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, mustJSON(map[string]any{"ready": result.Ready, "ready_codes": result.ReadyCodes, "newly_available_codes": result.NewlyAvailableCodes}), nodeIDs["ready"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, dispatchStatus, mustJSON(map[string]any{"dispatched": result.Dispatched}), errorMessage, nodeIDs["dispatch"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.TargetCount, result.TargetCount, errorMessage, job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, result.Status, mustJSON(result), job.RunID); err != nil {
		return err
	}
	if result.Status == "succeeded" {
		if err := updateCustomWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
			return err
		}
	} else if err := updateCustomWorkflowTriggerFailure(ctx, tx, job.RunID, "Availability Watch completed with some failures"); err != nil {
		return err
	}
	if len(result.NewlyAvailableCodes) > 0 {
		if err := createAvailabilityWatchNotifications(ctx, tx, job.RunID, result.NewlyAvailableCodes); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func createAvailabilityWatchNotifications(ctx context.Context, tx *sql.Tx, runID int64, codes []string) error {
	message := fmt.Sprintf("%d watched works are now available.", len(codes))
	if len(codes) == 1 {
		message = codes[0] + " is now available."
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_notification (
			user_id, workflow_run_id, notification_type, status, work_code, message
		)
		SELECT id, ?, 'availability_watch_ready', 'succeeded', ?, ?
		FROM user_account
		WHERE enabled = 1 AND role IN ('super_admin', 'admin')
		ON CONFLICT(user_id, workflow_run_id, notification_type) DO UPDATE SET
			status = excluded.status,
			work_code = excluded.work_code,
			message = excluded.message
	`, runID, codes[0], message)
	return err
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
