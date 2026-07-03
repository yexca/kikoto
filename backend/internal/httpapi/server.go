package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"path/filepath"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

type Server struct {
	db  *sql.DB
	cfg config.Config
}

func NewServer(db *sql.DB, cfg config.Config) *Server {
	return &Server{db: db, cfg: cfg}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", s.health)
	mux.HandleFunc("GET /api/works", s.listWorks)
	mux.HandleFunc("GET /api/file-sources", s.listFileSources)
	mux.HandleFunc("GET /api/workflow-runs", s.listWorkflowRuns)
	mux.HandleFunc("POST /api/workflow-runs/local-scan", s.createLocalScanRun)
	return withCORS(mux)
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) listWorks(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, primary_code, title, created_at
		FROM work
		ORDER BY created_at DESC
		LIMIT 100
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	type work struct {
		ID          int64  `json:"id"`
		PrimaryCode string `json:"primaryCode"`
		Title       string `json:"title"`
		CreatedAt   string `json:"createdAt"`
	}

	works := []work{}
	for rows.Next() {
		var item work
		if err := rows.Scan(&item.ID, &item.PrimaryCode, &item.Title, &item.CreatedAt); err != nil {
			writeError(w, err)
			return
		}
		works = append(works, item)
	}

	writeJSON(w, http.StatusOK, works)
}

func (s *Server) listFileSources(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, code, display_name, source_type, enabled
		FROM file_source
		ORDER BY priority ASC, id ASC
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	type source struct {
		ID          int64  `json:"id"`
		Code        string `json:"code"`
		DisplayName string `json:"displayName"`
		SourceType  string `json:"sourceType"`
		Enabled     bool   `json:"enabled"`
	}

	sources := []source{}
	for rows.Next() {
		var item source
		if err := rows.Scan(&item.ID, &item.Code, &item.DisplayName, &item.SourceType, &item.Enabled); err != nil {
			writeError(w, err)
			return
		}
		sources = append(sources, item)
	}

	writeJSON(w, http.StatusOK, sources)
}

func (s *Server) listWorkflowRuns(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, template_code, status, trigger_reason, created_at
		FROM workflow_run
		ORDER BY created_at DESC
		LIMIT 100
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	type run struct {
		ID            int64  `json:"id"`
		TemplateCode  string `json:"templateCode"`
		Status        string `json:"status"`
		TriggerReason string `json:"triggerReason"`
		CreatedAt     string `json:"createdAt"`
	}

	runs := []run{}
	for rows.Next() {
		var item run
		if err := rows.Scan(&item.ID, &item.TemplateCode, &item.Status, &item.TriggerReason, &item.CreatedAt); err != nil {
			writeError(w, err)
			return
		}
		runs = append(runs, item)
	}

	writeJSON(w, http.StatusOK, runs)
}

