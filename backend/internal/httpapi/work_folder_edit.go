package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/storagepool"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// A folder edit is one durable user intent and produces one workflow run. The
// bounds keep the request and its stored plan small enough to review.
const (
	maxWorkFolderEditAdditions = 5000
	maxWorkFolderEditRemovals  = maxMediaCleanupTargets
	// A family check asks every healthy source about each edition in turn.
	maxWorkFolderEditCheckedEditions = 16
	workFolderEditWorkerType         = "work_folder_edit"
	workFolderEditWorkflowCode       = "work_folder_edit"
)

type workFolderEditAdditionRequest struct {
	// Kind is "local" for a file of another local folder of the family and
	// "remote" for a file a configured source offers for a family edition.
	Kind       string `json:"kind"`
	FolderID   int64  `json:"folderId,omitempty"`
	SourceID   int64  `json:"sourceId,omitempty"`
	RemoteCode string `json:"remoteCode,omitempty"`
	// Path is relative to the source folder or to the remote edition's tree.
	Path string `json:"path"`
	// Language, when present, adds a lyrics text file as lyrics of that
	// language: it goes to the language's folder inside Kikoto's lyrics folder
	// instead of keeping its path. Empty is the fallback lyrics. A language is
	// never inferred.
	Language *string `json:"language,omitempty"`
}

type workFolderEditRequest struct {
	FolderID          int64                           `json:"folderId"`
	Additions         []workFolderEditAdditionRequest `json:"additions"`
	RemoveLocationIDs []int64                         `json:"removeLocationIds"`
	Decisions         []remoteFetchFileDecision       `json:"decisions"`
	Assignments       []workFolderEditAssignment      `json:"assignments"`
	RequestID         string                          `json:"requestId"`
}

// workFolderEditItem is one file to add to the folder. It shares the Fetch
// plan item's shape so both reviews resolve conflicts the same way.
type workFolderEditItem struct {
	remoteWorkSavePlanItem
	SourceFolderID int64  `json:"sourceFolderId,omitempty"`
	RemoteCode     string `json:"remoteCode,omitempty"`
	// Language is present for a file added as lyrics of that language.
	Language *string `json:"language,omitempty"`
}

type workFolderEditRemoval struct {
	LocationID int64  `json:"locationId"`
	Path       string `json:"path"`
	SizeBytes  *int64 `json:"sizeBytes"`
}

type workFolderEditSummary struct {
	Add      int `json:"add"`
	Copy     int `json:"copy"`
	Download int `json:"download"`
	Skip     int `json:"skip"`
	Conflict int `json:"conflict"`
	Remove   int `json:"remove"`
	// Lyrics counts the added files that go to a lyrics folder.
	Lyrics      int   `json:"lyrics"`
	AddBytes    int64 `json:"addBytes"`
	RemoveBytes int64 `json:"removeBytes"`
}

type workFolderEditPlan struct {
	WorkID      int64  `json:"workId"`
	PrimaryCode string `json:"primaryCode"`
	FolderID    int64  `json:"folderId"`
	// SaveRoot is the folder being edited, relative to the data root.
	SaveRoot        string                  `json:"saveRoot"`
	TransactionPool string                  `json:"transactionPool,omitempty"`
	Items           []workFolderEditItem    `json:"items"`
	Removals        []workFolderEditRemoval `json:"removals"`
	Summary         workFolderEditSummary   `json:"summary"`
}

type workFolderEditSources struct {
	WorkID      int64                `json:"workId"`
	PrimaryCode string               `json:"primaryCode"`
	Editions    []remoteFetchEdition `json:"editions"`
	Warnings    []string             `json:"warnings"`
}

type workFolderEditResult struct {
	RunID       int64                 `json:"runId"`
	JobID       int64                 `json:"jobId"`
	WorkID      int64                 `json:"workId"`
	PrimaryCode string                `json:"primaryCode"`
	Status      string                `json:"status"`
	SaveRoot    string                `json:"saveRoot"`
	Plan        workFolderEditSummary `json:"plan"`
	RequestID   string                `json:"requestId"`
}

// workFolderEditFolder is an active local folder of the work's family.
type workFolderEditFolder struct {
	ID           int64
	WorkID       int64
	FileSourceID int64
	RootPath     string
	Absolute     string
}

type workFolderEditConflictError struct {
	Summary workFolderEditSummary
}

