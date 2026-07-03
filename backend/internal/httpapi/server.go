package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/metasync"
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
	mux.HandleFunc("GET /api/auth/me", s.getCurrentUser)
	mux.HandleFunc("POST /api/auth/login", s.login)
	mux.HandleFunc("POST /api/auth/logout", s.logout)
	mux.HandleFunc("GET /api/users", s.listUsers)
	mux.HandleFunc("POST /api/users", s.createUser)
	mux.HandleFunc("PATCH /api/users/{id}", s.updateUser)
	mux.HandleFunc("DELETE /api/users/{id}", s.deleteUser)
	mux.HandleFunc("GET /api/works", s.listWorks)
	mux.HandleFunc("GET /api/works/{id}", s.getWork)
	mux.HandleFunc("PATCH /api/works/{id}/user-state", s.updateWorkUserState)
	mux.HandleFunc("GET /api/assets/covers/{file}", s.getCoverAsset)
	mux.HandleFunc("GET /api/media/{id}/stream", s.streamMedia)
	mux.HandleFunc("PATCH /api/media-items/{id}/progress", s.updateMediaProgress)
	mux.HandleFunc("GET /api/file-sources", s.listFileSources)
	mux.HandleFunc("GET /api/workflow-runs", s.listWorkflowRuns)
	mux.HandleFunc("POST /api/workflow-runs/local-scan", s.createLocalScanRun)
	mux.HandleFunc("POST /api/workflow-runs/dlsite-sync", s.createDLsiteSyncRun)
	return withCORS(s.authMiddleware(mux))
}

func (s *Server) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

func (s *Server) getCurrentUser(w http.ResponseWriter, r *http.Request) {
	user, ok := userFromContext(r.Context())
	if !ok {
		writeJSON(w, http.StatusOK, map[string]any{"authenticated": false})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": user})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	username, password, err := parseLoginRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}

	var userID int64
	var passwordHash string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT account.id, credential.password_hash
		FROM user_account AS account
		INNER JOIN user_password_credential AS credential ON credential.user_id = account.id
		WHERE account.username = ? AND account.enabled = 1
	`, username).Scan(&userID, &passwordHash); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}
	if !verifyPassword(password, passwordHash) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid username or password"})
		return
	}

	sessionID, err := newSessionID()
	if err != nil {
		writeError(w, err)
		return
	}
	expiresAt := time.Now().Add(30 * 24 * time.Hour).UTC()
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_session (id, user_id, expires_at)
		VALUES (?, ?, ?)
	`, sessionID, userID, expiresAt.Format("2006-01-02 15:04:05")); err != nil {
		writeError(w, err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    sessionID,
		Path:     "/",
		Expires:  expiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})

	user, err := s.loadUserByID(r.Context(), userID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"authenticated": true, "user": user})
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	if cookie, err := r.Cookie(sessionCookieName); err == nil {
		_, _ = s.db.ExecContext(r.Context(), "DELETE FROM user_session WHERE id = ?", cookie.Value)
	}
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName,
		Value:    "",
		Path:     "/",
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) getCoverAsset(w http.ResponseWriter, r *http.Request) {
	file := filepath.Base(r.PathValue("file"))
	if file == "." || file == string(filepath.Separator) || strings.Contains(file, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid cover file"})
		return
	}
	path := filepath.Join(s.cfg.CacheRoot, "cover", file)
	http.ServeFile(w, r, path)
}

