package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// localWorkCleanupJobFolder is one confirmed local folder of a work a rated
// local work cleanup deletes.
type localWorkCleanupJobFolder struct {
	ID       int64  `json:"id"`
	WorkID   int64  `json:"workId"`
	SourceID int64  `json:"sourceId"`
	Path     string `json:"path"`
}

// localWorkCleanupJobWork is one work family of the run: the folders to
// delete and the family's works, whose rating and Quick mark are cleared and
// which are forgotten when the run asks for it.
type localWorkCleanupJobWork struct {
	Code    string                      `json:"code"`
	WorkIDs []int64                     `json:"workIds"`
	Folders []localWorkCleanupJobFolder `json:"folders"`
}

type localWorkCleanupFailure struct {
	Code  string `json:"code"`
	Error string `json:"error"`
}

func localWorkCleanupJobWorkFor(candidate localWorkCleanupCandidate) localWorkCleanupJobWork {
	work := localWorkCleanupJobWork{
		Code:    candidate.PrimaryCode,
		WorkIDs: append([]int64(nil), candidate.familyWorkIDs...),
		Folders: make([]localWorkCleanupJobFolder, 0, len(candidate.Folders)),
	}
	for _, folder := range candidate.Folders {
		work.Folders = append(work.Folders, localWorkCleanupJobFolder{
			ID: folder.ID, WorkID: folder.workID, SourceID: folder.sourceID, Path: folder.Path,
		})
	}
	return work
}

// executeLocalWorkCleanup cleans the run's works one at a time. A work whose
// folders cannot all be deleted keeps its folders' state, rating, Quick mark,
// and identity and is reported; the other works go on. A retry tries the
// failed works again.
func (s *Server) executeLocalWorkCleanup(
	ctx context.Context,
	statusCtx context.Context,
	job workflowJobRecord,
	payload mediaCleanupJobPayload,
	checkpoint mediaCleanupCheckpoint,
	finishCancelled func() error,
) error {
	done := make(map[int]bool, len(checkpoint.DoneWorks))
	for _, index := range checkpoint.DoneWorks {
		done[index] = true
	}
	checkpoint.Failures = nil
	for index, work := range payload.Works {
		if done[index] {
			continue
		}
		if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
			return err
		}
		workErr := s.cleanLocalWork(ctx, statusCtx, job, payload, work, &checkpoint)
		if stopped, err := s.stopMediaCleanupIfNeeded(ctx, statusCtx, job.RunID, finishCancelled); stopped {
			return err
		}
		if workErr != nil {
			if err := s.restoreLocalWorkCleanupFolders(statusCtx, job.RunID, work); err != nil {
				return s.failMediaCleanupTarget(statusCtx, job, err)
			}
			checkpoint.Failures = append(checkpoint.Failures, localWorkCleanupFailure{Code: work.Code, Error: workErr.Error()})
		} else {
			checkpoint.DoneWorks = append(checkpoint.DoneWorks, index)
		}
		if err := s.updateWorkflowJobCheckpoint(statusCtx, job.ID, "cleanup", checkpoint, index+1, len(payload.Works)); err != nil {
			return s.failMediaCleanupTarget(statusCtx, job, err)
		}
	}
	return s.finishLocalWorkCleanup(statusCtx, job, payload, checkpoint, finishCancelled)
}

