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
)

// lyricsEditAssignment names a plan item as the library lyrics of an audio
// item.
type lyricsEditAssignment struct {
	audioID int64
	item    int
}

func (s *Server) runLyricsEdit(ctx context.Context, userID int64, workID int64, payload lyricsEditRequest) (lyricsEditResult, error) {
	plan, err := s.buildLyricsEditPlan(ctx, workID, payload)
	if err != nil {
		return lyricsEditResult{}, err
	}
	if plan.Summary.Conflict > 0 {
		return lyricsEditResult{}, lyricsEditConflictError{Summary: plan.Summary}
	}
	assignments, err := s.lyricsEditAssignments(ctx, plan, payload.Assignments)
	if err != nil {
		return lyricsEditResult{}, err
	}
	if plan.Summary.Add == 0 && plan.Summary.Remove == 0 && len(assignments) == 0 {
		return lyricsEditResult{}, lyricsFetchBadRequest("the edit does not change the lyrics")
	}
	removals := make([]mediaCleanupTarget, 0, len(plan.Removals))
	for _, removal := range plan.Removals {
		// The complete check, including the symbolic-link review, runs only
		// when the edit is applied, never for a preview.
		target, err := s.loadMediaCleanupTarget(ctx, mediaCleanupTargetRequest{Kind: "local", LocationID: removal.LocationID})
		if err != nil {
			return lyricsEditResult{}, err
		}
		removals = append(removals, target)
	}
	previous, err := s.lyricsEditMovedItems(ctx, plan)
	if err != nil {
		return lyricsEditResult{}, err
	}
	poolPath, err := s.fetchTransactionPool(ctx, plan.target.RootPath)
	if err != nil {
		return lyricsEditResult{}, err
	}
	stagingRoot, err := s.createLyricsStaging(path.Join(poolPath, ".kikoto-staging"))
	if err != nil {
		return lyricsEditResult{}, err
	}
	keepStaging := false
	defer func() {
		if !keepStaging {
			_ = os.RemoveAll(stagingRoot)
		}
	}()
	if err := s.stageLyricsEdit(ctx, plan, stagingRoot); err != nil {
		return lyricsEditResult{}, err
	}
	changed, recoveryNeeded, commitErr := s.commitLyricsEdit(ctx, plan, removals, stagingRoot)
	keepStaging = recoveryNeeded
	if recoveryNeeded {
		slog.Error("lyrics edit rollback needs recovery", "work_id", workID, "staging_root", stagingRoot, "error", commitErr)
	}
	if changed {
		// The index follows the folder even when the edit stopped halfway.
		if err := s.indexLocalMediaForWork(ctx, plan.target.WorkID, plan.target.FileSourceID, plan.target.RootPath); err != nil && commitErr == nil {
			commitErr = err
		}
	}
	if commitErr != nil {
		return lyricsEditResult{}, commitErr
	}
	assigned, err := s.declareLyricsEdit(ctx, userID, plan, previous, assignments)
	if err != nil {
		return lyricsEditResult{}, err
	}
	return lyricsEditResult{
		WorkID: plan.WorkID, SaveRoot: plan.SaveRoot,
		Moved: plan.Summary.Move, Copied: plan.Summary.Copy, Downloaded: plan.Summary.Download,
		Removed: len(removals), Skipped: plan.Summary.Skip, Assigned: assigned,
	}, nil
}

// lyricsEditAssignments validates the requested assignments against the plan.
// A track takes one file per language, and only a file the edit leaves in the
// folder can be assigned.
func (s *Server) lyricsEditAssignments(ctx context.Context, plan lyricsEditPlan, requested []lyricsEditAssignmentIn) ([]lyricsEditAssignment, error) {
	if len(requested) > maxLyricsAssignmentChanges {
		return nil, lyricsFetchBadRequest(fmt.Sprintf("at most %d assignments can be saved at once", maxLyricsAssignmentChanges))
	}
	byKey := make(map[string]int, len(plan.Items))
	for index, item := range plan.Items {
		byKey[item.ItemKey] = index
	}
	audio := map[int64]string{}
	taken := map[string]bool{}
	assignments := make([]lyricsEditAssignment, 0, len(requested))
	for _, assignment := range requested {
		index, ok := byKey[strings.TrimSpace(assignment.ItemKey)]
		if assignment.AudioMediaItemID <= 0 || !ok {
			return nil, lyricsFetchBadRequest("each assignment must name an audio item and one of the added files")
		}
		item := plan.Items[index]
		if !lyricsEditItemAdds(item) && item.Action != "skip" {
			continue
		}
		slot := fmt.Sprintf("%d:%s", assignment.AudioMediaItemID, item.Language)
		if taken[slot] {
			return nil, lyricsFetchBadRequest("each audio media item can be assigned only once per language")
		}
		taken[slot] = true
		audio[assignment.AudioMediaItemID] = ""
		assignments = append(assignments, lyricsEditAssignment{audioID: assignment.AudioMediaItemID, item: index})
	}
	if err := s.validateLyricsFetchAudio(ctx, plan.target.WorkID, audio); err != nil {
		return nil, err
	}
	return assignments, nil
}

