package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type remoteWorkSyncResult struct {
	RunID            int64  `json:"runId"`
	JobID            int64  `json:"jobId"`
	WorkID           int64  `json:"workId"`
	PrimaryCode      string `json:"primaryCode"`
	Status           string `json:"status"`
	Tracked          bool   `json:"tracked"`
	SyncedMediaItems int    `json:"syncedMediaItems"`
	SyncedLocations  int    `json:"syncedLocations"`
	TriggerReason    string `json:"triggerReason"`
}

type remoteWorkTrackResult struct {
	RunID         int64  `json:"runId"`
	JobID         int64  `json:"jobId"`
	WorkID        *int64 `json:"workId"`
	PrimaryCode   string `json:"primaryCode"`
	Status        string `json:"status"`
	TriggerReason string `json:"triggerReason"`
	Deduplicated  bool   `json:"deduplicated"`
}

type remoteWorkTrackJobPayload struct {
	RequestedByUserID int64  `json:"requested_by_user_id,omitempty"`
	SourceID          int64  `json:"source_id"`
	WorkCode          string `json:"work_code"`
	TriggerReason     string `json:"trigger_reason"`
}

func (s *Server) trackRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	var payload struct {
		TriggerReason string `json:"triggerReason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&payload)
	payload.TriggerReason = strings.TrimSpace(payload.TriggerReason)
	if payload.TriggerReason == "" {
		payload.TriggerReason = "manual_track"
	}
	operationCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()
	result, err := s.enqueueRemoteWorkTrack(operationCtx, actor.ID, id, code, payload.TriggerReason)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) syncRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	var payload struct {
		TriggerReason string `json:"triggerReason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&payload)
	payload.TriggerReason = strings.TrimSpace(payload.TriggerReason)
	if payload.TriggerReason == "" {
		payload.TriggerReason = "manual"
	}
	result, err := s.runRemoteWorkMaterialize(r.Context(), id, code, payload.TriggerReason)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) enqueueRemoteWorkTrack(ctx context.Context, userID int64, sourceID int64, code string, triggerReason string) (remoteWorkTrackResult, error) {
	s.remoteTrackMu.Lock()
	defer s.remoteTrackMu.Unlock()

	requestedCode, triggerReason, err := normalizeRemoteWorkTrackRequest(code, triggerReason)
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteWorkTrackResult{}, fmt.Errorf("source not found")
		}
		return remoteWorkTrackResult{}, err
	}
	if err := validateRemoteWorkTrackSource(source); err != nil {
		return remoteWorkTrackResult{}, err
	}
	if existing, ok, err := reuseRemoteWorkTrack(ctx, s.db, userID, sourceID, requestedCode); err != nil {
		return remoteWorkTrackResult{}, err
	} else if ok {
		return existing, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if existing, ok, err := reuseRemoteWorkTrack(ctx, tx, userID, sourceID, requestedCode); err != nil {
		return remoteWorkTrackResult{}, err
	} else if ok {
		if err := tx.Commit(); err != nil {
			return remoteWorkTrackResult{}, err
		}
		return existing, nil
	}
	result, err := enqueueRemoteWorkTrackTx(ctx, tx, source, userID, requestedCode, triggerReason)
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkTrackResult{}, err
	}
	return result, nil
}

func normalizeRemoteWorkTrackRequest(code string, triggerReason string) (string, string, error) {
	requestedCode := strings.ToUpper(strings.TrimSpace(code))
	if requestedCode == "" {
		return "", "", fmt.Errorf("work code is required")
	}
	triggerReason = strings.TrimSpace(triggerReason)
	if triggerReason == "" {
		triggerReason = "manual_track"
	}
	return requestedCode, triggerReason, nil
}

func validateRemoteWorkTrackSource(source remoteSourceForUse) error {
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return fmt.Errorf("source has no API endpoint")
	}
	return nil
}

type remoteWorkTrackQueryer interface {
	rowQueryer
	contextExecer
}

