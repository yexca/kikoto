package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type appSettingsResponse struct {
	LocalScanDepth       int                 `json:"localScanDepth"`
	AutoSyncRemote      bool                `json:"autoSyncRemote"`
	CacheEnabled        bool                `json:"cacheEnabled"`
	CacheLimitGB        int                 `json:"cacheLimitGb"`
	RemoteSaveTemplate  string              `json:"remoteSaveTemplate"`
	DataRoot            string              `json:"dataRoot"`
	CacheRoot           string              `json:"cacheRoot"`
	FileSources         []fileSourceSummary `json:"fileSources"`
}

type fileSourceSummary struct {
	ID            int64              `json:"id"`
	Code          string             `json:"code"`
	DisplayName   string             `json:"displayName"`
	SourceType    string             `json:"sourceType"`
	Priority      int                `json:"priority"`
	Enabled       bool               `json:"enabled"`
	Config        fileSourceConfig   `json:"config"`
	Endpoint      fileSourceEndpoint `json:"endpoint"`
	HealthStatus  string             `json:"healthStatus"`
	LastCheckedAt *string            `json:"lastCheckedAt"`
}

type fileSourceConfig struct {
	AutoSyncOnInterest *bool  `json:"autoSyncOnInterest,omitempty"`
	CacheEnabled       *bool  `json:"cacheEnabled,omitempty"`
	CacheLimitGB       *int   `json:"cacheLimitGb,omitempty"`
	SaveRootTemplate   string `json:"saveRootTemplate,omitempty"`
	ScanDepth          *int   `json:"scanDepth,omitempty"`
}

type fileSourceEndpoint struct {
	BaseURL     string `json:"baseUrl"`
	APIURL      string `json:"apiUrl"`
	FallbackURL string `json:"fallbackUrl"`
}

type remoteWorksResponse struct {
	SourceID int64               `json:"sourceId"`
	Works    []remoteWorkSummary `json:"works"`
	Page     int                 `json:"page"`
	PageSize int                 `json:"pageSize"`
	Total    int                 `json:"total"`
	Status   string              `json:"status"`
}

type librarySource struct {
	ID                 int64 `json:"id"`
	Code               string `json:"code"`
	DisplayName        string `json:"displayName"`
	SourceType         string `json:"sourceType"`
	Enabled            bool `json:"enabled"`
	AutoSyncOnInterest bool `json:"autoSyncOnInterest"`
	CacheEnabled       bool `json:"cacheEnabled"`
}

type remoteWorkSummary struct {
	RemoteID       string   `json:"remoteId"`
	PrimaryCode    string   `json:"primaryCode"`
	Title          string   `json:"title"`
	CoverURL       string   `json:"coverUrl"`
	Circle         string   `json:"circle"`
	Tags           []string `json:"tags"`
	ImportStatus   string   `json:"importStatus"`
	RemotePlayable bool     `json:"remotePlayable"`
	WorkID         *int64   `json:"workId"`
}

type remoteWorkSyncResult struct {
	RunID             int64  `json:"runId"`
	JobID             int64  `json:"jobId"`
	WorkID            int64  `json:"workId"`
	PrimaryCode       string `json:"primaryCode"`
	Status            string `json:"status"`
	SyncedMediaItems  int    `json:"syncedMediaItems"`
	SyncedLocations   int    `json:"syncedLocations"`
	TriggerReason     string `json:"triggerReason"`
}

var sourceCodePattern = regexp.MustCompile(`[^a-z0-9_]+`)