func (err workFolderEditConflictError) Error() string {
	if err.Summary.Conflict == 1 {
		return "the folder edit has 1 file conflict; review the result before applying"
	}
	return fmt.Sprintf("the folder edit has %d file conflicts; review the result before applying", err.Summary.Conflict)
}

func (s *Server) parseWorkFolderEditRequest(w http.ResponseWriter, r *http.Request) (int64, workFolderEditRequest, bool) {
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return 0, workFolderEditRequest{}, false
	}
	var payload workFolderEditRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return 0, workFolderEditRequest{}, false
	}
	return workID, payload, true
}

func workFolderEditHasRemote(additions []workFolderEditAdditionRequest) bool {
	for _, addition := range additions {
		if strings.TrimSpace(addition.Kind) == "remote" {
			return true
		}
	}
	return false
}

// requireWorkFolderEdit checks that the actor may change local files, may
// download from a remote source when the edit asks for remote files, and may
// write library lyrics when it assigns added lyrics to tracks.
func (s *Server) requireWorkFolderEdit(w http.ResponseWriter, r *http.Request, payload workFolderEditRequest) (currentUser, bool) {
	permissions := []string{"downloads:manage"}
	if workFolderEditHasRemote(payload.Additions) {
		permissions = append(permissions, "remote:fetch")
	}
	if len(payload.Assignments) > 0 {
		permissions = append(permissions, "library:write")
	}
	return s.requirePermissions(w, r, permissions...)
}

// listWorkFolderEditSources reports where files for a folder of the work can
// come from: the local folders of every edition of its family and the stored
// availability of those editions on the configured sources.
func (s *Server) listWorkFolderEditSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	workID, code, ok := s.workFolderEditSourcesWork(w, r)
	if !ok {
		return
	}
	s.writeWorkFolderEditSources(w, r, workID, code, nil)
}

// checkWorkFolderEditSources asks every enabled remote source that answers its
// health check whether it offers each edition of the work's family, records
// the answers as the editions' stored availability, and reports the sources
// as listWorkFolderEditSources does. Editions are checked one after another,
// at most maxWorkFolderEditCheckedEditions of them, and a cancelled request
// stops before the next edition.
func (s *Server) checkWorkFolderEditSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "remote:track"); !ok {
		return
	}
	workID, code, ok := s.workFolderEditSourcesWork(w, r)
	if !ok || refuseCustomWorkCode(w, code) {
		return
	}
	ctx := r.Context()
	editions, err := s.loadRemoteFetchEditions(ctx, code)
	if err != nil {
		writeError(w, err)
		return
	}
	healthy, err := s.healthyRemoteSourceIDsForAvailability(ctx, 0)
	if err != nil {
		writeError(w, err)
		return
	}
	warnings := []string{}
	if len(healthy) == 0 {
		warnings = append(warnings, "no enabled remote source answered its health check")
	}
	for index, edition := range editions {
		if len(healthy) == 0 {
			break
		}
		if index >= maxWorkFolderEditCheckedEditions {
			warnings = append(warnings, fmt.Sprintf("only the first %d editions were checked", maxWorkFolderEditCheckedEditions))
			break
		}
		if err := ctx.Err(); err != nil {
			writeError(w, err)
			return
		}
		if _, err := s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, edition.PrimaryCode, 0, healthy, "manual", "folder_edit_family_check"); err != nil {
			writeError(w, err)
			return
		}
	}
	s.writeWorkFolderEditSources(w, r, workID, code, warnings)
}

func (s *Server) workFolderEditSourcesWork(w http.ResponseWriter, r *http.Request) (int64, string, bool) {
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return 0, "", false
	}
	var code string
	if err := s.db.QueryRowContext(r.Context(), "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeError(w, notFoundError("work not found"))
			return 0, "", false
		}
		writeError(w, err)
		return 0, "", false
	}
	return workID, code, true
}

func (s *Server) writeWorkFolderEditSources(w http.ResponseWriter, r *http.Request, workID int64, code string, warnings []string) {
	preparation := s.prepareRemoteFetch(r.Context(), code)
	writeJSON(w, http.StatusOK, workFolderEditSources{
		WorkID: workID, PrimaryCode: strings.ToUpper(strings.TrimSpace(code)),
		Editions: preparation.Editions, Warnings: append(preparation.Warnings, warnings...),
	})
}

