package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/workcode"
)

// customWorkFolderLimit bounds one candidate listing; a query narrows it.
const customWorkFolderLimit = 200

// customWorkFolderNameLimit is the longest folder name, in bytes, that common
// filesystems accept.
const customWorkFolderNameLimit = 255

const customWorkTitleLimit = 500

// customWorkNoticeKey stores an administrator's acceptance of the custom work
// notice: creating a custom work renames its folder on disk.
const customWorkNoticeKey = "custom_work_rename_notice"

// customWorkNoticeVersion changes when the notice changes materially, so the
// next administrator creating a custom work accepts the new text.
const customWorkNoticeVersion = 1

type customWorkNoticeAcceptance struct {
	Version    int       `json:"version"`
	UserID     int64     `json:"userId"`
	AcceptedAt time.Time `json:"acceptedAt"`
}

var (
	errCustomWorkFolderUnavailable = errors.New("the folder cannot become a custom work")
	errCustomWorkCodesExhausted    = errors.New("no custom work code is left to assign")
	errCustomWorkFolderInUse       = errors.New("the folder is a Fetch folder or one a running job writes into")
)

type customWorkFolder struct {
	Path string `json:"path"`
	Name string `json:"name"`
	// InUse marks a folder Fetch writes into; creation refuses it until then.
	InUse bool `json:"inUse"`
}

type customWorkFoldersResponse struct {
	Folders        []customWorkFolder `json:"folders"`
	Truncated      bool               `json:"truncated"`
	NoticeAccepted bool               `json:"noticeAccepted"`
}

// customWorkTreeFolder is one folder of the folder tree. A folder that cannot
// become a custom work is still shown when candidates lie below it.
type customWorkTreeFolder struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	Selectable  bool   `json:"selectable"`
	HasChildren bool   `json:"hasChildren"`
	// Reason says why a folder is not selectable: "holds_works" for a folder
	// that holds a work folder, "in_use" for a folder Fetch writes into, and
	// "storage_pool" for a storage pool's own folder.
	Reason string `json:"reason,omitempty"`
}

type customWorkTreeResponse struct {
	Path      string                 `json:"path"`
	Folders   []customWorkTreeFolder `json:"folders"`
	Truncated bool                   `json:"truncated"`
}

// customWorkTreeLimit bounds the folders one tree level returns.
const customWorkTreeLimit = 500

type createCustomWorkResponse struct {
	WorkID    int64  `json:"workId"`
	Code      string `json:"code"`
	Path      string `json:"path"`
	ScanRunID int64  `json:"scanRunId,omitempty"`
}

