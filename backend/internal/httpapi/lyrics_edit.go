package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// A lyrics edit is one request. The bounds keep it from holding the folder for
// an unbounded tree or collecting an unbounded amount of text.
const (
	maxLyricsEditAdditions   = 2000
	maxLyricsEditStagedBytes = 128 << 20
)

type lyricsEditAdditionRequest struct {
	// Kind is "folder" for a file of the edited folder itself, "local" for a
	// file of another local folder of the family, and "remote" for a file a
	// configured source offers for a family edition.
	Kind       string `json:"kind"`
	FolderID   int64  `json:"folderId,omitempty"`
	SourceID   int64  `json:"sourceId,omitempty"`
	RemoteCode string `json:"remoteCode,omitempty"`
	// Path is relative to the edited folder, the source folder, or the remote
	// edition's tree.
	Path string `json:"path"`
	// Language declares the language of the file; empty applies to every
	// language. It is required, because a language is never inferred.
	Language *string `json:"language"`
}

// lyricsEditAssignmentIn names an added file, by its item key, as the library
// lyrics of a local audio file in the file's language.
type lyricsEditAssignmentIn struct {
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	ItemKey          string `json:"itemKey"`
}

type lyricsEditRequest struct {
	FolderID  int64                       `json:"folderId"`
	Additions []lyricsEditAdditionRequest `json:"additions"`
	// FolderMode is "copy" or "move" for the added files of the edited folder
	// outside Kikoto's lyrics folder; empty takes the administrator's default.
	FolderMode        string                    `json:"folderMode,omitempty"`
	RemoveLocationIDs []int64                   `json:"removeLocationIds"`
	Decisions         []remoteFetchFileDecision `json:"decisions"`
	Assignments       []lyricsEditAssignmentIn  `json:"assignments"`
}

// lyricsEditItem is one lyrics file to bring into a language's lyrics folder.
// It shares the Fetch plan item's shape so every review resolves conflicts the
// same way.
type lyricsEditItem struct {
	remoteWorkSavePlanItem
	Language       string `json:"language"`
	SourceFolderID int64  `json:"sourceFolderId,omitempty"`
	RemoteCode     string `json:"remoteCode,omitempty"`

	// sourceRoot is the folder a moved or copied file lies in and
	// sourceAbsolute the file itself; remote is the source a download uses.
	sourceRoot     string
	sourceAbsolute string
	remote         remoteSourceForUse
	// copyFolder copies a file of the edited folder instead of moving it.
	copyFolder bool
}

type lyricsEditSummary struct {
	Add      int `json:"add"`
	Move     int `json:"move"`
	Copy     int `json:"copy"`
	Download int `json:"download"`
	Skip     int `json:"skip"`
	Conflict int `json:"conflict"`
	Remove   int `json:"remove"`
}

type lyricsEditPlan struct {
	WorkID   int64 `json:"workId"`
	FolderID int64 `json:"folderId"`
	// FolderMode is how the plan brings files of the edited folder in.
	FolderMode string `json:"folderMode"`
	// SaveRoot is the edited folder, relative to the data root.
	SaveRoot string                  `json:"saveRoot"`
	Items    []lyricsEditItem        `json:"items"`
	Removals []workFolderEditRemoval `json:"removals"`
	Summary  lyricsEditSummary       `json:"summary"`

	target       lyricsFetchTarget
	rootAbsolute string
}

type lyricsEditResult struct {
	WorkID     int64  `json:"workId"`
	SaveRoot   string `json:"saveRoot"`
	Moved      int    `json:"moved"`
	Copied     int    `json:"copied"`
	Downloaded int    `json:"downloaded"`
	Removed    int    `json:"removed"`
	Skipped    int    `json:"skipped"`
	Assigned   int    `json:"assigned"`
}

// lyricsEditConflictError rejects an edit whose additions still collide with
// files of the folder, so the caller reviews a fresh preview.
type lyricsEditConflictError struct {
	Summary lyricsEditSummary
}

func (err lyricsEditConflictError) Error() string {
	return "the lyrics edit has file conflicts; review the result before applying"
}

