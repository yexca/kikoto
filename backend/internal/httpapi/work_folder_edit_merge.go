package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
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
// folder, with the version of it the edit was planned with. Lost marks a file
// the merge check reported without an identical copy in the edited folder;
// any other file is deleted only while such a copy is there.
type workFolderEditMergeFile struct {
	Path      string `json:"path"`
	SizeBytes int64  `json:"sizeBytes"`
	Version   string `json:"version"`
	Lost      bool   `json:"lost,omitempty"`
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
// them too. Kikoto's lyrics folder marker and metadata sidecars are not files
// of the work.
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
		if info.IsDir() || localfs.IsLyricsRootMarker(relative) || workFolderEditMergeSidecarPath(relative) {
			return nil
		}
		if len(files) >= maxWorkFolderEditRemovals {
			return invalidRequestError(fmt.Sprintf("a merged folder can hold at most %d files", maxWorkFolderEditRemovals))
		}
		files = append(files, workFolderEditMergeFile{Path: relative, SizeBytes: info.Size(), Version: localfs.FileVersion(info)})
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

// workFolderEditMergeSidecar reports whether an entry of a merged folder is
// metadata that a NAS or operating system keeps beside the folder's files and
// that every library walk skips: Synology's @eaDir, an archive's __MACOSX, and
// sidecar files such as ._ files, .DS_Store, and Thumbs.db. Such metadata can
// change at any time on its own, so the merge check neither lists nor compares
// it, and it goes with the merged folder. Other folders the library skips,
// such as a recycle bin, can hold the user's files and are listed.
func workFolderEditMergeSidecar(name string, directory bool) bool {
	if !directory {
		return localfs.IsIgnoredFileName(name)
	}
	return localfs.IsMetadataDirectoryName(name)
}

// workFolderEditMergeSidecarPath reports whether a file, by its path below a
// merged folder, is a sidecar or lies in a sidecar folder.
func workFolderEditMergeSidecarPath(relative string) bool {
	parts := strings.Split(relative, "/")
	for index, part := range parts {
		if workFolderEditMergeSidecar(part, index < len(parts)-1) {
			return true
		}
	}
	return false
}

// removeWorkFolderEditMergeSidecars deletes the sidecar folders and files left
// in a merged folder once its files are gone, so the folder itself can go.
// Like every deletion below the library, it refuses links and special files.
func (s *Server) removeWorkFolderEditMergeSidecars(absolute string) error {
	folders, files := []string{}, []string{}
	err := filepath.WalkDir(absolute, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if errors.Is(walkErr, os.ErrNotExist) {
				return nil
			}
			return walkErr
		}
		if current == absolute || !workFolderEditMergeSidecar(entry.Name(), entry.IsDir()) {
			return nil
		}
		if entry.IsDir() {
			folders = append(folders, relativeDataPath(s.cfg.DataRoot, current))
			return fs.SkipDir
		}
		files = append(files, relativeDataPath(s.cfg.DataRoot, current))
		return nil
	})
	if err != nil {
		return err
	}
	for _, folder := range folders {
		if _, err := removeDestructiveTree(s.cfg.DataRoot, folder); err != nil {
			return err
		}
	}
	for _, file := range files {
		if _, _, err := removeDestructiveFile(s.cfg.DataRoot, file); err != nil {
			return err
		}
	}
	return nil
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
// false, files that could be identical are still unhashed. A complete check
// carries Review, which applying the edit sends back: it identifies the files
// the check compared, so an edit whose folders changed since is refused.
type workFolderEditMergeCheck struct {
	Complete     bool                     `json:"complete"`
	CheckedFiles int                      `json:"checkedFiles"`
	PendingFiles int                      `json:"pendingFiles"`
	PendingBytes int64                    `json:"pendingBytes"`
	Lost         []workFolderEditLostFile `json:"lost"`
	Review       string                   `json:"review,omitempty"`
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
	check, _, err := s.workFolderEditMergeLosses(r.Context(), plan, workFolderEditMergeCheckBudget)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, check)
}

