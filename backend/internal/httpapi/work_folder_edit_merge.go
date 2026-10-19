package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

// A folder edit can merge other local folders of the family into the edited
// folder: the files selected from a merged folder are copied in like any
// addition, and once the edited folder is complete the merged folder is
// deleted with everything it still holds. Before the edit is applied, a check
// reports the files of a merged folder that have no copy with identical
// content in the edited folder as it will be, since deleting them loses them.

// workFolderEditMergeFile is a file of a merged folder, by its path below the
// folder.
type workFolderEditMergeFile struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

// workFolderEditMerge is a local folder of the family that the edit deletes
// once the edited folder holds what it takes from it.
type workFolderEditMerge struct {
	FolderID     int64                     `json:"folderId"`
	WorkID       int64                     `json:"workId"`
	FileSourceID int64                     `json:"fileSourceId"`
	RootPath     string                    `json:"rootPath"`
	FileCount    int                       `json:"fileCount"`
	Bytes        int64                     `json:"bytes"`
	Files        []workFolderEditMergeFile `json:"files,omitempty"`
}

// workFolderEditMerges resolves the folders to merge. Each is another active
// local folder of the family, neither inside the edited folder nor holding
// it, and contains only plain folders and regular files.
func (s *Server) workFolderEditMerges(ctx context.Context, family map[int64]bool, target workFolderEditFolder, folderIDs []int64) ([]workFolderEditMerge, error) {
	merges := []workFolderEditMerge{}
	seen := map[int64]bool{}
	for _, folderID := range folderIDs {
		if folderID <= 0 || seen[folderID] {
			continue
		}
		seen[folderID] = true
		folder, err := s.workFolderEditFolder(ctx, family, folderID)
		if err != nil {
			return nil, err
		}
		if folder.ID == target.ID || strings.EqualFold(folder.RootPath, target.RootPath) {
			return nil, invalidRequestError("the edited folder cannot be merged into itself")
		}
		if mediaCleanupPathWithinRoot(folder.RootPath, target.RootPath) || mediaCleanupPathWithinRoot(target.RootPath, folder.RootPath) {
			return nil, invalidRequestError("a folder inside the edited folder, or one holding it, cannot be merged")
		}
		if _, err := validateDestructivePath(s.cfg.DataRoot, folder.RootPath, false, true); err != nil {
			return nil, invalidRequestError("a merged folder cannot be deleted from the library")
		}
		files, err := workFolderEditMergeFiles(folder.Absolute)
		if err != nil {
			return nil, err
		}
		merge := workFolderEditMerge{
			FolderID: folder.ID, WorkID: folder.WorkID, FileSourceID: folder.FileSourceID,
			RootPath: folder.RootPath, FileCount: len(files), Files: files,
		}
		for _, file := range files {
			merge.Bytes += file.SizeBytes
		}
		merges = append(merges, merge)
	}
	return merges, nil
}

// workFolderEditMergeFiles lists every file below a merged folder on disk,
// including files the index does not hold, since deleting the folder deletes
// them too. Kikoto's lyrics folder marker is not a file of the work.
func workFolderEditMergeFiles(root string) ([]workFolderEditMergeFile, error) {
	files := []workFolderEditMergeFile{}
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative := relativeDataPath(root, current)
		if unsafeFetchStagingEntry(info) || (!info.IsDir() && !info.Mode().IsRegular()) {
			return invalidRequestError("a merged folder holds a link or special file at " + relative + "; remove it first")
		}
		if info.IsDir() || localfs.IsLyricsRootMarker(relative) {
			return nil
		}
		if len(files) >= maxWorkFolderEditRemovals {
			return invalidRequestError(fmt.Sprintf("a merged folder can hold at most %d files", maxWorkFolderEditRemovals))
		}
		files = append(files, workFolderEditMergeFile{Path: relative, SizeBytes: info.Size()})
		return nil
	})
	if err != nil {
		var requestErr *requestError
		if errors.As(err, &requestErr) {
			return nil, err
		}
		return nil, conflictError("a merged folder could not be read")
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files, nil
}

// publicWorkFolderEditMerges leaves out the file lists, which the merge check
// reports where it matters.
func publicWorkFolderEditMerges(merges []workFolderEditMerge) []workFolderEditMerge {
	public := make([]workFolderEditMerge, len(merges))
	for index, merge := range merges {
		merge.Files = nil
		public[index] = merge
	}
	return public
}

// workFolderEditMergeCheckBudget bounds how long one check spends hashing; the
// next check continues from the hashes this one stored.
const workFolderEditMergeCheckBudget = 20 * time.Second

type workFolderEditLostFile struct {
	FolderID  int64  `json:"folderId"`
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
}