func (s *Server) getSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	settings, err := s.loadAppSettings(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) getRuntimeSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	cacheEnabled := s.settingBool(r, "remote_cache_enabled", false)
	writeJSON(w, http.StatusOK, map[string]any{
		"autoSyncRemote": cacheEnabled || s.settingBool(r, "remote_auto_sync_enabled", false),
		"cacheEnabled":   cacheEnabled,
	})
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var payload struct {
		LocalScanDepth      *int    `json:"localScanDepth"`
		AutoSyncRemote     *bool   `json:"autoSyncRemote"`
		CacheEnabled       *bool   `json:"cacheEnabled"`
		CacheLimitGB       *int    `json:"cacheLimitGb"`
		RemoteSaveTemplate *string `json:"remoteSaveTemplate"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	if payload.LocalScanDepth != nil {
		if *payload.LocalScanDepth < 1 || *payload.LocalScanDepth > 8 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "localScanDepth must be between 1 and 8"})
			return
		}
		if err := upsertSetting(r, tx, "local_scan_depth", *payload.LocalScanDepth); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.CacheEnabled != nil {
		if *payload.CacheEnabled {
			if err := upsertSetting(r, tx, "remote_auto_sync_enabled", true); err != nil {
				writeError(w, err)
				return
			}
		}
		if err := upsertSetting(r, tx, "remote_cache_enabled", *payload.CacheEnabled); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.AutoSyncRemote != nil {
		cacheWillBeEnabled := s.settingBool(r, "remote_cache_enabled", false)
		if payload.CacheEnabled != nil {
			cacheWillBeEnabled = *payload.CacheEnabled
		}
		if !*payload.AutoSyncRemote && cacheWillBeEnabled {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "auto sync must stay enabled while automatic cache is enabled"})
			return
		}
		if err := upsertSetting(r, tx, "remote_auto_sync_enabled", *payload.AutoSyncRemote); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.CacheLimitGB != nil {
		if *payload.CacheLimitGB < 0 || *payload.CacheLimitGB > 4096 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "cacheLimitGb must be between 0 and 4096"})
			return
		}
		if err := upsertSetting(r, tx, "remote_cache_limit_gb", *payload.CacheLimitGB); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.RemoteSaveTemplate != nil {
		value := strings.TrimSpace(*payload.RemoteSaveTemplate)
		if value == "" {
			value = "/data/<source_name>/<work_code>"
		}
		if err := upsertSetting(r, tx, "remote_save_root_template", value); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	settings, err := s.loadAppSettings(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) listLibrarySources(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, code, display_name, source_type, enabled, config_json
		FROM file_source
		WHERE source_type = 'kikoeru_compatible'
		ORDER BY priority ASC, id ASC
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	sources := []librarySource{}
	for rows.Next() {
		var source librarySource
		var configJSON string
		if err := rows.Scan(&source.ID, &source.Code, &source.DisplayName, &source.SourceType, &source.Enabled, &configJSON); err != nil {
			writeError(w, err)
			return
		}
		var config fileSourceConfig
		_ = json.Unmarshal([]byte(configJSON), &config)
		source.AutoSyncOnInterest = config.AutoSyncOnInterest != nil && *config.AutoSyncOnInterest
		source.CacheEnabled = config.CacheEnabled != nil && *config.CacheEnabled
		sources = append(sources, source)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sources)
}

func (s *Server) createFileSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	payload, ok := parseFileSourcePayload(w, r, false)
	if !ok {
		return
	}
	code := slugSourceCode(payload.DisplayName)
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	sourceID, err := insertAndID(r.Context(), tx, `
		INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`, code, payload.DisplayName, payload.SourceType, payload.Priority, payload.Enabled, mustJSON(payload.Config))
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, fallback_url)
		VALUES (?, ?, ?, ?)
	`, sourceID, payload.Endpoint.BaseURL, payload.Endpoint.APIURL, payload.Endpoint.FallbackURL); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	source, err := s.loadFileSource(r, sourceID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, source)
}

func (s *Server) updateFileSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	payload, ok := parseFileSourcePayload(w, r, true)
	if !ok {
		return
	}
	var existingSourceType string
	if err := s.db.QueryRowContext(r.Context(), "SELECT source_type FROM file_source WHERE id = ?", id).Scan(&existingSourceType); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found"})
			return
		}
		writeError(w, err)
		return
	}
	if existingSourceType == "local_folder" || payload.SourceType == "local_folder" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "local folder source is managed by local scan settings"})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()

	result, err := tx.ExecContext(r.Context(), `
		UPDATE file_source
		SET display_name = ?,
			source_type = ?,
			priority = ?,
			enabled = ?,
			config_json = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, payload.DisplayName, payload.SourceType, payload.Priority, payload.Enabled, mustJSON(payload.Config), id)
	if err != nil {
		writeError(w, err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found"})
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, fallback_url)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(file_source_id) DO UPDATE SET
			base_url = excluded.base_url,
			api_url = excluded.api_url,
			fallback_url = excluded.fallback_url
	`, id, payload.Endpoint.BaseURL, payload.Endpoint.APIURL, payload.Endpoint.FallbackURL); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	source, err := s.loadFileSource(r, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, source)
}

