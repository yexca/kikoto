package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type remoteWorkSavePreparation struct {
	requestedCode      string
	requestedSourceID  int64
	requestedByUserID  int64
	requestID          string
	jobPriority        int
	selectedPaths      []string
	selectedLocalPaths []string
	decisions          []remoteFetchFileDecision
	minFreeBytes       int64
	source             remoteSourceForUse
	remoteWork         kikoeru.Work
	tracks             []kikoeru.Track
	workCode           string
	plan               remoteWorkSavePlan
	rawWork            []byte
	rawTracks          []byte
	localScanDepth     int
}

func (s *Server) prepareRemoteWorkSaveEnqueue(
	ctx context.Context,
	sourceID int64,
	code string,
	selectedPaths []string,
	selectedLocalPaths []string,
	targetRoot string,
	requestID string,
	decisions []remoteFetchFileDecision,
	minFreeBytes int64,
	requestedByUserID int64,
	jobPriority int,
) (remoteWorkSavePreparation, error) {
	source, remoteWork, tracks, err := s.loadRemoteWorkTracksCached(ctx, sourceID, code)
	if err != nil {
		return remoteWorkSavePreparation{}, err
	}
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = strings.ToUpper(strings.TrimSpace(code))
	}
	plan, err := s.buildRemoteWorkSavePlanFromSnapshot(ctx, source, remoteWork, tracks, workCode, selectedPaths, selectedLocalPaths, targetRoot, decisions)
	if err != nil {
		return remoteWorkSavePreparation{}, err
	}
	if plan.Summary.Conflict > 0 {
		return remoteWorkSavePreparation{}, remoteWorkSaveConflictError{Summary: plan.Summary}
	}
	downloadLimit := s.remoteMediaDownloadLimitBytes(ctx)
	if err := validateRemoteFetchDownloadPlan(plan.Items, downloadLimit); err != nil {
		return remoteWorkSavePreparation{}, err
	}
	if err := s.ensureRemoteWorkSaveDiskReserve(plan, minFreeBytes, ""); err != nil {
		return remoteWorkSavePreparation{}, err
	}
	claimedRoot, err := s.ensureRemoteFetchRootClaim(ctx, source, plan.SaveRoot)
	if err != nil {
		return remoteWorkSavePreparation{}, err
	}
	if claimedRoot.Conflict {
		if !plan.FetchRoot.Conflict {
			plan.Summary.Conflict++
		}
		plan.FetchRoot = claimedRoot
		return remoteWorkSavePreparation{}, remoteWorkSaveConflictError{Summary: plan.Summary}
	}
	if plan.FetchRoot.Status == "ready" || plan.FetchRoot.Status == "legacy_managed" {
		s.notifyFilesystemTriggerConfigChanged()
	}
	plan.FetchRoot = claimedRoot
	rawWork, _ := json.Marshal(remoteWork)
	rawTracks, _ := json.Marshal(tracks)
	return remoteWorkSavePreparation{
		requestedCode: requestedCode(code), requestedSourceID: sourceID, requestedByUserID: requestedByUserID,
		requestID: requestID, jobPriority: jobPriority, source: source, remoteWork: remoteWork, tracks: tracks,
		workCode: workCode, plan: plan, rawWork: rawWork, rawTracks: rawTracks,
		selectedPaths: selectedPaths, selectedLocalPaths: selectedLocalPaths, decisions: decisions, minFreeBytes: minFreeBytes,
		localScanDepth: s.configuredLocalScanDepth(ctx),
	}, nil
}

type remoteFetchOriginKey struct{}

// withRemoteFetchOrigin records which workflow queued a Fetch, so its run
// shows the real origin instead of a manual selection.
func withRemoteFetchOrigin(ctx context.Context, origin string) context.Context {
	return context.WithValue(ctx, remoteFetchOriginKey{}, origin)
}

func remoteFetchOrigin(ctx context.Context) string {
	if origin, ok := ctx.Value(remoteFetchOriginKey{}).(string); ok && origin != "" {
		return origin
	}
	return "fetch_selected"
}

