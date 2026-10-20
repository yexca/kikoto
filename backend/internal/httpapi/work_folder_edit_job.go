package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

type workFolderEditJobPayload struct {
	ActorUserID     int64                `json:"actor_user_id,omitempty"`
	WorkID          int64                `json:"work_id"`
	WorkCode        string               `json:"work_code"`
	FolderID        int64                `json:"folder_id"`
	FileSourceID    int64                `json:"file_source_id"`
	TargetRoot      string               `json:"target_root"`
	TransactionPool string               `json:"transaction_pool,omitempty"`
	Items           []workFolderEditItem `json:"items"`
	Removals        []mediaCleanupTarget `json:"removals"`
	// RemovalFiles are the removed files as the plan saw them on disk.
	RemovalFiles []workFolderEditRemoval `json:"removal_files,omitempty"`
	Moves        []workFolderEditMove    `json:"moves,omitempty"`
	// Folders are the folders to create, as library paths.
	Folders []string `json:"folders,omitempty"`
	// Merges are deleted once the folder is indexed, with the files each held
	// when the edit was planned.
	Merges []workFolderEditMerge `json:"merges,omitempty"`
	// Assignments are stored once the folder is indexed.
	Assignments []workFolderEditAssignment `json:"assignments,omitempty"`
	RequestID   string                     `json:"request_id"`
	// Summary is the summary of the plan the edit was queued with.
	Summary *workFolderEditSummary `json:"summary,omitempty"`
}

// workFolderEditCheckpoint records what already happened, so a resumed or
// retried job neither repeats a download nor removes or publishes twice.
type workFolderEditCheckpoint struct {
	Staged    []string `json:"staged"`
	Removed   []string `json:"removed"`
	Published []string `json:"published"`
	// Lifted and Placed record moved files, by location, that left their
	// place for the staging folder and that reached their new path.
	Lifted []int64 `json:"lifted,omitempty"`
	Placed []int64 `json:"placed,omitempty"`
	// Arranged is set once moved files keep their identity, emptied folders
	// are gone, and requested folders exist.
	Arranged bool    `json:"arranged,omitempty"`
	Merged   []int64 `json:"merged,omitempty"`
	Deleted  int     `json:"deleted"`
}

// workFolderEditPermissions is what starting the edit requires, so a retry
// never does more than its actor could start directly.
func workFolderEditPermissions(payload workFolderEditJobPayload) []string {
	permissions := []string{"downloads:manage"}
	for _, item := range payload.Items {
		if item.SourceKind == "remote" && workFolderEditItemAdds(item) {
			permissions = append(permissions, "remote:fetch")
			break
		}
	}
	if len(payload.Assignments) > 0 {
		permissions = append(permissions, "library:write")
	}
	return permissions
}

func workFolderEditItemAdds(item workFolderEditItem) bool {
	return item.Action == "copy_local" || item.Action == "cache_download"
}

// workFolderEditProgressTotal counts one step to collect and one to publish
// each added file, one for each removed or moved file, and one for each file
// a merged folder deletes.
func workFolderEditProgressTotal(payload workFolderEditJobPayload) int {
	total := len(payload.Removals) + len(payload.Moves)
	for _, merge := range payload.Merges {
		total += merge.FileCount
	}
	for _, item := range payload.Items {
		if workFolderEditItemAdds(item) {
			total += 2
		}
	}
	return total
}

type workFolderEditExecution struct {
	server     *Server
	job        workflowJobRecord
	payload    workFolderEditJobPayload
	checkpoint workFolderEditCheckpoint
	nodes      map[string]int64
	stagingAbs string
	targetAbs  string
	progress   int
	total      int
	assigned   int
	// node is the step an error belongs to.
	node string
}

func (s *Server) executeWorkFolderEditJob(ctx context.Context, job workflowJobRecord) error {
	execution := &workFolderEditExecution{server: s, job: job, node: "stage"}
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &execution.payload); err != nil {
		_ = s.failClaimedWorkflowJob(context.WithoutCancel(ctx), job, err.Error())
		return err
	}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &execution.checkpoint); err != nil {
		_ = s.failClaimedWorkflowJob(context.WithoutCancel(ctx), job, err.Error())
		return err
	}
	execution.total = workFolderEditProgressTotal(execution.payload)
	err := execution.run(ctx)
	if err == nil {
		slog.Info("work folder edit completed", "run_id", job.RunID, "job_id", job.ID, "work_code", execution.payload.WorkCode)
		return nil
	}
	return execution.fail(ctx, err)
}

// locate finds the edited folder, which must be online, and the run's staging
// folder on its pool.
func (e *workFolderEditExecution) locate(ctx context.Context) error {
	s := e.server
	if err := s.ensureLibraryPathOnline(ctx, e.payload.TargetRoot); err != nil {
		return err
	}
	targetAbs, err := safeDataPath(s.cfg.DataRoot, e.payload.TargetRoot)
	if err != nil {
		return err
	}
	if info, err := os.Lstat(targetAbs); err != nil || !info.IsDir() || unsafeFetchStagingEntry(info) {
		return errors.New("the edited folder is no longer available")
	}
	e.targetAbs = targetAbs
	stagingAbs, err := safeDataPath(s.cfg.DataRoot, workFolderEditStagingRoot(e.payload.TransactionPool, e.job.RunID))
	if err != nil {
		return err
	}
	// A link at .kikoto-staging, or below it, would carry the staged files,
	// and their removal, outside the pool.
	if _, err := validateFetchStagingPath(s.cfg.DataRoot, stagingAbs); err != nil {
		return fmt.Errorf("edit staging: %w", err)
	}
	e.stagingAbs = stagingAbs
	return nil
}

