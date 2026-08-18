package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

type knownLocalWorkRoot struct {
	WorkID int64
	Code   string
	Root   string
}

func (s *Server) executeIncrementalLocalScanJob(ctx context.Context, job workflowJobRecord, payload localScanJobPayload) error {
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "discovering", map[string]any{
		"root": payload.Root, "scan_mode": localScanModeIncremental, "changed_path_count": len(payload.ChangedPaths),
	}, 0, 0)

	workFolders, scanSummary, err := localfs.DiscoverChangedFolders(
		payload.Root,
		localfs.Options{ScanDepth: payload.ScanDepth},
		payload.ChangedPaths,
	)
	if err != nil {
		payload.ScanMode = localScanModeFull
		payload.FullFallbackReason = "changed_path_resolution_failed"
		return s.executeFullLocalScanJob(ctx, job, payload)
	}
	knownRoots, err := s.loadKnownLocalWorkRoots(ctx)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if incrementalLocalScanNeedsFullFallback(payload.Root, payload.ChangedPaths, workFolders, scanSummary, knownRoots) {
		payload.ScanMode = localScanModeFull
		payload.FullFallbackReason = "duplicate_work_roots"
		return s.executeFullLocalScanJob(ctx, job, payload)
	}

	for index := range workFolders {
		files, collectErr := localfs.CollectWorkFiles(payload.Root, workFolders[index].AbsPath)
		if collectErr != nil {
			if errors.Is(collectErr, os.ErrNotExist) {
				payload.ScanMode = localScanModeFull
				payload.FullFallbackReason = "work_root_changed_during_scan"
				return s.executeFullLocalScanJob(ctx, job, payload)
			}
			_ = s.failClaimedWorkflowJob(ctx, job, collectErr.Error())
			return collectErr
		}
		workFolders[index].Files = files
		scanSummary.ScannedFiles += len(files)
	}

	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, runSummary, fileSourceID, err := s.persistIncrementalLocalScanResults(
		ctx, job, payload, workFolders, scanSummary, knownRoots, nodeIDs,
	)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "finishing", map[string]any{
		"detected_works": result.DetectedWorks, "scan_mode": localScanModeIncremental,
	}, result.ScannedFiles, result.ScannedFiles)
	if err := s.finishQueuedLocalScanJob(ctx, job, nodeIDs["sync"], result, runSummary); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	files := make([]localfs.LocalFile, 0, scanSummary.ScannedFiles)
	for _, folder := range workFolders {
		files = append(files, folder.Files...)
	}
	if len(files) > 0 {
		go func() {
			s.localDurationProbeMu.Lock()
			defer s.localDurationProbeMu.Unlock()
			s.probeLocalDurationsForFiles(context.Background(), fileSourceID, files)
		}()
	}
	return nil
}

func (s *Server) loadKnownLocalWorkRoots(ctx context.Context) ([]knownLocalWorkRoot, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT presence.work_id, work.primary_code, presence.source_url
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE source.code = 'main_local_library' AND presence.presence_type = 'local'
		UNION ALL
		SELECT folder.work_id, work.primary_code, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN work ON work.id = folder.work_id
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE source.code = 'main_local_library' AND folder.state = 'active'
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []knownLocalWorkRoot{}
	seen := map[string]bool{}
	for rows.Next() {
		var item knownLocalWorkRoot
		if err := rows.Scan(&item.WorkID, &item.Code, &item.Root); err != nil {
			return nil, err
		}
		item.Code = strings.ToUpper(strings.TrimSpace(item.Code))
		item.Root = normalizeFolderRootPath(item.Root)
		if item.WorkID <= 0 || item.Code == "" || item.Root == "" {
			continue
		}
		key := strings.ToLower(item.Root) + ":" + item.Code
		if !seen[key] {
			seen[key] = true
			result = append(result, item)
		}
	}
	return result, rows.Err()
}