// remoteFetchRunName names a Fetch run after its work, so Activity shows
// which work is downloading.
func remoteFetchRunName(workCode string) string {
	if workCode = strings.ToUpper(strings.TrimSpace(workCode)); workCode != "" {
		return "Fetch " + workCode
	}
	return "Fetch remote work"
}

func requestedCode(code string) string {
	return strings.ToUpper(strings.TrimSpace(code))
}

type remoteFetchWorkflowNodes struct {
	cacheNodeID int64
}

func insertRemoteFetchWorkflowNodes(ctx context.Context, tx *sql.Tx, runID int64, sourceID int64, workCode string, tracks []kikoeru.Track, plan remoteWorkSavePlan, runInput remoteWorkFetchJobPayload, rawWork []byte, rawTracks []byte) (remoteFetchWorkflowNodes, error) {
	staticNodes := []workflow.NodeRunSpec{
		{NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded", Input: runInput, Output: map[string]any{"source_id": sourceID, "work_code": workCode}},
		{NodeID: "tree", NodeType: "fetch_remote_tree", DisplayName: "Fetch remote tree", Position: 2, Status: "succeeded", Input: map[string]any{"work_code": workCode}, Output: map[string]any{"tracks": len(tracks), "snapshot_bytes": len(rawWork) + len(rawTracks)}},
		{NodeID: "plan", NodeType: "plan_save", DisplayName: "Plan save", Position: 3, Status: "succeeded", Input: map[string]any{"paths": runInput.Paths, "local_paths": runInput.LocalPaths}, Output: plan},
		{NodeID: "cache", NodeType: "materialize_cache", DisplayName: "Cache selected files", Position: 4, Status: "queued", Input: map[string]any{"items": len(plan.Items)}},
		{NodeID: "stage", NodeType: "stage_fetch_result", DisplayName: "Assemble staging directory", Position: 5, Status: "queued", Input: map[string]any{"items": len(plan.Items)}},
		{NodeID: "verify", NodeType: "verify_files", DisplayName: "Verify staged files", Position: 6, Status: "queued", Input: map[string]any{"items": len(plan.Items)}},
		{NodeID: "promote", NodeType: "publish_staged_fetch", DisplayName: "Publish staged result", Position: 7, Status: "queued", Input: map[string]any{"items": len(plan.Items)}},
		{NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync fetched locations", Position: 8, Status: "queued", Input: map[string]any{"items": len(plan.Items)}},
		{NodeID: "cleanup", NodeType: "cleanup_cache", DisplayName: "Remove promoted cache files", Position: 9, Status: "queued", Input: map[string]any{"items": len(plan.Items)}},
	}
	var nodes remoteFetchWorkflowNodes
	for _, spec := range staticNodes {
		id, err := workflow.InsertNodeRun(ctx, tx, runID, spec)
		if err != nil {
			return remoteFetchWorkflowNodes{}, err
		}
		if spec.NodeID == "cache" {
			nodes.cacheNodeID = id
		}
	}
	return nodes, nil
}

func (s *Server) enqueuePreparedRemoteWorkSave(ctx context.Context, prep remoteWorkSavePreparation) (remoteWorkSaveResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if existing, found, err := activeRemoteFetchResult(ctx, tx, prep.workCode); err != nil {
		return remoteWorkSaveResult{}, err
	} else if found {
		if err := subscribeRemoteFetchNotification(ctx, tx, prep.requestedByUserID, existing.RunID, existing.WorkID, existing.PrimaryCode); err != nil {
			return remoteWorkSaveResult{}, err
		}
		return existing, tx.Commit()
	}
	result, err := s.insertPreparedRemoteFetchTx(ctx, tx, prep)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkSaveResult{}, err
	}
	return result, nil
}

func (s *Server) insertPreparedRemoteFetchTx(ctx context.Context, tx *sql.Tx, prep remoteWorkSavePreparation) (remoteWorkSaveResult, error) {
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_work_fetch", "Fetch remote work", "Select remote files, cache them, promote cache files to the local library, and sync local locations.", remoteWorkFetchDefinition())
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	runInput := remoteWorkFetchJobPayload{
		RequestedByUserID: prep.requestedByUserID, SourceID: prep.requestedSourceID, WorkCode: prep.workCode,
		Paths: prep.selectedPaths, LocalPaths: prep.selectedLocalPaths, TargetRoot: prep.plan.SaveRoot,
		RequestID: prep.requestID, Decisions: prep.decisions, MinFreeBytes: prep.minFreeBytes,
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_work_fetch", remoteFetchRunName(prep.workCode), "queued", "manual", remoteFetchOrigin(ctx), runInput, map[string]any{"plan": prep.plan.Summary})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	nodes, err := insertRemoteFetchWorkflowNodes(ctx, tx, runID, prep.source.ID, prep.workCode, prep.tracks, prep.plan, runInput, prep.rawWork, prep.rawTracks)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	return s.persistPreparedRemoteFetchTx(ctx, tx, prep, runID, runInput, nodes)
}

func (s *Server) persistPreparedRemoteFetchTx(ctx context.Context, tx *sql.Tx, prep remoteWorkSavePreparation, runID int64, runInput remoteWorkFetchJobPayload, nodes remoteFetchWorkflowNodes) (remoteWorkSaveResult, error) {
	workID, err := upsertRemoteWork(ctx, tx, prep.source, prep.remoteWork, prep.rawWork, true)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if err := upsertAvailableRemoteSourcePresence(ctx, tx, prep.source, prep.remoteWork, workID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, _, err := syncRemoteTrackTree(ctx, tx, prep.source.ID, workID, prep.workCode, prep.tracks); err != nil {
		return remoteWorkSaveResult{}, err
	}
	localSourceID, err := s.upsertLocalFileSource(ctx, tx, prep.localScanDepth)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	transferBytesTotal, transferUnknownItems := remoteFetchTransferTotals(prep.plan.Items)
	jobInput := runInput
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: nodes.cacheNodeID, WorkerType: "remote_work_fetch", Status: "queued", Priority: prep.jobPriority,
		ResourceKey: sourceResourceKey(prep.source.Endpoint.APIURL), Payload: jobInput, Recoverable: true, MaxRetries: 5,
		ProgressCurrent: 0, ProgressTotal: len(prep.plan.Items) * 2, ProgressBytesTotal: transferBytesTotal, ProgressBytesUnknownItems: transferUnknownItems,
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := createRemoteFetchManifest(ctx, tx, runID, jobID, prep.requestID, workID, prep.requestedSourceID, localSourceID, prep.plan); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if err := subscribeRemoteFetchNotification(ctx, tx, prep.requestedByUserID, runID, workID, prep.workCode); err != nil {
		return remoteWorkSaveResult{}, err
	}
	result := remoteWorkSaveResult{RunID: runID, JobID: jobID, WorkID: workID, PrimaryCode: prep.workCode, Status: "queued", SaveRoot: prep.plan.SaveRoot, Plan: prep.plan.Summary, RequestID: prep.requestID}
	if prep.requestID != "" {
		resultJSON, err := json.Marshal(result)
		if err != nil {
			return remoteWorkSaveResult{}, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO remote_fetch_request (request_id, source_id, work_code, workflow_run_id, result_json) VALUES (?, ?, ?, ?, ?)`, prep.requestID, prep.requestedSourceID, prep.requestedCode, runID, string(resultJSON)); err != nil {
			return remoteWorkSaveResult{}, err
		}
	}
	return result, nil
}

type remoteWorkSaveRequest struct {
	Paths        []string                  `json:"paths"`
	LocalPaths   []string                  `json:"localPaths"`
	TargetRoot   string                    `json:"targetRoot"`
	RequestID    string                    `json:"requestId"`
	Decisions    []remoteFetchFileDecision `json:"decisions"`
	MinFreeBytes int64                     `json:"minFreeBytes"`
}

type remoteWorkFetchJobPayload struct {
	RequestedByUserID int64                     `json:"requested_by_user_id,omitempty"`
	SourceID          int64                     `json:"source_id"`
	WorkCode          string                    `json:"work_code"`
	Paths             []string                  `json:"paths"`
	LocalPaths        []string                  `json:"local_paths"`
	TargetRoot        string                    `json:"target_root"`
	RequestID         string                    `json:"request_id"`
	Decisions         []remoteFetchFileDecision `json:"decisions"`
	MinFreeBytes      int64                     `json:"min_free_bytes"`
}

var remoteFetchRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

func (s *Server) planRemoteSourceWorkSave(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	sourceID, code, payload, ok := parseRemoteWorkSaveRequest(w, r)
	if !ok {
		return
	}
	metadataErr := s.ensureRemoteFetchMetadata(r.Context(), code)
	preparation := s.prepareRemoteFetch(r.Context(), code)
	if metadataErr != nil {
		preparation.MetadataStatus = "degraded"
		preparation.Warnings = append(preparation.Warnings, "metadata refresh: "+metadataErr.Error())
	}
	plan, err := s.buildRemoteWorkSavePlan(r.Context(), sourceID, code, payload.Paths, payload.LocalPaths, payload.TargetRoot, payload.Decisions)
	if err != nil {
		if !writeFetchDestinationError(w, err) {
			writeUpstreamError(w, err)
		}
		return
	}
	if err := s.ensureRemoteWorkSaveDiskReserve(plan, payload.MinFreeBytes, ""); err != nil {
		writeError(w, err)
		return
	}
	attachRemoteFetchPreparation(&plan, preparation)
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) saveRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	sourceID, code, payload, ok := parseRemoteWorkSaveRequest(w, r)
	if !ok {
		return
	}
	payload.RequestID = strings.TrimSpace(payload.RequestID)
	if payload.RequestID != "" && !validRemoteFetchRequestID(payload.RequestID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid fetch request id"})
		return
	}
	if payload.RequestID != "" {
		if existing, found, err := s.remoteFetchRequestResult(r.Context(), payload.RequestID, sourceID, code); err != nil {
			writeError(w, err)
			return
		} else if found {
			writeJSON(w, http.StatusAccepted, existing)
			return
		}
	}
	operationCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()
	result, err := s.enqueueRemoteWorkSave(operationCtx, sourceID, code, payload.Paths, payload.LocalPaths, payload.TargetRoot, payload.RequestID, payload.Decisions, payload.MinFreeBytes, actor.ID, workflow.JobPriorityUserInitiated)
	if err != nil {
		if payload.RequestID != "" {
			if existing, found, lookupErr := s.remoteFetchRequestResult(r.Context(), payload.RequestID, sourceID, code); lookupErr == nil && found {
				writeJSON(w, http.StatusAccepted, existing)
				return
			}
		}
		var conflict remoteWorkSaveConflictError
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "summary": conflict.Summary})
			return
		}
		if writeFetchDestinationError(w, err) {
			return
		}
		writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) enqueueRemoteWorkSave(ctx context.Context, sourceID int64, code string, selectedPaths []string, selectedLocalPaths []string, targetRoot string, requestID string, decisions []remoteFetchFileDecision, minFreeBytes int64, requestedByUserID int64, jobPriority int) (remoteWorkSaveResult, error) {
	requestedCode := strings.ToUpper(strings.TrimSpace(code))
	if existing, found, err := activeRemoteFetchResult(ctx, s.db, requestedCode); err != nil {
		return remoteWorkSaveResult{}, err
	} else if found {
		if err := subscribeRemoteFetchNotification(ctx, s.db, requestedByUserID, existing.RunID, existing.WorkID, existing.PrimaryCode); err != nil {
			return remoteWorkSaveResult{}, err
		}
		return existing, nil
	}
	if s.db != nil {
		// Background Fetch runs may not have a preceding plan request.
		_ = s.ensureRemoteFetchMetadata(ctx, requestedCode)
	}
	prep, err := s.prepareRemoteWorkSaveEnqueue(ctx, sourceID, code, selectedPaths, selectedLocalPaths, targetRoot, requestID, decisions, minFreeBytes, requestedByUserID, jobPriority)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	return s.enqueuePreparedRemoteWorkSave(ctx, prep)
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func activeRemoteFetchResult(ctx context.Context, queryer rowQueryer, workCode string) (remoteWorkSaveResult, bool, error) {
	workCode = strings.ToUpper(strings.TrimSpace(workCode))
	if workCode == "" {
		return remoteWorkSaveResult{}, false, nil
	}
	var result remoteWorkSaveResult
	var planJSON string
	err := queryer.QueryRowContext(ctx, `
		SELECT run.id,
			job.id,
			COALESCE(manifest.work_id, 0),
			COALESCE(CAST(json_extract(run.input_json, '$.work_code') AS TEXT), ''),
			run.status,
			COALESCE(manifest.target_root, ''),
			COALESCE(manifest.plan_json, '{}'),
			COALESCE(CAST(json_extract(run.input_json, '$.request_id') AS TEXT), '')
		FROM workflow_run AS run
		INNER JOIN workflow_job AS job
			ON job.workflow_run_id = run.id AND job.worker_type = 'remote_work_fetch'
		LEFT JOIN remote_fetch_manifest AS manifest ON manifest.workflow_run_id = run.id
		WHERE run.workflow_code = 'remote_work_fetch'
			AND (
				run.status IN ('queued', 'running')
				OR (
					run.status = 'partial'
					AND EXISTS (
						SELECT 1
						FROM workflow_candidate AS candidate
						WHERE candidate.workflow_run_id = run.id
							AND candidate.candidate_type = 'remote_origin_blocked'
							AND candidate.status = 'pending'
					)
				)
			)
			AND UPPER(COALESCE(CAST(json_extract(run.input_json, '$.work_code') AS TEXT), '')) = ?
		ORDER BY run.id ASC
		LIMIT 1
	`, workCode).Scan(&result.RunID, &result.JobID, &result.WorkID, &result.PrimaryCode, &result.Status, &result.SaveRoot, &planJSON, &result.RequestID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkSaveResult{}, false, nil
	}
	if err != nil {
		return remoteWorkSaveResult{}, false, err
	}
	var plan remoteWorkSavePlan
	if json.Unmarshal([]byte(planJSON), &plan) == nil {
		result.Plan = plan.Summary
	}
	result.Deduplicated = true
	return result, true, nil
}

func remoteWorkFetchDefinition() map[string]any {
	return map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "tree", "type": "fetch_remote_tree"},
			{"id": "plan", "type": "plan_save"},
			{"id": "cache", "type": "materialize_cache"},
			{"id": "stage", "type": "stage_fetch_result"},
			{"id": "verify", "type": "verify_files"},
			{"id": "promote", "type": "publish_staged_fetch"},
			{"id": "sync", "type": "sync_file_locations"},
			{"id": "cleanup", "type": "cleanup_cache"},
		},
	}
}

func parseRemoteWorkSaveRequest(w http.ResponseWriter, r *http.Request) (int64, string, remoteWorkSaveRequest, bool) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return 0, "", remoteWorkSaveRequest{}, false
	}
	code := remoteWorkCodeFromPath(r)
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return 0, "", remoteWorkSaveRequest{}, false
	}
	var payload remoteWorkSaveRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	return id, code, payload, true
}

func validRemoteFetchRequestID(value string) bool {
	return remoteFetchRequestIDPattern.MatchString(strings.TrimSpace(value))
}

func (s *Server) remoteFetchRequestResult(ctx context.Context, requestID string, sourceID int64, code string) (remoteWorkSaveResult, bool, error) {
	var storedSourceID int64
	var storedCode string
	var raw string
	err := s.db.QueryRowContext(ctx, `
		SELECT source_id, work_code, result_json
		FROM remote_fetch_request
		WHERE request_id = ?
	`, requestID).Scan(&storedSourceID, &storedCode, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkSaveResult{}, false, nil
	}
	if err != nil {
		return remoteWorkSaveResult{}, false, err
	}
	if storedSourceID != sourceID || !strings.EqualFold(strings.TrimSpace(storedCode), strings.TrimSpace(code)) {
		return remoteWorkSaveResult{}, false, fmt.Errorf("fetch request id was already used for another work")
	}
	var result remoteWorkSaveResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return remoteWorkSaveResult{}, false, err
	}
	result.Deduplicated = true
	return result, true, nil
}