// settleCancelledWorkFolderEdit puts back what a cancelled edit lifted and
// deletes what it collected when no executor was working on it, such as an
// edit waiting for a retry, for recovery after a restart, or for the library
// folders. It first waits, until ctx ends, for any job that is changing
// library folders. The folders the edit merges are folders of the work again,
// also while its folder is offline; an offline folder, or a wait that ctx
// ended, leaves the edit for settleCancelledWorkFolderEdits at a later start.
func (s *Server) settleCancelledWorkFolderEdit(ctx context.Context, runID int64) {
	if err := s.mediaCleanupMu.LockContext(ctx); err != nil {
		return
	}
	defer s.mediaCleanupMu.Unlock()
	// A settlement that started finishes, so a stop never leaves it between
	// moved files.
	ctx = context.WithoutCancel(ctx)
	defer func() { _ = s.restoreMediaCleanupFolders(ctx, runID) }()
	execution := &workFolderEditExecution{server: s}
	err := s.db.QueryRowContext(ctx, `
		SELECT id, workflow_run_id, payload_json, checkpoint_json FROM workflow_job
		WHERE workflow_run_id = ? AND worker_type = ? ORDER BY id DESC LIMIT 1
	`, runID, workFolderEditWorkerType).Scan(&execution.job.ID, &execution.job.RunID, &execution.job.PayloadJSON, &execution.job.CheckpointJSON)
	if err == nil {
		err = decodeWorkflowJobPayload(execution.job.PayloadJSON, &execution.payload)
	}
	if err == nil {
		err = decodeWorkflowJobCheckpointDetail(execution.job.CheckpointJSON, &execution.checkpoint)
	}
	if err == nil {
		execution.total = workFolderEditProgressTotal(execution.payload)
		err = execution.locate(ctx)
	}
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			slog.Error("settle cancelled work folder edit", "run_id", runID, "error", err)
		}
		return
	}
	if kept := execution.discardStaging(ctx); kept > 0 {
		slog.Error("cancelled work folder edit keeps moved files in staging", "run_id", runID, "files", kept)
	}
}

// settleCancelledWorkFolderEdits runs at startup and settles each cancelled
// edit that still has its staging folder or a merged folder it claimed, such
// as one whose settlement a stop interrupted or whose folder was offline.
func (s *Server) settleCancelledWorkFolderEdits(ctx context.Context) {
	runIDs, err := s.unsettledCancelledWorkFolderEdits(ctx)
	if err != nil {
		slog.Error("find unsettled cancelled work folder edits", "error", err)
		return
	}
	for _, runID := range runIDs {
		if ctx.Err() != nil {
			return
		}
		s.settleCancelledWorkFolderEdit(ctx, runID)
	}
}