func (s *Server) parseLyricsEditRequest(w http.ResponseWriter, r *http.Request) (currentUser, int64, lyricsEditRequest, bool) {
	actor, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return currentUser{}, 0, lyricsEditRequest{}, false
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return currentUser{}, 0, lyricsEditRequest{}, false
	}
	var payload lyricsEditRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return currentUser{}, 0, lyricsEditRequest{}, false
	}
	return actor, workID, payload, true
}

// planWorkLyricsEdit previews an edit of the lyrics Kikoto manages in one
// local work folder. It never changes a file.
func (s *Server) planWorkLyricsEdit(w http.ResponseWriter, r *http.Request) {
	_, workID, payload, ok := s.parseLyricsEditRequest(w, r)
	if !ok {
		return
	}
	plan, err := s.buildLyricsEditPlan(r.Context(), workID, payload)
	if err != nil {
		writeLyricsEditError(w, workID, err)
		return
	}
	for index := range plan.Items {
		// A review of the edit does not need the download addresses.
		plan.Items[index].SourcePath = ""
	}
	writeJSON(w, http.StatusOK, plan)
}

// applyWorkLyricsEdit edits the lyrics Kikoto manages in one local work
// folder: it moves lyrics files of the folder into a language's lyrics folder,
// copies them there from another local folder of the family, downloads them
// from a remote edition, and deletes the managed lyrics taken out. A file that
// is already at a target is replaced only when the request decides so.
func (s *Server) applyWorkLyricsEdit(w http.ResponseWriter, r *http.Request) {
	actor, workID, payload, ok := s.parseLyricsEditRequest(w, r)
	if !ok {
		return
	}
	if len(payload.Assignments) > 0 && !userHasPermission(actor, "library:write") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "library:write permission is required to assign lyrics"})
		return
	}
	// An edit that has started finishes even when the client goes away, so the
	// folder and its index do not disagree.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), lyricsFetchRequestTimeout)
	defer cancel()
	result, err := s.runLyricsEdit(ctx, actor.ID, workID, payload)
	if err != nil {
		writeLyricsEditError(w, workID, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// writeLyricsEditError keeps upstream details and local paths in the server
// log; the response carries fixed messages only.
func writeLyricsEditError(w http.ResponseWriter, workID int64, err error) {
	var conflict lyricsEditConflictError
	if errors.As(err, &conflict) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": conflict.Error(), "code": "lyrics_edit_conflict", "summary": conflict.Summary})
		return
	}
	var requestErr lyricsFetchRequestError
	if errors.As(err, &requestErr) {
		if requestErr.code != "" {
			writeAPIError(w, requestErr.status, requestErr.code, requestErr.message, false)
			return
		}
		writeJSON(w, requestErr.status, map[string]string{"error": requestErr.message})
		return
	}
	var symlinkErr symlinkMediaLocationError
	var cleanupConflict mediaCleanupTargetConflictError
	if errors.As(err, &symlinkErr) || errors.As(err, &cleanupConflict) {
		writeMediaCleanupError(w, err)
		return
	}
	if writeRequestError(w, err) {
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	if writeLibraryStorageError(w, err) {
		return
	}
	slog.Warn("lyrics edit failed", "work_id", workID, "error", err)
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "the lyrics could not be changed"})
}