// workFolderEditMergeCheck reports the files of the merged folders that the
// edited folder will not hold with identical content. While Complete is
// false, files that could be identical are still unhashed.
type workFolderEditMergeCheck struct {
	Complete     bool                     `json:"complete"`
	CheckedFiles int                      `json:"checkedFiles"`
	PendingFiles int                      `json:"pendingFiles"`
	PendingBytes int64                    `json:"pendingBytes"`
	Lost         []workFolderEditLostFile `json:"lost"`
}

func (s *Server) checkWorkFolderEditMerge(w http.ResponseWriter, r *http.Request) {
	workID, payload, ok := s.parseWorkFolderEditRequest(w, r)
	if !ok {
		return
	}
	payload.Assignments = nil
	if _, ok := s.requireWorkFolderEdit(w, r, payload); !ok {
		return
	}
	plan, err := s.buildWorkFolderEditPlan(r.Context(), workID, payload)
	if err != nil {
		writeWorkFolderEditError(w, err)
		return
	}
	check, err := s.workFolderEditMergeLosses(r.Context(), plan, workFolderEditMergeCheckBudget)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, check)
}

type workFolderEditContent struct {
	libraryPath string
	size        int64
}

// workFolderEditMergeLosses compares each merged file with the files the edited
// folder will hold. A merged file the edit copies in is kept by definition;
// any other is kept only when a file of the same size and SHA-256 stays in or
// is copied into the edited folder. A file downloaded from a remote source is
// not compared, since its content is known only once it is downloaded.
func (s *Server) workFolderEditMergeLosses(ctx context.Context, plan workFolderEditPlan, budget time.Duration) (workFolderEditMergeCheck, error) {
	check := workFolderEditMergeCheck{Lost: []workFolderEditLostFile{}}
	if len(plan.Merges) == 0 {
		check.Complete = true
		return check, nil
	}
	copied := map[string]bool{}
	final := []workFolderEditContent{}
	for _, item := range plan.Items {
		if item.Action != "copy_local" {
			continue
		}
		copied[fmt.Sprintf("%d:%s", item.SourceFolderID, item.Path)] = true
		if item.SizeBytes != nil {
			final = append(final, workFolderEditContent{libraryPath: item.LocalSourcePath, size: *item.SizeBytes})
		}
	}
	removed := map[string]bool{}
	for _, removal := range plan.Removals {
		removed[removal.Path] = true
	}
	target := workFolderEditFolder{ID: plan.FolderID, WorkID: plan.WorkID, RootPath: plan.SaveRoot}
	if err := s.db.QueryRowContext(ctx, "SELECT file_source_id FROM work_folder_location WHERE id = ?", plan.FolderID).Scan(&target.FileSourceID); err != nil {
		return check, err
	}
	current, err := s.workFolderEditCurrentPaths(ctx, target)
	if err != nil {
		return check, err
	}
	for _, file := range current {
		if removed[file] {
			continue
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, file)
		if err != nil {
			continue
		}
		if info, err := os.Lstat(absolute); err == nil && info.Mode().IsRegular() {
			final = append(final, workFolderEditContent{libraryPath: file, size: info.Size()})
		}
	}
	bySize := map[int64][]workFolderEditContent{}
	for _, content := range final {
		bySize[content.size] = append(bySize[content.size], content)
	}
	hashes := newWorkFolderEditHashes(s, time.Now().Add(budget))
	for _, merge := range plan.Merges {
		for _, file := range merge.Files {
			if copied[fmt.Sprintf("%d:%s", merge.FolderID, file.Path)] {
				continue
			}
			lost := workFolderEditLostFile{FolderID: merge.FolderID, Path: path.Join(merge.RootPath, file.Path), SizeBytes: file.SizeBytes}
			candidates := bySize[file.SizeBytes]
			if len(candidates) == 0 {
				check.Lost = append(check.Lost, lost)
				continue
			}
			kept, known, err := hashes.matchesAny(ctx, lost.Path, candidates)
			if err != nil {
				return check, err
			}
			switch {
			case !known:
				check.PendingFiles++
				check.PendingBytes += file.SizeBytes
			case kept:
				check.CheckedFiles++
			default:
				check.CheckedFiles++
				check.Lost = append(check.Lost, lost)
			}
		}
	}
	check.Complete = check.PendingFiles == 0
	return check, nil
}

// workFolderEditHashes hashes library files once per check, reusing and
// storing the hash cached on their indexed locations. After the deadline it
// still answers from what it already knows.
type workFolderEditHashes struct {
	server   *Server
	deadline time.Time
	known    map[string]string
	hashed   int
}

const workFolderEditUnreadable = "-"

func newWorkFolderEditHashes(server *Server, deadline time.Time) *workFolderEditHashes {
	return &workFolderEditHashes{server: server, deadline: deadline, known: map[string]string{}}
}