func (s *Server) unsettledCancelledWorkFolderEdits(ctx context.Context) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT job.workflow_run_id, job.payload_json,
			EXISTS (SELECT 1 FROM work_folder_location AS folder
				WHERE folder.cleanup_run_id = job.workflow_run_id AND folder.state = 'pending_cleanup')
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.worker_type = ? AND run.status = 'cancelled'
			AND job.id = (SELECT MAX(latest.id) FROM workflow_job AS latest
				WHERE latest.workflow_run_id = job.workflow_run_id AND latest.worker_type = job.worker_type)
		ORDER BY job.workflow_run_id
	`, workFolderEditWorkerType)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	var runIDs []int64
	for rows.Next() {
		var runID int64
		var payloadJSON string
		var claimsFolders bool
		if err := rows.Scan(&runID, &payloadJSON, &claimsFolders); err != nil {
			return nil, err
		}
		if claimsFolders || s.workFolderEditStagingExists(runID, payloadJSON) {
			runIDs = append(runIDs, runID)
		}
	}
	return runIDs, rows.Err()
}

func (s *Server) workFolderEditStagingExists(runID int64, payloadJSON string) bool {
	var payload workFolderEditJobPayload
	if err := decodeWorkflowJobPayload(payloadJSON, &payload); err != nil {
		return false
	}
	stagingAbs, err := safeDataPath(s.cfg.DataRoot, workFolderEditStagingRoot(payload.TransactionPool, runID))
	if err != nil {
		return false
	}
	_, err = os.Lstat(stagingAbs)
	return err == nil
}

func (e *workFolderEditExecution) run(ctx context.Context) error {
	s := e.server
	nodes, err := workflowNodeIDsByNodeID(ctx, s.db, e.job.RunID)
	if err != nil {
		return err
	}
	e.nodes = nodes
	if err := e.locate(ctx); err != nil {
		return err
	}
	if err := e.stage(ctx); err != nil {
		return err
	}
	e.node = "remove"
	if err := e.remove(ctx); err != nil {
		return err
	}
	e.node = "publish"
	if err := e.publish(ctx); err != nil {
		return err
	}
	e.node = "index"
	if err := s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "index", "running", nil); err != nil {
		return err
	}
	if err := e.index(ctx); err != nil {
		return err
	}
	assigned, err := s.declareWorkFolderEditAssignments(ctx, e.payload)
	if err != nil {
		return err
	}
	e.assigned = assigned
	e.node = "merge"
	if err := e.mergeFolders(ctx); err != nil {
		return err
	}
	return e.finish(ctx)
}

// index reads the edited folder into the library. A pool that went offline
// since the edit started shows an empty mount point, which would mark every
// file of the folder missing, so the pool must still be online.
func (e *workFolderEditExecution) index(ctx context.Context) error {
	if err := e.server.ensureLibraryPathOnline(ctx, e.payload.TargetRoot); err != nil {
		return err
	}
	return e.server.indexLocalMediaForWork(ctx, e.payload.WorkID, e.payload.FileSourceID, e.payload.TargetRoot)
}

func (e *workFolderEditExecution) stagedPath(index int) string {
	return filepath.Join(e.stagingAbs, fmt.Sprintf("%06d", index))
}

func (e *workFolderEditExecution) saveCheckpoint(ctx context.Context, phase string) error {
	return e.server.updateWorkflowJobCheckpoint(ctx, e.job.ID, phase, e.checkpoint, e.progress, e.total)
}

// stage collects every added file on the edited folder's storage pool and
// checks its size, before anything in the folder changes. A file an earlier
// attempt already published is in the folder, and its source may be gone
// with a merged folder, so it is not collected again.
func (e *workFolderEditExecution) stage(ctx context.Context) error {
	s := e.server
	if err := s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "stage", "running", nil); err != nil {
		return err
	}
	staged := stringSet(e.checkpoint.Staged)
	published := stringSet(e.checkpoint.Published)
	family, err := s.lyricsAssignmentFamily(ctx, e.payload.WorkID)
	if err != nil {
		return err
	}
	downloads := workFolderEditBaseItems(e.payload.Items)
	var byteProgress *remoteFetchByteProgress
	if len(downloads) > 0 {
		if byteProgress, err = newRemoteFetchByteProgress(ctx, s, e.job.ID, e.nodes["stage"], downloads); err != nil {
			return err
		}
	}
	localFolders := map[int64]workFolderEditFolder{}
	remoteTrees := map[string]workFolderEditRemoteTree{}
	downloadLimit := s.remoteMediaDownloadLimitBytes(ctx)
	downloadIndex := 0
	count := 0
	for index, item := range e.payload.Items {
		if !workFolderEditItemAdds(item) {
			continue
		}
		if err := s.ensureWorkflowRunActive(ctx, e.job.RunID); err != nil {
			return err
		}
		count++
		stagedPath := e.stagedPath(index)
		if published[item.ItemKey] || (staged[item.ItemKey] && existingFileMatches(stagedPath, item.SizeBytes)) {
			if item.Action == "cache_download" {
				if err := byteProgress.skipDownload(downloadIndex, item.remoteWorkSavePlanItem); err != nil {
					return err
				}
				downloadIndex++
			}
			e.progress = count
			continue
		}
		if err := os.MkdirAll(e.stagingAbs, 0o755); err != nil {
			return err
		}
		if err := os.Remove(stagedPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if item.Action == "copy_local" {
			folder, ok := localFolders[item.SourceFolderID]
			if !ok {
				if folder, err = s.workFolderEditFolder(ctx, family, item.SourceFolderID); err != nil {
					return err
				}
				localFolders[item.SourceFolderID] = folder
			}
			size, err := localFolderFileSize(folder.Absolute, item.Path)
			if err != nil {
				return err
			}
			if item.SizeBytes != nil && size != *item.SizeBytes {
				return fmt.Errorf("%s changed after the edit was planned", item.Path)
			}
			if err := copyFile(filepath.Join(folder.Absolute, filepath.FromSlash(item.Path)), stagedPath); err != nil {
				return err
			}
		} else {
			treeKey := fmt.Sprintf("%d:%s", item.RemoteSourceID, item.RemoteCode)
			tree, ok := remoteTrees[treeKey]
			if !ok {
				if tree, err = s.workFolderEditRemoteTree(ctx, family, item.RemoteSourceID, item.RemoteCode); err != nil {
					return err
				}
				remoteTrees[treeKey] = tree
			}
			file, ok := tree.files[cleanRemoteRelativePath(item.RemotePath)]
			if !ok {
				return fmt.Errorf("%s is no longer offered by the remote edition", item.Path)
			}
			if err := byteProgress.begin(downloadIndex, item.remoteWorkSavePlanItem); err != nil {
				return err
			}
			currentIndex := downloadIndex
			written, err := s.downloadToFile(ctx, tree.source, firstNonEmpty(file.DownloadURL, file.StreamURL), stagedPath, remoteDownloadOptions{
				MaxBytes:      downloadLimit,
				ExpectedBytes: item.SizeBytes,
				OnProgress: func(written int64) {
					byteProgress.report(currentIndex, item.remoteWorkSavePlanItem, written)
				},
			})
			if err != nil {
				byteProgress.abort(downloadIndex, item.remoteWorkSavePlanItem)
				_ = os.Remove(stagedPath)
				return err
			}
			downloadIndex++
			if err := byteProgress.complete(downloadIndex, item.remoteWorkSavePlanItem, written); err != nil {
				return err
			}
		}
		info, err := os.Lstat(stagedPath)
		if err != nil {
			return err
		}
		if item.SizeBytes != nil && info.Size() != *item.SizeBytes {
			_ = os.Remove(stagedPath)
			return fmt.Errorf("collected size mismatch for %s: got %d, want %d", item.Path, info.Size(), *item.SizeBytes)
		}
		staged[item.ItemKey] = true
		e.checkpoint.Staged = append(e.checkpoint.Staged, item.ItemKey)
		e.progress = count
		if err := e.saveCheckpoint(ctx, "stage"); err != nil {
			return err
		}
	}
	e.progress = count
	return s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "stage", "succeeded", map[string]any{"collected": count})
}

// remove deletes the files taken out of the folder. It runs after every added
// file is collected, so a failed download removes nothing, and it deletes a
// file only while it is the version the plan saw.
func (e *workFolderEditExecution) remove(ctx context.Context) error {
	s := e.server
	if err := s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "remove", "running", nil); err != nil {
		return err
	}
	planned := map[int64]workFolderEditRemoval{}
	for _, file := range e.payload.RemovalFiles {
		planned[file.LocationID] = file
	}
	removed := stringSet(e.checkpoint.Removed)
	base := e.progress
	for index, target := range e.payload.Removals {
		key := mediaCleanupTargetKey(target)
		if removed[key] {
			e.progress = base + index + 1
			continue
		}
		if err := s.ensureWorkflowRunActive(ctx, e.job.RunID); err != nil {
			return err
		}
		if target.Kind != "local" || normalizeFolderRootPath(target.Path) == normalizeFolderRootPath(e.payload.TargetRoot) ||
			!mediaCleanupPathWithinRoot(e.payload.TargetRoot, target.Path) {
			return fmt.Errorf("refusing to remove a file outside the edited folder")
		}
		if file, ok := planned[target.LocationID]; ok {
			if err := s.checkWorkFolderEditRemoval(file); err != nil {
				return err
			}
		}
		// A removal that started is recorded even if the service stops next.
		statusCtx := context.WithoutCancel(ctx)
		deleted, err := s.clearLocalMediaLocation(statusCtx, target.LocationID, target.Path)
		if err != nil {
			return err
		}
		if deleted {
			e.checkpoint.Deleted++
		}
		removed[key] = true
		e.checkpoint.Removed = append(e.checkpoint.Removed, key)
		e.progress = base + index + 1
		if err := e.saveCheckpoint(statusCtx, "remove"); err != nil {
			return err
		}
	}
	e.progress = base + len(e.payload.Removals)
	return s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "remove", "succeeded", map[string]any{
		"locations": len(e.payload.Removals), "deleted": e.checkpoint.Deleted,
	})
}

// checkWorkFolderEditRemoval refuses to remove a file that changed since the
// edit was planned, or that appeared where the plan saw none, such as a file
// a Fetch published there meanwhile. A file already gone needs no deletion.
func (s *Server) checkWorkFolderEditRemoval(file workFolderEditRemoval) error {
	absolute, err := safeDataPath(s.cfg.DataRoot, file.Path)
	if err != nil {
		return err
	}
	info, err := os.Lstat(absolute)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if file.Version == "" || localfs.FileVersion(info) != file.Version {
		return fmt.Errorf("%s changed after the edit was planned; review the edit again", file.Path)
	}
	return nil
}

// publish moves each collected file into the folder. A move is a rename on
// the folder's own filesystem, and it never lands on a file the plan did not
// decide to replace.
func (e *workFolderEditExecution) publish(ctx context.Context) error {
	s := e.server
	if err := s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "publish", "running", nil); err != nil {
		return err
	}
	// Every moved file leaves its place before any file takes a path, so
	// files can trade places and an added file can take a path a moved file
	// frees.
	if err := e.liftMoves(ctx); err != nil {
		return err
	}
	published := stringSet(e.checkpoint.Published)
	base := e.progress
	count := 0
	lyricsRootReady := false
	for index, item := range e.payload.Items {
		if !workFolderEditItemAdds(item) {
			continue
		}
		count++
		if published[item.ItemKey] {
			e.progress = base + count
			continue
		}
		if err := s.ensureWorkflowRunActive(ctx, e.job.RunID); err != nil {
			return err
		}
		if item.Language != nil && !lyricsRootReady {
			// Kikoto creates and marks its lyrics folder, and never writes
			// lyrics into a folder of that name it did not create.
			if err := ensureLyricsRoot(e.targetAbs); err != nil {
				return err
			}
			lyricsRootReady = true
		}
		statusCtx := context.WithoutCancel(ctx)
		if err := e.publishItem(index, item); err != nil {
			return err
		}
		published[item.ItemKey] = true
		e.checkpoint.Published = append(e.checkpoint.Published, item.ItemKey)
		e.progress = base + count
		if err := e.saveCheckpoint(statusCtx, "publish"); err != nil {
			return err
		}
	}
	e.progress = base + count
	if err := e.placeMoves(ctx); err != nil {
		return err
	}
	if err := e.arrange(ctx); err != nil {
		return err
	}
	return s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "publish", "succeeded", map[string]any{
		"published": count, "moved": len(e.checkpoint.Placed), "target_root": e.payload.TargetRoot,
	})
}

func (e *workFolderEditExecution) liftedPath(index int) string {
	return filepath.Join(e.stagingAbs, fmt.Sprintf("m%06d", index))
}

// liftMoves takes each moved file out of its place into the staging folder,
// which lies on the folder's own filesystem, so the move is a rename.
func (e *workFolderEditExecution) liftMoves(ctx context.Context) error {
	lifted := int64Set(e.checkpoint.Lifted)
	for index, move := range e.payload.Moves {
		if lifted[move.LocationID] {
			continue
		}
		if err := e.server.ensureWorkflowRunActive(ctx, e.job.RunID); err != nil {
			return err
		}
		source, err := safeDataPath(e.server.cfg.DataRoot, move.Path)
		if err != nil {
			return err
		}
		staged := e.liftedPath(index)
		info, err := os.Lstat(source)
		if errors.Is(err, os.ErrNotExist) && existingFileMatches(staged, move.SizeBytes) {
			// The rename finished before its checkpoint was written.
		} else if err != nil || !info.Mode().IsRegular() || (move.SizeBytes != nil && info.Size() != *move.SizeBytes) {
			return fmt.Errorf("%s changed after the edit was planned", move.Path)
		} else {
			if err := os.MkdirAll(e.stagingAbs, 0o755); err != nil {
				return err
			}
			if err := os.Rename(source, staged); err != nil {
				return err
			}
		}
		e.checkpoint.Lifted = append(e.checkpoint.Lifted, move.LocationID)
		if err := e.saveCheckpoint(context.WithoutCancel(ctx), "publish"); err != nil {
			return err
		}
	}
	return nil
}

// placeMoves puts each lifted file at its new path. Like an added file, it
// never lands on a file that is still there.
func (e *workFolderEditExecution) placeMoves(ctx context.Context) error {
	placed := int64Set(e.checkpoint.Placed)
	for index, move := range e.payload.Moves {
		if placed[move.LocationID] {
			e.progress++
			continue
		}
		relative, err := fetchPathRelativeToRoot(e.payload.TargetRoot, move.TargetPath)
		if err != nil {
			return err
		}
		destination := filepath.Join(e.targetAbs, filepath.FromSlash(relative))
		staged := e.liftedPath(index)
		if _, err := os.Lstat(staged); errors.Is(err, os.ErrNotExist) {
			if !existingFileMatches(destination, move.SizeBytes) {
				return fmt.Errorf("the moved file %s is missing; retry the edit", move.Path)
			}
		} else if err != nil {
			return err
		} else {
			if err := mkdirPlainDirectories(e.targetAbs, filepath.Dir(destination)); err != nil {
				return err
			}
			if err := renameNoReplace(staged, destination); errors.Is(err, os.ErrExist) {
				return fmt.Errorf("%s appeared in the folder after the edit was planned", relative)
			} else if err != nil {
				return err
			}
		}
		e.checkpoint.Placed = append(e.checkpoint.Placed, move.LocationID)
		e.progress++
		if err := e.saveCheckpoint(context.WithoutCancel(ctx), "publish"); err != nil {
			return err
		}
	}
	return nil
}

// arrange finishes the folder's layout: moved files keep their media items,
// folders the edit emptied are removed, and the requested folders exist.
func (e *workFolderEditExecution) arrange(ctx context.Context) error {
	if e.checkpoint.Arranged {
		return nil
	}
	s := e.server
	if err := s.keepWorkFolderEditMovedItems(ctx, e.payload); err != nil {
		return err
	}
	emptied := []string{}
	for _, move := range e.payload.Moves {
		emptied = append(emptied, move.Path)
	}
	for _, removal := range e.payload.Removals {
		emptied = append(emptied, removal.Path)
	}
	for _, libraryPath := range emptied {
		if relative, err := fetchPathRelativeToRoot(e.payload.TargetRoot, libraryPath); err == nil {
			removeEmptyDirectoriesBelow(e.targetAbs, path.Dir(relative))
		}
	}
	for _, folder := range e.payload.Folders {
		relative, err := fetchPathRelativeToRoot(e.payload.TargetRoot, folder)
		if err != nil {
			return err
		}
		if err := mkdirPlainDirectories(e.targetAbs, filepath.Join(e.targetAbs, filepath.FromSlash(relative))); err != nil {
			return err
		}
	}
	e.checkpoint.Arranged = true
	return e.saveCheckpoint(context.WithoutCancel(ctx), "publish")
}

// keepWorkFolderEditMovedItems gives each moved file's media item its new
// path before the folder is indexed, so playback progress, lyrics, and every
// other reference to the file follow it. An item that still has a file
// elsewhere, such as the same path in another folder of the work, stays with
// that file, and the index gives the moved file an item of its own.
func (s *Server) keepWorkFolderEditMovedItems(ctx context.Context, payload workFolderEditJobPayload) error {
	if len(payload.Moves) == 0 {
		return nil
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	type follow struct {
		move                  workFolderEditMove
		previous, fingerprint string
	}
	follows := []follow{}
	code := strings.ToUpper(strings.TrimSpace(payload.WorkCode))
	for _, move := range payload.Moves {
		var current, previous string
		err := tx.QueryRowContext(ctx, `
			SELECT location.path, item.fingerprint
			FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			WHERE location.id = ? AND item.id = ?
		`, move.LocationID, move.MediaItemID).Scan(&current, &previous)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		// A retried job finds the files it already followed at their new path.
		if filepath.ToSlash(current) != move.Path {
			continue
		}
		elsewhere, err := workFolderEditItemKeptElsewhere(ctx, tx, move, payload.Merges)
		if err != nil {
			return err
		}
		if elsewhere {
			continue
		}
		relative, err := fetchPathRelativeToRoot(payload.TargetRoot, move.TargetPath)
		if err != nil {
			return err
		}
		follows = append(follows, follow{move: move, previous: previous, fingerprint: fmt.Sprintf("local:%s:%s", code, relative)})
	}
	// Moving items first take a placeholder, so files that trade places can
	// take each other's identity.
	for _, entry := range follows {
		if _, err := tx.ExecContext(ctx, "UPDATE media_item SET fingerprint = ? WHERE id = ?",
			fmt.Sprintf("moving:%d", entry.move.MediaItemID), entry.move.MediaItemID); err != nil {
			return err
		}
	}
	for _, entry := range follows {
		taken, err := workFolderEditFingerprintTaken(ctx, tx, entry.fingerprint, code, payload)
		if err != nil {
			return err
		}
		fingerprint := entry.fingerprint
		if taken {
			// Another item already has the new path; the moved file joins it on
			// indexing, and this item keeps its own path.
			fingerprint = entry.previous
		} else if _, err := tx.ExecContext(ctx, `
			UPDATE media_file_location SET path = ?, last_checked_at = CURRENT_TIMESTAMP WHERE id = ?
		`, entry.move.TargetPath, entry.move.LocationID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE media_item SET fingerprint = ? WHERE id = ?", fingerprint, entry.move.MediaItemID); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// workFolderEditFingerprintTaken reports whether another media item keeps the
// path a moved file takes. An item whose file at that path the same edit
// removes, and which has no other available file outside the folders the edit
// merges away, keeps nothing there: it gives the path up, keeping its
// playback progress and lyrics, so the moved file keeps its own item.
func workFolderEditFingerprintTaken(ctx context.Context, tx *sql.Tx, fingerprint string, code string, payload workFolderEditJobPayload) (bool, error) {
	var holderID int64
	err := tx.QueryRowContext(ctx, "SELECT id FROM media_item WHERE fingerprint = ? ORDER BY id LIMIT 1", fingerprint).Scan(&holderID)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	removed := map[int64]bool{}
	for _, removal := range payload.Removals {
		if removal.LocationID > 0 {
			removed[removal.LocationID] = true
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT id, COALESCE(path, ''), availability FROM media_file_location WHERE media_item_id = ?", holderID)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	givesUp := false
	for rows.Next() {
		var locationID int64
		var other, availability string
		if err := rows.Scan(&locationID, &other, &availability); err != nil {
			return false, err
		}
		if removed[locationID] {
			givesUp = true
			continue
		}
		if availability != "available" {
			continue
		}
		merged := false
		for _, merge := range payload.Merges {
			if mediaCleanupPathWithinRoot(merge.RootPath, filepath.ToSlash(other)) {
				merged = true
				break
			}
		}
		if !merged {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	if !givesUp {
		return true, nil
	}
	// A work-relative path never starts with a slash, so the placeholder
	// matches no file the index finds.
	if _, err := tx.ExecContext(ctx, "UPDATE media_item SET fingerprint = ? WHERE id = ?",
		fmt.Sprintf("local:%s:/removed/%d", code, holderID), holderID); err != nil {
		return false, err
	}
	return false, nil
}

// workFolderEditItemKeptElsewhere reports whether a moved file's media item
// still has an available file outside the folders the same edit merges away,
// which then keeps the item.
func workFolderEditItemKeptElsewhere(ctx context.Context, tx *sql.Tx, move workFolderEditMove, merges []workFolderEditMerge) (bool, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT path FROM media_file_location
		WHERE media_item_id = ? AND id <> ? AND availability = 'available'
	`, move.MediaItemID, move.LocationID)
	if err != nil {
		return false, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var other string
		if err := rows.Scan(&other); err != nil {
			return false, err
		}
		merged := false
		for _, merge := range merges {
			if mediaCleanupPathWithinRoot(merge.RootPath, filepath.ToSlash(other)) {
				merged = true
				break
			}
		}
		if !merged {
			return true, nil
		}
	}
	return false, rows.Err()
}