// buildLyricsEditPlan resolves a requested edit against the folder as it is on
// disk. It never changes a file.
func (s *Server) buildLyricsEditPlan(ctx context.Context, workID int64, payload lyricsEditRequest) (lyricsEditPlan, error) {
	if len(payload.Additions) > maxLyricsEditAdditions {
		return lyricsEditPlan{}, lyricsFetchBadRequest(fmt.Sprintf("at most %d lyrics files can be added at once", maxLyricsEditAdditions))
	}
	if len(payload.RemoveLocationIDs) > maxLyricsEditAdditions {
		return lyricsEditPlan{}, lyricsFetchBadRequest(fmt.Sprintf("at most %d lyrics files can be removed at once", maxLyricsEditAdditions))
	}
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return lyricsEditPlan{}, err
	}
	target, err := s.lyricsFetchTarget(ctx, family, payload.FolderID)
	if err != nil {
		return lyricsEditPlan{}, err
	}
	if target.WorkID != workID {
		return lyricsEditPlan{}, lyricsFetchBadRequest("choose an active local folder of this work")
	}
	rootAbsolute, err := safeDataPath(s.cfg.DataRoot, target.RootPath)
	if err != nil {
		return lyricsEditPlan{}, err
	}
	if len(payload.Additions) > 0 {
		if err := checkLyricsRootWritable(rootAbsolute); err != nil {
			return lyricsEditPlan{}, err
		}
	}
	removals, err := s.lyricsEditRemovals(ctx, target, rootAbsolute, payload.RemoveLocationIDs)
	if err != nil {
		return lyricsEditPlan{}, err
	}
	removing := map[string]bool{}
	for _, removal := range removals {
		removing[fetchTargetKey(removal.Path)] = true
	}
	folderMode := s.folderLyricsMode(ctx)
	if strings.TrimSpace(payload.FolderMode) != "" {
		mode, ok := parseFolderLyricsMode(payload.FolderMode)
		if !ok {
			return lyricsEditPlan{}, lyricsFetchBadRequest("folderMode must be copy or move")
		}
		folderMode = mode
	}
	items, err := s.lyricsEditCandidates(ctx, family, target, rootAbsolute, payload.Additions)
	if err != nil {
		return lyricsEditPlan{}, err
	}
	for index := range items {
		// Managed lyrics that change language always move, so the language
		// folders never hold two copies of one file.
		items[index].copyFolder = folderMode == folderLyricsCopy && items[index].SourceKind == "folder" &&
			!managedLyricsPath(items[index].Path)
	}
	decisions := normalizeRemoteFetchDecisions(payload.Decisions)
	seenTargets := map[string]string{}
	base := make([]remoteWorkSavePlanItem, len(items))
	for index := range items {
		if err := s.resolveLyricsEditItem(&items[index], decisions[items[index].ItemKey], target.RootPath, removing, seenTargets); err != nil {
			return lyricsEditPlan{}, err
		}
		base[index] = items[index].remoteWorkSavePlanItem
	}
	validateResolvedFetchTargets(base)
	for index := range items {
		items[index].remoteWorkSavePlanItem = base[index]
	}
	return lyricsEditPlan{
		WorkID: workID, FolderID: payload.FolderID, FolderMode: folderMode, SaveRoot: target.RootPath,
		Items: items, Removals: removals, Summary: summarizeLyricsEdit(items, removals),
		target: target, rootAbsolute: rootAbsolute,
	}, nil
}

// lyricsEditItemAdds reports whether the plan brings the item's file into the
// folder.
func lyricsEditItemAdds(item lyricsEditItem) bool {
	return item.Action == "move_local" || item.Action == "copy_local" || item.Action == "cache_download"
}

func summarizeLyricsEdit(items []lyricsEditItem, removals []workFolderEditRemoval) lyricsEditSummary {
	summary := lyricsEditSummary{Remove: len(removals)}
	for _, item := range items {
		switch item.Action {
		case "move_local":
			summary.Move++
		case "copy_local":
			summary.Copy++
		case "cache_download":
			summary.Download++
		case "conflict":
			summary.Conflict++
			continue
		default:
			summary.Skip++
			continue
		}
		summary.Add++
	}
	return summary
}

// lyricsEditRemovals resolves the files to delete. Each must be a lyrics file
// in one of the edited folder's language lyrics folders, inside a lyrics
// folder Kikoto created.
func (s *Server) lyricsEditRemovals(ctx context.Context, target lyricsFetchTarget, rootAbsolute string, locationIDs []int64) ([]workFolderEditRemoval, error) {
	removals := make([]workFolderEditRemoval, 0, len(locationIDs))
	owned := len(locationIDs) == 0 || lyricsRootOwned(rootAbsolute)
	seen := map[int64]bool{}
	for _, locationID := range locationIDs {
		if locationID <= 0 || seen[locationID] {
			continue
		}
		seen[locationID] = true
		var removal workFolderEditRemoval
		var workID, sourceID int64
		var locationType string
		var size sql.NullInt64
		err := s.db.QueryRowContext(ctx, `
			SELECT location.id, item.work_id, location.file_source_id, location.location_type, location.path, location.size_bytes
			FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			WHERE location.id = ?
		`, locationID).Scan(&removal.LocationID, &workID, &sourceID, &locationType, &removal.Path, &size)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, lyricsFetchRequestError{status: http.StatusConflict, message: "a lyrics file to remove is no longer listed; refresh the work and try again"}
		}
		if err != nil {
			return nil, err
		}
		removal.Path = normalizeFolderRootPath(removal.Path)
		relative := strings.TrimPrefix(removal.Path, target.RootPath+"/")
		if locationType != "local" || workID != target.WorkID || sourceID != target.FileSourceID ||
			relative == removal.Path || !managedLyricsPath(relative) || !owned {
			return nil, lyricsFetchBadRequest("only lyrics Kikoto manages in this folder can be removed here")
		}
		if size.Valid {
			value := size.Int64
			removal.SizeBytes = &value
		}
		removals = append(removals, removal)
	}
	return removals, nil
}