// matchesAny reports whether the file at libraryPath has the content of one
// of the candidates, and whether that could be established in time.
func (h *workFolderEditHashes) matchesAny(ctx context.Context, libraryPath string, candidates []workFolderEditContent) (bool, bool, error) {
	hash, ok, err := h.hash(ctx, libraryPath)
	if err != nil || !ok {
		return false, false, err
	}
	if hash == workFolderEditUnreadable {
		return false, true, nil
	}
	known := true
	for _, candidate := range candidates {
		if candidate.libraryPath == libraryPath {
			continue
		}
		other, ok, err := h.hash(ctx, candidate.libraryPath)
		if err != nil {
			return false, false, err
		}
		if !ok {
			known = false
			continue
		}
		if other == hash {
			return true, true, nil
		}
	}
	return false, known, nil
}

func (h *workFolderEditHashes) hash(ctx context.Context, libraryPath string) (string, bool, error) {
	if hash, ok := h.known[libraryPath]; ok {
		return hash, true, nil
	}
	s := h.server
	absolute, err := safeDataPath(s.cfg.DataRoot, libraryPath)
	if err != nil {
		h.known[libraryPath] = workFolderEditUnreadable
		return workFolderEditUnreadable, true, nil
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.Mode().IsRegular() {
		h.known[libraryPath] = workFolderEditUnreadable
		return workFolderEditUnreadable, true, nil
	}
	version := localfs.FileVersion(info)
	var cached string
	err = s.db.QueryRowContext(ctx, `
		SELECT content_hash FROM media_file_location
		WHERE location_type = 'local' AND path = ? AND content_hash <> '' AND content_hash_version = ?
		ORDER BY id LIMIT 1
	`, libraryPath, version).Scan(&cached)
	if err == nil {
		h.known[libraryPath] = cached
		return cached, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return "", false, err
	}
	// Always hash one file, so every check makes progress.
	if h.hashed > 0 && !time.Now().Before(h.deadline) {
		return "", false, nil
	}
	h.hashed++
	hash, err := hashFileContext(ctx, absolute)
	if err != nil {
		if ctx.Err() != nil {
			return "", false, ctx.Err()
		}
		h.known[libraryPath] = workFolderEditUnreadable
		return workFolderEditUnreadable, true, nil
	}
	after, err := os.Lstat(absolute)
	if err != nil || localfs.FileVersion(after) != version {
		h.known[libraryPath] = workFolderEditUnreadable
		return workFolderEditUnreadable, true, nil
	}
	h.known[libraryPath] = hash
	if _, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location SET content_hash = ?, content_hash_version = ?
		WHERE location_type = 'local' AND path = ?
	`, hash, version, libraryPath); err != nil {
		return "", false, err
	}
	return hash, true, nil
}

// mergeFolders deletes each merged folder once the edited folder is complete.
// A merged folder must still hold exactly the files the edit was planned
// with, so nothing added since the review is deleted unseen.
func (e *workFolderEditExecution) mergeFolders(ctx context.Context) error {
	s := e.server
	if err := s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "merge", "running", nil); err != nil {
		return err
	}
	done := map[int64]bool{}
	for _, folderID := range e.checkpoint.Merged {
		done[folderID] = true
	}
	for _, merge := range e.payload.Merges {
		if done[merge.FolderID] {
			continue
		}
		if err := s.ensureWorkflowRunActive(ctx, e.job.RunID); err != nil {
			return err
		}
		if err := s.ensureLibraryPathOnline(ctx, merge.RootPath); err != nil {
			return err
		}
		statusCtx := context.WithoutCancel(ctx)
		target := mediaCleanupTarget{
			Kind: "local_root", FolderID: merge.FolderID, WorkID: merge.WorkID, SourceID: merge.FileSourceID,
			Path: merge.RootPath, ExpectedPath: merge.RootPath, CleanupRunID: e.job.RunID,
		}
		if err := s.claimMediaCleanupFolder(statusCtx, target, e.job.RunID); err != nil {
			return err
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, merge.RootPath)
		if err != nil {
			return err
		}
		present, err := workFolderEditMergeFiles(absolute)
		if err != nil {
			return err
		}
		planned := map[string]int64{}
		for _, file := range merge.Files {
			planned[file.Path] = file.SizeBytes
		}
		for _, file := range present {
			// A file already deleted by an earlier attempt is simply absent.
			if size, ok := planned[file.Path]; !ok || size != file.SizeBytes {
				return fmt.Errorf("%s changed after the edit was planned; review the merge again", path.Join(merge.RootPath, file.Path))
			}
		}
		for _, file := range present {
			deleted, _, err := removeDestructiveFile(s.cfg.DataRoot, path.Join(merge.RootPath, file.Path))
			if err != nil {
				return err
			}
			if deleted {
				e.checkpoint.Deleted++
			}
			e.progress++
		}
		if _, err := s.clearLocalWorkRoot(statusCtx, target); err != nil {
			return err
		}
		e.checkpoint.Merged = append(e.checkpoint.Merged, merge.FolderID)
		if err := e.saveCheckpoint(statusCtx, "merge"); err != nil {
			return err
		}
	}
	return s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "merge", "succeeded", map[string]any{"merged": len(e.checkpoint.Merged)})
}