func incrementalLocalScanNeedsFullFallback(root string, changedPaths []string, folders []localfs.WorkFolder, summary localfs.Summary, knownRoots []knownLocalWorkRoot) bool {
	if len(summary.DuplicateGroups) > 0 {
		return true
	}
	for _, affected := range knownRoots {
		if !localRootAffectedByChanges(affected.Root, changedPaths) {
			continue
		}
		for _, known := range knownRoots {
			if !strings.EqualFold(affected.Code, known.Code) || sameLocalRelativePath(affected.Root, known.Root) {
				continue
			}
			if knownLocalWorkRootExists(root, known) {
				return true
			}
		}
	}
	for _, folder := range folders {
		for _, known := range knownRoots {
			if !strings.EqualFold(folder.Code, known.Code) || sameLocalRelativePath(folder.RelPath, known.Root) {
				continue
			}
			if localRootAffectedByChanges(known.Root, changedPaths) {
				continue
			}
			if knownLocalWorkRootExists(root, known) {
				return true
			}
		}
	}
	return false
}

func (s *Server) persistIncrementalLocalScanResults(
	ctx context.Context,
	job workflowJobRecord,
	payload localScanJobPayload,
	workFolders []localfs.WorkFolder,
	scanSummary localfs.Summary,
	knownRoots []knownLocalWorkRoot,
	nodeIDs map[string]int64,
) (localScanResult, map[string]any, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return localScanResult{}, nil, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	fileSourceID, err := s.upsertLocalFileSource(ctx, tx, payload.ScanDepth)
	if err != nil {
		return localScanResult{}, nil, 0, err
	}
	state := localScanPersistState{
		duplicateCodes: map[string]bool{}, seenWorkIDs: map[int64]bool{}, reconciledWorkIDs: map[int64]bool{},
	}
	affectedWorkIDs := map[int64]bool{}
	seenRoots := map[string]bool{}
	for _, known := range knownRoots {
		if localRootAffectedByChanges(known.Root, payload.ChangedPaths) {
			affectedWorkIDs[known.WorkID] = true
		}
	}
	for _, folder := range workFolders {
		seenRoots[strings.ToLower(normalizeFolderRootPath(folder.RelPath))] = true
		for _, known := range knownRoots {
			if strings.EqualFold(folder.Code, known.Code) {
				if sameLocalRelativePath(folder.RelPath, known.Root) || !localWorkRootExists(payload.Root, known.Root) {
					affectedWorkIDs[known.WorkID] = true
				}
			}
		}
		workID, err := s.persistLocalScanFolder(ctx, tx, fileSourceID, folder, &state)
		if err != nil {
			return localScanResult{}, nil, 0, err
		}
		affectedWorkIDs[workID] = true
		for _, file := range folder.Files {
			exists, err := localLocationExists(ctx, tx, fileSourceID, file)
			if err != nil {
				return localScanResult{}, nil, 0, err
			}
			if exists {
				state.skippedLocations++
			} else {
				state.updatedLocations++
			}
		}
		seenPaths, err := persistIndexedLocalFiles(ctx, tx, workID, fileSourceID, folder)
		if err != nil {
			return localScanResult{}, nil, 0, err
		}
		missing, err := markMissingLocalLocationsForWork(ctx, tx, workID, fileSourceID, seenPaths)
		if err != nil {
			return localScanResult{}, nil, 0, err
		}
		state.missingLocations += missing
		if err := updateIncrementalLocalPresence(ctx, tx, workID, fileSourceID, folder); err != nil {
			return localScanResult{}, nil, 0, err
		}
	}
	for _, known := range knownRoots {
		if !localRootAffectedByChanges(known.Root, payload.ChangedPaths) || seenRoots[strings.ToLower(known.Root)] {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_folder_location
			SET state = 'missing', is_primary = 0, updated_at = CURRENT_TIMESTAMP
			WHERE work_id = ? AND file_source_id = ? AND root_path = ?
				AND role != 'managed_fetch' AND state = 'active'
		`, known.WorkID, fileSourceID, known.Root); err != nil {
			return localScanResult{}, nil, 0, err
		}
	}
	for workID := range affectedWorkIDs {
		if state.seenWorkIDs[workID] {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_source_presence
			SET availability = 'missing', last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
			WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
		`, workID, fileSourceID); err != nil {
			return localScanResult{}, nil, 0, err
		}
		missing, err := markAvailableLocalLocationsMissingForWork(ctx, tx, workID, fileSourceID)
		if err != nil {
			return localScanResult{}, nil, 0, err
		}
		state.missingLocations += missing
	}
	runSummary := map[string]any{
		"candidate_folders": scanSummary.CandidateFolders, "detected_works": scanSummary.DetectedWorks,
		"scanned_files": scanSummary.ScannedFiles, "ambiguous_folders": scanSummary.AmbiguousFolders,
		"duplicate_groups":  localDuplicateGroupSummaries(scanSummary.DuplicateGroups),
		"updated_locations": state.updatedLocations, "skipped_locations": state.skippedLocations,
		"missing_locations": state.missingLocations, "new_work_codes": state.newWorkCodes,
		"follow_up_requested": false, "scan_mode": localScanModeIncremental,
		"changed_path_count": len(payload.ChangedPaths), "affected_works": len(affectedWorkIDs),
	}
	if err := completeLocalScanNodes(ctx, tx, nodeIDs, fileSourceID, scanSummary, state); err != nil {
		return localScanResult{}, nil, 0, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET summary_json = ? WHERE id = ?", mustJSON(runSummary), job.RunID); err != nil {
		return localScanResult{}, nil, 0, err
	}
	if err := tx.Commit(); err != nil {
		return localScanResult{}, nil, 0, err
	}
	return localScanResult{
		RunID: job.RunID, JobID: job.ID, FileSourceID: fileSourceID, Status: "succeeded",
		DetectedWorks: scanSummary.DetectedWorks, ScannedFiles: scanSummary.ScannedFiles,
		UpdatedLocations: state.updatedLocations, SkippedLocations: state.skippedLocations,
		NewWorkCodes: state.newWorkCodes, Failures: []string{},
	}, runSummary, fileSourceID, nil
}