func (s *Server) deleteFileSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM file_source WHERE id = ? AND source_type <> 'local_folder'", id)
	if err != nil {
		writeError(w, err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found or cannot be deleted"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) listRemoteSourceWorks(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	source, err := s.loadRemoteSourceForUse(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found"})
			return
		}
		writeError(w, err)
		return
	}
	if source.SourceType != "kikoeru_compatible" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is not kikoeru_compatible"})
		return
	}
	if !source.Enabled {
		writeJSON(w, http.StatusOK, remoteWorksResponse{
			SourceID: id,
			Works:    []remoteWorkSummary{},
			Page:     queryInt(r, "page", 1),
			PageSize: queryInt(r, "pageSize", 24),
			Total:    0,
			Status:   "disabled",
		})
		return
	}
	page := queryInt(r, "page", 1)
	pageSize := queryInt(r, "pageSize", 24)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 24
	}
	client := kikoeru.NewClient(source.Endpoint.APIURL, nil)
	remotePage, err := client.ListWorks(r.Context(), page, pageSize, r.URL.Query().Get("q"))
	if err != nil {
		_ = s.updateSourceHealth(r.Context(), id, "unavailable")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	_ = s.updateSourceHealth(r.Context(), id, "healthy")
	works, err := s.remoteWorkSummaries(r.Context(), remotePage.Works)
	if err != nil {
		writeError(w, err)
		return
	}
	total := remotePage.Pagination.Total
	if total == 0 {
		total = remotePage.Pagination.Count
	}
	writeJSON(w, http.StatusOK, remoteWorksResponse{
		SourceID: id,
		Works:    works,
		Page:     page,
		PageSize: pageSize,
		Total:    total,
		Status:   "ok",
	})
}

func (s *Server) syncRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	var payload struct {
		TriggerReason string `json:"triggerReason"`
	}
	_ = json.NewDecoder(r.Body).Decode(&payload)
	payload.TriggerReason = strings.TrimSpace(payload.TriggerReason)
	if payload.TriggerReason == "" {
		payload.TriggerReason = "manual"
	}
	result, err := s.runRemoteWorkSync(r.Context(), id, code, payload.TriggerReason)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

type remoteSourceForUse struct {
	ID          int64
	Code        string
	DisplayName string
	SourceType  string
	Enabled     bool
	Config      fileSourceConfig
	Endpoint    fileSourceEndpoint
}

func (s *Server) loadRemoteSourceForUse(ctx context.Context, id int64) (remoteSourceForUse, error) {
	var source remoteSourceForUse
	var configJSON string
	if err := s.db.QueryRowContext(ctx, `
		SELECT source.id, source.code, source.display_name, source.source_type, source.enabled, source.config_json, COALESCE(endpoint.api_url, ''), COALESCE(endpoint.base_url, ''), COALESCE(endpoint.fallback_url, '')
		FROM file_source AS source
		LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		WHERE source.id = ?
	`, id).Scan(
		&source.ID,
		&source.Code,
		&source.DisplayName,
		&source.SourceType,
		&source.Enabled,
		&configJSON,
		&source.Endpoint.APIURL,
		&source.Endpoint.BaseURL,
		&source.Endpoint.FallbackURL,
	); err != nil {
		return remoteSourceForUse{}, err
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		source.Endpoint.APIURL = source.Endpoint.BaseURL
	}
	if strings.TrimSpace(configJSON) != "" {
		_ = json.Unmarshal([]byte(configJSON), &source.Config)
	}
	return source, nil
}

func (s *Server) remoteWorkSummaries(ctx context.Context, works []kikoeru.Work) ([]remoteWorkSummary, error) {
	result := make([]remoteWorkSummary, 0, len(works))
	for _, work := range works {
		code := normalizedRemoteWorkCode(work)
		var workID sql.NullInt64
		if code != "" {
			if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
		}
		tags := []string{}
		for _, tag := range work.Tags {
			if strings.TrimSpace(tag.Name) != "" {
				tags = append(tags, tag.Name)
			}
			if len(tags) >= 4 {
				break
			}
		}
		circle := ""
		if work.Circle != nil {
			circle = work.Circle.Name
		}
		status := "remote_only"
		if workID.Valid {
			status = "synced"
		}
		result = append(result, remoteWorkSummary{
			RemoteID:       strconv.FormatInt(work.ID, 10),
			PrimaryCode:    code,
			Title:          firstNonEmpty(work.Title, work.Name, code),
			CoverURL:       firstNonEmpty(work.MainCoverURL, work.SamCoverURL, work.ThumbnailCoverURL),
			Circle:         circle,
			Tags:           tags,
			ImportStatus:   status,
			RemotePlayable: true,
			WorkID:         nullableInt64(workID),
		})
	}
	return result, nil
}