type workFolderEditContent struct {
	libraryPath string
	size        int64
	version     string
}

// workFolderEditFinalContents lists the files the edited folder will hold
// whose content is known before the edit runs: the files that stay, and the
// local files the edit copies in, by their source. It also returns the merged
// files the edit copies in, by folder and path. A file an added file replaces
// does not stay.
func (s *Server) workFolderEditFinalContents(ctx context.Context, plan workFolderEditPlan) (map[string]bool, []workFolderEditContent, error) {
	copied := map[string]bool{}
	final := []workFolderEditContent{}
	// Paths compare the way the edited folder's filesystem may compare them, so
	// a file an added file replaces under another case does not count as
	// staying.
	replaced := map[string]bool{}
	for _, item := range plan.Items {
		if !workFolderEditItemAdds(item) {
			continue
		}
		if item.Resolution == "replace" || item.Status == "replace_target" {
			replaced[fetchTargetKey(item.TargetPath)] = true
		}
		if item.Action != "copy_local" {
			continue
		}
		copied[workFolderEditMergeKey(item.SourceFolderID, item.Path)] = true
		if item.SizeBytes != nil {
			final = append(final, workFolderEditContent{
				libraryPath: item.LocalSourcePath, size: *item.SizeBytes, version: s.workFolderEditFileVersion(item.LocalSourcePath),
			})
		}
	}
	removed := map[string]bool{}
	for _, removal := range plan.Removals {
		removed[fetchTargetKey(removal.Path)] = true
	}
	target := workFolderEditFolder{ID: plan.FolderID, WorkID: plan.WorkID, RootPath: plan.SaveRoot}
	if err := s.db.QueryRowContext(ctx, "SELECT file_source_id FROM work_folder_location WHERE id = ?", plan.FolderID).Scan(&target.FileSourceID); err != nil {
		return nil, nil, err
	}
	current, err := s.workFolderEditCurrentPaths(ctx, target)
	if err != nil {
		return nil, nil, err
	}
	for _, file := range current {
		if removed[fetchTargetKey(file)] || replaced[fetchTargetKey(file)] {
			continue
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, file)
		if err != nil {
			continue
		}
		if info, err := os.Lstat(absolute); err == nil && info.Mode().IsRegular() {
			final = append(final, workFolderEditContent{libraryPath: file, size: info.Size(), version: localfs.FileVersion(info)})
		}
	}
	return copied, final, nil
}