type lyricsEditRemoteTree struct {
	source remoteSourceForUse
	files  map[string]remoteSaveFile
}

// lyricsEditCandidates resolves every requested addition to its source file,
// in request order, before any target is decided.
func (s *Server) lyricsEditCandidates(ctx context.Context, family map[int64]bool, target lyricsFetchTarget, rootAbsolute string, additions []lyricsEditAdditionRequest) ([]lyricsEditItem, error) {
	localFolders := map[int64]lyricsSourceFolder{}
	remoteTrees := map[string]lyricsEditRemoteTree{}
	seen := map[string]bool{}
	downloads := 0
	items := make([]lyricsEditItem, 0, len(additions))
	for _, addition := range additions {
		relative := cleanRemoteRelativePath(addition.Path)
		if relative == "" || mediaKindFromPath(relative) != "text" {
			return nil, lyricsFetchBadRequest("only lyrics text files can be added")
		}
		if addition.Language == nil {
			return nil, lyricsFetchBadRequest("declare the language of the lyrics")
		}
		language, ok := normalizeLyricsLanguage(*addition.Language)
		if !ok {
			return nil, lyricsFetchBadRequest("unsupported lyrics language")
		}
		item := lyricsEditItem{Language: language}
		switch strings.TrimSpace(addition.Kind) {
		case "folder":
			info, ok := regularFileBelow(rootAbsolute, relative)
			if !ok {
				return nil, errLyricsFileGone
			}
			size := info.Size()
			item.sourceRoot = rootAbsolute
			item.sourceAbsolute = filepath.Join(rootAbsolute, filepath.FromSlash(relative))
			item.remoteWorkSavePlanItem = remoteWorkSavePlanItem{
				ItemKey: "folder:" + relative, SizeBytes: &size, SourceKind: "folder",
				LocalSourcePath: path.Join(target.RootPath, relative),
			}
		case "local":
			folder, ok := localFolders[addition.FolderID]
			if !ok {
				loaded, err := s.lyricsSourceFolder(ctx, family, addition.FolderID, target)
				if err != nil {
					return nil, err
				}
				folder = loaded
				localFolders[addition.FolderID] = folder
			}
			info, ok := regularFileBelow(folder.Absolute, relative)
			if !ok {
				return nil, errLyricsFileGone
			}
			size := info.Size()
			if size > maxLyricsFetchFileBytes {
				return nil, lyricsFetchBadRequest("a lyrics file is too large")
			}
			item.SourceFolderID = addition.FolderID
			item.sourceRoot = folder.Absolute
			item.sourceAbsolute = filepath.Join(folder.Absolute, filepath.FromSlash(relative))
			item.remoteWorkSavePlanItem = remoteWorkSavePlanItem{
				ItemKey: fmt.Sprintf("local:%d:%s", addition.FolderID, relative), SizeBytes: &size, SourceKind: "local",
				LocalSourcePath: path.Join(folder.RootPath, relative),
			}
		case "remote":
			code := normalizeWorkCode(addition.RemoteCode)
			if addition.SourceID <= 0 || code == "" {
				return nil, lyricsFetchBadRequest("each remote lyrics file needs its source and edition")
			}
			treeKey := fmt.Sprintf("%d:%s", addition.SourceID, code)
			tree, ok := remoteTrees[treeKey]
			if !ok {
				loaded, err := s.lyricsEditRemoteTree(ctx, family, addition.SourceID, code)
				if err != nil {
					return nil, err
				}
				tree = loaded
				remoteTrees[treeKey] = tree
			}
			file, ok := tree.files[relative]
			if !ok {
				return nil, lyricsFetchRequestError{status: http.StatusNotFound, message: "a selected lyrics file is no longer on the source"}
			}
			address, err := lyricsDownloadAddress(firstNonEmpty(file.DownloadURL, file.StreamURL), tree.source)
			if err != nil {
				return nil, err
			}
			if file.SizeBytes != nil && *file.SizeBytes > maxLyricsFetchFileBytes {
				return nil, lyricsFetchBadRequest("a lyrics file is too large")
			}
			item.RemoteCode = code
			item.remote = tree.source
			item.remoteWorkSavePlanItem = remoteWorkSavePlanItem{
				ItemKey:   fmt.Sprintf("remote:%d:%s:%s", tree.source.ID, code, relative),
				SizeBytes: file.SizeBytes, SourceKind: "remote", SourcePath: address,
				RemoteSourceID: tree.source.ID, RemoteSourceCode: tree.source.Code, RemoteSourceName: tree.source.DisplayName,
				RemotePath: file.Path,
			}
		default:
			return nil, lyricsFetchBadRequest("each added lyrics file must come from this folder, a local folder, or a remote source")
		}
		if seen[item.ItemKey] {
			continue
		}
		seen[item.ItemKey] = true
		if item.SourceKind == "remote" {
			if downloads++; downloads > maxLyricsFetchFiles {
				return nil, lyricsFetchBadRequest(fmt.Sprintf("at most %d lyrics files can be downloaded at once", maxLyricsFetchFiles))
			}
		}
		item.Path = relative
		item.Kind = "text"
		item.LocalPaths = []string{}
		item.SourceOptions = []remoteFetchSourceOption{}
		item.TargetPath = path.Join(target.RootPath, lyricsLanguageFolderPath(language), lyricsFolderRelativePath(relative))
		item.OriginalTargetPath = item.TargetPath
		items = append(items, item)
	}
	return items, nil
}

