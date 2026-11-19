package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strconv"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// A rated local work cleanup deletes a work's folders all or nothing. Each
// claimed folder is first moved, by a rename on its own pool's filesystem,
// into the run's cleanup area of that pool's .kikoto-staging. A folder that
// cannot be moved, such as one the operating system will not let go, puts the
// folders moved before it back, and nothing is deleted. Only once every folder
// of the work is moved does the index forget them, and the moved folders are
// deleted from there. A folder left in the cleanup area is finished by the
// next attempt of the run, or returned to its place when the run gives the
// folder back to its work.

// localWorkCleanupStage is one claimed folder of a work and where the run
// moves it before deleting it.
type localWorkCleanupStage struct {
	root mediaCleanupTarget
	// original and staged are absolute paths; stagedPath is staged relative
	// to the data root.
	original   string
	staged     string
	stagedPath string
	// absent is set when nothing is at either path: the folder is already gone.
	absent bool
}

// localWorkCleanupStagingPath is where a run moves a folder before deleting
// it, relative to the data root: .kikoto-staging/<run>/cleanup/<folder> on the
// pool that holds the folder.
func (s *Server) localWorkCleanupStagingPath(ctx context.Context, runID, folderID int64, root string) (string, error) {
	pool, err := s.fetchTransactionPool(ctx, root)
	if err != nil {
		return "", err
	}
	return storagepool.Join(pool, path.Join(".kikoto-staging", strconv.FormatInt(runID, 10), "cleanup", strconv.FormatInt(folderID, 10))), nil
}

// localWorkCleanupStageFor resolves where a claimed folder is and where the
// run moves it. A folder already in the cleanup area, with nothing at its own
// path, was moved by an earlier attempt that did not finish.
func (s *Server) localWorkCleanupStageFor(ctx context.Context, runID int64, root mediaCleanupTarget) (localWorkCleanupStage, error) {
	stagedPath, err := s.localWorkCleanupStagingPath(ctx, runID, root.FolderID, root.Path)
	if err != nil {
		return localWorkCleanupStage{}, err
	}
	stage := localWorkCleanupStage{root: root, stagedPath: stagedPath}
	if stage.original, err = safeDataPath(s.cfg.DataRoot, root.Path); err != nil {
		return localWorkCleanupStage{}, err
	}
	if stage.staged, err = safeDataPath(s.cfg.DataRoot, stagedPath); err != nil {
		return localWorkCleanupStage{}, err
	}
	// A link at .kikoto-staging, or below it, would carry the folder outside
	// the pool.
	if _, err := validateFetchStagingPath(s.cfg.DataRoot, stage.staged); err != nil {
		return localWorkCleanupStage{}, err
	}
	originalExists, err := cleanupEntryExists(stage.original)
	if err != nil {
		return localWorkCleanupStage{}, err
	}
	stagedExists, err := cleanupEntryExists(stage.staged)
	if err != nil {
		return localWorkCleanupStage{}, err
	}
	stage.absent = !originalExists && !stagedExists
	return stage, nil
}

// move moves the folder into the cleanup area unless it is already there.
func (stage localWorkCleanupStage) move(dataRoot string) error {
	if stage.absent {
		return nil
	}
	if exists, err := cleanupEntryExists(stage.original); err != nil || !exists {
		return err
	}
	if exists, err := cleanupEntryExists(stage.staged); err != nil {
		return err
	} else if exists {
		return fmt.Errorf("%s could not be moved for deletion because %s is taken, so nothing was deleted", stage.root.Path, stage.stagedPath)
	}
	// The folder itself must be a plain folder reached through plain folders.
	if _, err := validateDestructivePath(dataRoot, stage.root.Path, false, true); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(stage.staged), 0o755); err != nil {
		return err
	}
	if _, err := validateFetchStagingPath(dataRoot, stage.staged); err != nil {
		return err
	}
	if err := os.Rename(stage.original, stage.staged); err != nil {
		return fmt.Errorf("%s could not be moved for deletion, so nothing was deleted: %w", stage.root.Path, err)
	}
	return nil
}