func (s *Server) workFolderEditFileVersion(libraryPath string) string {
	absolute, err := safeDataPath(s.cfg.DataRoot, libraryPath)
	if err != nil {
		return ""
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	return localfs.FileVersion(info)
}

// workFolderEditMergeKey identifies a merged file by its folder and its path
// below the folder.
func workFolderEditMergeKey(folderID int64, relative string) string {
	return fmt.Sprintf("%d:%s", folderID, relative)
}

// workFolderEditMergeKeys lists the merged files by folder id, then path.
func workFolderEditMergeKeys(merges []workFolderEditMerge) []string {
	ordered := append([]workFolderEditMerge(nil), merges...)
	sort.SliceStable(ordered, func(i, j int) bool { return ordered[i].FolderID < ordered[j].FolderID })
	keys := []string{}
	for _, merge := range ordered {
		for _, file := range merge.Files {
			keys = append(keys, workFolderEditMergeKey(merge.FolderID, file.Path))
		}
	}
	return keys
}

// workFolderEditMergeReview identifies a complete merge check: every file of
// the merged folders and every file the edited folder will hold, each with its
// version, and the merged files the check reported lost. The review also
// carries those lost files, one bit per merged file in the order of
// workFolderEditMergeKeys, so applying the edit knows which losses were
// reviewed.
func workFolderEditMergeReview(merges []workFolderEditMerge, final []workFolderEditContent, lost map[string]bool) string {
	lines := []string{}
	for _, merge := range merges {
		lines = append(lines, fmt.Sprintf("folder\x00%d\x00%s", merge.FolderID, merge.RootPath))
		for _, file := range merge.Files {
			lines = append(lines, fmt.Sprintf("merge\x00%d\x00%s\x00%s", merge.FolderID, file.Path, file.Version))
		}
	}
	for _, content := range final {
		lines = append(lines, fmt.Sprintf("final\x00%s\x00%s", content.libraryPath, content.version))
	}
	keys := workFolderEditMergeKeys(merges)
	bits := make([]byte, (len(keys)+7)/8)
	for index, key := range keys {
		if lost[key] {
			lines = append(lines, "lost\x00"+key)
			bits[index/8] |= 1 << (index % 8)
		}
	}
	sort.Strings(lines)
	digest := sha256.Sum256([]byte(strings.Join(lines, "\n")))
	return hex.EncodeToString(digest[:]) + "." + base64.RawURLEncoding.EncodeToString(bits)
}

// workFolderEditReviewedLosses reads the lost files a review carries. A
// review that does not fit the merged files carries none, and then does not
// match the review of the same files either.
func workFolderEditReviewedLosses(merges []workFolderEditMerge, review string) map[string]bool {
	lost := map[string]bool{}
	_, encoded, ok := strings.Cut(review, ".")
	if !ok {
		return lost
	}
	keys := workFolderEditMergeKeys(merges)
	bits, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil || len(bits) != (len(keys)+7)/8 {
		return lost
	}
	for index, key := range keys {
		if bits[index/8]&(1<<(index%8)) != 0 {
			lost[key] = true
		}
	}
	return lost
}

// workFolderEditMergeChangedError refuses an edit whose merged or edited
// folder changed after its merge check.
type workFolderEditMergeChangedError struct{}

func (workFolderEditMergeChangedError) Error() string {
	return "a merged folder or the edited folder changed after the merge check; review the merge again"
}

// verifyWorkFolderEditMergeReview refuses to merge folders without a complete
// merge check of the same files, and marks the merged files that check
// reported lost. Only those files may be deleted without a copy: a merged file
// the comparison now finds without one, such as a file that can no longer be
// read, refuses the edit for a new review. Every other merged file must still
// have its identical copy in the edited folder when the merge deletes it; one
// whose comparison is not established again in time counts as having a copy,
// so the merge verifies it.
func (s *Server) verifyWorkFolderEditMergeReview(ctx context.Context, plan workFolderEditPlan, review string) error {
	if len(plan.Merges) == 0 {
		return nil
	}
	if strings.TrimSpace(review) == "" {
		return invalidRequestError("merging folders needs a completed merge check")
	}
	reviewed := workFolderEditReviewedLosses(plan.Merges, review)
	_, final, err := s.workFolderEditFinalContents(ctx, plan)
	if err != nil {
		return err
	}
	if workFolderEditMergeReview(plan.Merges, final, reviewed) != review {
		return workFolderEditMergeChangedError{}
	}
	_, lost, err := s.workFolderEditMergeLosses(ctx, plan, workFolderEditMergeCheckBudget)
	if err != nil {
		return err
	}
	for key := range lost {
		if !reviewed[key] {
			return workFolderEditMergeChangedError{}
		}
	}
	for _, merge := range plan.Merges {
		for index, file := range merge.Files {
			merge.Files[index].Lost = reviewed[workFolderEditMergeKey(merge.FolderID, file.Path)]
		}
	}
	return nil
}

// verifyWorkFolderEditMergeCopies checks, before a merged folder loses any
// file, that each of its files the merge check did not report lost still has
// a file of the same size and SHA-256 in the edited folder. A copy that was
// deleted or rewritten since the review stops the edit for a new review.
func (e *workFolderEditExecution) verifyWorkFolderEditMergeCopies(ctx context.Context, merge workFolderEditMerge, present []workFolderEditMergeFile) error {
	kept := map[string]bool{}
	for _, file := range merge.Files {
		kept[file.Path] = !file.Lost
	}
	final := map[int64][]workFolderEditContent{}
	targetRoot := normalizeFolderRootPath(e.payload.TargetRoot)
	err := filepath.WalkDir(e.targetAbs, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative := relativeDataPath(e.targetAbs, current)
		if !entry.Type().IsRegular() || localfs.IsIgnoredPath(relative) {
			// A file the library skips, such as NAS metadata, is no copy.
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		libraryPath := path.Join(targetRoot, relative)
		final[info.Size()] = append(final[info.Size()], workFolderEditContent{libraryPath: libraryPath, size: info.Size()})
		return nil
	})
	if err != nil {
		return fmt.Errorf("the edited folder could not be read to check the merge: %w", err)
	}
	hashes := newWorkFolderEditHashes(e.server, time.Now().Add(24*time.Hour))
	for _, file := range present {
		if !kept[file.Path] {
			continue
		}
		mergedPath := path.Join(normalizeFolderRootPath(merge.RootPath), file.Path)
		matched, _, err := hashes.matchesAny(ctx, mergedPath, final[file.SizeBytes])
		if err != nil {
			return err
		}
		if !matched {
			return fmt.Errorf("%s no longer has an identical copy in the edited folder; review the merge again", mergedPath)
		}
	}
	return nil
}

// workFolderEditMergeLosses compares each merged file with the files the edited
// folder will hold. A merged file the edit copies in is kept by definition;
// any other is kept only when a file of the same size and SHA-256 stays in or
// is copied into the edited folder. A file downloaded from a remote source is
// not compared, since its content is known only once it is downloaded. It
// also returns the lost files by workFolderEditMergeKey.
func (s *Server) workFolderEditMergeLosses(ctx context.Context, plan workFolderEditPlan, budget time.Duration) (workFolderEditMergeCheck, map[string]bool, error) {
	check := workFolderEditMergeCheck{Lost: []workFolderEditLostFile{}}
	lostKeys := map[string]bool{}
	if len(plan.Merges) == 0 {
		check.Complete = true
		return check, lostKeys, nil
	}
	copied, final, err := s.workFolderEditFinalContents(ctx, plan)
	if err != nil {
		return check, lostKeys, err
	}
	bySize := map[int64][]workFolderEditContent{}
	for _, content := range final {
		bySize[content.size] = append(bySize[content.size], content)
	}
	hashes := newWorkFolderEditHashes(s, time.Now().Add(budget))
	for _, merge := range plan.Merges {
		for _, file := range merge.Files {
			key := workFolderEditMergeKey(merge.FolderID, file.Path)
			if copied[key] {
				continue
			}
			lost := workFolderEditLostFile{FolderID: merge.FolderID, Path: path.Join(merge.RootPath, file.Path), SizeBytes: file.SizeBytes}
			candidates := bySize[file.SizeBytes]
			if len(candidates) == 0 {
				check.Lost = append(check.Lost, lost)
				lostKeys[key] = true
				continue
			}
			kept, known, err := hashes.matchesAny(ctx, lost.Path, candidates)
			if err != nil {
				return check, lostKeys, err
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
				lostKeys[key] = true
			}
		}
	}
	check.Complete = check.PendingFiles == 0
	if check.Complete {
		check.Review = workFolderEditMergeReview(plan.Merges, final, lostKeys)
	}
	return check, lostKeys, nil
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

// activeRemoteFetchForWork refuses to merge away a folder of a work that a
// Fetch is still filling.
func activeRemoteFetchForWork(ctx context.Context, queryer rowQueryer, workID int64) error {
	var code string
	if err := queryer.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if _, found, err := activeRemoteFetchResult(ctx, queryer, code); err != nil {
		return err
	} else if found {
		return conflictError(fmt.Sprintf("a Fetch for %s, whose folder the edit merges, is still running; wait for it to finish", code))
	}
	return nil
}

// mergeFolders deletes each merged folder once the edited folder is complete.
// A merged folder must still hold exactly the files the edit was planned
// with, so nothing added since the review is deleted unseen. Each deleted
// file's location turns unavailable with the deletion, and a folder an earlier
// attempt already cleared counts as merged, so a stopped merge never leaves a
// deleted file reading available and a resumed one finishes where it stopped.
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
		cleared, err := s.workFolderEditMergeCleared(statusCtx, merge)
		if err != nil {
			return err
		}
		if cleared {
			e.progress += merge.FileCount
		} else if err := e.mergeFolder(ctx, merge); err != nil {
			return err
		}
		e.checkpoint.Merged = append(e.checkpoint.Merged, merge.FolderID)
		if err := e.saveCheckpoint(statusCtx, "merge"); err != nil {
			return err
		}
	}
	return s.updateRemoteFetchPhaseNode(ctx, e.job.RunID, "merge", "succeeded", map[string]any{"merged": len(e.checkpoint.Merged)})
}