// lyricsEditRemoteTree reads the lyrics a source offers for an edition of the
// family. The edition is read, not recorded as a work.
func (s *Server) lyricsEditRemoteTree(ctx context.Context, family map[int64]bool, sourceID int64, code string) (lyricsEditRemoteTree, error) {
	if _, err := s.lyricsFetchEditionLanguage(ctx, family, code); err != nil {
		return lyricsEditRemoteTree{}, err
	}
	source, tracks, err := s.lyricsFetchRemoteTree(ctx, sourceID, code)
	if err != nil {
		return lyricsEditRemoteTree{}, err
	}
	files := map[string]remoteSaveFile{}
	for _, file := range flattenRemoteSaveFiles(tracks) {
		key := cleanRemoteRelativePath(file.Path)
		if _, duplicate := files[key]; key != "" && !duplicate && mediaKindFromPath(key) == "text" {
			files[key] = file
		}
	}
	return lyricsEditRemoteTree{source: source, files: files}, nil
}

// lyricsDownloadAddress checks a remote lyrics address against the source's
// outbound policy before any download.
func lyricsDownloadAddress(rawURL string, source remoteSourceForUse) (string, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || rawURL == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || !remotePreviewURLAllowed(parsed, source) {
		return "", lyricsFetchRequestError{status: http.StatusBadGateway, message: "a lyrics file URL is not allowed by the source policy"}
	}
	return parsed.String(), nil
}

// lyricsEditRenameTarget is the target a rename decision asks for. The file
// stays a lyrics file in the lyrics folder of its declared language.
func lyricsEditRenameTarget(rootPath string, folderName string, requested string) (string, error) {
	requested = strings.TrimSpace(strings.ReplaceAll(requested, "\\", "/"))
	outside := lyricsFetchBadRequest("a renamed lyrics file must stay in its lyrics folder")
	if requested == "" || path.IsAbs(requested) || filepath.VolumeName(requested) != "" {
		return "", outside
	}
	for _, part := range strings.Split(requested, "/") {
		if part == ".." {
			return "", outside
		}
	}
	relative := lyricsFolderRelativePath(strings.TrimPrefix(cleanRemoteRelativePath(requested), rootPath+"/"))
	if relative == "" || mediaKindFromPath(relative) != "text" {
		return "", lyricsFetchBadRequest("a renamed lyrics file must keep a lyrics file extension")
	}
	return path.Join(rootPath, folderName, relative), nil
}