func (s *Server) planWorkFolderEdit(w http.ResponseWriter, r *http.Request) {
	workID, payload, ok := s.parseWorkFolderEditRequest(w, r)
	if !ok {
		return
	}
	// A preview stores nothing, so the assignments a request carries are not
	// part of it.
	payload.Assignments = nil
	if _, ok := s.requireWorkFolderEdit(w, r, payload); !ok {
		return
	}
	plan, err := s.buildWorkFolderEditPlan(r.Context(), workID, payload)
	if err != nil {
		writeWorkFolderEditError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, publicWorkFolderEditPlan(plan))
}

func (s *Server) applyWorkFolderEdit(w http.ResponseWriter, r *http.Request) {
	workID, payload, ok := s.parseWorkFolderEditRequest(w, r)
	if !ok {
		return
	}
	actor, ok := s.requireWorkFolderEdit(w, r, payload)
	if !ok {
		return
	}
	payload.RequestID = strings.TrimSpace(payload.RequestID)
	if payload.RequestID != "" && !validRemoteFetchRequestID(payload.RequestID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid folder edit request id"})
		return
	}
	operationCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()
	result, err := s.enqueueWorkFolderEdit(operationCtx, workID, payload, actor.ID)
	if err != nil {
		writeWorkFolderEditError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func writeWorkFolderEditError(w http.ResponseWriter, err error) {
	var conflict workFolderEditConflictError
	if errors.As(err, &conflict) {
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "code": "folder_edit_conflict", "summary": conflict.Summary})
		return
	}
	var lyricsErr lyricsFetchRequestError
	if errors.As(err, &lyricsErr) {
		if lyricsErr.code != "" {
			writeAPIError(w, lyricsErr.status, lyricsErr.code, lyricsErr.message, false)
			return
		}
		writeJSON(w, lyricsErr.status, map[string]string{"error": lyricsErr.message})
		return
	}
	var symlinkErr symlinkMediaLocationError
	var cleanupConflict mediaCleanupTargetConflictError
	if errors.As(err, &symlinkErr) || errors.As(err, &cleanupConflict) {
		writeMediaCleanupError(w, err)
		return
	}
	if writeFetchDestinationError(w, err) {
		return
	}
	writeUpstreamError(w, err)
}

// publicWorkFolderEditPlan removes the remote download addresses, which a
// review of the edit does not need.
func publicWorkFolderEditPlan(plan workFolderEditPlan) workFolderEditPlan {
	for index := range plan.Items {
		plan.Items[index].SourcePath = ""
	}
	return plan
}

// buildWorkFolderEditPlan resolves a requested edit against the folder as it
// is on disk. It never changes a file.
func (s *Server) buildWorkFolderEditPlan(ctx context.Context, workID int64, payload workFolderEditRequest) (workFolderEditPlan, error) {
	if len(payload.Additions) > maxWorkFolderEditAdditions {
		return workFolderEditPlan{}, invalidRequestError(fmt.Sprintf("at most %d files can be added at once", maxWorkFolderEditAdditions))
	}
	if len(payload.RemoveLocationIDs) > maxWorkFolderEditRemovals {
		return workFolderEditPlan{}, invalidRequestError(fmt.Sprintf("at most %d files can be removed at once", maxWorkFolderEditRemovals))
	}
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workFolderEditPlan{}, notFoundError("work not found")
		}
		return workFolderEditPlan{}, err
	}
	target, err := s.workFolderEditFolder(ctx, family, payload.FolderID)
	if err != nil {
		return workFolderEditPlan{}, err
	}
	if target.WorkID != workID {
		return workFolderEditPlan{}, invalidRequestError("choose a local folder of this work to edit")
	}
	if err := s.ensureFetchTargetWritable(ctx, target.RootPath); err != nil {
		return workFolderEditPlan{}, err
	}
	var code string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		return workFolderEditPlan{}, err
	}
	removals, err := s.workFolderEditRemovals(ctx, target, payload.RemoveLocationIDs)
	if err != nil {
		return workFolderEditPlan{}, err
	}
	removing := map[string]bool{}
	for _, removal := range removals {
		removing[fetchTargetKey(removal.Path)] = true
	}
	candidates, err := s.workFolderEditCandidates(ctx, family, target, payload.Additions)
	if err != nil {
		return workFolderEditPlan{}, err
	}
	if workFolderEditAddsLyrics(candidates) {
		if err := checkLyricsRootWritable(target.Absolute); err != nil {
			return workFolderEditPlan{}, err
		}
	}
	decisions := normalizeRemoteFetchDecisions(payload.Decisions)
	seenTargets := map[string]string{}
	items := make([]workFolderEditItem, 0, len(candidates))
	for _, candidate := range candidates {
		decision, err := workFolderEditItemDecision(candidate, decisions[candidate.ItemKey], target.RootPath)
		if err != nil {
			return workFolderEditPlan{}, err
		}
		if err := s.resolveWorkFolderEditItem(&candidate.remoteWorkSavePlanItem, decision, target.RootPath, removing, seenTargets); err != nil {
			return workFolderEditPlan{}, err
		}
		items = append(items, candidate)
	}
	base := make([]remoteWorkSavePlanItem, len(items))
	for index := range items {
		base[index] = items[index].remoteWorkSavePlanItem
	}
	validateResolvedFetchTargets(base)
	if err := validateRemoteFetchDownloadPlan(base, s.remoteMediaDownloadLimitBytes(ctx)); err != nil {
		return workFolderEditPlan{}, rejectedRequestError("download_limit_exceeded", "a selected file is larger than the remote download limit", err)
	}
	for index := range items {
		items[index].remoteWorkSavePlanItem = base[index]
	}
	transactionPool, err := s.fetchTransactionPool(ctx, target.RootPath)
	if err != nil {
		return workFolderEditPlan{}, err
	}
	return workFolderEditPlan{
		WorkID: workID, PrimaryCode: strings.ToUpper(strings.TrimSpace(code)), FolderID: target.ID,
		SaveRoot: target.RootPath, TransactionPool: transactionPool,
		Items: items, Removals: removals, Summary: summarizeWorkFolderEdit(items, removals),
	}, nil
}