func reuseRemoteWorkTrack(ctx context.Context, queryer remoteWorkTrackQueryer, userID, sourceID int64, requestedCode string) (remoteWorkTrackResult, bool, error) {
	existing, ok, err := activeRemoteWorkTrack(ctx, queryer, sourceID, requestedCode)
	if err != nil || !ok {
		return existing, ok, err
	}
	if err := subscribeRemoteTrackNotification(ctx, queryer, userID, existing.RunID, existing.WorkID, requestedCode); err != nil {
		return remoteWorkTrackResult{}, false, err
	}
	existing.Deduplicated = true
	return existing, true, nil
}

func enqueueRemoteWorkTrackTx(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, userID int64, requestedCode, triggerReason string) (remoteWorkTrackResult, error) {
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_source_sync", "Track remote source", "Track one remote work and fork its selected-source directory in a recoverable background job.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote source"},
			{"id": "discover", "type": "discover_remote_works", "displayName": "Resolve remote work"},
			{"id": "filter", "type": "filter_candidates", "displayName": "Validate candidate"},
			{"id": "match", "type": "match_works", "displayName": "Track work"},
			{"id": "metadata", "type": "sync_metadata", "displayName": "Record source metadata"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Fork remote directory"},
		},
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	payload := remoteWorkTrackJobPayload{
		RequestedByUserID: userID,
		SourceID:          source.ID,
		WorkCode:          requestedCode,
		TriggerReason:     triggerReason,
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_source_sync", "Track "+requestedCode, "queued", "manual", triggerReason, payload, map[string]any{
		"source_id": source.ID, "requested_work_code": requestedCode, "tracked": false,
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: payload, Output: map[string]any{"file_source_id": source.ID, "source_code": source.Code},
	}); err != nil {
		return remoteWorkTrackResult{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Resolve remote work", Position: 2, Status: "queued",
		Input: map[string]any{"work_code": requestedCode},
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Validate candidate", Position: 3, Status: "queued", Input: map[string]any{"work_code": requestedCode}},
		{NodeID: "match", NodeType: "match_works", DisplayName: "Track work", Position: 4, Status: "queued", Input: map[string]any{"work_code": requestedCode}},
		{NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Record source metadata", Position: 5, Status: "queued", Input: map[string]any{"work_code": requestedCode}},
		{NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Fork remote directory", Position: 6, Status: "queued", Input: map[string]any{"source_id": source.ID, "work_code": requestedCode}},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return remoteWorkTrackResult{}, err
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: discoverNodeID, WorkerType: "remote_source_track", Status: "queued", Priority: workflow.JobPriorityUserInitiated,
		ResourceKey: sourceResourceKey(source.Endpoint.APIURL), Payload: payload,
		Checkpoint: map[string]any{"phase": "queued", "workCode": requestedCode}, Recoverable: true, MaxRetries: 3, ProgressTotal: 5,
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	if err := subscribeRemoteTrackNotification(ctx, tx, userID, runID, nil, requestedCode); err != nil {
		return remoteWorkTrackResult{}, err
	}
	return remoteWorkTrackResult{
		RunID: runID, JobID: jobID, PrimaryCode: requestedCode, Status: "queued", TriggerReason: triggerReason,
	}, nil
}

func activeRemoteWorkTrack(ctx context.Context, queryer rowQueryer, sourceID int64, requestedCode string) (remoteWorkTrackResult, bool, error) {
	var result remoteWorkTrackResult
	var workID sql.NullInt64
	err := queryer.QueryRowContext(ctx, `
		SELECT run.id, job.id, run.status,
			NULLIF(CAST(json_extract(run.summary_json, '$.work_id') AS INTEGER), 0)
		FROM workflow_run AS run
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.workflow_code = 'remote_source_sync'
			AND run.status IN ('queued', 'running')
			AND job.worker_type = 'remote_source_track'
			AND CAST(json_extract(run.input_json, '$.source_id') AS INTEGER) = ?
			AND UPPER(CAST(json_extract(run.input_json, '$.work_code') AS TEXT)) = ?
		ORDER BY run.id DESC
		LIMIT 1
	`, sourceID, strings.ToUpper(strings.TrimSpace(requestedCode))).Scan(&result.RunID, &result.JobID, &result.Status, &workID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkTrackResult{}, false, nil
	}
	if err != nil {
		return remoteWorkTrackResult{}, false, err
	}
	if workID.Valid {
		result.WorkID = &workID.Int64
	}
	result.PrimaryCode = strings.ToUpper(strings.TrimSpace(requestedCode))
	return result, true, nil
}

type preparedRemoteWorkTrack struct {
	RequestedCode string
	WorkCode      string
	Source        remoteSourceForUse
	RemoteWork    kikoeru.Work
	RawWork       json.RawMessage
	Tracks        []kikoeru.Track
	CoverCached   bool
}

func (s *Server) prepareRemoteWorkTrack(ctx context.Context, sourceID int64, code string) (preparedRemoteWorkTrack, error) {
	requestedCode := strings.ToUpper(strings.TrimSpace(code))
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return preparedRemoteWorkTrack{}, fmt.Errorf("source not found")
		}
		return preparedRemoteWorkTrack{}, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return preparedRemoteWorkTrack{}, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := s.kikoeruCrawlClientForSource(source)
	remoteWork, rawWork, err := s.resolveRemoteWorkForAccess(ctx, client, requestedCode)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		}
		return preparedRemoteWorkTrack{}, err
	}
	tracks, _, err := client.Tracks(ctx, remoteWork.ID)
	if err != nil {
		_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		return preparedRemoteWorkTrack{}, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	workCode := strings.ToUpper(strings.TrimSpace(normalizedRemoteWorkCode(remoteWork)))
	if workCode == "" {
		workCode = requestedCode
	}
	coverCached := true
	coverURL := firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL)
	if coverURL != "" {
		coverCached = s.downloadRemoteCover(ctx, source, workCode, coverURL) == nil
	}
	return preparedRemoteWorkTrack{
		RequestedCode: requestedCode,
		WorkCode:      workCode,
		Source:        source,
		RemoteWork:    remoteWork,
		RawWork:       rawWork,
		Tracks:        tracks,
		CoverCached:   coverCached,
	}, nil
}

