package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type localScanJobPayload struct {
	Root                string   `json:"root"`
	ScanDepth           int      `json:"scan_depth"`
	ScanMode            string   `json:"scan_mode,omitempty"`
	ChangedPaths        []string `json:"changed_paths,omitempty"`
	FullFallbackReason  string   `json:"full_fallback_reason,omitempty"`
	DirectoryEventAt    string   `json:"directory_event_at,omitempty"`
	ObservedDirectories int      `json:"observed_directories,omitempty"`
	FollowUpRun         bool     `json:"follow_up_run,omitempty"`
}

const (
	localScanModeFull        = "full"
	localScanModeIncremental = "incremental"
)

type metadataSyncRunInput struct {
	SourceRunID int64 `json:"source_run_id,omitempty"`
}

func (s *Server) enqueueLocalScan(ctx context.Context, triggerType string, triggerReason string) (localScanResult, error) {
	return s.enqueueLocalScanWithOptions(ctx, triggerType, triggerReason, 0, false)
}

func (s *Server) enqueueLocalScanWithOptions(ctx context.Context, triggerType string, triggerReason string, triggerID int64, followUpRun bool) (localScanResult, error) {
	scanDepth := s.configuredLocalScanDepth(ctx)
	return s.enqueueLocalScanWithPayload(ctx, triggerType, triggerReason, triggerID, localScanJobPayload{
		Root: s.cfg.DataRoot, ScanDepth: scanDepth, ScanMode: localScanModeFull, FollowUpRun: followUpRun,
	})
}

func (s *Server) enqueueLocalScanWithPayload(ctx context.Context, triggerType string, triggerReason string, triggerID int64, payload localScanJobPayload) (localScanResult, error) {
	if strings.TrimSpace(payload.Root) == "" {
		payload.Root = s.cfg.DataRoot
	}
	if payload.ScanDepth <= 0 {
		payload.ScanDepth = s.configuredLocalScanDepth(ctx)
	}
	if payload.ScanMode == "" {
		payload.ScanMode = localScanModeFull
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return localScanResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_library_scan", "Scan local library", "Discover local works and synchronize local source presence.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_local_source", "displayName": "Select local source"},
			{"id": "discover", "type": "discover_local_files", "displayName": "Discover files"},
			{"id": "match", "type": "match_works", "displayName": "Match works"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync locations"},
		},
	})
	if err != nil {
		return localScanResult{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "local_library_scan", "Scan local library", "queued", triggerType, triggerReason, payload, map[string]any{})
	if err != nil {
		return localScanResult{}, err
	}
	if triggerID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", triggerID, runID); err != nil {
			return localScanResult{}, err
		}
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_local_source", DisplayName: "Select local source", Position: 1,
		Status: "succeeded", Input: payload, Output: map[string]any{"root": payload.Root, "scan_depth": payload.ScanDepth},
	}); err != nil {
		return localScanResult{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_local_files", DisplayName: "Discover local files", Position: 2, Status: "queued", Input: payload,
	})
	if err != nil {
		return localScanResult{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "match", NodeType: "match_works", DisplayName: "Match works", Position: 3, Status: "queued"},
		{NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync file locations", Position: 4, Status: "queued"},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return localScanResult{}, err
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: discoverNodeID, WorkerType: "local_library_scan", Status: "queued",
		Priority: workflowJobPriorityForTrigger(triggerType), ResourceKey: "local:scan", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3,
	})
	if err != nil {
		return localScanResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return localScanResult{}, err
	}
	return localScanResult{
		RunID: runID, JobID: jobID, Status: "queued", FollowUpRun: payload.FollowUpRun,
		NewWorkCodes: []string{}, Failures: []string{},
	}, nil
}

func (s *Server) executeLocalScanJob(ctx context.Context, job workflowJobRecord) error {
	payload, err := s.prepareLocalScanPayload(ctx, job)
	if err != nil {
		return err
	}
	if payload.ScanMode == localScanModeIncremental {
		return s.executeIncrementalLocalScanJob(ctx, job, payload)
	}
	return s.executeFullLocalScanJob(ctx, job, payload)
}