func summarizeWorkFolderEdit(items []workFolderEditItem, removals []workFolderEditRemoval) workFolderEditSummary {
	summary := workFolderEditSummary{Remove: len(removals)}
	for _, removal := range removals {
		if removal.SizeBytes != nil {
			summary.RemoveBytes += *removal.SizeBytes
		}
	}
	for _, item := range items {
		switch item.Action {
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
		if item.Language != nil {
			summary.Lyrics++
		}
		if item.SizeBytes != nil {
			summary.AddBytes += *item.SizeBytes
		}
	}
	return summary
}

// workFolderEditFolder loads an active local folder of the family and checks
// that it is a plain directory inside the library.
func (s *Server) workFolderEditFolder(ctx context.Context, family map[int64]bool, folderID int64) (workFolderEditFolder, error) {
	var folder workFolderEditFolder
	err := s.db.QueryRowContext(ctx, `
		SELECT folder.id, folder.work_id, folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE folder.id = ? AND folder.state = 'active' AND source.source_type = 'local_folder'
	`, folderID).Scan(&folder.ID, &folder.WorkID, &folder.FileSourceID, &folder.RootPath)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !family[folder.WorkID]) {
		return workFolderEditFolder{}, invalidRequestError("choose an active local folder of this work")
	}
	if err != nil {
		return workFolderEditFolder{}, err
	}
	folder.RootPath = normalizeFolderRootPath(folder.RootPath)
	if folder.RootPath == "" {
		return workFolderEditFolder{}, invalidRequestError("choose an active local folder of this work")
	}
	absolute, err := safeDataPath(s.cfg.DataRoot, folder.RootPath)
	if err != nil {
		return workFolderEditFolder{}, invalidRequestError("the local folder is outside the library")
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || unsafeFetchStagingEntry(info) {
		return workFolderEditFolder{}, conflictError("the local folder is not available")
	}
	folder.Absolute = absolute
	return folder, nil
}

// workFolderEditRemovals resolves the files to remove. Each must be a local
// file of the edited work inside the edited folder.
func (s *Server) workFolderEditRemovals(ctx context.Context, target workFolderEditFolder, locationIDs []int64) ([]workFolderEditRemoval, error) {
	removals := make([]workFolderEditRemoval, 0, len(locationIDs))
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
			return nil, mediaCleanupTargetConflictError{message: "a file to remove is no longer listed; refresh the work and try again"}
		}
		if err != nil {
			return nil, err
		}
		removal.Path = filepath.ToSlash(removal.Path)
		if locationType != "local" || workID != target.WorkID || sourceID != target.FileSourceID ||
			normalizeFolderRootPath(removal.Path) == target.RootPath || !mediaCleanupPathWithinRoot(target.RootPath, removal.Path) {
			return nil, invalidRequestError("a file to remove is not inside the edited folder")
		}
		if size.Valid {
			value := size.Int64
			removal.SizeBytes = &value
		}
		removals = append(removals, removal)
	}
	return removals, nil
}