func persistRemoteWorkSync(ctx context.Context, tx *sql.Tx, prepared preparedRemoteWorkTrack, tracked bool) (int64, int, int, error) {
	workID, err := upsertRemoteWork(ctx, tx, prepared.Source, prepared.RemoteWork, prepared.RawWork, true)
	if err != nil {
		return 0, 0, 0, err
	}
	if err := upsertAvailableRemoteSourcePresence(ctx, tx, prepared.Source, prepared.RemoteWork, workID); err != nil {
		return 0, 0, 0, err
	}
	if tracked {
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID:       workID,
			FileSourceID: prepared.Source.ID,
			PresenceType: "tracked",
			RemoteID:     strconv.FormatInt(prepared.RemoteWork.ID, 10),
			RemoteCode:   prepared.WorkCode,
			SourceURL:    prepared.RemoteWork.SourceURL,
			Availability: "available",
			RawJSON:      string(prepared.RawWork),
		}); err != nil {
			return 0, 0, 0, err
		}
	}
	syncedMediaItems, syncedLocations, err := syncRemoteTrackTree(ctx, tx, prepared.Source.ID, workID, prepared.WorkCode, prepared.Tracks)
	if err != nil {
		return 0, 0, 0, err
	}
	return workID, syncedMediaItems, syncedLocations, nil
}

func persistRemoteWorkTrack(ctx context.Context, tx *sql.Tx, prepared preparedRemoteWorkTrack) (int64, int, int, error) {
	return persistRemoteWorkSync(ctx, tx, prepared, true)
}

func (s *Server) runRemoteWorkMaterialize(ctx context.Context, sourceID int64, code string, triggerReason string) (remoteWorkSyncResult, error) {
	return s.runRemoteWorkSyncWithIntent(ctx, sourceID, code, triggerReason, false)
}

func (s *Server) runRemoteWorkSync(ctx context.Context, sourceID int64, code string, triggerReason string) (remoteWorkSyncResult, error) {
	return s.runRemoteWorkSyncWithIntent(ctx, sourceID, code, triggerReason, true)
}