func int64Set(values []int64) map[int64]bool {
	set := make(map[int64]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

func (e *workFolderEditExecution) publishItem(index int, item workFolderEditItem) error {
	s := e.server
	relative, err := fetchPathRelativeToRoot(e.payload.TargetRoot, item.TargetPath)
	if err != nil {
		return err
	}
	destination := filepath.Join(e.targetAbs, filepath.FromSlash(relative))
	stagedPath := e.stagedPath(index)
	if _, err := os.Lstat(stagedPath); errors.Is(err, os.ErrNotExist) {
		// The move finished before its checkpoint was written.
		if existingFileMatches(destination, item.SizeBytes) {
			return nil
		}
		return fmt.Errorf("the collected copy of %s is missing; retry the edit", item.Path)
	} else if err != nil {
		return err
	}
	if err := mkdirPlainDirectories(e.targetAbs, filepath.Dir(destination)); err != nil {
		return err
	}
	// Only a file the review chose to replace gives way, and only while it is
	// the file the plan saw there. A removed file the added file takes the
	// place of is already gone, so anything at its path came later.
	if info, err := os.Lstat(destination); err == nil {
		if item.Resolution != "replace" || !item.TargetExists || item.TargetSizeBytes == nil ||
			!info.Mode().IsRegular() || info.Size() != *item.TargetSizeBytes {
			return fmt.Errorf("%s appeared in the folder after the edit was planned", relative)
		}
		if _, _, err := removeDestructiveFile(s.cfg.DataRoot, item.TargetPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := renameNoReplace(stagedPath, destination); errors.Is(err, os.ErrExist) {
		return fmt.Errorf("%s appeared in the folder after the edit was planned", relative)
	} else if err != nil {
		return err
	}
	return nil
}

// mkdirPlainDirectories creates directory below base. Every component that
// already exists must be a plain directory, so a link inside the folder cannot
// redirect a published file outside it.
func mkdirPlainDirectories(base string, directory string) error {
	relative, err := filepath.Rel(base, directory)
	if err != nil || relative == "." {
		return err
	}
	current := base
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.Mkdir(current, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		if !info.IsDir() || unsafeFetchStagingEntry(info) {
			return fmt.Errorf("%s is not a plain folder", filepath.ToSlash(relative))
		}
	}
	return nil
}

func (e *workFolderEditExecution) finish(ctx context.Context) error {
	s := e.server
	ctx = context.WithoutCancel(ctx)
	summary := map[string]any{
		"plan":      summarizeWorkFolderEditPayload(e.payload),
		"added":     len(e.checkpoint.Published),
		"removed":   len(e.checkpoint.Removed),
		"deleted":   e.checkpoint.Deleted,
		"assigned":  e.assigned,
		"work_id":   e.payload.WorkID,
		"folder_id": e.payload.FolderID,
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'succeeded', error_message = '', finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP)
		WHERE workflow_run_id = ? AND status IN ('queued', 'running')
	`, e.job.RunID); err != nil {
		return err
	}
	if err := finishWorkflowRunResultTx(ctx, tx, e.job.RunID, e.job.ID, "succeeded", "", e.total, e.total, mustJSON(summary)); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	e.removeStaging()
	return nil
}

// summarizeWorkFolderEditPayload is the summary of the plan the edit was
// queued with. An edit queued without one is summarized from its files, with
// the removed files' sizes where it records them.
func summarizeWorkFolderEditPayload(payload workFolderEditJobPayload) workFolderEditSummary {
	if payload.Summary != nil {
		return *payload.Summary
	}
	summary := summarizeWorkFolderEdit(payload.Items, payload.RemovalFiles)
	summary.Remove = len(payload.Removals)
	summary.Move = len(payload.Moves)
	summary.Merge = len(payload.Merges)
	for _, merge := range payload.Merges {
		summary.MergeFiles += merge.FileCount
	}
	return summary
}

// removeStaging deletes the run's staging directory, which holds only what
// this run collected.
func (e *workFolderEditExecution) removeStaging() {
	if e.stagingAbs == "" {
		return
	}
	if _, err := validateFetchStagingPath(e.server.cfg.DataRoot, filepath.Dir(e.stagingAbs)); err != nil {
		slog.Warn("remove work folder edit staging", "run_id", e.job.RunID, "error", err)
		return
	}
	if err := os.RemoveAll(filepath.Dir(e.stagingAbs)); err != nil {
		slog.Warn("remove work folder edit staging", "run_id", e.job.RunID, "error", err)
	}
}

// putBackLiftedMoves returns each moved file that left its place but did not
// reach its new path to where it was, so a stopped edit never leaves a file
// only in its staging folder. A file whose old path another file took since
// stays lifted, and the staging folder keeps it for a retry. It returns how
// many files stay lifted.
func (e *workFolderEditExecution) putBackLiftedMoves(ctx context.Context) int {
	if e.stagingAbs == "" || e.targetAbs == "" || len(e.checkpoint.Lifted) == 0 {
		return 0
	}
	lifted := int64Set(e.checkpoint.Lifted)
	placed := int64Set(e.checkpoint.Placed)
	remaining := make([]int64, 0, len(e.checkpoint.Lifted))
	kept := 0
	for index, move := range e.payload.Moves {
		if !lifted[move.LocationID] {
			continue
		}
		if placed[move.LocationID] {
			remaining = append(remaining, move.LocationID)
			continue
		}
		if err := e.putBackMove(index, move); err != nil {
			slog.Error("work folder edit could not put a moved file back", "run_id", e.job.RunID, "path", move.Path, "error", err)
			remaining = append(remaining, move.LocationID)
			kept++
		}
	}
	e.checkpoint.Lifted = remaining
	if err := e.saveCheckpoint(context.WithoutCancel(ctx), "publish"); err != nil {
		slog.Warn("save work folder edit checkpoint", "run_id", e.job.RunID, "error", err)
	}
	return kept
}

func (e *workFolderEditExecution) putBackMove(index int, move workFolderEditMove) error {
	source, err := safeDataPath(e.server.cfg.DataRoot, move.Path)
	if err != nil {
		return err
	}
	staged := e.liftedPath(index)
	if _, err := os.Lstat(staged); errors.Is(err, os.ErrNotExist) {
		if existingFileMatches(source, move.SizeBytes) {
			// The file never left its place.
			return nil
		}
		return errors.New("the lifted file is missing")
	} else if err != nil {
		return err
	}
	if err := mkdirPlainDirectories(e.targetAbs, filepath.Dir(source)); err != nil {
		return err
	}
	if err := renameNoReplace(staged, source); errors.Is(err, os.ErrExist) {
		return errors.New("another file took its place")
	} else if err != nil {
		return err
	}
	return nil
}

// discardStaging puts lifted files back and deletes what the run collected.
// A moved file that could not go back keeps the staging folder, so it is never
// deleted; it returns how many such files there are.
func (e *workFolderEditExecution) discardStaging(ctx context.Context) int {
	kept := e.putBackLiftedMoves(ctx)
	if kept == 0 {
		e.removeStaging()
		return 0
	}
	for index, item := range e.payload.Items {
		if workFolderEditItemAdds(item) {
			_ = os.Remove(e.stagedPath(index))
		}
	}
	return kept
}

// fail records why the edit stopped. A service stop leaves the job for
// startup recovery. Any other stop puts lifted files back first, and a
// failure that will be retried keeps what it already collected.
func (e *workFolderEditExecution) fail(ctx context.Context, runErr error) error {
	s := e.server
	if shutdownInterrupted(ctx) {
		return runErr
	}
	statusCtx := context.WithoutCancel(ctx)
	var runStatus string
	if err := s.db.QueryRowContext(statusCtx, "SELECT status FROM workflow_run WHERE id = ?", e.job.RunID).Scan(&runStatus); err != nil {
		return runErr
	}
	if runStatus != "queued" && runStatus != "running" {
		// A cancelled run is settled by its cancellation, and a finished one
		// keeps its result.
		if runStatus == "cancelled" {
			e.discardStaging(statusCtx)
			_ = s.restoreMediaCleanupFolders(statusCtx, e.job.RunID)
		}
		return runErr
	}
	kept := 0
	if willRetry := isRetryableWorkflowError(runErr) && e.job.RetryCount < e.job.MaxRetries; willRetry {
		// A queued retry can still be cancelled, so it holds no moved file.
		kept = e.putBackLiftedMoves(statusCtx)
	} else {
		kept = e.discardStaging(statusCtx)
		// A merged folder the edit had started to delete is a folder of the
		// work again, holding whatever it still holds.
		_ = s.restoreMediaCleanupFolders(statusCtx, e.job.RunID)
	}
	slog.Error("work folder edit failed", "run_id", e.job.RunID, "job_id", e.job.ID, "step", e.node, "error", runErr)
	tx, err := beginTxWithDatabaseBusyRetry(statusCtx, s.db)
	if err != nil {
		return runErr
	}
	defer func() { _ = tx.Rollback() }()
	message := runErr.Error()
	if kept > 0 {
		message = fmt.Sprintf("%s; %d moved files could not return to their place and wait in the edit's staging folder for a retry", message, kept)
	}
	if _, err := tx.ExecContext(statusCtx, `
		UPDATE workflow_node_run
		SET status = 'failed', error_message = ?, finished_at = CURRENT_TIMESTAMP
		WHERE workflow_run_id = ? AND node_id = ?
	`, message, e.job.RunID, e.node); err != nil {
		return runErr
	}
	summary := mustJSON(map[string]any{
		"plan": summarizeWorkFolderEditPayload(e.payload), "error": message,
		"added": len(e.checkpoint.Published), "removed": len(e.checkpoint.Removed),
	})
	if err := finishWorkflowRunResultTx(statusCtx, tx, e.job.RunID, e.job.ID, "failed", message, e.progress, e.total, summary); err != nil {
		return runErr
	}
	_ = tx.Commit()
	return runErr
}

func stringSet(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}
