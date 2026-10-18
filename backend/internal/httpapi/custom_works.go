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
)

type customWorkFolder struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

type customWorkFoldersResponse struct {
	Folders        []customWorkFolder `json:"folders"`
	Truncated      bool               `json:"truncated"`
	NoticeAccepted bool               `json:"noticeAccepted"`
}

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
		response.Folders = append(response.Folders, customWorkFolder{Path: candidate.RelPath, Name: candidate.Name})
	}
	writeJSON(w, http.StatusOK, response)
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
	rel := normalizeFolderRootPath(payload.Path)
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

	s.customWorkMu.Lock()
	defer s.customWorkMu.Unlock()
	created, err := s.createCustomWorkFromFolder(r.Context(), rel, title)
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
	default:
		// Filesystem errors name host paths; they stay in the server log.
		slog.Warn("custom work request failed", "error", err)
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "the custom work could not be created"})
	}
}

// discoverCustomWorkCandidates walks the folders a local scan can observe:
// online storage pools, within the effective scan depth.
func (s *Server) discoverCustomWorkCandidates(ctx context.Context) (localfs.CustomWorkDiscovery, error) {
	scope, err := s.localScanScope(ctx, s.cfg.DataRoot, s.effectiveLocalScanDepth(ctx))
	if err != nil {
		return localfs.CustomWorkDiscovery{}, err
	}
	if len(scope.online) == 0 {
		return localfs.CustomWorkDiscovery{}, errLibraryUnavailable
	}
	discovery, err := localfs.DiscoverCustomWorkCandidates(s.cfg.DataRoot, localfs.Options{
		ScanDepth: scope.walkDepth(), SubRoots: scope.subRoots(),
	})
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

// createCustomWorkFromFolder renames the folder inside the transaction that
// assigns its code and inserts its work, so a failed rename leaves no work and
// a failed commit renames the folder back.
func (s *Server) createCustomWorkFromFolder(ctx context.Context, rel, title string) (createCustomWorkResponse, error) {
	discovery, err := s.discoverCustomWorkCandidates(ctx)
	if err != nil {
		return createCustomWorkResponse{}, err
	}
	var folder *localfs.CustomWorkCandidate
	for index := range discovery.Candidates {
		if discovery.Candidates[index].RelPath == rel {
			folder = &discovery.Candidates[index]
			break
		}
	}
	if folder == nil {
		return createCustomWorkResponse{}, errCustomWorkFolderUnavailable
	}
	if title == "" {
		title = strings.TrimSpace(folder.Name)
	}

	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return createCustomWorkResponse{}, err
	}
	defer func() { _ = tx.Rollback() }()
	code, err := assignCustomWorkCode(ctx, tx, discovery.Codes)
	if err != nil {
		return createCustomWorkResponse{}, err
	}
	name := customWorkFolderName(folder.Name, code)
	if len(name) > customWorkFolderNameLimit {
		return createCustomWorkResponse{}, errCustomWorkFolderUnavailable
	}
	target := filepath.Join(filepath.Dir(folder.AbsPath), name)
	if _, err := os.Lstat(target); err == nil {
		return createCustomWorkResponse{}, errCustomWorkFolderUnavailable
	} else if !os.IsNotExist(err) {
		return createCustomWorkResponse{}, err
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, description)
		VALUES (?, 'audio', ?, '')
	`, code, title)
	if err != nil {
		return createCustomWorkResponse{}, err
	}
	workID, err := result.LastInsertId()
	if err != nil {
		return createCustomWorkResponse{}, err
	}
	if err := os.Rename(folder.AbsPath, target); err != nil {
		return createCustomWorkResponse{}, err
	}
	if err := tx.Commit(); err != nil {
		if restoreErr := os.Rename(target, folder.AbsPath); restoreErr != nil {
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
