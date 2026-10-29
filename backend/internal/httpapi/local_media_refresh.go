package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// localMediaRefreshRequest names what to refresh. With a folder, only that
// active local folder of the work is indexed again; without one, the folder
// the work's local presence on the source names is, with the work's other
// folders.
type localMediaRefreshRequest struct {
	FileSourceID int64 `json:"fileSourceId"`
	FolderID     int64 `json:"folderId"`
}

type localMediaRefreshResult struct {
	WorkID       int64  `json:"workId"`
	FileSourceID int64  `json:"fileSourceId"`
	FolderID     int64  `json:"folderId,omitempty"`
	Status       string `json:"status"`
	IndexedFiles int    `json:"indexedFiles"`
}

func (s *Server) refreshWorkLocalFiles(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	request := localMediaRefreshRequest{}
	if r.Body != nil && r.ContentLength != 0 {
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
	}
	if request.FolderID > 0 {
		s.refreshWorkLocalFolder(w, r, workID, request)
		return
	}

	var targetWorkID int64
	var fileSourceID int64
	var relPath string
	err = s.db.QueryRowContext(r.Context(), `
		SELECT presence.work_id, presence.file_source_id, presence.source_url
		FROM work_source_presence AS presence
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE presence.work_id = ?
			AND presence.presence_type = 'local'
			AND presence.availability = 'available'
			AND source.source_type = 'local_folder'
			AND (? = 0 OR presence.file_source_id = ?)
		ORDER BY source.priority ASC, presence.updated_at DESC
		LIMIT 1
	`, workID, request.FileSourceID, request.FileSourceID).Scan(&targetWorkID, &fileSourceID, &relPath)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no local folder is linked to this work"})
			return
		}
		writeError(w, err)
		return
	}
	if err := s.ensureLibraryPathOnline(r.Context(), relPath); err != nil {
		writeError(w, err)
		return
	}
	if err := s.indexLocalMediaForWork(r.Context(), targetWorkID, fileSourceID, relPath); err != nil {
		writeError(w, err)
		return
	}
	if err := s.indexAdditionalLocalFolders(r.Context(), targetWorkID, true); err != nil {
		writeError(w, err)
		return
	}
	var indexedFiles int
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
	`, targetWorkID, fileSourceID).Scan(&indexedFiles); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, localMediaRefreshResult{
		WorkID: targetWorkID, FileSourceID: fileSourceID, Status: "succeeded", IndexedFiles: indexedFiles,
	})
}

// refreshWorkLocalFolder indexes one active local folder of the work again,
// such as the folder Manage files edits. The work's other folders keep what
// is indexed. A folder the library scan cannot reach, on an offline pool or
// deeper than the scan depth, is refused rather than recorded as missing.
func (s *Server) refreshWorkLocalFolder(w http.ResponseWriter, r *http.Request, workID int64, request localMediaRefreshRequest) {
	var fileSourceID int64
	var root string
	err := s.db.QueryRowContext(r.Context(), `
		SELECT folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE folder.id = ?
			AND folder.work_id = ?
			AND folder.state = 'active'
			AND source.source_type = 'local_folder'
			AND (? = 0 OR folder.file_source_id = ?)
	`, request.FolderID, workID, request.FileSourceID, request.FileSourceID).Scan(&fileSourceID, &root)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such local folder of this work"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if root = normalizeFolderRootPath(root); root == "" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such local folder of this work"})
		return
	}
	if err := s.ensureLibraryPathOnline(r.Context(), root); err != nil {
		writeError(w, err)
		return
	}
	scope, err := s.localScanScope(r.Context(), s.cfg.DataRoot, s.effectiveLocalScanDepth(r.Context()))
	if err != nil {
		writeError(w, err)
		return
	}
	if !scope.contains(root) {
		writeAPIError(w, http.StatusConflict, "folder_outside_scan_scope",
			"This folder is outside what the library scan reaches. Raise the scan depth in Settings -> Library to refresh it.", false)
		return
	}
	if err := s.indexLocalMediaForWork(r.Context(), workID, fileSourceID, root); err != nil {
		writeError(w, err)
		return
	}
	var indexedFiles int
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COUNT(*)
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
			AND substr(location.path, 1, length(?) + 1) = ? || '/'
	`, workID, fileSourceID, root, root).Scan(&indexedFiles); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, localMediaRefreshResult{
		WorkID: workID, FileSourceID: fileSourceID, FolderID: request.FolderID, Status: "succeeded", IndexedFiles: indexedFiles,
	})
}