// cleanLocalWork deletes one work's folders. Each folder is claimed for the
// run, indexed again so files added since its last index are deleted too,
// emptied, and removed; only then is the actor's state cleared and the work
// forgotten.
func (s *Server) cleanLocalWork(
	ctx context.Context,
	statusCtx context.Context,
	job workflowJobRecord,
	payload mediaCleanupJobPayload,
	work localWorkCleanupJobWork,
	checkpoint *mediaCleanupCheckpoint,
) error {
	roots := make([]mediaCleanupTarget, 0, len(work.Folders))
	for _, folder := range work.Folders {
		root := mediaCleanupTarget{
			Kind: "local_root", FolderID: folder.ID, WorkID: folder.WorkID, SourceID: folder.SourceID,
			Path: folder.Path, ExpectedPath: folder.Path, CleanupRunID: job.RunID,
		}
		if err := s.claimMediaCleanupFolder(statusCtx, root, job.RunID); err != nil {
			gone, goneErr := s.localWorkCleanupFolderGone(statusCtx, folder)
			if goneErr != nil {
				return goneErr
			}
			if gone {
				continue
			}
			return err
		}
		// An offline pool's mount point is not the folder the index
		// describes, and indexing it would mark every file missing.
		if err := s.ensureLibraryPathOnline(statusCtx, folder.Path); err != nil {
			return err
		}
		roots = append(roots, root)
	}
	for _, root := range roots {
		absolute, err := safeDataPath(s.cfg.DataRoot, root.Path)
		if err != nil {
			return err
		}
		if _, err := os.Stat(absolute); errors.Is(err, os.ErrNotExist) {
			continue
		} else if err != nil {
			return err
		}
		if err := s.indexLocalMediaForWork(ctx, root.WorkID, root.SourceID, root.Path); err != nil {
			return err
		}
	}
	targets, err := s.localWorkCleanupFileTargets(statusCtx, work, roots, payload.Mode == mediaCleanupForgetWork)
	if err != nil {
		return err
	}
	// A folder whose removal would fail keeps every file: what would stop it
	// is found before anything is deleted.
	for _, root := range roots {
		blocker, err := s.localWorkCleanupBlocker(root, targets)
		if err != nil {
			return err
		}
		if blocker != "" {
			return fmt.Errorf("%s also holds %s, so nothing was deleted", root.Path, blocker)
		}
	}
	for _, target := range append(targets, roots...) {
		if err := ctx.Err(); err != nil {
			return err
		}
		deleted, err := s.clearMediaCleanupTarget(statusCtx, target)
		if err != nil {
			return err
		}
		if deleted {
			checkpoint.Deleted++
		}
	}
	return s.finishLocalWorkState(statusCtx, payload, work, checkpoint)
}

// localWorkCleanupBlocker names the first entry below a claimed folder that
// would keep the folder from being removed once the run's files are gone: a
// file the run does not delete, a link, or a special file. The lyrics folder's
// marker and the sidecars a NAS or operating system keeps go with the folder,
// as clearLocalWorkRoot removes them. "" means the folder can go.
func (s *Server) localWorkCleanupBlocker(root mediaCleanupTarget, targets []mediaCleanupTarget) (string, error) {
	absolute, err := safeDataPath(s.cfg.DataRoot, root.Path)
	if err != nil {
		return "", err
	}
	if _, err := os.Lstat(absolute); errors.Is(err, os.ErrNotExist) {
		return "", nil
	} else if err != nil {
		return "", err
	}
	deleted := make(map[string]bool, len(targets))
	for _, target := range targets {
		if target.Kind == "local" {
			deleted[normalizeFolderRootPath(target.Path)] = true
		}
	}
	blocker := ""
	err = filepath.WalkDir(absolute, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == absolute {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative := relativeDataPath(absolute, current)
		if unsafeFetchStagingEntry(info) || (!info.IsDir() && !info.Mode().IsRegular()) {
			blocker = relative
			return fs.SkipAll
		}
		if info.IsDir() || localfs.IsLyricsRootMarker(relative) || workFolderEditMergeSidecarPath(relative) {
			return nil
		}
		if !deleted[normalizeFolderRootPath(path.Join(root.Path, relative))] {
			blocker = relative
			return fs.SkipAll
		}
		return nil
	})
	return blocker, err
}

// localWorkCleanupFolderGone reports whether an earlier attempt of the run
// already removed a folder: its record is gone or no longer active, and
// nothing is left at its path.
func (s *Server) localWorkCleanupFolderGone(ctx context.Context, folder localWorkCleanupJobFolder) (bool, error) {
	var state string
	err := s.db.QueryRowContext(ctx, "SELECT state FROM work_folder_location WHERE id = ?", folder.ID).Scan(&state)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	if err == nil && (state == "active" || state == "pending_cleanup") {
		return false, nil
	}
	// An offline pool shows nothing at any path, which says nothing about
	// whether the folder is gone.
	if err := s.ensureLibraryPathOnline(ctx, folder.Path); err != nil {
		return false, nil
	}
	absolute, err := safeDataPath(s.cfg.DataRoot, folder.Path)
	if err != nil {
		return false, err
	}
	if _, err := os.Lstat(absolute); errors.Is(err, os.ErrNotExist) {
		return true, nil
	} else if err != nil {
		return false, err
	}
	return false, nil
}