func (s *Server) runRemoteWorkSync(ctx context.Context, sourceID int64, code string, triggerReason string) (remoteWorkSyncResult, error) {
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteWorkSyncResult{}, fmt.Errorf("source not found")
		}
		return remoteWorkSyncResult{}, err
	}
	if source.SourceType != "kikoeru_compatible" || !source.Enabled {
		return remoteWorkSyncResult{}, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := kikoeru.NewClient(source.Endpoint.APIURL, nil)
	remoteWork, rawWork, err := client.WorkInfo(ctx, code)
	if err != nil {
		_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		return remoteWorkSyncResult{}, err
	}
	tracks, rawTracks, err := client.Tracks(ctx, remoteWork.ID)
	if err != nil {
		_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		return remoteWorkSyncResult{}, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_source_sync", "Sync remote source", "Discover remote works, filter candidates, match works, and sync remote locations.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "discover", "type": "discover_remote_works"},
			{"id": "filter", "type": "filter_candidates"},
			{"id": "match", "type": "match_works"},
			{"id": "metadata", "type": "sync_metadata"},
			{"id": "sync", "type": "sync_file_locations"},
		},
	})
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = code
	}
	runInput := map[string]any{"file_source_id": source.ID, "source_code": source.Code, "work_code": workCode, "trigger_reason": triggerReason}
	runSummary := map[string]any{"remote_work_id": remoteWork.ID, "track_nodes": countTrackNodes(tracks)}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_source_sync", "Sync remote source", "succeeded", "manual", triggerReason, runInput, runSummary)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: runInput, Output: map[string]any{"file_source_id": source.ID, "api_url": source.Endpoint.APIURL},
	})
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: "kikoeru_remote_sync", Status: "succeeded", Payload: runInput, ProgressCurrent: 1, ProgressTotal: 1,
	})
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, rawWork)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	mediaItems, locations, err := syncRemoteTrackTree(ctx, tx, source.ID, workID, workCode, tracks)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Discover remote works", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"remote_work_id": remoteWork.ID, "track_nodes": countTrackNodes(tracks)},
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter candidates", Position: 3, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"accepted": 1, "rejected": 0},
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'remote_work', ?, 'accepted', ?)
	`, runID, workCode, mustJSON(map[string]any{"work_code": workCode, "remote_work_id": remoteWork.ID})); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "match", NodeType: "match_works", DisplayName: "Match works", Position: 4, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"work_id": workID},
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Sync metadata", Position: 5, Status: "succeeded",
		Input: map[string]any{"work_id": workID}, Output: map[string]any{"snapshot_bytes": len(rawWork) + len(rawTracks)},
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync file locations", Position: 6, Status: "succeeded",
		Input: map[string]any{"work_id": workID, "file_source_id": source.ID}, Output: map[string]any{"media_items": mediaItems, "locations": locations},
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkSyncResult{}, err
	}
	return remoteWorkSyncResult{
		RunID:            runID,
		JobID:            jobID,
		WorkID:           workID,
		PrimaryCode:      workCode,
		Status:           "succeeded",
		SyncedMediaItems: mediaItems,
		SyncedLocations:  locations,
		TriggerReason:    triggerReason,
	}, nil
}

func upsertRemoteWork(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, remoteWork kikoeru.Work, rawWork json.RawMessage) (int64, error) {
	code := normalizedRemoteWorkCode(remoteWork)
	if code == "" {
		code = strings.ToUpper(strings.TrimSpace(remoteWork.SourceID))
	}
	if code == "" {
		return 0, fmt.Errorf("remote work does not expose a stable work code")
	}
	title := firstNonEmpty(remoteWork.Title, remoteWork.Name, code)
	description := ""
	releaseDate := normalizeDate(remoteWork.Release)
	var duration any
	if remoteWork.Duration != nil && *remoteWork.Duration > 0 {
		duration = int64(*remoteWork.Duration)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, description, release_date, age_rating, duration_seconds)
		VALUES (?, 'audio', ?, ?, ?, ?, ?)
		ON CONFLICT(primary_code) DO UPDATE SET
			title = excluded.title,
			release_date = COALESCE(excluded.release_date, work.release_date),
			age_rating = excluded.age_rating,
			duration_seconds = COALESCE(excluded.duration_seconds, work.duration_seconds),
			updated_at = CURRENT_TIMESTAMP
	`, code, title, description, releaseDate, remoteWork.AgeCategoryString, duration); err != nil {
		return 0, err
	}
	workID, err := selectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", code)
	if err != nil {
		return 0, err
	}
	providerCode := "kikoeru_source_" + source.Code
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_provider (code, display_name)
		VALUES (?, ?)
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name
	`, providerCode, source.DisplayName); err != nil {
		return 0, err
	}
	providerID, err := selectID(ctx, tx, "SELECT id FROM metadata_provider WHERE code = ?", providerCode)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_external_id (work_id, provider_id, id_type, external_id, url, is_primary)
		VALUES (?, ?, 'work_code', ?, ?, 1)
		ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
			work_id = excluded.work_id,
			url = excluded.url,
			is_primary = excluded.is_primary
	`, workID, providerID, code, remoteWork.SourceURL); err != nil {
		return 0, err
	}
	if remoteWork.ID > 0 {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_external_id (work_id, provider_id, id_type, external_id, url, is_primary)
			VALUES (?, ?, 'remote_work_id', ?, ?, 0)
			ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
				work_id = excluded.work_id,
				url = excluded.url
		`, workID, providerID, strconv.FormatInt(remoteWork.ID, 10), remoteWork.SourceURL); err != nil {
			return 0, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (?, ?, ?, ?)
	`, workID, providerID, code, string(rawWork)); err != nil {
		return 0, err
	}
	return workID, nil
}