func (s *Server) createLocalScanRun(w http.ResponseWriter, r *http.Request) {
	result, err := s.runLocalScan(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}

type localScanResult struct {
	RunID            int64  `json:"runId"`
	JobID            int64  `json:"jobId"`
	FileSourceID     int64  `json:"fileSourceId"`
	Status           string `json:"status"`
	DetectedWorks    int    `json:"detectedWorks"`
	ScannedFiles     int    `json:"scannedFiles"`
	UpdatedLocations int    `json:"updatedLocations"`
}

func (s *Server) runLocalScan(ctx context.Context) (localScanResult, error) {
	scanDepth := s.cfg.LocalScanDepth

	workFolders, scanSummary, err := localfs.Discover(s.cfg.DataRoot, localfs.Options{ScanDepth: scanDepth})
	if err != nil {
		return localScanResult{}, err
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return localScanResult{}, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	runID, err := insertAndID(ctx, tx, `
		INSERT INTO workflow_run (
			template_code,
			status,
			trigger_reason,
			params_json,
			summary_json,
			started_at,
			finished_at
		)
		VALUES (
			'local_scan',
			'succeeded',
			'manual',
			?,
			?,
			CURRENT_TIMESTAMP,
			CURRENT_TIMESTAMP
		)
	`, mustJSON(map[string]any{
		"root":       s.cfg.DataRoot,
		"scan_depth": scanDepth,
	}), mustJSON(map[string]any{
		"candidate_folders": scanSummary.CandidateFolders,
		"detected_works":    scanSummary.DetectedWorks,
		"scanned_files":     scanSummary.ScannedFiles,
		"ambiguous_folders": scanSummary.AmbiguousFolders,
	}))
	if err != nil {
		return localScanResult{}, err
	}

	jobID, err := insertAndID(ctx, tx, `
		INSERT INTO workflow_job (
			run_id,
			node_code,
			worker_type,
			status,
			payload_json,
			progress_current,
			progress_total
		)
		VALUES (
			?,
			'scan_local_folder',
			'local_folder_scan',
			'succeeded',
			?,
			?,
			?
		)
	`, runID, mustJSON(map[string]any{
		"root":       s.cfg.DataRoot,
		"scan_depth": scanDepth,
	}), scanSummary.ScannedFiles, scanSummary.ScannedFiles)
	if err != nil {
		return localScanResult{}, err
	}

	fileSourceID, err := s.upsertLocalFileSource(ctx, tx, scanDepth)
	if err != nil {
		return localScanResult{}, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'missing',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
			AND location_type = 'local'
	`, fileSourceID); err != nil {
		return localScanResult{}, err
	}

	updatedLocations := 0
	for _, folder := range workFolders {
		workID, err := upsertDetectedWork(ctx, tx, folder)
		if err != nil {
			return localScanResult{}, err
		}

		for index, file := range folder.AudioFiles {
			mediaItemID, err := upsertDetectedMediaItem(ctx, tx, workID, folder, file, index+1)
			if err != nil {
				return localScanResult{}, err
			}
			if _, err := upsertDetectedLocation(ctx, tx, mediaItemID, fileSourceID, file); err != nil {
				return localScanResult{}, err
			}
			updatedLocations++
		}
	}

	if err := tx.Commit(); err != nil {
		return localScanResult{}, err
	}

	return localScanResult{
		RunID:            runID,
		JobID:            jobID,
		FileSourceID:     fileSourceID,
		Status:           "succeeded",
		DetectedWorks:    scanSummary.DetectedWorks,
		ScannedFiles:     scanSummary.ScannedFiles,
		UpdatedLocations: updatedLocations,
	}, nil
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
		"watch_enabled":    false,
		"code_patterns":    []string{"RJ", "BJ", "VJ", "CC"},
		"audio_extensions": []string{".mp3", ".m4a", ".flac", ".wav", ".ogg", ".opus", ".aac"},
	})); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, "SELECT id FROM file_source WHERE code = ?", "main_local_library")
}

func upsertDetectedWork(ctx context.Context, tx *sql.Tx, folder localfs.WorkFolder) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, description)
		VALUES (?, 'audio', ?, ?)
		ON CONFLICT(primary_code) DO UPDATE SET
			title = excluded.title,
			description = excluded.description,
			updated_at = CURRENT_TIMESTAMP
	`, folder.Code, folder.Title, fmt.Sprintf("Detected from local folder %s.", filepath.ToSlash(folder.RelPath))); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", folder.Code)
}

func upsertDetectedMediaItem(ctx context.Context, tx *sql.Tx, workID int64, folder localfs.WorkFolder, file localfs.AudioFile, trackNo int) (int64, error) {
	fingerprint := fmt.Sprintf("local:%s:%s", folder.Code, file.WorkRelPath)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO media_item (
			work_id,
			kind,
			title,
			track_no,
			duration_seconds,
			size_bytes,
			fingerprint
		)
		SELECT ?, 'audio', ?, ?, NULL, ?, ?
		WHERE NOT EXISTS (
			SELECT 1 FROM media_item WHERE fingerprint = ?
		)
	`, workID, file.Title, trackNo, file.SizeBytes, fingerprint, fingerprint); err != nil {
		return 0, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET title = ?,
			track_no = ?,
			size_bytes = ?
		WHERE fingerprint = ?
	`, file.Title, trackNo, file.SizeBytes, fingerprint); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, "SELECT id FROM media_item WHERE fingerprint = ?", fingerprint)
}

func upsertDetectedLocation(ctx context.Context, tx *sql.Tx, mediaItemID int64, fileSourceID int64, file localfs.AudioFile) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
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
		SELECT ?, ?, 'local', ?, ?, NULL, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'local'
				AND path = ?
		)
	`, mediaItemID, fileSourceID, file.RelPath, file.SizeBytes, mediaItemID, fileSourceID, file.RelPath); err != nil {
		return 0, err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, file.SizeBytes, mediaItemID, fileSourceID, file.RelPath); err != nil {
		return 0, err
	}

	return selectID(ctx, tx, `
		SELECT id
		FROM media_file_location
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, mediaItemID, fileSourceID, file.RelPath)
}

func insertAndID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}

	id, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}

	return id, nil
}

func selectID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	var id int64
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, sql.ErrNoRows
		}
		return 0, err
	}

	return id, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func writeError(w http.ResponseWriter, err error) {
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
}

func mustJSON(value any) string {
	bytes, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(bytes)
}

func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