// localWorkCleanupFileTargets lists the work's available local files inside
// the folders the run claimed, and its cached copies when the work is to be
// forgotten, since a cached copy would keep the work linked. A folder the work
// gained after the cleanup was confirmed is not claimed, so its files stay.
func (s *Server) localWorkCleanupFileTargets(ctx context.Context, work localWorkCleanupJobWork, roots []mediaCleanupTarget, forget bool) ([]mediaCleanupTarget, error) {
	if len(work.WorkIDs) == 0 {
		return nil, nil
	}
	placeholders := sqlPlaceholders(len(work.WorkIDs))
	cache := 0
	if forget {
		cache = 1
	}
	args := append(int64Args(work.WorkIDs), cache)
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.media_item_id, item.work_id, location.file_source_id, location.location_type, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id IN (`+placeholders+`)
			AND location.availability = 'available'
			AND (location.location_type = 'local' OR (location.location_type = 'cache' AND ? = 1))
		ORDER BY location.location_type DESC, location.path, location.id
	`, args...)
	if err != nil {
		return nil, err
	}
	type locationRow struct {
		target       mediaCleanupTarget
		locationType string
	}
	locations := []locationRow{}
	for rows.Next() {
		var row locationRow
		if err := rows.Scan(&row.target.LocationID, &row.target.MediaItemID, &row.target.WorkID, &row.target.SourceID, &row.locationType, &row.target.Path); err != nil {
			_ = rows.Close()
			return nil, err
		}
		locations = append(locations, row)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	targets := make([]mediaCleanupTarget, 0, len(locations))
	for _, row := range locations {
		requested := mediaCleanupTargetRequest{Kind: row.locationType, LocationID: row.target.LocationID}
		var target mediaCleanupTarget
		if row.locationType == "cache" {
			target, err = prepareCacheCleanupTarget(requested, row.target, row.locationType, s.cfg.CacheRoot)
		} else {
			if !localWorkCleanupInClaimedRoot(roots, row.target) {
				continue
			}
			target, err = s.prepareLocalFileCleanupTarget(ctx, requested, row.target, row.locationType)
		}
		if err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, nil
}

func localWorkCleanupInClaimedRoot(roots []mediaCleanupTarget, target mediaCleanupTarget) bool {
	for _, root := range roots {
		if root.WorkID == target.WorkID && root.SourceID == target.SourceID && mediaCleanupPathWithinRoot(root.Path, target.Path) {
			return true
		}
	}
	return false
}

// finishLocalWorkState clears the actor's rating and Quick mark of a cleaned
// work and forgets it when asked, in one transaction.
func (s *Server) finishLocalWorkState(ctx context.Context, payload mediaCleanupJobPayload, work localWorkCleanupJobWork, checkpoint *mediaCleanupCheckpoint) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	placeholders := sqlPlaceholders(len(work.WorkIDs))
	args := append([]any{payload.ActorUserID}, int64Args(work.WorkIDs)...)
	var ratings, marks int64
	if payload.ClearRating && payload.ActorUserID > 0 {
		if ratings, err = execAffected(ctx, tx, `UPDATE user_work_state SET rating = NULL, updated_at = CURRENT_TIMESTAMP
			WHERE user_id = ? AND rating IS NOT NULL AND work_id IN (`+placeholders+`)`, args...); err != nil {
			return err
		}
	}
	if payload.ClearMark && payload.ActorUserID > 0 {
		if marks, err = execAffected(ctx, tx, `UPDATE user_work_state SET listening_status = 'none', updated_at = CURRENT_TIMESTAMP
			WHERE user_id = ? AND listening_status <> 'none' AND work_id IN (`+placeholders+`)`, args...); err != nil {
			return err
		}
	}
	var purge unlinkedWorkDeleteResult
	if payload.Mode == mediaCleanupForgetWork {
		if purge, err = s.deleteUnlinkedWorkFamiliesTx(ctx, tx, work.WorkIDs); err != nil {
			return err
		}
		if purge.DeletedFamilyCount > 0 {
			if err := insertUnlinkedWorkDeleteAudit(ctx, tx, payload.ActorUserID, purge, true, mediaCleanupForgetAuditAction); err != nil {
				return err
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	checkpoint.ClearedRatings += ratings
	checkpoint.ClearedMarks += marks
	checkpoint.Forgotten = append(checkpoint.Forgotten, purge.DeletedCodes...)
	for _, skipped := range purge.Skipped {
		if skipped.Reason == "source_available" {
			checkpoint.Retained = append(checkpoint.Retained, skipped)
		}
	}
	return nil
}

func execAffected(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}

// restoreLocalWorkCleanupFolders returns the folders of a work that could not
// be cleaned to their work, as a cancelled cleanup does for all of them.
func (s *Server) restoreLocalWorkCleanupFolders(ctx context.Context, runID int64, work localWorkCleanupJobWork) error {
	if len(work.Folders) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(work.Folders))
	for _, folder := range work.Folders {
		ids = append(ids, folder.ID)
	}
	args := append([]any{runID}, int64Args(ids)...)
	return withDatabaseBusyRetry(context.WithoutCancel(ctx), func() error {
		_, err := s.db.ExecContext(context.WithoutCancel(ctx), `
			UPDATE work_folder_location
			SET state = 'active', cleanup_run_id = NULL, updated_at = CURRENT_TIMESTAMP
			WHERE cleanup_run_id = ? AND state = 'pending_cleanup' AND id IN (`+sqlPlaceholders(len(ids))+`)
		`, args...)
		return err
	})
}

// finishLocalWorkCleanup settles the run. A run with a work that could not be
// cleaned fails, so a retry can try that work again; a run that kept a work
// another source still provides is partial.
func (s *Server) finishLocalWorkCleanup(
	ctx context.Context,
	job workflowJobRecord,
	payload mediaCleanupJobPayload,
	checkpoint mediaCleanupCheckpoint,
	finishCancelled func() error,
) error {
	status := "succeeded"
	switch {
	case len(checkpoint.Failures) > 0:
		status = "failed"
	case len(checkpoint.Retained) > 0:
		status = "partial"
	}
	summary := map[string]any{
		"mode":            string(payload.Mode),
		"works":           len(payload.Works),
		"completed_works": len(checkpoint.DoneWorks),
		"deleted":         checkpoint.Deleted,
	}
	if payload.ClearRating {
		summary["cleared_ratings"] = checkpoint.ClearedRatings
	}
	if payload.ClearMark {
		summary["cleared_marks"] = checkpoint.ClearedMarks
	}
	if payload.Mode == mediaCleanupForgetWork {
		summary["forgotten_codes"] = nonNilStrings(checkpoint.Forgotten)
		retained := checkpoint.Retained
		if retained == nil {
			retained = []unlinkedWorkMaintenanceSkip{}
		}
		summary["retained"] = retained
	}
	errorMessage := ""
	if len(checkpoint.Failures) > 0 {
		summary["failures"] = checkpoint.Failures
		codes := make([]string, 0, len(checkpoint.Failures))
		for _, failure := range checkpoint.Failures {
			codes = append(codes, failure.Code)
		}
		errorMessage = fmt.Sprintf("%d of %d works could not be cleaned: %s", len(codes), len(payload.Works), strings.Join(codes, ", "))
		summary["error"] = errorMessage
	}
	nodeStatus := status
	if nodeStatus == "partial" {
		nodeStatus = "succeeded"
	}
	output := mustJSON(summary)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	updates := []struct {
		query string
		args  []any
	}{
		{"UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{nodeStatus, output, errorMessage, job.NodeRunID}},
		{"UPDATE workflow_job SET status = ?, progress_current = progress_total, error_message = ?, locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'", []any{nodeStatus, errorMessage, job.ID}},
		{"UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{status, output, job.RunID}},
	}
	if payload.ForgetNodeID > 0 {
		updates = append(updates, struct {
			query string
			args  []any
		}{"UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{status, output, payload.ForgetNodeID}})
	}
	for _, update := range updates {
		affected, err := execMediaCleanupUpdate(ctx, tx, update.query, update.args...)
		if err != nil {
			return err
		}
		if !affected {
			_ = tx.Rollback()
			return finishCancelled()
		}
	}
	if len(checkpoint.Retained) > 0 {
		if err := insertLocalWorkRetainedEvent(ctx, tx, job, payload, checkpoint); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func insertLocalWorkRetainedEvent(ctx context.Context, tx *sql.Tx, job workflowJobRecord, payload mediaCleanupJobPayload, checkpoint mediaCleanupCheckpoint) error {
	return workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: payload.ForgetNodeID, JobID: job.ID, Level: "warn", Type: "media_cleanup.work_retained",
		Message: "Files were deleted, but works another source still provides were retained",
		Detail:  map[string]any{"skipped": checkpoint.Retained},
	})
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}
