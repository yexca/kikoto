package httpapi

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type localScanJobPayload struct {
	Root      string `json:"root"`
	ScanDepth int    `json:"scan_depth"`
}

func (s *Server) enqueueLocalScan(ctx context.Context, triggerType string, triggerReason string) (localScanResult, error) {
	return s.enqueueLocalScanWithTrigger(ctx, triggerType, triggerReason, 0)
}

func (s *Server) enqueueLocalScanWithTrigger(ctx context.Context, triggerType string, triggerReason string, triggerID int64) (localScanResult, error) {
	scanDepth := s.configuredLocalScanDepth(ctx)
	payload := localScanJobPayload{Root: s.cfg.DataRoot, ScanDepth: scanDepth}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return localScanResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	definitionID, err := workflow.EnsureDefinition(ctx, tx, "local_library_scan", "Scan local library", "Discover local works, sync local source presence, and synchronize missing metadata.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_local_source", "displayName": "Select local source"},
			{"id": "discover", "type": "discover_local_files", "displayName": "Discover files"},
			{"id": "match", "type": "match_works", "displayName": "Match works"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Sync locations"},
			{"id": "metadata", "type": "sync_metadata", "displayName": "Sync metadata"},
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
		{NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Sync metadata", Position: 5, Status: "queued"},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return localScanResult{}, err
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: discoverNodeID, WorkerType: "local_library_scan", Status: "queued",
		Priority: workflowJobPriorityForTrigger(triggerType), ResourceKey: "metadata:provider", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3,
	})
	if err != nil {
		return localScanResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return localScanResult{}, err
	}
	return localScanResult{RunID: runID, JobID: jobID, Status: "queued", NewWorkCodes: []string{}, Failures: []string{}}, nil
}

