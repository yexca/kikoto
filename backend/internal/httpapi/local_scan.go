package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func (s *Server) createLocalScanRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	var request localScanRunRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid local scan request"})
		return
	}
	result, err := s.enqueueLocalScanWithOptions(r.Context(), "manual", "manual", 0, request.FollowUpRun)
	if err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}

type localScanRunRequest struct {
	FollowUpRun bool `json:"followUpRun"`
}

type localScanResult struct {
	RunID            int64    `json:"runId"`
	JobID            int64    `json:"jobId"`
	FileSourceID     int64    `json:"fileSourceId"`
	Status           string   `json:"status"`
	DetectedWorks    int      `json:"detectedWorks"`
	ScannedFiles     int      `json:"scannedFiles"`
	UpdatedLocations int      `json:"updatedLocations"`
	SkippedLocations int      `json:"skippedLocations"`
	FollowUpRun      bool     `json:"followUpRun"`
	NewWorkCodes     []string `json:"newWorkCodes"`
	Failures         []string `json:"failures"`
}

func (s *Server) configuredLocalScanDepth(ctx context.Context) int {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = 'local_scan_depth'").Scan(&raw); err != nil {
		return s.cfg.LocalScanDepth
	}
	var value int
	if err := json.Unmarshal([]byte(raw), &value); err != nil || value <= 0 {
		return s.cfg.LocalScanDepth
	}
	return value
}

// EnsureLocalSource initializes the deployment-owned local source before the
// HTTP server starts. Settings reads can then remain strictly read-only.
func (s *Server) EnsureLocalSource(ctx context.Context) error {
	scanDepth := s.configuredLocalScanDepth(ctx)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := s.upsertLocalFileSource(ctx, tx, scanDepth); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) upsertLocalFileSource(ctx context.Context, tx *sql.Tx, scanDepth int) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES ('main_local_library', 'Main local library', 'local_folder', 1, 1, ?)
		ON CONFLICT(code) DO UPDATE SET
			display_name = excluded.display_name,
			source_type = excluded.source_type,
			priority = excluded.priority,
			enabled = excluded.enabled,
			config_json = excluded.config_json,
			updated_at = CURRENT_TIMESTAMP
	`, mustJSON(map[string]any{
		"root":             s.cfg.DataRoot,
		"scan_depth":       scanDepth,
		"code_patterns":    []string{"RJ", "BJ", "VJ", "CC"},
		"audio_extensions": []string{".mp3", ".m4a", ".flac", ".wav", ".wma", ".ogg", ".opus", ".aac"},
	})); err != nil {
		return 0, err
	}

	return sqlutil.SelectID(ctx, tx, "SELECT id FROM file_source WHERE code = ?", "main_local_library")
}

func localDuplicateGroupSummaries(groups []localfs.DuplicateGroup) []map[string]any {
	summaries := make([]map[string]any, 0, len(groups))
	for _, group := range groups {
		summaries = append(summaries, map[string]any{
			"code":    group.Code,
			"folders": localDuplicateFolderSummaries(group.Folders),
		})
	}
	return summaries
}

func localDuplicateFolderSummaries(folders []localfs.WorkFolder) []map[string]any {
	summaries := make([]map[string]any, 0, len(folders))
	for _, folder := range folders {
		var totalSize int64
		audioFiles := 0
		for _, file := range folder.Files {
			totalSize += file.SizeBytes
			if localFileKind(file.WorkRelPath) == "audio" {
				audioFiles++
			}
		}
		summaries = append(summaries, map[string]any{
			"code":        folder.Code,
			"title":       folder.Title,
			"rel_path":    filepath.ToSlash(folder.RelPath),
			"depth":       folder.Depth,
			"files":       len(folder.Files),
			"audio_files": audioFiles,
			"size_bytes":  totalSize,
		})
	}
	return summaries
}

func (s *Server) probeMediaMetadataSeconds(ctx context.Context, path string) (int64, bool, bool) {
	output, err := s.runBoundedFFprobe(ctx, path, "format=duration:stream=codec_type")
	if err != nil {
		return 0, false, false
	}
	return parseMediaProbeOutput(output)
}

func parseMediaProbeOutput(output []byte) (int64, bool, bool) {
	var payload struct {
		Format struct {
			Duration string `json:"duration"`
		} `json:"format"`
		Streams []struct {
			CodecType string `json:"codec_type"`
		} `json:"streams"`
	}
	if err := json.Unmarshal(output, &payload); err != nil {
		return 0, false, false
	}
	hasAudio := false
	for _, stream := range payload.Streams {
		if strings.EqualFold(strings.TrimSpace(stream.CodecType), "audio") {
			hasAudio = true
			break
		}
	}
	seconds, err := strconv.ParseFloat(strings.TrimSpace(payload.Format.Duration), 64)
	if err != nil || seconds <= 0 {
		return 0, hasAudio, true
	}
	return int64(seconds + 0.5), hasAudio, true
}

func insertLocalDuplicateCandidates(ctx context.Context, tx *sql.Tx, runID int64, groups []localfs.DuplicateGroup) error {
	for _, group := range groups {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
			VALUES (?, 'local_duplicate_work_folder', ?, 'pending', ?)
		`, runID, group.Code, mustJSON(map[string]any{
			"code":    group.Code,
			"folders": localDuplicateFolderSummaries(group.Folders),
			"message": "Multiple local folders were detected for the same work code. Review before deleting or hiding any files.",
		})); err != nil {
			return err
		}
	}
	return nil
}