func (e *workFolderEditExecution) mergeFolder(ctx context.Context, merge workFolderEditMerge) error {
	s := e.server
	statusCtx := context.WithoutCancel(ctx)
	// A Fetch of the merged folder's work may publish into it.
	if err := activeRemoteFetchForWork(ctx, s.db, merge.WorkID); err != nil {
		return err
	}
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
	// An earlier attempt may have deleted the folder itself before it could
	// record the folder as gone.
	present := []workFolderEditMergeFile{}
	if _, err := os.Lstat(absolute); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	} else if err == nil {
		if present, err = workFolderEditMergeFiles(absolute); err != nil {
			return err
		}
	}
	planned := map[string]workFolderEditMergeFile{}
	for _, file := range merge.Files {
		planned[file.Path] = file
	}
	for _, file := range present {
		// A file already deleted by an earlier attempt is simply absent.
		if reviewed, ok := planned[file.Path]; !ok || reviewed.SizeBytes != file.SizeBytes || reviewed.Version != file.Version {
			return fmt.Errorf("%s changed after the edit was planned; review the merge again", path.Join(merge.RootPath, file.Path))
		}
	}
	if err := e.verifyWorkFolderEditMergeCopies(ctx, merge, present); err != nil {
		return err
	}
	for _, file := range present {
		deleted, err := s.removeWorkFolderEditMergedFile(statusCtx, merge, file.Path)
		if err != nil {
			return err
		}
		if deleted {
			e.checkpoint.Deleted++
		}
		e.progress++
	}
	if err := s.removeWorkFolderEditMergeSidecars(absolute); err != nil {
		return err
	}
	_, err = s.clearLocalWorkRoot(statusCtx, target)
	return err
}