func (s *Server) executeFullLocalScanJob(ctx context.Context, job workflowJobRecord, payload localScanJobPayload) error {
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "discovering", map[string]any{"root": payload.Root, "scan_mode": localScanModeFull}, 0, 0)
	workFolders, scanSummary, err := localfs.DiscoverFolders(payload.Root, localfs.Options{ScanDepth: payload.ScanDepth})
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, runSummary, err := s.persistLocalScanResults(ctx, job, payload, workFolders, scanSummary, nodeIDs)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "finishing", map[string]any{"detected_works": result.DetectedWorks}, result.ScannedFiles, result.ScannedFiles)
	if err := s.finishQueuedLocalScanJob(ctx, job, nodeIDs["sync"], result, runSummary); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if payload.FollowUpRun {
		s.queueLocalScanMetadataFollowUp(ctx, job.RunID)
	}
	return nil
}

func (s *Server) prepareLocalScanPayload(ctx context.Context, job workflowJobRecord) (localScanJobPayload, error) {
	var payload localScanJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return payload, err
	}
	if payload.ScanDepth <= 0 {
		payload.ScanDepth = s.configuredLocalScanDepth(ctx)
	}
	if strings.TrimSpace(payload.Root) == "" {
		payload.Root = s.cfg.DataRoot
	}
	payload.ScanMode = strings.ToLower(strings.TrimSpace(payload.ScanMode))
	if payload.ScanMode == "" {
		payload.ScanMode = localScanModeFull
	}
	if payload.ScanMode != localScanModeFull && payload.ScanMode != localScanModeIncremental {
		return payload, errors.New("local scan mode is invalid")
	}
	if payload.ScanMode == localScanModeIncremental && len(payload.ChangedPaths) == 0 {
		payload.ScanMode = localScanModeFull
		payload.FullFallbackReason = "changed_paths_unavailable"
	}
	return payload, nil
}

func (s *Server) persistLocalScanResults(ctx context.Context, job workflowJobRecord, payload localScanJobPayload, workFolders []localfs.WorkFolder, scanSummary localfs.Summary, nodeIDs map[string]int64) (localScanResult, map[string]any, error) {

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return localScanResult{}, nil, err
	}
	defer func() { _ = tx.Rollback() }()
	fileSourceID, err := s.upsertLocalFileSource(ctx, tx, payload.ScanDepth)
	if err != nil {
		return localScanResult{}, nil, err
	}
	state := localScanPersistState{duplicateCodes: localScanDuplicateCodes(scanSummary.DuplicateGroups), seenWorkIDs: map[int64]bool{}, reconciledWorkIDs: map[int64]bool{}}
	seenRoots := map[string]bool{}
	for _, folder := range workFolders {
		seenRoots[strings.ToLower(normalizeFolderRootPath(folder.RelPath))] = true
		if _, err := s.persistLocalScanFolder(ctx, tx, fileSourceID, folder, &state); err != nil {
			return localScanResult{}, nil, err
		}
	}
	if err := markMissingExternalWorkFolderLocations(ctx, tx, fileSourceID, seenRoots); err != nil {
		return localScanResult{}, nil, err
	}
	missingWorkIDs, err := markMissingLocalPresence(ctx, tx, fileSourceID, state.seenWorkIDs)
	if err != nil {
		return localScanResult{}, nil, err
	}
	for _, workID := range missingWorkIDs {
		missing, err := markAvailableLocalLocationsMissingForWork(ctx, tx, workID, fileSourceID)
		if err != nil {
			return localScanResult{}, nil, err
		}
		state.missingLocations += missing
	}
	runSummary := map[string]any{
		"candidate_folders":   scanSummary.CandidateFolders,
		"detected_works":      scanSummary.DetectedWorks,
		"scanned_files":       scanSummary.ScannedFiles,
		"ambiguous_folders":   scanSummary.AmbiguousFolders,
		"duplicate_groups":    localDuplicateGroupSummaries(scanSummary.DuplicateGroups),
		"updated_locations":   state.updatedLocations,
		"skipped_locations":   state.skippedLocations,
		"missing_locations":   state.missingLocations,
		"new_work_codes":      state.newWorkCodes,
		"follow_up_requested": payload.FollowUpRun,
		"scan_mode":           localScanModeFull,
	}
	if payload.FullFallbackReason != "" {
		runSummary["full_fallback_reason"] = payload.FullFallbackReason
	}
	if err := completeLocalScanNodes(ctx, tx, nodeIDs, fileSourceID, scanSummary, state); err != nil {
		return localScanResult{}, nil, err
	}
	if err := insertLocalDuplicateCandidates(ctx, tx, job.RunID, scanSummary.DuplicateGroups); err != nil {
		return localScanResult{}, nil, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET summary_json = ? WHERE id = ?", mustJSON(runSummary), job.RunID); err != nil {
		return localScanResult{}, nil, err
	}
	if err := tx.Commit(); err != nil {
		return localScanResult{}, nil, err
	}
	result := localScanResult{
		RunID: job.RunID, JobID: job.ID, FileSourceID: fileSourceID, Status: "succeeded",
		DetectedWorks: scanSummary.DetectedWorks, ScannedFiles: scanSummary.ScannedFiles,
		UpdatedLocations: state.updatedLocations, SkippedLocations: state.skippedLocations,
		FollowUpRun: payload.FollowUpRun, NewWorkCodes: state.newWorkCodes, Failures: []string{},
	}
	return result, runSummary, nil
}