func (s *Server) runRemoteWorkSyncWithIntent(ctx context.Context, sourceID int64, code string, triggerReason string, tracked bool) (remoteWorkSyncResult, error) {
	prepared, err := s.prepareRemoteWorkTrack(ctx, sourceID, code)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	workCode := prepared.WorkCode

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	runID, jobID, err := createRemoteWorkSyncWorkflow(ctx, tx, prepared, triggerReason, tracked)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	workID, syncedMediaItems, syncedLocations, err := persistRemoteWorkSync(ctx, tx, prepared, tracked)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := recordRemoteWorkSyncWorkflow(ctx, tx, runID, prepared, tracked, workID, syncedMediaItems, syncedLocations); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkSyncResult{}, err
	}
	return remoteWorkSyncResult{
		RunID:            runID,
		JobID:            jobID,
		WorkID:           workID,
		PrimaryCode:      workCode,
		Status:           "succeeded",
		Tracked:          tracked,
		SyncedMediaItems: syncedMediaItems,
		SyncedLocations:  syncedLocations,
		TriggerReason:    triggerReason,
	}, nil
}

func createRemoteWorkSyncWorkflow(ctx context.Context, tx *sql.Tx, prepared preparedRemoteWorkTrack, triggerReason string, tracked bool) (int64, int64, error) {
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_source_sync", "Track remote source", "Discover remote works, filter candidates, match works, and track remote metadata.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"}, {"id": "discover", "type": "discover_remote_works"},
			{"id": "filter", "type": "filter_candidates"}, {"id": "match", "type": "match_works"},
			{"id": "metadata", "type": "sync_metadata"}, {"id": "tree", "type": "fetch_remote_tree"},
		},
	})
	if err != nil {
		return 0, 0, err
	}
	runInput := map[string]any{
		"file_source_id": prepared.Source.ID, "source_code": prepared.Source.Code, "work_code": prepared.WorkCode,
		"requested_work_code": prepared.RequestedCode, "trigger_reason": triggerReason, "tracked": tracked,
	}
	runDisplayName := "Sync remote source"
	if tracked {
		runDisplayName = "Track remote source"
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_source_sync", runDisplayName, "succeeded", "manual", triggerReason, runInput, map[string]any{"remote_work_id": prepared.RemoteWork.ID, "tracked": tracked})
	if err != nil {
		return 0, 0, err
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: runInput, Output: map[string]any{"file_source_id": prepared.Source.ID, "api_url": prepared.Source.Endpoint.APIURL},
	})
	if err != nil {
		return 0, 0, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: "kikoeru_remote_sync", Status: "succeeded", Payload: runInput, ProgressCurrent: 1, ProgressTotal: 1,
	})
	return runID, jobID, err
}