// removeWorkFolderEditMergedFile deletes one file of a merged folder and marks
// its indexed location unavailable at once.
func (s *Server) removeWorkFolderEditMergedFile(ctx context.Context, merge workFolderEditMerge, relative string) (bool, error) {
	libraryPath := path.Join(normalizeFolderRootPath(merge.RootPath), relative)
	deleted, _, err := removeDestructiveFile(s.cfg.DataRoot, libraryPath)
	if err != nil {
		return false, err
	}
	err = withDatabaseBusyRetry(ctx, func() error {
		_, err := s.db.ExecContext(ctx, `
			UPDATE media_file_location
			SET availability = 'unavailable', last_checked_at = CURRENT_TIMESTAMP
			WHERE file_source_id = ? AND location_type = 'local' AND path = ?
				AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
		`, merge.FileSourceID, libraryPath, merge.WorkID)
		return err
	})
	return deleted, err
}

// workFolderEditMergeCleared reports whether an earlier attempt already
// deleted a merged folder and recorded it as gone: the folder is no longer
// part of the library and nothing is left on disk.
func (s *Server) workFolderEditMergeCleared(ctx context.Context, merge workFolderEditMerge) (bool, error) {
	var state string
	err := withDatabaseBusyRetry(ctx, func() error {
		return s.db.QueryRowContext(ctx, `
			SELECT state FROM work_folder_location
			WHERE id = ? AND work_id = ? AND file_source_id = ? AND root_path = ?
		`, merge.FolderID, merge.WorkID, merge.FileSourceID, normalizeFolderRootPath(merge.RootPath)).Scan(&state)
	})
	if errors.Is(err, sql.ErrNoRows) || (err == nil && state != "ignored") {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	absolute, err := safeDataPath(s.cfg.DataRoot, merge.RootPath)
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