func upsertDetectedWork(ctx context.Context, tx *sql.Tx, folder localfs.WorkFolder) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, description)
		VALUES (?, 'audio', ?, ?)
		ON CONFLICT(primary_code) DO UPDATE SET
			description = CASE
				WHEN work.description = '' OR work.description LIKE 'Detected from local folder %' THEN excluded.description
				ELSE work.description
			END,
			updated_at = CURRENT_TIMESTAMP
	`, folder.Code, folder.Title, fmt.Sprintf("Detected from local folder %s.", filepath.ToSlash(folder.RelPath))); err != nil {
		return 0, err
	}

	return sqlutil.SelectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", folder.Code)
}

func upsertDetectedMediaItem(ctx context.Context, tx *sql.Tx, workID int64, folder localfs.WorkFolder, file localfs.LocalFile, kind string, trackNo int) (int64, error) {
	fingerprint := fmt.Sprintf("local:%s:%s", folder.Code, file.WorkRelPath)
	var trackNoValue any
	if trackNo > 0 {
		trackNoValue = trackNo
	}
	durationValue := nullableDuration(file.DurationSeconds)
	hasAudioValue := nullableBoolPointer(file.HasAudio)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO media_item (
			work_id,
			kind,
			title,
			track_no,
			duration_seconds,
			has_audio,
			size_bytes,
			fingerprint
		)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM media_item WHERE fingerprint = ?
		)
	`, workID, kind, file.Title, trackNoValue, durationValue, hasAudioValue, file.SizeBytes, fingerprint, fingerprint)
	if err != nil {
		return 0, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return 0, err
	} else if affected > 0 {
		return result.LastInsertId()
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET kind = ?,
			title = ?,
			track_no = ?,
			duration_seconds = COALESCE(?, duration_seconds),
			has_audio = COALESCE(?, has_audio),
			size_bytes = ?
		WHERE fingerprint = ?
	`, kind, file.Title, trackNoValue, durationValue, hasAudioValue, file.SizeBytes, fingerprint); err != nil {
		return 0, err
	}
	return sqlutil.SelectID(ctx, tx, "SELECT id FROM media_item WHERE fingerprint = ? ORDER BY id ASC LIMIT 1", fingerprint)
}

func upsertDetectedLocation(ctx context.Context, tx *sql.Tx, mediaItemID int64, fileSourceID int64, file localfs.LocalFile) (int64, error) {
	durationValue := nullableDuration(file.DurationSeconds)
	result, err := tx.ExecContext(ctx, `
		INSERT INTO media_file_location (
			media_item_id,
			file_source_id,
			location_type,
			path,
			size_bytes,
			duration_seconds,
			availability,
			last_checked_at
		)
		SELECT ?, ?, 'local', ?, ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'local'
				AND path = ?
		)
	`, mediaItemID, fileSourceID, file.RelPath, file.SizeBytes, durationValue, mediaItemID, fileSourceID, file.RelPath)
	if err != nil {
		return 0, err
	}
	if affected, err := result.RowsAffected(); err != nil {
		return 0, err
	} else if affected > 0 {
		return result.LastInsertId()
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			duration_seconds = COALESCE(?, duration_seconds),
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, file.SizeBytes, durationValue, mediaItemID, fileSourceID, file.RelPath); err != nil {
		return 0, err
	}
	return sqlutil.SelectID(ctx, tx, `
		SELECT id
		FROM media_file_location
		WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'local' AND path = ?
		ORDER BY id ASC
		LIMIT 1
	`, mediaItemID, fileSourceID, file.RelPath)
}

func (s *Server) updateLocalMediaMetadata(ctx context.Context, fileSourceID int64, file localfs.LocalFile, durationSeconds int64, hasAudio bool) error {
	var durationValue any
	if durationSeconds > 0 {
		durationValue = durationSeconds
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET duration_seconds = COALESCE(duration_seconds, ?)
		WHERE file_source_id = ?
			AND location_type = 'local'
			AND path = ?
			AND size_bytes = ?
			AND availability = 'available'
			AND duration_seconds IS NULL
	`, durationValue, fileSourceID, file.RelPath, file.SizeBytes); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET duration_seconds = COALESCE(duration_seconds, ?),
			has_audio = ?
		WHERE id IN (
			SELECT media_item_id
			FROM media_file_location
			WHERE file_source_id = ?
				AND location_type = 'local'
				AND path = ?
				AND size_bytes = ?
				AND availability = 'available'
		)
			AND duration_seconds IS NULL
	`, durationValue, hasAudio, fileSourceID, file.RelPath, file.SizeBytes); err != nil {
		return err
	}
	return tx.Commit()
}

func localLocationExists(ctx context.Context, tx *sql.Tx, fileSourceID int64, file localfs.LocalFile) (bool, error) {
	var count int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM media_file_location
		WHERE file_source_id = ?
			AND location_type = 'local'
			AND path = ?
			AND size_bytes = ?
			AND availability = 'available'
	`, fileSourceID, file.RelPath, file.SizeBytes).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