func recordRemoteWorkSyncWorkflow(ctx context.Context, tx *sql.Tx, runID int64, prepared preparedRemoteWorkTrack, tracked bool, workID int64, syncedMediaItems, syncedLocations int) error {
	workCode := prepared.WorkCode
	remoteWork := prepared.RemoteWork
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Discover remote works", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"remote_work_id": remoteWork.ID},
	}); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter candidates", Position: 3, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"accepted": 1, "rejected": 0},
	}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'remote_work', ?, 'accepted', ?)
	`, runID, workCode, mustJSON(map[string]any{"work_code": workCode, "remote_work_id": remoteWork.ID})); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "match", NodeType: "match_works", DisplayName: "Match works", Position: 4, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"work_id": workID, "tracked": tracked},
	}); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Sync metadata", Position: 5, Status: "succeeded",
		Input: map[string]any{"work_id": workID}, Output: map[string]any{"snapshot_bytes": len(prepared.RawWork)},
	}); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "tree", NodeType: "fetch_remote_tree", DisplayName: "Sync remote directory", Position: 6, Status: "succeeded",
		Input: map[string]any{"work_id": workID, "source_id": prepared.Source.ID}, Output: map[string]any{"media_items": syncedMediaItems, "locations": syncedLocations, "tracked": tracked},
	}); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "UPDATE workflow_run SET summary_json = ? WHERE id = ?", mustJSON(map[string]any{
		"remote_work_id": remoteWork.ID, "tracked": tracked, "media_items": syncedMediaItems, "locations": syncedLocations,
	}), runID)
	return err
}

func (s *Server) executeRemoteWorkTrackJob(ctx context.Context, job workflowJobRecord) error {
	var payload remoteWorkTrackJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "resolving", map[string]any{
		"sourceId": payload.SourceID, "workCode": payload.WorkCode,
	}, 0, 5); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	prepared, err := s.prepareRemoteWorkTrack(ctx, payload.SourceID, payload.WorkCode)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, err := s.finishRemoteWorkTrackJob(ctx, job, payload, prepared)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}

	metadataResult, metadataErr := s.enqueueWorkMetadataSync(context.WithoutCancel(ctx), result.WorkID)
	if metadataErr != nil {
		_ = s.recordWorkflowRunEvent(context.WithoutCancel(ctx), job.RunID, "warn", "track.metadata_followup_failed", "Track succeeded, but metadata refresh could not be queued", map[string]any{
			"work_id": result.WorkID,
		})
		return nil
	}
	_ = s.recordWorkflowRunEvent(context.WithoutCancel(ctx), job.RunID, "info", "track.metadata_followup", "Metadata refresh follow-up recorded", map[string]any{
		"work_id": result.WorkID, "metadata_run_id": metadataResult.RunID, "status": metadataResult.Status,
	})
	return nil
}

func (s *Server) finishRemoteWorkTrackJob(ctx context.Context, job workflowJobRecord, payload remoteWorkTrackJobPayload, prepared preparedRemoteWorkTrack) (remoteWorkSyncResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	workID, syncedMediaItems, syncedLocations, err := persistRemoteWorkTrack(ctx, tx, prepared)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	outputs := map[string]any{
		"discover": map[string]any{"remote_work_id": prepared.RemoteWork.ID, "primary_code": prepared.WorkCode},
		"filter":   map[string]any{"accepted": 1, "rejected": 0},
		"match":    map[string]any{"work_id": workID, "tracked": true},
		"metadata": map[string]any{"snapshot_bytes": len(prepared.RawWork), "cover_cached": prepared.CoverCached},
		"sync":     map[string]any{"media_items": syncedMediaItems, "locations": syncedLocations, "forked": true},
	}
	for nodeID, output := range outputs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = 'succeeded', output_json = ?, error_message = '',
				started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
			WHERE workflow_run_id = ? AND node_id = ?
		`, mustJSON(output), job.RunID, nodeID); err != nil {
			return remoteWorkSyncResult{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json)
		SELECT ?, id, 'remote_work', ?, 'accepted', ?
		FROM workflow_node_run
		WHERE workflow_run_id = ? AND node_id = 'filter'
	`, job.RunID, prepared.WorkCode, mustJSON(map[string]any{
		"work_code": prepared.WorkCode, "remote_work_id": prepared.RemoteWork.ID,
	}), job.RunID); err != nil {
		return remoteWorkSyncResult{}, err
	}
	summary := map[string]any{
		"source_id": prepared.Source.ID, "source_code": prepared.Source.Code,
		"requested_work_code": prepared.RequestedCode, "primary_code": prepared.WorkCode,
		"remote_work_id": prepared.RemoteWork.ID, "work_id": workID,
		"tracked": true, "forked": true, "media_items": syncedMediaItems, "locations": syncedLocations,
		"cover_cached": prepared.CoverCached,
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'succeeded', progress_current = 5, progress_total = 5,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL,
			checkpoint_json = ?, error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(map[string]any{"phase": "completed", "detail": summary, "progressCurrent": 5, "progressTotal": 5}), job.ID); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(summary), job.RunID); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: "info", Type: "track.completed",
		Message: "Tracked remote work and forked its directory", Detail: summary,
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkSyncResult{}, err
	}
	return remoteWorkSyncResult{
		RunID: job.RunID, JobID: job.ID, WorkID: workID, PrimaryCode: prepared.WorkCode,
		Status: "succeeded", Tracked: true, SyncedMediaItems: syncedMediaItems, SyncedLocations: syncedLocations,
		TriggerReason: payload.TriggerReason,
	}, nil
}
