package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"strings"

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
	if err := s.ensureRemoteWorkSaveDiskReserve(plan, minFreeBytes); err != nil {
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
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_work_fetch", "Fetch remote work", "queued", "manual", "fetch_selected", runInput, map[string]any{"plan": prep.plan.Summary})
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
