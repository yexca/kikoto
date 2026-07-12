package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

type localMediaRefreshRequest struct {
	FileSourceID int64 `json:"fileSourceId"`
}

type localMediaRefreshResult struct {
	WorkID       int64  `json:"workId"`
	FileSourceID int64  `json:"fileSourceId"`
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

	var targetWorkID int64
	var fileSourceID int64
	var relPath string
	err = s.db.QueryRowContext(r.Context(), `
		SELECT presence.work_id, presence.file_source_id, presence.source_url
		FROM work_source_presence AS presence
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE (
				presence.work_id = ?
				OR presence.work_id IN (
					SELECT sibling.work_id
					FROM work_edition AS current_edition
					INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
					WHERE current_edition.work_id = ?
				)
			)
			AND presence.presence_type = 'local'
			AND presence.availability = 'available'
			AND source.source_type = 'local_folder'
			AND (? = 0 OR presence.file_source_id = ?)
		ORDER BY CASE WHEN presence.work_id = ? THEN 0 ELSE 1 END, source.priority ASC, presence.updated_at DESC
		LIMIT 1
	`, workID, workID, request.FileSourceID, request.FileSourceID, workID).Scan(&targetWorkID, &fileSourceID, &relPath)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no local folder is linked to this work"})
			return
		}
		writeError(w, err)
		return
	}
	if err := s.indexLocalMediaForWork(r.Context(), targetWorkID, fileSourceID, relPath); err != nil {
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