// lyricsEditLyricsItem returns the media item of the available local file at a
// library path of the edited folder.
func lyricsEditLyricsItem(ctx context.Context, db interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}, target lyricsFetchTarget, libraryPath string) (int64, bool, error) {
	var id int64
	err := db.QueryRowContext(ctx, `
		SELECT item.id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
			AND location.path = ?
		ORDER BY location.id
		LIMIT 1
	`, target.WorkID, target.FileSourceID, libraryPath).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return id, err == nil, err
}

// lyricsEditMovedItems returns, by plan index, the media item of each file the
// edit moves, as it is indexed before the move.
func (s *Server) lyricsEditMovedItems(ctx context.Context, plan lyricsEditPlan) (map[int]int64, error) {
	previous := map[int]int64{}
	for index, item := range plan.Items {
		if item.Action != "move_local" {
			continue
		}
		id, ok, err := lyricsEditLyricsItem(ctx, s.db, plan.target, item.LocalSourcePath)
		if err != nil {
			return nil, err
		}
		if ok {
			previous[index] = id
		}
	}
	return previous, nil
}

func lyricsEditStagedPath(stagingRoot string, index int) string {
	return filepath.Join(stagingRoot, fmt.Sprintf("%06d", index))
}

// stageLyricsEdit collects every copied and downloaded file on the edited
// folder's storage pool, before anything in the folder changes.
func (s *Server) stageLyricsEdit(ctx context.Context, plan lyricsEditPlan, stagingRoot string) error {
	total := int64(0)
	for index, item := range plan.Items {
		if item.Action != "copy_local" && item.Action != "cache_download" {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		destination := lyricsEditStagedPath(stagingRoot, index)
		var written int64
		var err error
		if item.Action == "copy_local" {
			written, err = copyLibraryLyricsFile(item.sourceRoot, item.Path, destination)
		} else {
			written, err = s.downloadLyricsFile(ctx, item.remote, item.SourcePath, destination)
		}
		if err != nil {
			return err
		}
		if total += written; total > maxLyricsEditStagedBytes {
			return lyricsFetchBadRequest("the selected lyrics files are too large")
		}
	}
	return nil
}

// commitLyricsEdit changes the folder: the moved files leave their places, the
// removed files are deleted, and every added file takes its target. It reports
// whether the folder may have changed and whether staging must be retained for
// recovery. A failure retracts publications before restoring moved sources.
func (s *Server) commitLyricsEdit(ctx context.Context, plan lyricsEditPlan, removals []mediaCleanupTarget, stagingRoot string) (bool, bool, error) {
	for _, item := range plan.Items {
		if item.Action != "move_local" {
			continue
		}
		if _, ok := regularFileBelow(item.sourceRoot, item.Path); !ok {
			return false, false, errLyricsFileGone
		}
	}
	lifted := []int{}
	published := map[int]os.FileInfo{}
	if err := writeLyricsEditRecovery(plan, stagingRoot); err != nil {
		return false, false, err
	}
	restore := func(cause error) (bool, bool, error) {
		err := restoreLyricsEdit(plan, stagingRoot, lifted, published)
		removeEmptyLyricsRoot(plan.rootAbsolute)
		return len(lifted) > 0 || len(published) > 0, err != nil, errors.Join(cause, err)
	}
	for _, item := range plan.Items {
		if lyricsEditItemAdds(item) {
			if err := ensureLyricsRoot(plan.rootAbsolute); err != nil {
				return restore(err)
			}
			break
		}
	}
	for index, item := range plan.Items {
		if item.Action != "move_local" {
			continue
		}
		if err := os.Rename(item.sourceAbsolute, lyricsEditStagedPath(stagingRoot, index)); err != nil {
			return restore(err)
		}
		lifted = append(lifted, index)
	}
	for _, removal := range removals {
		if _, err := s.clearLocalMediaLocation(ctx, removal.LocationID, removal.Path); err != nil {
			_, recovery, restoreErr := restore(err)
			return true, recovery, restoreErr
		}
	}
	for index, item := range plan.Items {
		if !lyricsEditItemAdds(item) {
			continue
		}
		stagedPath := lyricsEditStagedPath(stagingRoot, index)
		info, err := lyricsEditFileIdentity(stagedPath)
		if err != nil {
			return restore(err)
		}
		if err := s.publishLyricsEditItem(plan, stagedPath, item); err != nil {
			_, recovery, restoreErr := restore(err)
			return true, recovery, restoreErr
		}
		published[index] = info
	}
	for _, index := range lifted {
		removeEmptyDirectoriesBelow(plan.rootAbsolute, path.Dir(plan.Items[index].Path))
	}
	for _, removal := range removals {
		if relative, err := fetchPathRelativeToRoot(plan.target.RootPath, removal.Path); err == nil {
			removeEmptyDirectoriesBelow(plan.rootAbsolute, path.Dir(relative))
		}
	}
	removeEmptyLyricsRoot(plan.rootAbsolute)
	return true, false, nil
}

// publishLyricsEditItem moves one collected file to its target. The move is a
// rename on the folder's own filesystem, and it never lands on a file the plan
// did not decide to replace.
func (s *Server) publishLyricsEditItem(plan lyricsEditPlan, stagedPath string, item lyricsEditItem) error {
	relative, err := fetchPathRelativeToRoot(plan.target.RootPath, item.TargetPath)
	if err != nil {
		return err
	}
	destination := filepath.Join(plan.rootAbsolute, filepath.FromSlash(relative))
	if err := mkdirPlainDirectories(plan.rootAbsolute, filepath.Dir(destination)); err != nil {
		return err
	}
	if _, err := os.Lstat(destination); err == nil {
		if item.Resolution != "replace" && item.Status != "replace_target" {
			// The folder changed after the edit was planned.
			return lyricsEditConflictError{Summary: plan.Summary}
		}
		if _, _, err := removeDestructiveFile(s.cfg.DataRoot, item.TargetPath); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.Rename(stagedPath, destination)
}

func lyricsEditAssignmentOrigin(item lyricsEditItem) string {
	switch item.SourceKind {
	case "local":
		return "library_import"
	case "remote":
		return "remote_fetch"
	default:
		return "manual"
	}
}

// declareLyricsEdit stores what the edit means for library lyrics, for the
// files the rescan indexed. References to a moved file follow it to its new
// media item, the assignments that use it take its declared language, and the
// requested assignments are stored in the language of their file. A file the
// scan did not index is skipped, not an error: the files themselves changed.
func (s *Server) declareLyricsEdit(ctx context.Context, userID int64, plan lyricsEditPlan, previous map[int]int64, assignments []lyricsEditAssignment) (int, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	for index, item := range plan.Items {
		if item.Action != "move_local" {
			continue
		}
		lyricsID, ok, err := lyricsEditLyricsItem(ctx, tx, plan.target, item.TargetPath)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		if err := followMovedLyricsItem(ctx, tx, previous[index], lyricsID); err != nil {
			return 0, err
		}
		if err := redeclareLyricsAssignments(ctx, tx, lyricsID, item.Language); err != nil {
			return 0, err
		}
	}
	assigned := 0
	for _, assignment := range assignments {
		item := plan.Items[assignment.item]
		lyricsID, ok, err := lyricsEditLyricsItem(ctx, tx, plan.target, item.TargetPath)
		if err != nil {
			return 0, err
		}
		if !ok {
			continue
		}
		if err := upsertLyricsAssignment(ctx, tx, assignment.audioID, item.Language, lyricsID, lyricsEditAssignmentOrigin(item), userID); err != nil {
			return 0, err
		}
		assigned++
	}
	return assigned, tx.Commit()
}