func syncRemoteTrackTree(ctx context.Context, tx *sql.Tx, fileSourceID int64, workID int64, workCode string, tracks []kikoeru.Track) (int, int, error) {
	mediaItems := 0
	locations := 0
	var walk func(parentID *int64, basePath string, nodes []kikoeru.Track) error
	walk = func(parentID *int64, basePath string, nodes []kikoeru.Track) error {
		for index, node := range nodes {
			title := strings.TrimSpace(node.Title)
			if title == "" {
				title = fmt.Sprintf("Track %d", index+1)
			}
			path := joinRemotePath(basePath, title)
			kind := remoteTrackKind(node.Type)
			fingerprint := fmt.Sprintf("remote:%d:%s:%s", fileSourceID, workCode, path)
			var parent any
			if parentID != nil {
				parent = *parentID
			}
			duration := nullableSeconds(node.Duration)
			var size any
			if node.Size > 0 {
				size = node.Size
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO media_item (work_id, parent_id, kind, title, track_no, duration_seconds, size_bytes, fingerprint)
				SELECT ?, ?, ?, ?, ?, ?, ?, ?
				WHERE NOT EXISTS (SELECT 1 FROM media_item WHERE fingerprint = ?)
			`, workID, parent, kind, title, index+1, duration, size, fingerprint, fingerprint); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE media_item
				SET parent_id = ?,
					kind = ?,
					title = ?,
					track_no = ?,
					duration_seconds = ?,
					size_bytes = ?
				WHERE fingerprint = ?
			`, parent, kind, title, index+1, duration, size, fingerprint); err != nil {
				return err
			}
			itemID, err := selectID(ctx, tx, "SELECT id FROM media_item WHERE fingerprint = ?", fingerprint)
			if err != nil {
				return err
			}
			mediaItems++
			if len(node.Children) > 0 || kind == "folder" {
				childID := itemID
				if err := walk(&childID, path, node.Children); err != nil {
					return err
				}
				continue
			}
			streamURL := firstNonEmpty(node.MediaStreamURL, node.StreamLowQualityURL)
			downloadURL := node.MediaDownloadURL
			if streamURL == "" && downloadURL == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO media_file_location (
					media_item_id,
					file_source_id,
					location_type,
					path,
					stream_url,
					download_url,
					remote_hash,
					size_bytes,
					duration_seconds,
					availability,
					last_checked_at
				)
				SELECT ?, ?, 'remote_stream', ?, ?, ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP
				WHERE NOT EXISTS (
					SELECT 1
					FROM media_file_location
					WHERE media_item_id = ?
						AND file_source_id = ?
						AND location_type = 'remote_stream'
						AND path = ?
				)
			`, itemID, fileSourceID, path, streamURL, downloadURL, node.Hash, size, duration, itemID, fileSourceID, path); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE media_file_location
				SET stream_url = ?,
					download_url = ?,
					remote_hash = ?,
					size_bytes = ?,
					duration_seconds = ?,
					availability = 'available',
					last_checked_at = CURRENT_TIMESTAMP
				WHERE media_item_id = ?
					AND file_source_id = ?
					AND location_type = 'remote_stream'
					AND path = ?
			`, streamURL, downloadURL, node.Hash, size, duration, itemID, fileSourceID, path); err != nil {
				return err
			}
			locations++
		}
		return nil
	}
	if err := walk(nil, "", tracks); err != nil {
		return 0, 0, err
	}
	return mediaItems, locations, nil
}