// listCustomWorkFolders lists the library folders a custom work can be made
// from. Paths are relative to the data root.
func (s *Server) listCustomWorkFolders(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireCustomWorkAccess(w, r); !ok {
		return
	}
	discovery, err := s.discoverCustomWorkCandidates(r.Context())
	if err != nil {
		writeCustomWorkError(w, err)
		return
	}
	accepted, err := s.customWorkNoticeAccepted(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	busy, err := s.customWorkBusyRoots(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	response := customWorkFoldersResponse{Folders: []customWorkFolder{}, NoticeAccepted: accepted}
	for _, candidate := range discovery.Candidates {
		if query != "" && !strings.Contains(strings.ToLower(candidate.RelPath), query) {
			continue
		}
		if len(response.Folders) == customWorkFolderLimit {
			response.Truncated = true
			break
		}
		response.Folders = append(response.Folders, customWorkFolder{
			Path: candidate.RelPath, Name: candidate.Name, InUse: customWorkFolderBusy(busy, candidate.RelPath),
		})
	}
	writeJSON(w, http.StatusOK, response)
}

// listCustomWorkTree lists the folders directly inside one folder of the custom
// work scope, or the scope's top level for an empty path: every folder that
// can become a custom work, and every folder on the way to one. Folders that
// carry a work code, and the folders inside them, are left out.
func (s *Server) listCustomWorkTree(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireCustomWorkAccess(w, r); !ok {
		return
	}
	rel := s.customWorkRequestPath(r.URL.Query().Get("path"))
	scope, options, err := s.customWorkScope(r.Context())
	if err != nil {
		writeCustomWorkError(w, err)
		return
	}
	if rel != "" && localfs.IsIgnoredPath(rel) {
		writeCustomWorkError(w, errCustomWorkFolderUnavailable)
		return
	}
	nodes, ok, err := localfs.CustomWorkFolderChildren(s.cfg.DataRoot, rel, options)
	if err != nil {
		writeCustomWorkError(w, err)
		return
	}
	if !ok {
		writeCustomWorkError(w, errCustomWorkFolderUnavailable)
		return
	}
	busy, err := s.customWorkBusyRoots(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	response := customWorkTreeResponse{Path: rel, Folders: []customWorkTreeFolder{}}
	for _, node := range nodes {
		if len(response.Folders) == customWorkTreeLimit {
			response.Truncated = true
			break
		}
		folder := customWorkTreeFolder{Path: node.RelPath, Name: node.Name, HasChildren: node.HasChildren}
		switch {
		case !scope.contains(node.RelPath):
			// Only a storage pool's own folder is shown outside the scope.
			folder.Reason = "storage_pool"
		case !node.Candidate:
			folder.Reason = "holds_works"
		case customWorkFolderBusy(busy, node.RelPath):
			folder.Reason = "in_use"
		default:
			folder.Selectable = true
		}
		response.Folders = append(response.Folders, folder)
	}
	writeJSON(w, http.StatusOK, response)
}

// getCustomWorkFolder checks a typed folder path: it returns the folder when
// it can become a custom work, by the same rules creation applies.
func (s *Server) getCustomWorkFolder(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireCustomWorkAccess(w, r); !ok {
		return
	}
	rel := s.customWorkRequestPath(r.URL.Query().Get("path"))
	if rel == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "folder is required"})
		return
	}
	folder, err := s.customWorkCandidate(r.Context(), rel)
	if err != nil {
		writeCustomWorkError(w, err)
		return
	}
	busy, err := s.customWorkBusyRoots(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, customWorkFolder{Path: folder.RelPath, Name: folder.Name, InUse: customWorkFolderBusy(busy, folder.RelPath)})
}

// customWorkRequestPath reads a requested folder as a path relative to the
// data root. A path that starts with the data root's own absolute path, as a
// file manager on the server shows it, is made relative to it.
func (s *Server) customWorkRequestPath(raw string) string {
	value := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	if root := strings.TrimRight(filepath.ToSlash(filepath.Clean(s.cfg.DataRoot)), "/"); root != "" && root != "." {
		if value == root {
			return ""
		}
		value = strings.TrimPrefix(value, root+"/")
	}
	return normalizeFolderRootPath(value)
}