func (s *Server) executeLocalScanJob(ctx context.Context, job workflowJobRecord) error {
	var payload localScanJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if payload.ScanDepth <= 0 {
		payload.ScanDepth = s.configuredLocalScanDepth(ctx)
	}
	if strings.TrimSpace(payload.Root) == "" {
		payload.Root = s.cfg.DataRoot
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "discovering", map[string]any{"root": payload.Root}, 0, 0)
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

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	defer func() { _ = tx.Rollback() }()
	rollbackAndFail := func(runErr error) error {
		_ = tx.Rollback()
		_ = s.failClaimedWorkflowJob(ctx, job, runErr.Error())
		return runErr
	}
	fileSourceID, err := s.upsertLocalFileSource(ctx, tx, payload.ScanDepth)
	if err != nil {
		return rollbackAndFail(err)
	}
	updatedLocations := 0
	skippedLocations := 0
	newWorkCodes := []string{}
	seenWorkIDs := map[int64]bool{}
	for _, folder := range workFolders {
		_, existedBefore := s.workIDForCode(ctx, folder.Code)
		workID, err := upsertDetectedWork(ctx, tx, folder)
		if err != nil {
			return rollbackAndFail(err)
		}
		if !existedBefore {
			newWorkCodes = append(newWorkCodes, folder.Code)
		}
		seenWorkIDs[workID] = true
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID: workID, FileSourceID: fileSourceID, PresenceType: "local",
			SourceURL: filepath.ToSlash(folder.RelPath), Availability: "available",
			RawJSON: mustJSON(map[string]any{
				"code": folder.Code, "title": folder.Title, "rel_path": filepath.ToSlash(folder.RelPath),
				"files": len(folder.Files), "file_tree_scanned": false,
			}),
		}); err != nil {
			return rollbackAndFail(err)
		}
	}
	missingLocations := 0
	if err := markMissingLocalPresence(ctx, tx, fileSourceID, seenWorkIDs); err != nil {
		return rollbackAndFail(err)
	}
	runSummary := map[string]any{
		"candidate_folders": scanSummary.CandidateFolders,
		"detected_works":    scanSummary.DetectedWorks,
		"scanned_files":     scanSummary.ScannedFiles,
		"ambiguous_folders": scanSummary.AmbiguousFolders,
		"duplicate_groups":  localDuplicateGroupSummaries(scanSummary.DuplicateGroups),
		"updated_locations": updatedLocations,
		"skipped_locations": skippedLocations,
		"missing_locations": missingLocations,
		"new_work_codes":    newWorkCodes,
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(map[string]any{
		"candidate_folders": scanSummary.CandidateFolders, "detected_works": scanSummary.DetectedWorks,
		"scanned_files": scanSummary.ScannedFiles, "ambiguous_folders": scanSummary.AmbiguousFolders,
		"skipped_locations": skippedLocations, "missing_locations": missingLocations,
	}), nodeIDs["discover"]); err != nil {
		return rollbackAndFail(err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', input_json = ?, output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(map[string]any{"detected_works": scanSummary.DetectedWorks}), mustJSON(map[string]any{
		"matched_works": scanSummary.DetectedWorks, "duplicate_groups": len(scanSummary.DuplicateGroups),
	}), nodeIDs["match"]); err != nil {
		return rollbackAndFail(err)
	}
	if err := insertLocalDuplicateCandidates(ctx, tx, job.RunID, scanSummary.DuplicateGroups); err != nil {
		return rollbackAndFail(err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'succeeded', input_json = ?, output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(map[string]any{"file_source_id": fileSourceID}), mustJSON(map[string]any{
		"updated_locations": updatedLocations, "skipped_locations": skippedLocations,
		"missing_locations": missingLocations, "new_work_codes": newWorkCodes,
	}), nodeIDs["sync"]); err != nil {
		return rollbackAndFail(err)
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?
	`, nodeIDs["metadata"]); err != nil {
		return rollbackAndFail(err)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET summary_json = ? WHERE id = ?", mustJSON(runSummary), job.RunID); err != nil {
		return rollbackAndFail(err)
	}
	if err := tx.Commit(); err != nil {
		return rollbackAndFail(err)
	}

	result := localScanResult{
		RunID: job.RunID, JobID: job.ID, FileSourceID: fileSourceID, Status: "succeeded",
		DetectedWorks: scanSummary.DetectedWorks, ScannedFiles: scanSummary.ScannedFiles,
		UpdatedLocations: updatedLocations, SkippedLocations: skippedLocations,
		NewWorkCodes: newWorkCodes, Failures: []string{},
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "metadata", map[string]any{"detected_works": result.DetectedWorks}, result.ScannedFiles, result.ScannedFiles)
	metadataResult, metadataErr := s.newDLsiteMetadataSyncer(ctx).SyncAllWithoutWorkflow(ctx)
	if metadataErr == nil {
		metadataErr = s.syncPartiesFromDLsiteSnapshots(ctx)
	}
	result.TargetWorks = metadataResult.TargetWorks
	result.SyncedWorks = metadataResult.SyncedWorks
	result.SkippedWorks = metadataResult.SkippedWorks
	result.FailedWorks = metadataResult.FailedWorks
	result.UnavailableWorks = metadataResult.UnavailableWorks
	result.Failures = append(result.Failures, metadataResult.Failures...)
	result.Status = metadataResult.Status
	if result.Status == "" {
		result.Status = "succeeded"
	}
	if metadataErr != nil {
		result.Status = "failed"
		result.Failures = append(result.Failures, metadataErr.Error())
	}
	if err := s.finishQueuedLocalScanJob(ctx, job, nodeIDs["metadata"], result, runSummary, metadataResult); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	return metadataErr
}

func (s *Server) finishQueuedLocalScanJob(ctx context.Context, job workflowJobRecord, metadataNodeID int64, result localScanResult, runSummary map[string]any, metadataResult metasync.DLsiteSyncResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	errorMessage := strings.Join(result.Failures, "\n")
	metadataOutput := map[string]any{
		"target_works": result.TargetWorks, "synced_works": result.SyncedWorks,
		"skipped_works": result.SkippedWorks, "failed_works": result.FailedWorks,
		"unavailable_works": result.UnavailableWorks, "review_works": len(metadataResult.ReviewCandidates),
		"review_candidates": metadataResult.ReviewCandidates, "failures": result.Failures,
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, result.Status, mustJSON(metadataOutput), errorMessage, metadataNodeID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.SyncedWorks, result.TargetWorks, errorMessage,
		mustJSON(map[string]any{"phase": "completed", "detail": metadataOutput, "progressCurrent": result.SyncedWorks, "progressTotal": result.TargetWorks}), job.ID); err != nil {
		return err
	}
	if err := insertDLsiteReviewCandidates(ctx, tx, job.RunID, metadataNodeID, metadataResult.ReviewCandidates); err != nil {
		return err
	}
	runSummary["target_works"] = result.TargetWorks
	runSummary["synced_works"] = result.SyncedWorks
	runSummary["skipped_works"] = result.SkippedWorks
	runSummary["failed_works"] = result.FailedWorks
	runSummary["unavailable_works"] = result.UnavailableWorks
	runSummary["failures"] = result.Failures
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, result.Status, mustJSON(runSummary), job.RunID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: metadataNodeID, JobID: job.ID, Level: eventLevelForWorkflowStatus(result.Status),
		Type: "local_library_scan.completed", Message: "Local library scan " + result.Status, Detail: runSummary,
	}); err != nil {
		return err
	}
	if err := updateTriggerForQueuedSystemRun(ctx, tx, job.RunID, result.Status, result.Failures); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) enqueueDLsiteMetadataSync(ctx context.Context, triggerType string, triggerReason string) (metasync.DLsiteSyncResult, error) {
	return s.enqueueDLsiteMetadataSyncWithTrigger(ctx, triggerType, triggerReason, 0)
}

func (s *Server) enqueueDLsiteMetadataSyncWithTrigger(ctx context.Context, triggerType string, triggerReason string, triggerID int64) (metasync.DLsiteSyncResult, error) {
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
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "metadata_sync", "Sync work metadata", "queued", triggerType, triggerReason, map[string]any{}, map[string]any{})
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
		Payload: map[string]any{}, Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3,
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