func (s *Server) updateSourceHealth(ctx context.Context, sourceID int64, status string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE file_source_endpoint
		SET health_status = ?,
			last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
	`, status, sourceID)
	return err
}

func normalizedRemoteWorkCode(work kikoeru.Work) string {
	for _, candidate := range []string{work.SourceID, work.OriginalWorkNumber} {
		code := strings.ToUpper(strings.TrimSpace(candidate))
		if code != "" {
			return code
		}
	}
	return ""
}

func countTrackNodes(nodes []kikoeru.Track) int {
	count := 0
	for _, node := range nodes {
		count++
		count += countTrackNodes(node.Children)
	}
	return count
}

func remoteTrackKind(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "folder":
		return "folder"
	case "audio":
		return "audio"
	case "text", "image":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "file"
	}
}

func joinRemotePath(basePath string, name string) string {
	name = strings.ReplaceAll(strings.TrimSpace(name), "\\", "/")
	name = strings.Trim(name, "/")
	if basePath == "" {
		return name
	}
	return strings.Trim(basePath, "/") + "/" + name
}

func nullableSeconds(value float64) any {
	if value <= 0 {
		return nil
	}
	return int64(value)
}

func normalizeDate(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	if len(value) >= 10 {
		return value[:10]
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}

func (s *Server) loadAppSettings(r *http.Request) (appSettingsResponse, error) {
	if _, err := s.ensureLocalSourceForSettings(r); err != nil {
		return appSettingsResponse{}, err
	}
	sources, err := s.loadFileSources(r)
	if err != nil {
		return appSettingsResponse{}, err
	}
	return appSettingsResponse{
		LocalScanDepth:      s.settingInt(r, "local_scan_depth", s.cfg.LocalScanDepth),
		AutoSyncRemote:     s.settingBool(r, "remote_auto_sync_enabled", false) || s.settingBool(r, "remote_cache_enabled", false),
		CacheEnabled:       s.settingBool(r, "remote_cache_enabled", false),
		CacheLimitGB:       s.settingInt(r, "remote_cache_limit_gb", 20),
		RemoteSaveTemplate: s.settingString(r, "remote_save_root_template", "/data/<source_name>/<work_code>"),
		DataRoot:           s.cfg.DataRoot,
		CacheRoot:          s.cfg.CacheRoot,
		FileSources:        sources,
	}, nil
}

func (s *Server) ensureLocalSourceForSettings(r *http.Request) (int64, error) {
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	id, err := s.upsertLocalFileSource(r.Context(), tx, s.settingInt(r, "local_scan_depth", s.cfg.LocalScanDepth))
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return id, nil
}

func (s *Server) loadFileSources(r *http.Request) ([]fileSourceSummary, error) {
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT
			source.id,
			source.code,
			source.display_name,
			source.source_type,
			source.priority,
			source.enabled,
			source.config_json,
			COALESCE(endpoint.base_url, ''),
			COALESCE(endpoint.api_url, ''),
			COALESCE(endpoint.fallback_url, ''),
			COALESCE(endpoint.health_status, 'unknown'),
			endpoint.last_checked_at
		FROM file_source AS source
		LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		ORDER BY source.priority ASC, source.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	sources := []fileSourceSummary{}
	for rows.Next() {
		source, err := scanFileSource(rows)
		if err != nil {
			return nil, err
		}
		sources = append(sources, source)
	}
	return sources, rows.Err()
}

func (s *Server) loadFileSource(r *http.Request, id int64) (fileSourceSummary, error) {
	row := s.db.QueryRowContext(r.Context(), `
		SELECT
			source.id,
			source.code,
			source.display_name,
			source.source_type,
			source.priority,
			source.enabled,
			source.config_json,
			COALESCE(endpoint.base_url, ''),
			COALESCE(endpoint.api_url, ''),
			COALESCE(endpoint.fallback_url, ''),
			COALESCE(endpoint.health_status, 'unknown'),
			endpoint.last_checked_at
		FROM file_source AS source
		LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		WHERE source.id = ?
	`, id)
	return scanFileSource(row)
}

type fileSourceScanner interface {
	Scan(dest ...any) error
}

func scanFileSource(scanner fileSourceScanner) (fileSourceSummary, error) {
	var source fileSourceSummary
	var configJSON string
	var lastCheckedAt sql.NullString
	if err := scanner.Scan(
		&source.ID,
		&source.Code,
		&source.DisplayName,
		&source.SourceType,
		&source.Priority,
		&source.Enabled,
		&configJSON,
		&source.Endpoint.BaseURL,
		&source.Endpoint.APIURL,
		&source.Endpoint.FallbackURL,
		&source.HealthStatus,
		&lastCheckedAt,
	); err != nil {
		return fileSourceSummary{}, err
	}
	source.LastCheckedAt = nullableString(lastCheckedAt)
	if strings.TrimSpace(configJSON) != "" {
		_ = json.Unmarshal([]byte(configJSON), &source.Config)
	}
	return source, nil
}

type fileSourcePayload struct {
	DisplayName string             `json:"displayName"`
	SourceType  string             `json:"sourceType"`
	Priority    int                `json:"priority"`
	Enabled     bool               `json:"enabled"`
	Config      fileSourceConfig   `json:"config"`
	Endpoint    fileSourceEndpoint `json:"endpoint"`
}

func parseFileSourcePayload(w http.ResponseWriter, r *http.Request, allowLocal bool) (fileSourcePayload, bool) {
	var payload fileSourcePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return fileSourcePayload{}, false
	}
	payload.DisplayName = strings.TrimSpace(payload.DisplayName)
	payload.SourceType = strings.TrimSpace(payload.SourceType)
	payload.Endpoint.BaseURL = strings.TrimSpace(payload.Endpoint.BaseURL)
	payload.Endpoint.APIURL = strings.TrimSpace(payload.Endpoint.APIURL)
	payload.Endpoint.FallbackURL = strings.TrimSpace(payload.Endpoint.FallbackURL)
	if payload.DisplayName == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "displayName is required"})
		return fileSourcePayload{}, false
	}
	if payload.SourceType == "" {
		payload.SourceType = "kikoeru_compatible"
	}
	if payload.SourceType != "kikoeru_compatible" && !(allowLocal && payload.SourceType == "local_folder") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported sourceType"})
		return fileSourcePayload{}, false
	}
	if payload.Priority <= 0 {
		payload.Priority = 30
	}
	if payload.SourceType == "kikoeru_compatible" {
		for _, candidate := range []string{payload.Endpoint.BaseURL, payload.Endpoint.APIURL, payload.Endpoint.FallbackURL} {
			if candidate == "" {
				continue
			}
			if _, err := url.ParseRequestURI(candidate); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "endpoint URLs must be valid absolute URLs"})
				return fileSourcePayload{}, false
			}
		}
	}
	return payload, true
}

func upsertSetting(r *http.Request, tx *sql.Tx, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(r.Context(), `
		INSERT INTO app_setting (key, value_json)
		VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET
			value_json = excluded.value_json,
			updated_at = CURRENT_TIMESTAMP
	`, key, string(encoded))
	return err
}

func (s *Server) settingInt(r *http.Request, key string, fallback int) int {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value int
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingBool(r *http.Request, key string, fallback bool) bool {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value bool
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingString(r *http.Request, key string, fallback string) string {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value string
	if err := json.Unmarshal([]byte(raw), &value); err != nil || strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func slugSourceCode(displayName string) string {
	base := strings.ToLower(strings.TrimSpace(displayName))
	base = sourceCodePattern.ReplaceAllString(base, "_")
	base = strings.Trim(base, "_")
	if base == "" {
		base = "remote_source"
	}
	if !strings.HasPrefix(base, "remote_") {
		base = "remote_" + base
	}
	return fmt.Sprintf("%s_%d", base, time.Now().Unix())
}

func queryInt(r *http.Request, key string, fallback int) int {
	value := strings.TrimSpace(r.URL.Query().Get(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}