type localScanPersistState struct {
	updatedLocations, skippedLocations, missingLocations int
	newWorkCodes                                         []string
	seenWorkIDs, reconciledWorkIDs                       map[int64]bool
	duplicateCodes                                       map[string]bool
}

func localScanDuplicateCodes(groups []localfs.DuplicateGroup) map[string]bool {
	result := map[string]bool{}
	for _, group := range groups {
		result[strings.ToUpper(strings.TrimSpace(group.Code))] = true
	}
	return result
}

func (s *Server) persistLocalScanFolder(ctx context.Context, tx *sql.Tx, fileSourceID int64, folder localfs.WorkFolder, state *localScanPersistState) (int64, error) {
	_, existedBefore, err := workIDForCodeInTx(ctx, tx, folder.Code)
	if err != nil {
		return 0, err
	}
	workID, err := upsertDetectedWork(ctx, tx, folder)
	if err != nil {
		return 0, err
	}
	if !existedBefore {
		state.newWorkCodes = append(state.newWorkCodes, folder.Code)
	}
	state.seenWorkIDs[workID] = true
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID: workID, FileSourceID: fileSourceID, PresenceType: "local",
		SourceURL: filepath.ToSlash(folder.RelPath), Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"code": folder.Code, "title": folder.Title, "rel_path": filepath.ToSlash(folder.RelPath),
			"files": len(folder.Files), "file_tree_scanned": false,
		}),
	}); err != nil {
		return 0, err
	}
	var managedFetchRootExists bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM work_folder_location
			WHERE work_id = ? AND file_source_id = ? AND role = 'managed_fetch'
		)
	`, workID, fileSourceID).Scan(&managedFetchRootExists); err != nil {
		return 0, err
	}
	if !managedFetchRootExists {
		if err := upsertWorkFolderLocation(ctx, tx, workID, fileSourceID, folder.RelPath, "external", "active", true); err != nil {
			return 0, err
		}
	}
	// A duplicate stays reviewable. Invalidating either folder here would
	// choose a winner before the user has reviewed the candidate.
	code := strings.ToUpper(strings.TrimSpace(folder.Code))
	if !state.duplicateCodes[code] && !state.reconciledWorkIDs[workID] {
		missing, err := markLocalLocationsMissingForChangedFolder(ctx, tx, workID, fileSourceID, folder.RelPath)
		if err != nil {
			return 0, err
		}
		state.missingLocations += missing
		state.reconciledWorkIDs[workID] = true
	}
	return workID, nil
}

func completeLocalScanNodes(ctx context.Context, tx *sql.Tx, nodeIDs map[string]int64, fileSourceID int64, summary localfs.Summary, state localScanPersistState) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(map[string]any{
		"candidate_folders": summary.CandidateFolders, "detected_works": summary.DetectedWorks,
		"scanned_files": summary.ScannedFiles, "ambiguous_folders": summary.AmbiguousFolders,
		"skipped_locations": state.skippedLocations, "missing_locations": state.missingLocations,
	}), nodeIDs["discover"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', input_json = ?, output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(map[string]any{"detected_works": summary.DetectedWorks}), mustJSON(map[string]any{
		"matched_works": summary.DetectedWorks, "duplicate_groups": len(summary.DuplicateGroups),
	}), nodeIDs["match"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', input_json = ?, output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(map[string]any{"file_source_id": fileSourceID}), mustJSON(map[string]any{
		"updated_locations": state.updatedLocations, "skipped_locations": state.skippedLocations,
		"missing_locations": state.missingLocations, "new_work_codes": state.newWorkCodes,
	}), nodeIDs["sync"]); err != nil {
		return err
	}
	return nil
}

func workIDForCodeInTx(ctx context.Context, tx *sql.Tx, code string) (int64, bool, error) {
	var id int64
	err := tx.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&id)
	if err == nil {
		return id, true, nil
	}
	if err == sql.ErrNoRows {
		return 0, false, nil
	}
	return 0, false, err
}

func (s *Server) finishQueuedLocalScanJob(ctx context.Context, job workflowJobRecord, completedNodeID int64, result localScanResult, runSummary map[string]any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	errorMessage := strings.Join(result.Failures, "\n")
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.ScannedFiles, result.ScannedFiles, errorMessage,
		mustJSON(map[string]any{"phase": "completed", "detail": runSummary, "progressCurrent": result.ScannedFiles, "progressTotal": result.ScannedFiles}), job.ID); err != nil {
		return err
	}
	runSummary["failures"] = result.Failures
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, result.Status, mustJSON(runSummary), job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: completedNodeID, JobID: job.ID, Level: eventLevelForWorkflowStatus(result.Status),
		Type: "local_library_scan.completed", Message: "Local library scan " + result.Status, Detail: runSummary,
	}); err != nil {
		return err
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, result.Status, result.Failures); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) queueLocalScanMetadataFollowUp(ctx context.Context, sourceRunID int64) {
	result, coalesced, err := s.enqueueDLsiteMetadataSyncFollowUp(ctx, sourceRunID)
	if err != nil {
		slog.Error("queue local scan metadata follow-up", "source_run_id", sourceRunID, "error", err)
		_ = s.recordWorkflowRunEvent(ctx, sourceRunID, "warning", "local_library_scan.follow_up_failed", "Metadata sync follow-up could not be queued.", map[string]any{
			"follow_up_requested": true,
		})
		return
	}
	_ = s.recordWorkflowRunEvent(ctx, sourceRunID, "info", "local_library_scan.follow_up_queued", "Metadata sync follow-up queued.", map[string]any{
		"metadata_run_id": result.RunID,
		"coalesced":       coalesced,
	})
}

func (s *Server) enqueueDLsiteMetadataSync(ctx context.Context, triggerType string, triggerReason string) (metasync.DLsiteSyncResult, error) {
	return s.enqueueDLsiteMetadataSyncWithTrigger(ctx, triggerType, triggerReason, 0)
}

func (s *Server) enqueueDLsiteMetadataSyncWithTrigger(ctx context.Context, triggerType string, triggerReason string, triggerID int64) (metasync.DLsiteSyncResult, error) {
	return s.enqueueDLsiteMetadataSyncWithInput(ctx, triggerType, triggerReason, triggerID, metadataSyncRunInput{})
}

func (s *Server) enqueueDLsiteMetadataSyncFollowUp(ctx context.Context, sourceRunID int64) (metasync.DLsiteSyncResult, bool, error) {
	var result metasync.DLsiteSyncResult
	err := s.db.QueryRowContext(ctx, `
		SELECT run.id, job.id
		FROM workflow_run AS run
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.workflow_code = 'metadata_sync'
			AND run.status = 'queued'
			AND job.worker_type = 'metadata_sync'
			AND job.status = 'queued'
		ORDER BY run.id ASC
		LIMIT 1
	`).Scan(&result.RunID, &result.JobID)
	if err == nil {
		result.Status = "queued"
		result.ReviewCandidates = []metasync.DLsiteReviewCandidate{}
		result.Failures = []string{}
		return result, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return metasync.DLsiteSyncResult{}, false, err
	}
	result, err = s.enqueueDLsiteMetadataSyncWithInput(ctx, "follow_up", "local_scan_follow_up", 0, metadataSyncRunInput{SourceRunID: sourceRunID})
	return result, false, err
}

func (s *Server) enqueueDLsiteMetadataSyncWithInput(ctx context.Context, triggerType string, triggerReason string, triggerID int64, input metadataSyncRunInput) (metasync.DLsiteSyncResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return metasync.DLsiteSyncResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "metadata_sync", "Sync work metadata", "Select works and sync normalized metadata snapshots.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_works", "displayName": "Select works"},
			{"id": "sync", "type": "sync_metadata", "displayName": "Sync metadata"},
		},
	})
	if err != nil {
		return metasync.DLsiteSyncResult{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "metadata_sync", "Sync work metadata", "queued", triggerType, triggerReason, input, map[string]any{})
	if err != nil {
		return metasync.DLsiteSyncResult{}, err
	}
	if triggerID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", triggerID, runID); err != nil {
			return metasync.DLsiteSyncResult{}, err
		}
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_works", DisplayName: "Select works", Position: 1, Status: "queued",
	})
	if err != nil {
		return metasync.DLsiteSyncResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_metadata", DisplayName: "Sync metadata", Position: 2, Status: "queued",
	}); err != nil {
		return metasync.DLsiteSyncResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: "metadata_sync", Status: "queued",
		Priority: workflowJobPriorityForTrigger(triggerType), ResourceKey: "metadata:provider",
		Payload: input, Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3,
	})
	if err != nil {
		return metasync.DLsiteSyncResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return metasync.DLsiteSyncResult{}, err
	}
	return metasync.DLsiteSyncResult{RunID: runID, JobID: jobID, Status: "queued", ReviewCandidates: []metasync.DLsiteReviewCandidate{}, Failures: []string{}}, nil
}

func (s *Server) executeDLsiteMetadataSyncJob(ctx context.Context, job workflowJobRecord) error {
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if _, err := s.db.ExecContext(ctx, `UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?`, nodeIDs["sync"]); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing", map[string]any{"provider": "dlsite"}, 0, 0)
	result, runErr := s.newDLsiteMetadataSyncer(ctx).SyncAllWithoutWorkflow(ctx)
	if runErr == nil {
		runErr = s.syncPartiesFromDLsiteSnapshots(ctx)
	}
	if result.Status == "" {
		result.Status = "succeeded"
	}
	if runErr != nil {
		result.Status = "failed"
		result.Failures = append(result.Failures, runErr.Error())
	}
	if err := s.finishQueuedDLsiteMetadataSyncJob(ctx, job, nodeIDs, result); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	return runErr
}

func (s *Server) finishQueuedDLsiteMetadataSyncJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, result metasync.DLsiteSyncResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	summary := map[string]any{
		"target_works": result.TargetWorks, "synced_works": result.SyncedWorks,
		"skipped_works": result.SkippedWorks, "failed_works": result.FailedWorks,
		"unavailable_works": result.UnavailableWorks, "review_works": len(result.ReviewCandidates),
		"review_candidates": result.ReviewCandidates, "failures": result.Failures,
	}
	errorMessage := strings.Join(result.Failures, "\n")
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(map[string]any{"target_works": result.TargetWorks}), nodeIDs["select"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = ?, input_json = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, result.Status, mustJSON(map[string]any{"target_works": result.TargetWorks}), mustJSON(summary), errorMessage, nodeIDs["sync"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.SyncedWorks, result.TargetWorks, errorMessage,
		mustJSON(map[string]any{"phase": "completed", "detail": summary, "progressCurrent": result.SyncedWorks, "progressTotal": result.TargetWorks}), job.ID); err != nil {
		return err
	}
	if err := insertDLsiteReviewCandidates(ctx, tx, job.RunID, nodeIDs["sync"], result.ReviewCandidates); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, result.Status, mustJSON(summary), job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: nodeIDs["sync"], JobID: job.ID, Level: eventLevelForWorkflowStatus(result.Status),
		Type: "metadata_sync.completed", Message: "Metadata sync " + result.Status, Detail: summary,
	}); err != nil {
		return err
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, result.Status, result.Failures); err != nil {
		return err
	}
	return tx.Commit()
}

func insertDLsiteReviewCandidates(ctx context.Context, tx *sql.Tx, runID int64, nodeRunID int64, candidates []metasync.DLsiteReviewCandidate) error {
	for _, candidate := range candidates {
		payload := map[string]any{
			"work_id": candidate.WorkID, "code": candidate.Code, "provider": "dlsite",
			"reason": candidate.Reason, "message": candidate.Message,
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workflow_candidate (workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json)
			VALUES (?, ?, 'dlsite_unavailable_work', ?, 'pending', ?)
		`, runID, nodeRunID, candidate.Code, mustJSON(payload)); err != nil {
			return err
		}
	}
	return nil
}

func updateTriggerForQueuedSystemRun(ctx context.Context, tx *sql.Tx, runID int64, status string, failures []string) error {
	if status == "succeeded" {
		_, err := tx.ExecContext(ctx, `
			UPDATE workflow_trigger SET last_success_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP
			WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
		`, runID)
		return err
	}
	message := strings.Join(failures, "; ")
	if message == "" {
		message = "workflow completed with status " + status
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = (SELECT trigger_id FROM workflow_run WHERE id = ?)
	`, message, runID)
	return err
}

func eventLevelForWorkflowStatus(status string) string {
	switch status {
	case "failed":
		return "error"
	case "partial":
		return "warn"
	default:
		return "info"
	}
}