// workFolderEditCandidates resolves every requested addition to its source
// file, in request order, before any target is decided.
func (s *Server) workFolderEditCandidates(ctx context.Context, family map[int64]bool, target workFolderEditFolder, additions []workFolderEditAdditionRequest) ([]workFolderEditItem, error) {
	localFolders := map[int64]workFolderEditFolder{}
	remoteTrees := map[string]workFolderEditRemoteTree{}
	seen := map[string]bool{}
	items := make([]workFolderEditItem, 0, len(additions))
	for _, addition := range additions {
		relative := cleanRemoteRelativePath(addition.Path)
		if relative == "" {
			return nil, invalidRequestError("each added file needs a path")
		}
		var item workFolderEditItem
		switch strings.TrimSpace(addition.Kind) {
		case "local":
			folder, ok := localFolders[addition.FolderID]
			if !ok {
				loaded, err := s.workFolderEditFolder(ctx, family, addition.FolderID)
				if err != nil {
					return nil, err
				}
				if loaded.ID == target.ID || strings.EqualFold(loaded.RootPath, target.RootPath) {
					return nil, invalidRequestError("a file to add is already in the edited folder")
				}
				folder = loaded
				localFolders[addition.FolderID] = folder
			}
			size, err := localFolderFileSize(folder.Absolute, relative)
			if err != nil {
				return nil, err
			}
			item = workFolderEditItem{SourceFolderID: folder.ID}
			item.remoteWorkSavePlanItem = remoteWorkSavePlanItem{
				ItemKey: fmt.Sprintf("local:%d:%s", folder.ID, relative), Path: relative, Kind: mediaKindFromPath(relative),
				SizeBytes: &size, SourceKind: "local", LocalSourcePath: path.Join(folder.RootPath, relative),
			}
		case "remote":
			code := normalizeWorkCode(addition.RemoteCode)
			treeKey := fmt.Sprintf("%d:%s", addition.SourceID, code)
			tree, ok := remoteTrees[treeKey]
			if !ok {
				loaded, err := s.workFolderEditRemoteTree(ctx, family, addition.SourceID, code)
				if err != nil {
					return nil, err
				}
				tree = loaded
				remoteTrees[treeKey] = tree
			}
			file, ok := tree.files[relative]
			if !ok {
				return nil, invalidRequestError("a selected file is not offered by the remote edition")
			}
			item = workFolderEditItem{RemoteCode: code}
			item.remoteWorkSavePlanItem = remoteWorkSavePlanItem{
				ItemKey: fmt.Sprintf("remote:%d:%s:%s", tree.source.ID, code, relative), Path: relative, Kind: file.Kind,
				SizeBytes: file.SizeBytes, SourceKind: "remote", SourcePath: firstNonEmpty(file.DownloadURL, file.StreamURL),
				RemoteSourceID: tree.source.ID, RemoteSourceCode: tree.source.Code, RemoteSourceName: tree.source.DisplayName,
				RemotePath: file.Path,
			}
		default:
			return nil, invalidRequestError("each added file must be local or remote")
		}
		if seen[item.ItemKey] {
			continue
		}
		seen[item.ItemKey] = true
		item.LocalPaths = []string{}
		item.SourceOptions = []remoteFetchSourceOption{}
		item.TargetPath = path.Join(target.RootPath, relative)
		if err := applyWorkFolderEditLyricsRole(&item, addition.Language, target.RootPath); err != nil {
			return nil, err
		}
		item.OriginalTargetPath = item.TargetPath
		items = append(items, item)
	}
	return items, nil
}

type workFolderEditRemoteTree struct {
	source remoteSourceForUse
	files  map[string]remoteSaveFile
}