// resolveLyricsEditItem decides what adding one file does to the folder. A
// target that the same edit removes is replaced; any other file already at the
// target is kept when it has the same content and is a conflict otherwise.
func (s *Server) resolveLyricsEditItem(item *lyricsEditItem, decision remoteFetchFileDecision, targetRoot string, removing map[string]bool, seenTargets map[string]string) error {
	base := &item.remoteWorkSavePlanItem
	if strings.EqualFold(strings.TrimSpace(decision.Resolution), "rename") {
		renamed, err := lyricsEditRenameTarget(targetRoot, lyricsLanguageFolderPath(item.Language), decision.TargetPath)
		if err != nil {
			return err
		}
		base.TargetPath = renamed
	}
	inPlace := func() bool {
		return base.SourceKind == "folder" && fetchTargetKey(base.LocalSourcePath) == fetchTargetKey(base.TargetPath)
	}
	absolute, err := safeDataPath(s.cfg.DataRoot, base.TargetPath)
	if err != nil {
		return lyricsFetchBadRequest("a target path is outside the library")
	}
	rootAbsolute, err := safeDataPath(s.cfg.DataRoot, targetRoot)
	if err != nil {
		return lyricsFetchBadRequest("the local folder is outside the library")
	}
	relative, err := fetchPathRelativeToRoot(targetRoot, base.TargetPath)
	if err != nil {
		return lyricsFetchBadRequest("a target path is outside the local folder")
	}
	replacesRemoved := false
	info, statErr := os.Lstat(absolute)
	switch {
	case markBlockedPath(base, rootAbsolute, relative):
	case statErr == nil:
		base.TargetExists = true
		switch {
		case info.IsDir() || unsafeFetchStagingEntry(info) || !info.Mode().IsRegular():
			markNotFileTarget(base, info)
		case inPlace():
		case removing[fetchTargetKey(base.TargetPath)]:
			replacesRemoved = true
		default:
			size := info.Size()
			base.TargetSizeBytes = &size
			if lyricsEditSameContent(*item, absolute, size) {
				base.Action, base.Status = "skip", "local_exists"
			} else {
				base.TargetConflict = true
				base.TargetConflictReason = "a different file with this name is already there"
				base.Action, base.Status = "conflict", "target_conflict"
			}
		}
	case !errors.Is(statErr, os.ErrNotExist):
		base.TargetConflict = true
		base.TargetConflictReason = "target could not be checked"
		base.Action, base.Status = "conflict", "target_conflict"
	}
	applyRemoteFetchTargetState(base, seenTargets, "two selected files would take the same place: ")
	if err := s.applyRemoteFetchConflictDecision(base, blockedTargetDecision(*base, decision), targetRoot, seenTargets); err != nil {
		return err
	}
	if inPlace() {
		// The file is already where its language puts it.
		base.Action, base.Status = "skip", "local_source_already_target"
		base.TargetConflict, base.TargetConflictReason = false, ""
		return nil
	}
	if replacesRemoved && base.Action == "" && base.Resolution == "auto" {
		base.Status = "replace_target"
	}
	if base.Action == "" {
		switch {
		case base.SourceKind == "folder" && !item.copyFolder:
			base.Action = "move_local"
		case base.SourceKind == "folder", base.SourceKind == "local":
			base.Action = "copy_local"
		default:
			base.Action = "cache_download"
		}
		if base.Status == "" {
			base.Status = base.Action
		}
	}
	return nil
}

// lyricsEditSameContent reports whether the file at a target already holds
// what the item would put there. A local source is compared byte for byte; a
// remote one is compared by the size its source reports.
func lyricsEditSameContent(item lyricsEditItem, targetAbsolute string, targetSize int64) bool {
	if item.SizeBytes == nil || *item.SizeBytes != targetSize {
		return false
	}
	if item.SourceKind == "remote" {
		return true
	}
	if targetSize > maxLyricsFetchFileBytes {
		return false
	}
	source, err := os.ReadFile(item.sourceAbsolute)
	if err != nil {
		return false
	}
	existing, err := os.ReadFile(targetAbsolute)
	return err == nil && bytes.Equal(source, existing)
}