func (s *Server) listWorks(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			work.id,
			work.primary_code,
			work.title,
			work.created_at,
			(
				SELECT COUNT(*)
				FROM media_item
				WHERE media_item.work_id = work.id
			) AS track_count,
			(
				SELECT COUNT(*)
				FROM media_file_location
				INNER JOIN media_item ON media_item.id = media_file_location.media_item_id
				WHERE media_item.work_id = work.id
					AND media_file_location.availability = 'available'
			) AS available_locations,
			(
				SELECT snapshot_json
				FROM metadata_snapshot
				INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id
				WHERE metadata_snapshot.work_id = work.id
					AND metadata_provider.code = 'dlsite'
				ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC
				LIMIT 1
			) AS snapshot_json,
			COALESCE(user_work_state.listening_status, 'none') AS listening_status
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id
			AND user_work_state.user_id = ?
		ORDER BY work.created_at DESC
		LIMIT 100
	`, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	type work struct {
		ID                 int64    `json:"id"`
		PrimaryCode        string   `json:"primaryCode"`
		Title              string   `json:"title"`
		CreatedAt          string   `json:"createdAt"`
		CoverURL           string   `json:"coverUrl"`
		DLsiteURL          string   `json:"dlsiteUrl"`
		Circle             string   `json:"circle"`
		Rating             *float64 `json:"rating"`
		Tags               []string `json:"tags"`
		VoiceActors        []string `json:"voiceActors"`
		TrackCount         int64    `json:"trackCount"`
		AvailableLocations int64    `json:"availableLocations"`
		Availability       []string `json:"availability"`
		ListeningStatus    string   `json:"listeningStatus"`
	}

	works := []work{}
	for rows.Next() {
		var item work
		var snapshot sql.NullString
		if err := rows.Scan(
			&item.ID,
			&item.PrimaryCode,
			&item.Title,
			&item.CreatedAt,
			&item.TrackCount,
			&item.AvailableLocations,
			&snapshot,
			&item.ListeningStatus,
		); err != nil {
			writeError(w, err)
			return
		}
		metadata := parseDLsiteSnapshot(snapshot.String)
		item.CoverURL = s.coverURL(item.PrimaryCode)
		item.DLsiteURL = dlsiteURL(item.PrimaryCode)
		item.Circle = metadata.Circle
		item.Rating = metadata.Rating
		item.Tags = metadata.Tags
		item.VoiceActors = metadata.VoiceActors
		item.Availability = availabilityBadges(item.AvailableLocations)
		works = append(works, item)
	}

	writeJSON(w, http.StatusOK, works)
}

type workDetail struct {
	ID              int64             `json:"id"`
	PrimaryCode     string            `json:"primaryCode"`
	WorkType        string            `json:"workType"`
	Title           string            `json:"title"`
	TitleKana       string            `json:"titleKana"`
	Description     string            `json:"description"`
	ReleaseDate     *string           `json:"releaseDate"`
	AgeRating       string            `json:"ageRating"`
	DurationSeconds *int64            `json:"durationSeconds"`
	CreatedAt       string            `json:"createdAt"`
	UpdatedAt       string            `json:"updatedAt"`
	CoverURL        string            `json:"coverUrl"`
	DLsiteURL       string            `json:"dlsiteUrl"`
	Circle          string            `json:"circle"`
	Rating          *float64          `json:"rating"`
	Tags            []string          `json:"tags"`
	VoiceActors     []string          `json:"voiceActors"`
	ListeningStatus string            `json:"listeningStatus"`
	MediaItems      []mediaItemDetail `json:"mediaItems"`
}

type mediaItemDetail struct {
	ID              int64                `json:"id"`
	ParentID        *int64               `json:"parentId"`
	Kind            string               `json:"kind"`
	Title           string               `json:"title"`
	DiscNo          *int64               `json:"discNo"`
	TrackNo         *int64               `json:"trackNo"`
	DurationSeconds *int64               `json:"durationSeconds"`
	SizeBytes       *int64               `json:"sizeBytes"`
	Fingerprint     string               `json:"fingerprint"`
	Progress        *mediaProgressDetail `json:"progress"`
	Locations       []fileLocationDetail `json:"locations"`
}

type fileLocationDetail struct {
	ID              int64   `json:"id"`
	FileSourceID    int64   `json:"fileSourceId"`
	FileSourceCode  string  `json:"fileSourceCode"`
	FileSourceName  string  `json:"fileSourceName"`
	LocationType    string  `json:"locationType"`
	Path            string  `json:"path"`
	StreamURL       string  `json:"streamUrl"`
	DownloadURL     string  `json:"downloadUrl"`
	RemoteHash      string  `json:"remoteHash"`
	SizeBytes       *int64  `json:"sizeBytes"`
	DurationSeconds *int64  `json:"durationSeconds"`
	Availability    string  `json:"availability"`
	LastCheckedAt   *string `json:"lastCheckedAt"`
}

func (s *Server) getWork(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}

	work, err := s.loadWorkDetail(r.Context(), user.ID, id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, work)
}

func (s *Server) streamMedia(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "playback:use"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}

	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, id).Scan(&locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "media location not found"})
			return
		}
		writeError(w, err)
		return
	}

	if locationType != "local" || availability != "available" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media location is not available"})
		return
	}

	path, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media path"})
		return
	}
	http.ServeFile(w, r, path)
}

func (s *Server) loadWorkDetail(ctx context.Context, userID int64, id int64) (workDetail, error) {
	var work workDetail
	var releaseDate sql.NullString
	var durationSeconds sql.NullInt64
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			work.id,
			work.primary_code,
			work.work_type,
			work.title,
			work.title_kana,
			work.description,
			work.release_date,
			work.age_rating,
			work.duration_seconds,
			work.created_at,
			work.updated_at,
			COALESCE(user_work_state.listening_status, 'none') AS listening_status
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id
			AND user_work_state.user_id = ?
		WHERE work.id = ?
	`, userID, id).Scan(
		&work.ID,
		&work.PrimaryCode,
		&work.WorkType,
		&work.Title,
		&work.TitleKana,
		&work.Description,
		&releaseDate,
		&work.AgeRating,
		&durationSeconds,
		&work.CreatedAt,
		&work.UpdatedAt,
		&work.ListeningStatus,
	); err != nil {
		return workDetail{}, err
	}
	work.ReleaseDate = nullableString(releaseDate)
	work.DurationSeconds = nullableInt64(durationSeconds)
	work.CoverURL = s.coverURL(work.PrimaryCode)
	work.DLsiteURL = dlsiteURL(work.PrimaryCode)
	work.MediaItems = []mediaItemDetail{}

	var snapshot sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT metadata_snapshot.snapshot_json
		FROM metadata_snapshot
		INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id
		WHERE metadata_snapshot.work_id = ?
			AND metadata_provider.code = 'dlsite'
		ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC
		LIMIT 1
	`, id).Scan(&snapshot); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return workDetail{}, err
	}
	metadata := parseDLsiteSnapshot(snapshot.String)
	work.Circle = metadata.Circle
	work.Rating = metadata.Rating
	work.Tags = metadata.Tags
	work.VoiceActors = metadata.VoiceActors

	rows, err := s.db.QueryContext(ctx, `
		SELECT
			media_item.id,
			media_item.parent_id,
			media_item.kind,
			media_item.title,
			media_item.disc_no,
			media_item.track_no,
			media_item.duration_seconds,
			media_item.size_bytes,
			media_item.fingerprint,
			user_media_progress.position_seconds,
			user_media_progress.duration_seconds,
			user_media_progress.completed,
			user_media_progress.last_played_at
		FROM media_item
		LEFT JOIN user_media_progress ON user_media_progress.media_item_id = media_item.id
			AND user_media_progress.user_id = ?
		WHERE media_item.work_id = ?
		ORDER BY
			COALESCE(media_item.disc_no, 0) ASC,
			COALESCE(media_item.track_no, 0) ASC,
			media_item.title ASC,
			media_item.id ASC
	`, userID, id)
	if err != nil {
		return workDetail{}, err
	}
	defer rows.Close()

	itemIndexes := map[int64]int{}
	for rows.Next() {
		var item mediaItemDetail
		var parentID sql.NullInt64
		var discNo sql.NullInt64
		var trackNo sql.NullInt64
		var itemDurationSeconds sql.NullInt64
		var sizeBytes sql.NullInt64
		var progressPositionSeconds sql.NullFloat64
		var progressDurationSeconds sql.NullFloat64
		var progressCompleted sql.NullBool
		var progressLastPlayedAt sql.NullString
		if err := rows.Scan(
			&item.ID,
			&parentID,
			&item.Kind,
			&item.Title,
			&discNo,
			&trackNo,
			&itemDurationSeconds,
			&sizeBytes,
			&item.Fingerprint,
			&progressPositionSeconds,
			&progressDurationSeconds,
			&progressCompleted,
			&progressLastPlayedAt,
		); err != nil {
			return workDetail{}, err
		}
		item.ParentID = nullableInt64(parentID)
		item.DiscNo = nullableInt64(discNo)
		item.TrackNo = nullableInt64(trackNo)
		item.DurationSeconds = nullableInt64(itemDurationSeconds)
		item.SizeBytes = nullableInt64(sizeBytes)
		item.Progress = nullableMediaProgress(progressPositionSeconds, progressDurationSeconds, progressCompleted, progressLastPlayedAt)
		item.Locations = []fileLocationDetail{}
		itemIndexes[item.ID] = len(work.MediaItems)
		work.MediaItems = append(work.MediaItems, item)
	}
	if err := rows.Err(); err != nil {
		return workDetail{}, err
	}

	if len(work.MediaItems) == 0 {
		return work, nil
	}

	locationRows, err := s.db.QueryContext(ctx, `
		SELECT
			location.id,
			location.media_item_id,
			location.file_source_id,
			source.code,
			source.display_name,
			location.location_type,
			location.path,
			location.stream_url,
			location.download_url,
			location.remote_hash,
			location.size_bytes,
			location.duration_seconds,
			location.availability,
			location.last_checked_at
		FROM media_file_location AS location
		INNER JOIN file_source AS source ON source.id = location.file_source_id
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
		ORDER BY source.priority ASC, location.id ASC
	`, id)
	if err != nil {
		return workDetail{}, err
	}
	defer locationRows.Close()

	for locationRows.Next() {
		var mediaItemID int64
		var location fileLocationDetail
		var sizeBytes sql.NullInt64
		var locationDurationSeconds sql.NullInt64
		var lastCheckedAt sql.NullString
		if err := locationRows.Scan(
			&location.ID,
			&mediaItemID,
			&location.FileSourceID,
			&location.FileSourceCode,
			&location.FileSourceName,
			&location.LocationType,
			&location.Path,
			&location.StreamURL,
			&location.DownloadURL,
			&location.RemoteHash,
			&sizeBytes,
			&locationDurationSeconds,
			&location.Availability,
			&lastCheckedAt,
		); err != nil {
			return workDetail{}, err
		}
		location.SizeBytes = nullableInt64(sizeBytes)
		location.DurationSeconds = nullableInt64(locationDurationSeconds)
		location.LastCheckedAt = nullableString(lastCheckedAt)
		if location.LocationType == "local" && location.Availability == "available" && location.StreamURL == "" {
			location.StreamURL = fmt.Sprintf("/api/media/%d/stream", location.ID)
		}
		if index, ok := itemIndexes[mediaItemID]; ok {
			work.MediaItems[index].Locations = append(work.MediaItems[index].Locations, location)
		}
	}
	if err := locationRows.Err(); err != nil {
		return workDetail{}, err
	}

	return work, nil
}

func (s *Server) listFileSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
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
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
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
	if _, ok := s.requirePermission(w, r, "workflows:run"); !ok {
		return
	}
	result, err := s.runLocalScan(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) createDLsiteSyncRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	syncer := metasync.NewDLsiteSyncer(s.db, dlsite.NewClient(nil)).WithCacheRoot(s.cfg.CacheRoot)
	result, err := syncer.SyncAll(r.Context())
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

func parseInt64PathValue(r *http.Request, name string) (int64, error) {
	value := r.PathValue(name)
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 {
		return 0, fmt.Errorf("invalid path value %s", name)
	}
	return id, nil
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

type dlsiteSnapshotMetadata struct {
	Circle      string
	Rating      *float64
	Tags        []string
	VoiceActors []string
}

func parseDLsiteSnapshot(raw string) dlsiteSnapshotMetadata {
	metadata := dlsiteSnapshotMetadata{
		Tags:        []string{},
		VoiceActors: []string{},
	}
	if strings.TrimSpace(raw) == "" {
		return metadata
	}

	rawBytes := []byte(raw)
	var combined struct {
		Product json.RawMessage `json:"product"`
		Dynamic json.RawMessage `json:"dynamic"`
	}
	if err := json.Unmarshal(rawBytes, &combined); err == nil && len(combined.Product) > 0 {
		rawBytes = combined.Product
	}

	var payload struct {
		MakerName      string   `json:"maker_name"`
		RateAverage2DP *float64 `json:"rate_average_2dp"`
		RateAverage    *float64 `json:"rate_average"`
		Genres         []struct {
			Name     string `json:"name"`
			NameBase string `json:"name_base"`
		} `json:"genres"`
		Creators map[string][]struct {
			Name string `json:"name"`
		} `json:"creaters"`
	}
	if err := json.Unmarshal(rawBytes, &payload); err != nil {
		return metadata
	}
	if len(combined.Dynamic) > 0 {
		var dynamic struct {
			RateAverage2DP *float64 `json:"rate_average_2dp"`
			RateAverage    *float64 `json:"rate_average"`
		}
		if err := json.Unmarshal(combined.Dynamic, &dynamic); err == nil {
			if dynamic.RateAverage2DP != nil {
				payload.RateAverage2DP = dynamic.RateAverage2DP
			} else if dynamic.RateAverage != nil {
				payload.RateAverage = dynamic.RateAverage
			}
		}
	}

	metadata.Circle = strings.TrimSpace(payload.MakerName)
	if payload.RateAverage2DP != nil {
		metadata.Rating = payload.RateAverage2DP
	} else if payload.RateAverage != nil {
		metadata.Rating = payload.RateAverage
	}

	seenTags := map[string]bool{}
	for _, genre := range payload.Genres {
		name := strings.TrimSpace(genre.Name)
		if name == "" {
			name = strings.TrimSpace(genre.NameBase)
		}
		if name == "" || seenTags[name] {
			continue
		}
		seenTags[name] = true
		metadata.Tags = append(metadata.Tags, name)
		if len(metadata.Tags) >= 8 {
			break
		}
	}

	seenActors := map[string]bool{}
	for _, creator := range payload.Creators["voice_by"] {
		name := strings.TrimSpace(creator.Name)
		if name == "" || seenActors[name] {
			continue
		}
		seenActors[name] = true
		metadata.VoiceActors = append(metadata.VoiceActors, name)
	}

	return metadata
}

func availabilityBadges(availableLocations int64) []string {
	if availableLocations > 0 {
		return []string{"local"}
	}
	return []string{"missing"}
}

func (s *Server) coverURL(primaryCode string) string {
	code := strings.ToUpper(strings.TrimSpace(primaryCode))
	if code == "" {
		return ""
	}
	for _, extension := range []string{".jpg", ".jpeg", ".png", ".webp"} {
		file := code + extension
		path := filepath.Join(s.cfg.CacheRoot, "cover", file)
		if _, err := os.Stat(path); err == nil {
			return "/api/assets/covers/" + file
		}
	}
	return ""
}

func dlsiteURL(primaryCode string) string {
	code := strings.ToUpper(strings.TrimSpace(primaryCode))
	if code == "" {
		return ""
	}
	site := "maniax"
	if strings.HasPrefix(code, "VJ") {
		site = "pro"
	}
	return fmt.Sprintf("https://www.dlsite.com/%s/work/=/product_id/%s.html", site, code)
}

func safeDataPath(root string, relPath string) (string, error) {
	if strings.TrimSpace(relPath) == "" || filepath.IsAbs(relPath) {
		return "", fmt.Errorf("invalid relative path")
	}

	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	absPath, err := filepath.Abs(filepath.Join(absRoot, filepath.FromSlash(relPath)))
	if err != nil {
		return "", err
	}
	rel, err := filepath.Rel(absRoot, absPath)
	if err != nil {
		return "", err
	}
	if rel == "." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) || rel == ".." {
		return "", fmt.Errorf("path escapes data root")
	}
	return absPath, nil
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
		origin := r.Header.Get("Origin")
		if origin == "" {
			origin = "*"
		}
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