// workFolderEditRemoteTree reads the files a source offers for an edition of
// the family. The edition is read, not recorded as a work.
func (s *Server) workFolderEditRemoteTree(ctx context.Context, family map[int64]bool, sourceID int64, code string) (workFolderEditRemoteTree, error) {
	if sourceID <= 0 || code == "" {
		return workFolderEditRemoteTree{}, invalidRequestError("each remote file needs its source and edition")
	}
	var editionWorkID int64
	err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code).Scan(&editionWorkID)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !family[editionWorkID]) {
		return workFolderEditRemoteTree{}, invalidRequestError("the remote edition does not belong to this work")
	}
	if err != nil {
		return workFolderEditRemoteTree{}, err
	}
	if err := s.requireUsableRemoteSource(ctx, sourceID); err != nil {
		return workFolderEditRemoteTree{}, err
	}
	source, _, tracks, err := s.loadInstanceRemoteWorkTracksCached(ctx, sourceID, code)
	if err != nil {
		return workFolderEditRemoteTree{}, err
	}
	files := map[string]remoteSaveFile{}
	for _, file := range flattenRemoteSaveFiles(tracks) {
		key := cleanRemoteRelativePath(file.Path)
		if _, duplicate := files[key]; key != "" && !duplicate {
			files[key] = file
		}
	}
	return workFolderEditRemoteTree{source: source, files: files}, nil
}

// localFolderFileSize returns the size of a regular file below root. Every
// path component must be a plain directory or file, so a link inside the
// folder cannot name a file outside it.
func localFolderFileSize(root string, relative string) (int64, error) {
	missing := conflictError("a selected local file is no longer in its folder; refresh and try again")
	current := root
	parts := strings.Split(relative, "/")
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return 0, missing
		}
		last := index == len(parts)-1
		if unsafeFetchStagingEntry(info) || info.IsDir() == last || (last && !info.Mode().IsRegular()) {
			return 0, missing
		}
		if last {
			return info.Size(), nil
		}
	}
	return 0, missing
}

// resolveWorkFolderEditItem decides what adding one file does to the folder.
// A target that the same edit removes is replaced; any other file already at
// the target is kept when it has the same size and is a conflict otherwise.
func (s *Server) resolveWorkFolderEditItem(item *remoteWorkSavePlanItem, decision remoteFetchFileDecision, targetRoot string, removing map[string]bool, seenTargets map[string]string) error {
	if err := applyRemoteFetchRename(item, decision, targetRoot); err != nil {
		return err
	}
	absolute, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
	if err != nil {
		return invalidRequestError("a target path is outside the library")
	}
	relative, err := fetchPathRelativeToRoot(targetRoot, item.TargetPath)
	if err != nil {
		return invalidRequestError("a target path is outside the edited folder")
	}
	rootAbsolute, err := safeDataPath(s.cfg.DataRoot, targetRoot)
	if err != nil {
		return invalidRequestError("the edited folder is outside the library")
	}
	replacesRemoved := false
	info, statErr := os.Lstat(absolute)
	switch {
	case markBlockedPath(item, rootAbsolute, relative):
	case statErr == nil:
		item.TargetExists = true
		switch {
		case info.IsDir() || unsafeFetchStagingEntry(info) || !info.Mode().IsRegular():
			markNotFileTarget(item, info)
		case removing[fetchTargetKey(item.TargetPath)]:
			replacesRemoved = true
		default:
			size := info.Size()
			item.TargetSizeBytes = &size
			if item.SizeBytes != nil && size == *item.SizeBytes {
				item.Action, item.Status = "skip", "local_exists"
			} else {
				item.TargetConflict = true
				item.TargetConflictReason = "target exists with a different size"
				item.Action, item.Status = "conflict", "target_conflict"
			}
		}
	case !errors.Is(statErr, os.ErrNotExist):
		item.TargetConflict = true
		item.TargetConflictReason = "target could not be checked"
		item.Action, item.Status = "conflict", "target_conflict"
	}
	applyRemoteFetchTargetState(item, seenTargets, "multiple selected files resolve to the same target path: ")
	if err := s.applyRemoteFetchConflictDecision(item, blockedTargetDecision(*item, decision), targetRoot, seenTargets); err != nil {
		return err
	}
	if replacesRemoved && item.Action == "" && item.Resolution == "auto" {
		item.Status = "replace_target"
	}
	if item.Action == "" {
		if item.SourceKind == "local" {
			item.Action = "copy_local"
		} else {
			item.Action = "cache_download"
		}
		if item.Status == "" {
			item.Status = item.Action
		}
	}
	return nil
}