func updateIncrementalLocalPresence(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, folder localfs.WorkFolder) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET raw_json = ?, last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
	`, mustJSON(map[string]any{
		"code": folder.Code, "title": folder.Title, "rel_path": filepath.ToSlash(folder.RelPath),
		"files": len(folder.Files), "file_tree_scanned": true,
		"file_tree_scanned_at": formatWorkflowTimestamp(time.Now().UTC()),
	}), workID, fileSourceID)
	return err
}

func localRootAffectedByChanges(root string, changedPaths []string) bool {
	for _, changedPath := range changedPaths {
		if localRelativePathsOverlap(root, changedPath) {
			return true
		}
	}
	return false
}

func localRelativePathsOverlap(left, right string) bool {
	left = strings.ToLower(normalizeFolderRootPath(left))
	right = strings.ToLower(normalizeFolderRootPath(right))
	if left == "" || right == "" {
		return false
	}
	return left == right || strings.HasPrefix(left, right+"/") || strings.HasPrefix(right, left+"/")
}

func sameLocalRelativePath(left, right string) bool {
	return strings.EqualFold(normalizeFolderRootPath(left), normalizeFolderRootPath(right))
}

func localWorkRootExists(root, rel string) bool {
	info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(normalizeFolderRootPath(rel))))
	return err == nil && info.IsDir()
}

func knownLocalWorkRootExists(root string, known knownLocalWorkRoot) bool {
	knownPath := filepath.Join(root, filepath.FromSlash(known.Root))
	if !localWorkRootExists(root, known.Root) {
		return false
	}
	code, _ := localfs.ExtractWorkCode(filepath.Base(knownPath))
	return strings.EqualFold(code, known.Code)
}