// moveBack returns a folder in the cleanup area to its own path.
func (stage localWorkCleanupStage) moveBack() error {
	return returnStagedFolder(stage.staged, stage.original)
}

// returnLocalWorkCleanupStages moves the given folders back, last moved first,
// and reports the folders it could not return.
func returnLocalWorkCleanupStages(stages []localWorkCleanupStage) error {
	var errs []error
	for index := len(stages) - 1; index >= 0; index-- {
		if err := stages[index].moveBack(); err != nil {
			errs = append(errs, fmt.Errorf("%s could not be returned from %s: %w", stages[index].root.Path, stages[index].stagedPath, err))
		}
	}
	return errors.Join(errs...)
}

// returnStagedFolder moves a folder from the cleanup area back to original
// when it is there and nothing else took its place.
func returnStagedFolder(staged, original string) error {
	stagedExists, err := cleanupEntryExists(staged)
	if err != nil || !stagedExists {
		return err
	}
	if originalExists, err := cleanupEntryExists(original); err != nil {
		return err
	} else if originalExists {
		return fmt.Errorf("another entry is at %s", filepath.ToSlash(original))
	}
	if err := os.MkdirAll(filepath.Dir(original), 0o755); err != nil {
		return err
	}
	return os.Rename(staged, original)
}

// removeLocalWorkCleanupArea removes the run's cleanup area of a pool once
// nothing is left in it.
func (s *Server) removeLocalWorkCleanupArea(stagedPath string) {
	cleanup := path.Dir(stagedPath)
	for _, directory := range []string{cleanup, path.Dir(cleanup)} {
		absolute, err := safeDataPath(s.cfg.DataRoot, directory)
		if err != nil {
			return
		}
		if err := os.Remove(absolute); err != nil {
			return
		}
	}
}

// returnStagedCleanupFolders moves the folders a run claimed and moved into
// its cleanup area back to their own paths, before the run gives them back to
// their works. A folder the move cannot return stays in the cleanup area,
// where a retry of the run finishes it, and is logged.
func (s *Server) returnStagedCleanupFolders(ctx context.Context, runID int64, folderIDs []int64) {
	query := `SELECT id, root_path FROM work_folder_location WHERE cleanup_run_id = ? AND state = 'pending_cleanup'`
	args := []any{runID}
	if len(folderIDs) > 0 {
		query += ` AND id IN (` + sqlPlaceholders(len(folderIDs)) + `)`
		args = append(args, int64Args(folderIDs)...)
	}
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		slog.Warn("cleanup folders could not be listed for return", "run_id", runID, "error", err)
		return
	}
	type claimed struct {
		id   int64
		root string
	}
	folders := []claimed{}
	for rows.Next() {
		var folder claimed
		if err := rows.Scan(&folder.id, &folder.root); err != nil {
			_ = rows.Close()
			return
		}
		folders = append(folders, folder)
	}
	_ = rows.Close()
	for _, folder := range folders {
		stagedPath, err := s.localWorkCleanupStagingPath(ctx, runID, folder.id, folder.root)
		if err != nil {
			continue
		}
		staged, stagedErr := safeDataPath(s.cfg.DataRoot, stagedPath)
		original, originalErr := safeDataPath(s.cfg.DataRoot, folder.root)
		if stagedErr != nil || originalErr != nil {
			continue
		}
		if _, err := validateFetchStagingPath(s.cfg.DataRoot, staged); err != nil {
			slog.Warn("cleanup folder was not returned", "run_id", runID, "folder_id", folder.id, "error", err)
			continue
		}
		if err := returnStagedFolder(staged, original); err != nil {
			slog.Warn("cleanup folder was not returned", "run_id", runID, "folder_id", folder.id, "staged", stagedPath, "error", err)
			continue
		}
		s.removeLocalWorkCleanupArea(stagedPath)
	}
}

func cleanupEntryExists(absolute string) (bool, error) {
	if _, err := os.Lstat(absolute); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	return true, nil
}