func (s *Server) enqueueWorkFolderEdit(ctx context.Context, workID int64, payload workFolderEditRequest, actorUserID int64) (workFolderEditResult, error) {
	if payload.RequestID != "" {
		if existing, found, err := s.workFolderEditRequestResult(ctx, payload.RequestID, workID); err != nil || found {
			return existing, err
		}
	}
	plan, err := s.buildWorkFolderEditPlan(ctx, workID, payload)
	if err != nil {
		return workFolderEditResult{}, err
	}
	if plan.Summary.Conflict > 0 {
		return workFolderEditResult{}, workFolderEditConflictError{Summary: plan.Summary}
	}
	if plan.Summary.Add == 0 && plan.Summary.Remove == 0 {
		return workFolderEditResult{}, invalidRequestError("the edit does not change the folder")
	}
	assignments, err := s.workFolderEditAssignments(ctx, plan, payload.Assignments)
	if err != nil {
		return workFolderEditResult{}, err
	}
	removals := make([]mediaCleanupTarget, 0, len(plan.Removals))
	for _, removal := range plan.Removals {
		// The complete check, including the symbolic-link review, runs only
		// when the edit is applied, never for a preview.
		target, err := s.loadMediaCleanupTarget(ctx, mediaCleanupTargetRequest{Kind: "local", LocationID: removal.LocationID})
		if err != nil {
			return workFolderEditResult{}, err
		}
		removals = append(removals, target)
	}
	var fileSourceID int64
	if err := s.db.QueryRowContext(ctx, "SELECT file_source_id FROM work_folder_location WHERE id = ?", plan.FolderID).Scan(&fileSourceID); err != nil {
		return workFolderEditResult{}, err
	}
	jobPayload := workFolderEditJobPayload{
		ActorUserID: actorUserID, WorkID: plan.WorkID, WorkCode: plan.PrimaryCode, FolderID: plan.FolderID,
		FileSourceID: fileSourceID, TargetRoot: plan.SaveRoot, TransactionPool: plan.TransactionPool,
		Items: plan.Items, Removals: removals, Assignments: assignments, RequestID: payload.RequestID,
	}
	for index := range jobPayload.Items {
		// A download address is resolved again when the job runs.
		jobPayload.Items[index].SourcePath = ""
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return workFolderEditResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	var activeRunID int64
	err = tx.QueryRowContext(ctx, `
		SELECT run.id FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
			AND CAST(json_extract(run.input_json, '$.folder_id') AS INTEGER) = ?
		ORDER BY run.id ASC LIMIT 1
	`, workFolderEditWorkflowCode, plan.FolderID).Scan(&activeRunID)
	if err == nil {
		return workFolderEditResult{}, conflictError(fmt.Sprintf("this folder is already being edited by workflow run #%d", activeRunID))
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return workFolderEditResult{}, err
	}
	if _, found, err := activeRemoteFetchResult(ctx, tx, plan.PrimaryCode); err != nil {
		return workFolderEditResult{}, err
	} else if found {
		return workFolderEditResult{}, conflictError("a Fetch for this work is still running; wait for it to finish")
	}
	spec := workFolderEditDefinition()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, spec.Code, spec.Name, spec.Description, map[string]any{"nodes": spec.Nodes})
	if err != nil {
		return workFolderEditResult{}, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, spec.Code, workFolderEditRunName(plan.PrimaryCode), "queued", "manual", "edit_folder", jobPayload, map[string]any{"plan": plan.Summary})
	if err != nil {
		return workFolderEditResult{}, err
	}
	stageNodeID, err := insertWorkFolderEditNodeRuns(ctx, tx, runID, plan)
	if err != nil {
		return workFolderEditResult{}, err
	}
	bytesTotal, bytesUnknown := remoteFetchTransferTotals(workFolderEditBaseItems(plan.Items))
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: stageNodeID, WorkerType: workFolderEditWorkerType, Status: "queued", Priority: workflow.JobPriorityUserInitiated,
		ResourceKey: "media:cleanup", Payload: jobPayload, Checkpoint: workFolderEditCheckpoint{}, Recoverable: true, MaxRetries: 3,
		ProgressCurrent: 0, ProgressTotal: workFolderEditProgressTotal(jobPayload),
		ProgressBytesTotal: bytesTotal, ProgressBytesUnknownItems: bytesUnknown,
	})
	if err != nil {
		return workFolderEditResult{}, err
	}
	result := workFolderEditResult{
		RunID: runID, JobID: jobID, WorkID: plan.WorkID, PrimaryCode: plan.PrimaryCode, Status: "queued",
		SaveRoot: plan.SaveRoot, Plan: plan.Summary, RequestID: payload.RequestID,
	}
	if err := tx.Commit(); err != nil {
		return workFolderEditResult{}, err
	}
	return result, nil
}