// createCustomWork assigns the next custom work code to a library folder,
// appends the code to the folder's name so every scan finds it, and records the
// work with the requested title. The folder is indexed by an incremental scan.
func (s *Server) createCustomWork(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireCustomWorkAccess(w, r); !ok {
		return
	}
	var payload struct {
		Path  string `json:"path"`
		Title string `json:"title"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json body"})
		return
	}
	rel := s.customWorkRequestPath(payload.Path)
	title := strings.TrimSpace(payload.Title)
	if rel == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "folder is required"})
		return
	}
	if utf8.RuneCountInString(title) > customWorkTitleLimit {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "title is too long"})
		return
	}

	if accepted, err := s.customWorkNoticeAccepted(r.Context()); err != nil {
		writeError(w, err)
		return
	} else if !accepted {
		writeAPIError(w, http.StatusConflict, "custom_work_notice_required", "Accept the custom work notice before creating a custom work.", false)
		return
	}

	// The full walk only collects the codes folder names already carry, so it
	// runs before the lock. Every code Kikoto assigns lies at or below the
	// counter, so a folder renamed after the walk cannot carry the next one;
	// the walk guards against codes named outside Kikoto, which no lock orders.
	discovery, err := s.discoverCustomWorkCandidates(r.Context())
	if err != nil {
		writeCustomWorkError(w, err)
		return
	}
	// The rename holds the media:cleanup resource, so no Edit files job,
	// cleanup, scan, or Fetch publication changes library folders meanwhile.
	if !s.mediaCleanupMu.TryLock() {
		writeAPIError(w, http.StatusConflict, "custom_work_library_busy", "Another job is changing library folders; try again when it finishes.", true)
		return
	}
	defer s.mediaCleanupMu.Unlock()
	created, err := s.createCustomWorkFromFolder(r.Context(), rel, title, discovery.Codes)
	if err != nil {
		writeCustomWorkError(w, err)
		return
	}
	scan, err := s.enqueueLocalScanWithPayload(r.Context(), "manual", "custom_work_created", 0, localScanJobPayload{
		Root: s.cfg.DataRoot, ScanDepth: s.effectiveLocalScanDepth(r.Context()),
		ScanMode: localScanModeIncremental, ChangedPaths: []string{created.Path},
	})
	if err != nil {
		// The renamed folder carries its code, so the next scan indexes it.
		slog.Warn("custom work scan could not be queued", "work_id", created.WorkID, "error", err)
	} else {
		created.ScanRunID = scan.RunID
	}
	writeJSON(w, http.StatusCreated, created)
}

// acceptCustomWorkNotice records that an administrator accepted the notice
// that creating a custom work renames its folder. Creation is refused until the
// current version is accepted, whatever the client shows.
func (s *Server) acceptCustomWorkNotice(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requireCustomWorkAccess(w, r)
	if !ok {
		return
	}
	encoded, err := json.Marshal(customWorkNoticeAcceptance{Version: customWorkNoticeVersion, UserID: user.ID, AcceptedAt: time.Now().UTC()})
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `INSERT INTO app_setting(key, value_json) VALUES(?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP`, customWorkNoticeKey, string(encoded)); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"noticeAccepted": true})
}

// getCustomWorkNotice reports whether the rename notice is accepted, without
// reading the library.
func (s *Server) getCustomWorkNotice(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requireCustomWorkAccess(w, r); !ok {
		return
	}
	accepted, err := s.customWorkNoticeAccepted(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"noticeAccepted": accepted})
}

func (s *Server) customWorkNoticeAccepted(ctx context.Context) (bool, error) {
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", customWorkNoticeKey).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var acceptance customWorkNoticeAcceptance
	if json.Unmarshal([]byte(raw), &acceptance) != nil {
		return false, nil
	}
	return acceptance.Version >= customWorkNoticeVersion, nil
}

func (s *Server) requireCustomWorkAccess(w http.ResponseWriter, r *http.Request) (currentUser, bool) {
	if s.cfg.IsDemo() {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "custom works are unavailable in demo mode"})
		return currentUser{}, false
	}
	return s.requirePermissions(w, r, "library:write", "downloads:manage")
}

func writeCustomWorkError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errLibraryUnavailable):
		writeJSON(w, http.StatusConflict, map[string]string{"error": "the library folder is unavailable"})
	case errors.Is(err, errCustomWorkFolderUnavailable):
		writeJSON(w, http.StatusConflict, map[string]string{"error": errCustomWorkFolderUnavailable.Error()})
	case errors.Is(err, errCustomWorkCodesExhausted):
		writeJSON(w, http.StatusConflict, map[string]string{"error": errCustomWorkCodesExhausted.Error()})
	case errors.Is(err, errCustomWorkFolderInUse):
		writeJSON(w, http.StatusConflict, map[string]string{"error": errCustomWorkFolderInUse.Error()})
	default:
		// Filesystem errors name host paths; they stay in the server log.
		slog.Warn("custom work request failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "the custom work could not be created"})
	}
}

// customWorkScope is the part of the library a local scan can observe: online
// storage pools, within the effective scan depth.
func (s *Server) customWorkScope(ctx context.Context) (localScanScope, localfs.Options, error) {
	scope, err := s.localScanScope(ctx, s.cfg.DataRoot, s.effectiveLocalScanDepth(ctx))
	if err != nil {
		return localScanScope{}, localfs.Options{}, err
	}
	if len(scope.online) == 0 {
		return localScanScope{}, localfs.Options{}, errLibraryUnavailable
	}
	return scope, localfs.Options{ScanDepth: scope.walkDepth(), SubRoots: scope.subRoots()}, nil
}

// discoverCustomWorkCandidates walks every folder in the custom work scope.
func (s *Server) discoverCustomWorkCandidates(ctx context.Context) (localfs.CustomWorkDiscovery, error) {
	scope, options, err := s.customWorkScope(ctx)
	if err != nil {
		return localfs.CustomWorkDiscovery{}, err
	}
	discovery, err := localfs.DiscoverCustomWorkCandidates(s.cfg.DataRoot, options)
	if err != nil {
		return localfs.CustomWorkDiscovery{}, err
	}
	kept := discovery.Candidates[:0]
	for _, candidate := range discovery.Candidates {
		if scope.contains(candidate.RelPath) {
			kept = append(kept, candidate)
		}
	}
	discovery.Candidates = kept
	return discovery, nil
}

// renameCustomWorkFolder renames a custom work's folder. Tests replace it to
// observe the database while the rename runs.
var renameCustomWorkFolder = renameNoReplace

// createCustomWorkFromFolder re-checks the folder, reserves its code, renames
// the folder, and inserts its work, with no database transaction open across
// the rename. The caller holds mediaCleanupMu. folderCodes are the codes folder
// names in the scope already carry.
func (s *Server) createCustomWorkFromFolder(ctx context.Context, rel, title string, folderCodes map[string]bool) (createCustomWorkResponse, error) {
	folder, err := s.customWorkCandidate(ctx, rel)
	if err != nil {
		return createCustomWorkResponse{}, err
	}
	if inUse, err := s.customWorkFolderInUse(ctx, folder.AbsPath); err != nil {
		return createCustomWorkResponse{}, err
	} else if inUse {
		return createCustomWorkResponse{}, errCustomWorkFolderInUse
	}
	if title == "" {
		title = strings.TrimSpace(folder.Name)
	}
	// Every custom code has the same length, so a name that is too long is
	// refused before a number is spent on it.
	if len(customWorkFolderName(folder.Name, workcode.Custom(1))) > customWorkFolderNameLimit {
		return createCustomWorkResponse{}, errCustomWorkFolderUnavailable
	}

	code, err := s.reserveCustomWorkCode(ctx, folderCodes)
	if err != nil {
		return createCustomWorkResponse{}, err
	}
	name := customWorkFolderName(folder.Name, code)
	target := filepath.Join(filepath.Dir(folder.AbsPath), name)
	// The rename never replaces a folder that already has the new name. A
	// refused or failed rename leaves the reserved number unused; numbers are
	// never handed out again.
	if err := renameCustomWorkFolder(folder.AbsPath, target); errors.Is(err, os.ErrExist) {
		return createCustomWorkResponse{}, errCustomWorkFolderUnavailable
	} else if err != nil {
		return createCustomWorkResponse{}, err
	}
	// The folder has changed on disk, so a client that stops waiting does not
	// abandon the record: the insert finishes, or the folder is renamed back.
	workID, err := s.insertCustomWork(context.WithoutCancel(ctx), code, title)
	if err != nil {
		if restoreErr := renameNoReplace(target, folder.AbsPath); restoreErr != nil {
			return createCustomWorkResponse{}, errors.Join(err, restoreErr)
		}
		return createCustomWorkResponse{}, err
	}
	return createCustomWorkResponse{
		WorkID: workID,
		Code:   code,
		Path:   path.Join(path.Dir(rel), name),
	}, nil
}

// customWorkCandidate returns the folder at rel when it can still become a
// custom work, by the same rules as the full candidate walk but reading only
// the folders above it and its own subtree.
func (s *Server) customWorkCandidate(ctx context.Context, rel string) (localfs.CustomWorkCandidate, error) {
	scope, options, err := s.customWorkScope(ctx)
	if err != nil {
		return localfs.CustomWorkCandidate{}, err
	}
	if !scope.contains(rel) {
		return localfs.CustomWorkCandidate{}, errCustomWorkFolderUnavailable
	}
	folder, ok, err := localfs.CustomWorkCandidateAt(s.cfg.DataRoot, rel, options)
	if err != nil {
		return localfs.CustomWorkCandidate{}, err
	}
	if !ok {
		return localfs.CustomWorkCandidate{}, errCustomWorkFolderUnavailable
	}
	return folder, nil
}

// reserveCustomWorkCode commits the next custom work code in a transaction of
// its own, so the counter's write lock is released before the folder changes.
func (s *Server) reserveCustomWorkCode(ctx context.Context, folderCodes map[string]bool) (string, error) {
	var code string
	err := withDatabaseBusyRetry(ctx, func() error {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		defer func() { _ = tx.Rollback() }()
		if code, err = assignCustomWorkCode(ctx, tx, folderCodes); err != nil {
			return err
		}
		return tx.Commit()
	})
	return code, err
}

func (s *Server) insertCustomWork(ctx context.Context, code, title string) (int64, error) {
	var workID int64
	err := withDatabaseBusyRetry(ctx, func() error {
		result, err := s.db.ExecContext(ctx, `
			INSERT INTO work (primary_code, work_type, title, description)
			VALUES (?, 'audio', ?, '')
		`, code, title)
		if err != nil {
			return err
		}
		workID, err = result.LastInsertId()
		return err
	})
	return workID, err
}

// customWorkFolderInUse reports whether a folder is, holds, or lies inside a
// folder Fetch writes into: a configured Fetch root, or the target of an
// active Fetch or Edit files run, including a folder that run merges away.
func (s *Server) customWorkFolderInUse(ctx context.Context, absolute string) (bool, error) {
	roots, err := s.customWorkBusyRoots(ctx)
	if err != nil {
		return false, err
	}
	return customWorkFolderBusy(roots, relativeDataPath(s.cfg.DataRoot, absolute)), nil
}

// customWorkFolderBusy reports whether a folder, relative to the data root,
// is, holds, or lies inside one of roots.
func customWorkFolderBusy(roots []string, folder string) bool {
	for _, root := range roots {
		if fetchPathWithinRoot(root, folder) || fetchPathWithinRoot(folder, root) {
			return true
		}
	}
	return false
}

// customWorkBusyRoots lists, relative to the data root, the folders Fetch
// writes into: every configured Fetch root and the target of every active
// Fetch or Edit files run, including a folder that run merges away.
func (s *Server) customWorkBusyRoots(ctx context.Context) ([]string, error) {
	fetchRoots, err := s.configuredRemoteFetchWatchRoots(ctx)
	if err != nil {
		return nil, err
	}
	roots := []string{}
	for _, root := range fetchRoots {
		roots = append(roots, relativeDataPath(s.cfg.DataRoot, root))
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT manifest.target_root
		FROM remote_fetch_manifest AS manifest
		INNER JOIN workflow_run AS run ON run.id = manifest.workflow_run_id
		WHERE run.status IN ('queued', 'running')
		UNION ALL
		SELECT COALESCE(CAST(json_extract(job.payload_json, '$.target_root') AS TEXT), '')
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.worker_type = ? AND run.status IN ('queued', 'running')
		UNION ALL
		SELECT COALESCE(CAST(json_extract(merge.value, '$.rootPath') AS TEXT), '')
		FROM workflow_job AS job
		INNER JOIN workflow_run AS run ON run.id = job.workflow_run_id,
			json_each(job.payload_json, '$.merges') AS merge
		WHERE job.worker_type = ? AND run.status IN ('queued', 'running')
	`, workFolderEditWorkerType, workFolderEditWorkerType)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var root string
		if err := rows.Scan(&root); err != nil {
			_ = rows.Close()
			return nil, err
		}
		roots = append(roots, root)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return roots, nil
}

// customWorkFolderName keeps the folder's own name first and appends the code
// in brackets, such as "Example Work [KT00000001]".
func customWorkFolderName(name, code string) string {
	return strings.TrimSpace(name) + " [" + code + "]"
}

// assignCustomWorkCode advances the counter past every number a work or a
// folder name already uses.
func assignCustomWorkCode(ctx context.Context, tx *sql.Tx, folderCodes map[string]bool) (string, error) {
	for {
		var number int64
		if err := tx.QueryRowContext(ctx, `
			UPDATE custom_work_code_counter SET last_number = last_number + 1
			WHERE id = 1
			RETURNING last_number
		`).Scan(&number); err != nil {
			return "", err
		}
		code := workcode.Custom(number)
		if !workcode.Valid(code) {
			return "", errCustomWorkCodesExhausted
		}
		if folderCodes[code] {
			continue
		}
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM work WHERE UPPER(primary_code) = ?)", code).Scan(&exists); err != nil {
			return "", err
		}
		if !exists {
			return code, nil
		}
	}
}