func markMissingLocalLocationsForWork(ctx context.Context, tx *sql.Tx, workID int64, fileSourceID int64, seenPaths map[string]bool) (int, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT location.id, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
	`, workID, fileSourceID)
	if err != nil {
		return 0, err
	}
	defer func() { _ = rows.Close() }()
	missingIDs := []int64{}
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			return 0, err
		}
		if !seenPaths[path] {
			missingIDs = append(missingIDs, id)
		}
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, id := range missingIDs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE media_file_location
			SET availability = 'missing',
				last_checked_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, id); err != nil {
			return 0, err
		}
	}
	return len(missingIDs), nil
}

func markLocalLocationsMissingForChangedFolder(ctx context.Context, tx *sql.Tx, workID int64, fileSourceID int64, folderPath string) (int, error) {
	folderPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(folderPath))))
	folderPath = strings.Trim(folderPath, "/")
	if folderPath == "" || folderPath == "." {
		return 0, nil
	}
	var mismatched bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			WHERE item.work_id = ?
				AND location.file_source_id = ?
				AND location.location_type = 'local'
				AND location.availability = 'available'
				AND NOT (
					location.path = ?
					OR substr(location.path, 1, length(?) + 1) = ? || '/'
				)
		)
	`, workID, fileSourceID, folderPath, folderPath, folderPath).Scan(&mismatched); err != nil {
		return 0, err
	}
	if !mismatched {
		return 0, nil
	}
	// Invalidate the complete local set so the existing lazy indexer rebuilds
	// one consistent tree instead of stopping after it sees a partial new set.
	return markAvailableLocalLocationsMissingForWork(ctx, tx, workID, fileSourceID)
}

func markAvailableLocalLocationsMissingForWork(ctx context.Context, tx *sql.Tx, workID int64, fileSourceID int64) (int, error) {
	result, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'missing',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
			AND location_type = 'local'
			AND availability = 'available'
			AND media_item_id IN (
				SELECT id FROM media_item WHERE work_id = ?
			)
	`, fileSourceID, workID)
	if err != nil {
		return 0, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return 0, err
	}
	return int(affected), nil
}

// markMissingLocalPresence marks works the scan did not find. A work whose
// recorded root lies outside the scan's reach, in an offline pool or deeper
// than the scan depth, keeps its state: the scan could not have seen it.
func markMissingLocalPresence(ctx context.Context, tx *sql.Tx, fileSourceID int64, seenWorkIDs map[int64]bool, inScope func(string) bool) ([]int64, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT work_id, source_url
		FROM work_source_presence
		WHERE file_source_id = ?
			AND presence_type = 'local'
	`, fileSourceID)
	if err != nil {
		return nil, err
	}
	missingWorkIDs := []int64{}
	for rows.Next() {
		var workID int64
		var root string
		if err := rows.Scan(&workID, &root); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if !seenWorkIDs[workID] && (normalizeFolderRootPath(root) == "" || inScope(root)) {
			missingWorkIDs = append(missingWorkIDs, workID)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, workID := range missingWorkIDs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE work_source_presence
			SET availability = 'missing',
				last_checked_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
			WHERE file_source_id = ?
				AND presence_type = 'local'
				AND work_id = ?
				AND availability != 'missing'
		`, fileSourceID, workID); err != nil {
			return nil, err
		}
	}
	return missingWorkIDs, nil
}