// workFolderEditRequestResult returns the run an identical request already
// queued, so a repeated submission never edits the folder twice.
func (s *Server) workFolderEditRequestResult(ctx context.Context, requestID string, workID int64) (workFolderEditResult, bool, error) {
	var result workFolderEditResult
	var storedWorkID int64
	var summaryJSON string
	err := s.db.QueryRowContext(ctx, `
		SELECT run.id, COALESCE(job.id, 0), run.status,
			COALESCE(CAST(json_extract(run.input_json, '$.work_id') AS INTEGER), 0),
			COALESCE(CAST(json_extract(run.input_json, '$.work_code') AS TEXT), ''),
			COALESCE(CAST(json_extract(run.input_json, '$.target_root') AS TEXT), ''),
			COALESCE(json_extract(run.summary_json, '$.plan'), '{}')
		FROM workflow_run AS run
		LEFT JOIN workflow_job AS job ON job.workflow_run_id = run.id AND job.worker_type = ?
		WHERE run.workflow_code = ?
			AND CAST(json_extract(run.input_json, '$.request_id') AS TEXT) = ?
		ORDER BY run.id ASC LIMIT 1
	`, workFolderEditWorkerType, workFolderEditWorkflowCode, requestID).Scan(
		&result.RunID, &result.JobID, &result.Status, &storedWorkID, &result.PrimaryCode, &result.SaveRoot, &summaryJSON,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return workFolderEditResult{}, false, nil
	}
	if err != nil {
		return workFolderEditResult{}, false, err
	}
	if storedWorkID != workID {
		return workFolderEditResult{}, false, invalidRequestError("folder edit request id was already used for another work")
	}
	_ = json.Unmarshal([]byte(summaryJSON), &result.Plan)
	result.WorkID = workID
	result.RequestID = requestID
	return result, true, nil
}

func workFolderEditRunName(workCode string) string {
	if workCode = strings.ToUpper(strings.TrimSpace(workCode)); workCode != "" {
		return "Edit files of " + workCode
	}
	return "Edit work files"
}

func workFolderEditDefinition() systemWorkflowSpec {
	return systemWorkflowSpec{
		Code:        workFolderEditWorkflowCode,
		Name:        "Edit work files",
		Description: "Add files from the work's other local folders and remote editions to one local folder, as files or as lyrics of a language, and remove the files taken out of it.",
		Nodes: []map[string]string{
			{"id": "select", "type": "select_media_items", "displayName": "Select files"},
			{"id": "stage", "type": "stage_fetch_result", "displayName": "Collect added files"},
			{"id": "remove", "type": "cleanup_media_locations", "displayName": "Remove files"},
			{"id": "publish", "type": "publish_staged_fetch", "displayName": "Add files to the folder"},
			{"id": "index", "type": "sync_file_locations", "displayName": "Index the folder"},
		},
	}
}

func insertWorkFolderEditNodeRuns(ctx context.Context, tx *sql.Tx, runID int64, plan workFolderEditPlan) (int64, error) {
	counts := map[string]any{"add": plan.Summary.Add, "remove": plan.Summary.Remove}
	var stageNodeID int64
	for index, node := range workFolderEditDefinition().Nodes {
		spec := workflow.NodeRunSpec{
			NodeID: node["id"], NodeType: node["type"], DisplayName: node["displayName"], Position: index + 1,
			Status: "queued", Input: counts,
		}
		if node["id"] == "select" {
			spec.Status = "succeeded"
			spec.Input = map[string]any{"folder_id": plan.FolderID, "target_root": plan.SaveRoot}
			spec.Output = plan.Summary
		}
		id, err := workflow.InsertNodeRun(ctx, tx, runID, spec)
		if err != nil {
			return 0, err
		}
		if node["id"] == "stage" {
			stageNodeID = id
		}
	}
	return stageNodeID, nil
}

func workFolderEditBaseItems(items []workFolderEditItem) []remoteWorkSavePlanItem {
	base := make([]remoteWorkSavePlanItem, 0, len(items))
	for _, item := range items {
		if item.Action == "cache_download" {
			base = append(base, item.remoteWorkSavePlanItem)
		}
	}
	return base
}

// workFolderEditStagingRoot is the run's staging directory, relative to the
// data root, on the pool that holds the edited folder.
func workFolderEditStagingRoot(transactionPool string, runID int64) string {
	return storagepool.Join(transactionPool, path.Join(".kikoto-staging", fmt.Sprintf("%d", runID), "edit"))
}
