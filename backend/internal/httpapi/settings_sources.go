package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type appSettingsResponse struct {
	LocalScanDepth        int                 `json:"localScanDepth"`
	AutoSyncRemote        bool                `json:"autoSyncRemote"`
	CacheEnabled          bool                `json:"cacheEnabled"`
	CacheLimitGB          int                 `json:"cacheLimitGb"`
	RemoteSaveTemplate    string              `json:"remoteSaveTemplate"`
	RemoteDelayBase       float64             `json:"remoteDelayBaseSeconds"`
	RemoteDelayRandom     float64             `json:"remoteDelayRandomSeconds"`
	RemoteBackoff         float64             `json:"remoteBackoffSeconds"`
	RemoteMaxBackoff      float64             `json:"remoteMaxBackoffSeconds"`
	CircleAutoRefreshDays int                 `json:"circleAutoRefreshDays"`
	DataRoot              string              `json:"dataRoot"`
	CacheRoot             string              `json:"cacheRoot"`
	FileSources           []fileSourceSummary `json:"fileSources"`
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
	ID                 int64  `json:"id"`
	Code               string `json:"code"`
	DisplayName        string `json:"displayName"`
	SourceType         string `json:"sourceType"`
	Enabled            bool   `json:"enabled"`
	AutoSyncOnInterest bool   `json:"autoSyncOnInterest"`
	CacheEnabled       bool   `json:"cacheEnabled"`
}

type remoteWorkSummary struct {
	RemoteID       string   `json:"remoteId"`
	PrimaryCode    string   `json:"primaryCode"`
	Title          string   `json:"title"`
	ReleaseDate    string   `json:"releaseDate"`
	UpdatedAt      string   `json:"updatedAt"`
	CoverURL       string   `json:"coverUrl"`
	Circle         string   `json:"circle"`
	Rating         *float64 `json:"rating"`
	Sales          *int64   `json:"sales"`
	Tags           []string `json:"tags"`
	ImportStatus   string   `json:"importStatus"`
	RemotePlayable bool     `json:"remotePlayable"`
	WorkID         *int64   `json:"workId"`
}

type remoteWorkDetail struct {
	SourceID        int64               `json:"sourceId"`
	SourceCode      string              `json:"sourceCode"`
	SourceName      string              `json:"sourceName"`
	RemoteID        string              `json:"remoteId"`
	PrimaryCode     string              `json:"primaryCode"`
	Title           string              `json:"title"`
	CoverURL        string              `json:"coverUrl"`
	SourceURL       string              `json:"sourceUrl"`
	Circle          string              `json:"circle"`
	Rating          *float64            `json:"rating"`
	Sales           *int64              `json:"sales"`
	ReleaseDate     string              `json:"releaseDate"`
	DurationSeconds *int64              `json:"durationSeconds"`
	Tags            []string            `json:"tags"`
	VoiceActors     []string            `json:"voiceActors"`
	ImportStatus    string              `json:"importStatus"`
	WorkID          *int64              `json:"workId"`
	Tracks          []remoteTrackDetail `json:"tracks"`
}

type sourceAvailabilityResponse struct {
	WorkCode  string                      `json:"workCode"`
	CheckedAt string                      `json:"checkedAt"`
	RunID     int64                       `json:"runId"`
	Sources   []sourceAvailabilitySummary `json:"sources"`
}

type sourceAvailabilitySummary struct {
	SourceID    int64  `json:"sourceId"`
	SourceCode  string `json:"sourceCode"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
	RemoteID    string `json:"remoteId"`
	PrimaryCode string `json:"primaryCode"`
	Title       string `json:"title"`
	CoverURL    string `json:"coverUrl"`
	WorkID      *int64 `json:"workId"`
	HasRemote   bool   `json:"hasRemote"`
	HasCache    bool   `json:"hasCache"`
	HasLocal    bool   `json:"hasLocal"`
	Error       string `json:"error"`
	ElapsedMS   int64  `json:"elapsedMs"`
}

type remoteTrackDetail struct {
	Type            string              `json:"type"`
	Title           string              `json:"title"`
	Hash            string              `json:"hash"`
	StreamURL       string              `json:"streamUrl"`
	DownloadURL     string              `json:"downloadUrl"`
	DurationSeconds *int64              `json:"durationSeconds"`
	SizeBytes       *int64              `json:"sizeBytes"`
	CacheLocationID *int64              `json:"cacheLocationId"`
	CachePath       string              `json:"cachePath"`
	CacheAvailable  bool                `json:"cacheAvailable"`
	LocalLocationID *int64              `json:"localLocationId"`
	LocalPath       string              `json:"localPath"`
	LocalAvailable  bool                `json:"localAvailable"`
	Children        []remoteTrackDetail `json:"children"`
}

type remoteWorkSyncResult struct {
	RunID            int64  `json:"runId"`
	JobID            int64  `json:"jobId"`
	WorkID           int64  `json:"workId"`
	PrimaryCode      string `json:"primaryCode"`
	Status           string `json:"status"`
	SyncedMediaItems int    `json:"syncedMediaItems"`
	SyncedLocations  int    `json:"syncedLocations"`
	TriggerReason    string `json:"triggerReason"`
}

type remoteWorkSaveRequest struct {
	Paths []string `json:"paths"`
}

type remoteWorkSavePlan struct {
	SourceID    int64                    `json:"sourceId"`
	PrimaryCode string                   `json:"primaryCode"`
	SaveRoot    string                   `json:"saveRoot"`
	Items       []remoteWorkSavePlanItem `json:"items"`
	Summary     remoteWorkSaveSummary    `json:"summary"`
}

type remoteWorkSavePlanItem struct {
	Path       string `json:"path"`
	Kind       string `json:"kind"`
	SizeBytes  *int64 `json:"sizeBytes"`
	Action     string `json:"action"`
	Status     string `json:"status"`
	SourcePath string `json:"sourcePath"`
	TargetPath string `json:"targetPath"`
}

type remoteWorkSaveSummary struct {
	Total        int `json:"total"`
	SkipExisting int `json:"skipExisting"`
	CopyCache    int `json:"copyCache"`
	Download     int `json:"download"`
}

type remoteWorkSaveResult struct {
	RunID           int64                 `json:"runId"`
	JobID           int64                 `json:"jobId"`
	WorkID          int64                 `json:"workId"`
	PrimaryCode     string                `json:"primaryCode"`
	Status          string                `json:"status"`
	SaveRoot        string                `json:"saveRoot"`
	SavedFiles      int                   `json:"savedFiles"`
	SkippedFiles    int                   `json:"skippedFiles"`
	CopiedFromCache int                   `json:"copiedFromCache"`
	DownloadedFiles int                   `json:"downloadedFiles"`
	Plan            remoteWorkSaveSummary `json:"plan"`
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
		LocalScanDepth        *int     `json:"localScanDepth"`
		AutoSyncRemote        *bool    `json:"autoSyncRemote"`
		CacheEnabled          *bool    `json:"cacheEnabled"`
		CacheLimitGB          *int     `json:"cacheLimitGb"`
		RemoteSaveTemplate    *string  `json:"remoteSaveTemplate"`
		RemoteDelayBase       *float64 `json:"remoteDelayBaseSeconds"`
		RemoteDelayRandom     *float64 `json:"remoteDelayRandomSeconds"`
		RemoteBackoff         *float64 `json:"remoteBackoffSeconds"`
		RemoteMaxBackoff      *float64 `json:"remoteMaxBackoffSeconds"`
		CircleAutoRefreshDays *int     `json:"circleAutoRefreshDays"`
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
	if payload.RemoteDelayBase != nil {
		if *payload.RemoteDelayBase < 0 || *payload.RemoteDelayBase > 60 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "remoteDelayBaseSeconds must be between 0 and 60"})
			return
		}
		if err := upsertSetting(r, tx, "remote_request_delay_base_seconds", *payload.RemoteDelayBase); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.RemoteDelayRandom != nil {
		if *payload.RemoteDelayRandom < 0 || *payload.RemoteDelayRandom > 60 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "remoteDelayRandomSeconds must be between 0 and 60"})
			return
		}
		if err := upsertSetting(r, tx, "remote_request_delay_random_seconds", *payload.RemoteDelayRandom); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.RemoteBackoff != nil {
		if *payload.RemoteBackoff < 0 || *payload.RemoteBackoff > 3600 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "remoteBackoffSeconds must be between 0 and 3600"})
			return
		}
		if err := upsertSetting(r, tx, "remote_rate_limit_backoff_seconds", *payload.RemoteBackoff); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.RemoteMaxBackoff != nil {
		if *payload.RemoteMaxBackoff < 0 || *payload.RemoteMaxBackoff > 3600 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "remoteMaxBackoffSeconds must be between 0 and 3600"})
			return
		}
		if err := upsertSetting(r, tx, "remote_max_backoff_seconds", *payload.RemoteMaxBackoff); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.CircleAutoRefreshDays != nil {
		if *payload.CircleAutoRefreshDays < 0 || *payload.CircleAutoRefreshDays > 365 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "circleAutoRefreshDays must be between 0 and 365"})
			return
		}
		if err := upsertSetting(r, tx, "circle_auto_refresh_days", *payload.CircleAutoRefreshDays); err != nil {
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

func (s *Server) getRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
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
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is disabled"})
		return
	}
	client := kikoeru.NewClient(source.Endpoint.APIURL, nil)
	remoteWork, _, err := client.WorkInfo(r.Context(), code)
	if err != nil {
		_ = s.updateSourceHealth(r.Context(), id, "unavailable")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	tracks, _, err := client.Tracks(r.Context(), remoteWork.ID)
	if err != nil {
		_ = s.updateSourceHealth(r.Context(), id, "unavailable")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	_ = s.updateSourceHealth(r.Context(), id, "healthy")
	detail, err := s.remoteWorkDetail(r.Context(), source, remoteWork, tracks)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) getWorkSourceAvailability(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	sources, err := s.loadRemoteSourcesForAvailability(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	checkedAt := time.Now().UTC().Format(time.RFC3339)
	results := make([]sourceAvailabilitySummary, 0, len(sources))
	for _, source := range sources {
		result := sourceAvailabilitySummary{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName, Status: "disabled",
		}
		started := time.Now()
		if source.SourceType != "kikoeru_compatible" {
			result.Status = "unavailable"
			result.Error = "source is not kikoeru-compatible"
			results = append(results, result)
			continue
		}
		if !source.Enabled {
			results = append(results, result)
			continue
		}
		remoteWork, err := s.checkRemoteWorkAvailability(r.Context(), source, code)
		result.ElapsedMS = time.Since(started).Milliseconds()
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			if isNotFoundLikeError(err) {
				result.Status = "not_found"
			}
			_ = s.updateSourceHealth(r.Context(), source.ID, "unavailable")
			results = append(results, result)
			continue
		}
		_ = s.updateSourceHealth(r.Context(), source.ID, "healthy")
		workCode := normalizedRemoteWorkCode(remoteWork)
		if workCode == "" {
			workCode = code
		}
		result.Status = "available"
		result.RemoteID = strconv.FormatInt(remoteWork.ID, 10)
		result.PrimaryCode = workCode
		result.Title = firstNonEmpty(remoteWork.Title, remoteWork.Name, workCode)
		result.CoverURL = firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL)
		flags, err := s.sourceAvailabilityFlags(r.Context(), source.ID, workCode)
		if err != nil {
			writeError(w, err)
			return
		}
		result.WorkID = flags.WorkID
		result.HasRemote = flags.HasRemote
		result.HasCache = flags.HasCache
		result.HasLocal = flags.HasLocal
		results = append(results, result)
	}
	runID, err := s.recordSourceAvailabilityWorkflow(r.Context(), code, checkedAt, results)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sourceAvailabilityResponse{
		WorkCode: code, CheckedAt: checkedAt, RunID: runID, Sources: results,
	})
}

func (s *Server) planRemoteSourceWorkSave(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	sourceID, code, payload, ok := parseRemoteWorkSaveRequest(w, r)
	if !ok {
		return
	}
	plan, err := s.buildRemoteWorkSavePlan(r.Context(), sourceID, code, payload.Paths)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) saveRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	sourceID, code, payload, ok := parseRemoteWorkSaveRequest(w, r)
	if !ok {
		return
	}
	result, err := s.runRemoteWorkSave(context.WithoutCancel(r.Context()), sourceID, code, payload.Paths)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, result)
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

func (s *Server) cacheRemoteSourceWorkMedia(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "playback:use"); !ok {
		return
	}
	sourceID, err := parseInt64PathValue(r, "id")
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
		Path string `json:"path"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	remotePath := cleanRemoteRelativePath(payload.Path)
	if remotePath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "remote path is required"})
		return
	}
	syncResult, err := s.runRemoteWorkSync(r.Context(), sourceID, code, "auto_cache_on_preview_play")
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	locationID, err := s.findRemoteMediaLocationByPath(r.Context(), syncResult.WorkID, sourceID, remotePath)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	cacheResult, err := s.runRemoteMediaCache(r.Context(), locationID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusAccepted, cacheResult)
}

func (s *Server) findRemoteMediaLocationByPath(ctx context.Context, workID int64, sourceID int64, remotePath string) (int64, error) {
	remotePath = cleanRemoteRelativePath(remotePath)
	var id int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT location.id
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'remote_stream'
			AND location.availability = 'available'
			AND location.path = ?
		LIMIT 1
	`, workID, sourceID, remotePath).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, fmt.Errorf("remote media location not found")
		}
		return 0, err
	}
	return id, nil
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

func (s *Server) loadRemoteSourcesForAvailability(ctx context.Context) ([]remoteSourceForUse, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.code, source.display_name, source.source_type, source.enabled, source.config_json, COALESCE(endpoint.api_url, ''), COALESCE(endpoint.base_url, ''), COALESCE(endpoint.fallback_url, '')
		FROM file_source AS source
		LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		WHERE source.source_type = 'kikoeru_compatible'
		ORDER BY source.priority ASC, source.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sources := []remoteSourceForUse{}
	for rows.Next() {
		var source remoteSourceForUse
		var configJSON string
		if err := rows.Scan(
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
			return nil, err
		}
		if strings.TrimSpace(source.Endpoint.APIURL) == "" {
			source.Endpoint.APIURL = source.Endpoint.BaseURL
		}
		if strings.TrimSpace(configJSON) != "" {
			_ = json.Unmarshal([]byte(configJSON), &source.Config)
		}
		sources = append(sources, source)
	}
	return sources, rows.Err()
}

func (s *Server) checkRemoteWorkAvailability(ctx context.Context, source remoteSourceForUse, code string) (kikoeru.Work, error) {
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return kikoeru.Work{}, fmt.Errorf("source has no API endpoint")
	}
	client := kikoeru.NewClient(source.Endpoint.APIURL, nil)
	remoteWork, _, err := client.WorkInfo(ctx, code)
	return remoteWork, err
}

type sourceAvailabilityState struct {
	WorkID    *int64
	HasRemote bool
	HasCache  bool
	HasLocal  bool
}

func (s *Server) sourceAvailabilityFlags(ctx context.Context, sourceID int64, workCode string) (sourceAvailabilityState, error) {
	var flags sourceAvailabilityState
	var workID sql.NullInt64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", workCode).Scan(&workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return flags, nil
		}
		return flags, err
	}
	flags.WorkID = nullableInt64(workID)
	flags.HasRemote = s.workHasLocationType(ctx, workID.Int64, sourceID, "remote_stream")
	flags.HasCache = s.workHasLocationType(ctx, workID.Int64, sourceID, "cache")
	flags.HasLocal = s.workHasLocationType(ctx, workID.Int64, 0, "local")
	return flags, nil
}

func (s *Server) workHasLocationType(ctx context.Context, workID int64, sourceID int64, locationType string) bool {
	query := `
		SELECT 1
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.location_type = ?
			AND location.availability = 'available'
	`
	args := []any{workID, locationType}
	if sourceID > 0 {
		query += " AND location.file_source_id = ?"
		args = append(args, sourceID)
	}
	query += " LIMIT 1"
	var found int
	return s.db.QueryRowContext(ctx, query, args...).Scan(&found) == nil
}

func (s *Server) recordSourceAvailabilityWorkflow(ctx context.Context, code string, checkedAt string, results []sourceAvailabilitySummary) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "source_availability_check", "Check source availability", "Check configured remote sources for a work.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "discover", "type": "discover_remote_works"},
			{"id": "filter", "type": "filter_candidates"},
			{"id": "match", "type": "match_works"},
		},
	})
	if err != nil {
		return 0, err
	}
	available := 0
	errorsCount := 0
	notFound := 0
	for _, result := range results {
		switch result.Status {
		case "available":
			available++
		case "not_found":
			notFound++
		case "error", "unavailable":
			errorsCount++
		}
	}
	input := map[string]any{"work_code": code}
	summary := map[string]any{
		"checked_at": checkedAt, "sources": len(results), "available": available, "not_found": notFound, "errors": errorsCount,
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "source_availability_check", "Check source availability", "succeeded", "detail_view", "work_detail_source_tabs", input, summary)
	if err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote sources", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"sources": len(results)},
	}); err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Discover remote works", Position: 2, Status: "succeeded",
		Input: input, Output: map[string]any{"results": results},
	}); err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter available sources", Position: 3, Status: "succeeded",
		Input: map[string]any{"work_code": code}, Output: map[string]any{"available": available, "not_found": notFound, "errors": errorsCount},
	}); err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "match", NodeType: "match_works", DisplayName: "Match local and cached availability", Position: 4, Status: "succeeded",
		Input: map[string]any{"work_code": code}, Output: sourceAvailabilityMatchSummary(results),
	}); err != nil {
		return 0, err
	}
	return runID, tx.Commit()
}

func sourceAvailabilityMatchSummary(results []sourceAvailabilitySummary) map[string]any {
	hasLocal := 0
	hasCache := 0
	hasRemote := 0
	for _, result := range results {
		if result.HasLocal {
			hasLocal++
		}
		if result.HasCache {
			hasCache++
		}
		if result.HasRemote {
			hasRemote++
		}
	}
	return map[string]any{"has_local": hasLocal, "has_cache": hasCache, "has_remote": hasRemote}
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
			ReleaseDate:    work.Release,
			UpdatedAt:      work.Release,
			CoverURL:       firstNonEmpty(work.MainCoverURL, work.SamCoverURL, work.ThumbnailCoverURL),
			Circle:         circle,
			Rating:         work.RateAverage2DP,
			Sales:          work.DLCount,
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
	if err := s.downloadRemoteCover(ctx, workCode, firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL)); err != nil {
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

func (s *Server) buildRemoteWorkSavePlan(ctx context.Context, sourceID int64, code string, selectedPaths []string) (remoteWorkSavePlan, error) {
	source, remoteWork, tracks, err := s.loadRemoteWorkTracks(ctx, sourceID, code)
	if err != nil {
		return remoteWorkSavePlan{}, err
	}
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = strings.ToUpper(strings.TrimSpace(code))
	}
	saveRoot := s.remoteSaveRoot(source, workCode)
	selected := normalizeSelectedRemotePaths(selectedPaths)
	files := flattenRemoteSaveFiles(tracks)
	items := make([]remoteWorkSavePlanItem, 0, len(files))
	for _, file := range files {
		if len(selected) > 0 && !selectedRemotePathMatches(selected, file.Path) {
			continue
		}
		targetRelPath := joinRemotePath(saveRoot, file.Path)
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, targetRelPath)
		if err != nil {
			return remoteWorkSavePlan{}, err
		}
		item := remoteWorkSavePlanItem{
			Path:       file.Path,
			Kind:       file.Kind,
			SizeBytes:  file.SizeBytes,
			SourcePath: firstNonEmpty(file.DownloadURL, file.StreamURL),
			TargetPath: filepath.ToSlash(targetRelPath),
		}
		if existingFileMatches(targetAbsPath, file.SizeBytes) {
			item.Action = "skip"
			item.Status = "local_exists"
		} else if cachePath, ok := s.findRemoteCacheFile(ctx, source.ID, source.Code, workCode, file.Path, file.SizeBytes); ok {
			item.Action = "copy_from_cache"
			item.Status = "cache_hit"
			item.SourcePath = filepath.ToSlash(cachePath)
		} else {
			item.Action = "download"
			item.Status = "remote_only"
		}
		items = append(items, item)
	}
	plan := remoteWorkSavePlan{
		SourceID:    source.ID,
		PrimaryCode: workCode,
		SaveRoot:    saveRoot,
		Items:       items,
	}
	plan.Summary = summarizeRemoteSavePlan(items)
	return plan, nil
}

func (s *Server) runRemoteWorkSave(ctx context.Context, sourceID int64, code string, selectedPaths []string) (remoteWorkSaveResult, error) {
	source, remoteWork, tracks, err := s.loadRemoteWorkTracks(ctx, sourceID, code)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = strings.ToUpper(strings.TrimSpace(code))
	}
	plan, err := s.buildRemoteWorkSavePlan(ctx, sourceID, workCode, selectedPaths)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	rawWork, _ := json.Marshal(remoteWork)
	rawTracks, _ := json.Marshal(tracks)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_work_save", "Save remote work", "Select remote files, reuse cache hits, download misses, and materialize files under the local library.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "tree", "type": "fetch_remote_tree"},
			{"id": "plan", "type": "plan_save"},
			{"id": "materialize", "type": "materialize_save"},
			{"id": "sync", "type": "sync_file_locations"},
		},
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	runInput := map[string]any{"source_id": sourceID, "work_code": workCode, "paths": selectedPaths}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_work_save", "Save remote work", "running", "manual", "save_selected", runInput, map[string]any{"plan": plan.Summary})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: runInput, Output: map[string]any{"source_id": sourceID, "work_code": workCode},
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "tree", NodeType: "fetch_remote_tree", DisplayName: "Fetch remote tree", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"tracks": len(tracks), "snapshot_bytes": len(rawWork) + len(rawTracks)},
	}); err != nil {
		return remoteWorkSaveResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: "remote_work_save", Status: "running", Payload: runInput, ProgressCurrent: 0, ProgressTotal: len(plan.Items),
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "plan", NodeType: "plan_save", DisplayName: "Plan save", Position: 3, Status: "succeeded",
		Input: map[string]any{"paths": selectedPaths}, Output: plan,
	}); err != nil {
		return remoteWorkSaveResult{}, err
	}
	materializeNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "materialize", NodeType: "materialize_save", DisplayName: "Materialize selected files", Position: 4, Status: "running",
		Input: map[string]any{"items": len(plan.Items)}, Output: nil,
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	syncNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync saved locations", Position: 5, Status: "queued",
		Input: map[string]any{"items": len(plan.Items)}, Output: nil,
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, rawWork)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, _, err := syncRemoteTrackTree(ctx, tx, source.ID, workID, workCode, tracks); err != nil {
		return remoteWorkSaveResult{}, err
	}
	localSourceID, err := s.upsertLocalFileSource(ctx, tx, s.configuredLocalScanDepth(ctx))
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkSaveResult{}, err
	}

	saved, skipped, copied, downloaded := 0, 0, 0, 0
	for index, item := range plan.Items {
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, materializeNodeID, jobID, "failed", err.Error(), index, len(plan.Items), plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "skip" {
			skipped++
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items))
			continue
		}
		if err := os.MkdirAll(filepath.Dir(targetAbsPath), 0o755); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, materializeNodeID, jobID, "failed", err.Error(), index, len(plan.Items), plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "copy_from_cache" {
			sourceAbsPath := filepath.Join(s.cfg.CacheRoot, filepath.FromSlash(item.SourcePath))
			if err := copyFile(sourceAbsPath, targetAbsPath); err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, materializeNodeID, jobID, "failed", err.Error(), index, len(plan.Items), plan.Summary)
				return remoteWorkSaveResult{}, err
			}
			copied++
		} else {
			if _, err := s.downloadToFile(ctx, item.SourcePath, targetAbsPath); err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, materializeNodeID, jobID, "failed", err.Error(), index, len(plan.Items), plan.Summary)
				return remoteWorkSaveResult{}, err
			}
			downloaded++
		}
		saved++
		_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items))
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"saved": saved, "skipped": skipped, "copied_from_cache": copied, "downloaded": downloaded}), materializeNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_job SET status = 'succeeded', progress_current = ?, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", len(plan.Items), len(plan.Items), jobID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", syncNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	syncedLocations := 0
	for index, item := range plan.Items {
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), index, len(plan.Items), plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if err := s.upsertSavedLocalLocation(ctx, workID, localSourceID, item, targetAbsPath); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), index, len(plan.Items), plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		syncedLocations++
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"locations": syncedLocations}), syncNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"plan": plan.Summary, "saved": saved, "skipped": skipped, "copied_from_cache": copied, "downloaded": downloaded, "snapshot_bytes": len(rawWork) + len(rawTracks)}), runID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	return remoteWorkSaveResult{
		RunID:           runID,
		JobID:           jobID,
		WorkID:          workID,
		PrimaryCode:     workCode,
		Status:          "succeeded",
		SaveRoot:        plan.SaveRoot,
		SavedFiles:      saved,
		SkippedFiles:    skipped,
		CopiedFromCache: copied,
		DownloadedFiles: downloaded,
		Plan:            plan.Summary,
	}, nil
}

type remoteSaveFile struct {
	Path        string
	Kind        string
	StreamURL   string
	DownloadURL string
	SizeBytes   *int64
}

func parseRemoteWorkSaveRequest(w http.ResponseWriter, r *http.Request) (int64, string, remoteWorkSaveRequest, bool) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return 0, "", remoteWorkSaveRequest{}, false
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return 0, "", remoteWorkSaveRequest{}, false
	}
	var payload remoteWorkSaveRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	return id, code, payload, true
}

func (s *Server) loadRemoteWorkTracks(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, kikoeru.Work{}, nil, fmt.Errorf("source not found")
		}
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	if source.SourceType != "kikoeru_compatible" || !source.Enabled {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := kikoeru.NewClient(source.Endpoint.APIURL, nil)
	remoteWork, _, err := client.WorkInfo(ctx, code)
	if err != nil {
		_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	tracks, _, err := client.Tracks(ctx, remoteWork.ID)
	if err != nil {
		_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	return source, remoteWork, tracks, nil
}

func (s *Server) remoteSaveRoot(source remoteSourceForUse, workCode string) string {
	template := strings.TrimSpace(source.Config.SaveRootTemplate)
	if template == "" {
		template = s.settingStringContext(context.Background(), "remote_save_root_template", "/data/<source_name>/<work_code>")
	}
	if template == "" {
		template = "/data/<source_name>/<work_code>"
	}
	value := strings.ReplaceAll(template, "<source_name>", source.Code)
	value = strings.ReplaceAll(value, "<work_code>", strings.ToUpper(strings.TrimSpace(workCode)))
	value = strings.TrimPrefix(filepath.ToSlash(value), "/data/")
	value = strings.TrimPrefix(value, "data/")
	return strings.Trim(value, "/")
}

func (s *Server) settingStringContext(ctx context.Context, key string, fallback string) string {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value string
	if err := json.Unmarshal([]byte(raw), &value); err != nil || strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func normalizeSelectedRemotePaths(paths []string) map[string]bool {
	result := map[string]bool{}
	for _, path := range paths {
		path = cleanRemoteRelativePath(path)
		if path != "" {
			result[path] = true
		}
	}
	return result
}

func selectedRemotePathMatches(selected map[string]bool, filePath string) bool {
	filePath = cleanRemoteRelativePath(filePath)
	for path := range selected {
		if path == filePath {
			return true
		}
		if strings.HasPrefix(filePath, path+"/") {
			return true
		}
	}
	return false
}

func flattenRemoteSaveFiles(tracks []kikoeru.Track) []remoteSaveFile {
	files := []remoteSaveFile{}
	var walk func(basePath string, nodes []kikoeru.Track)
	walk = func(basePath string, nodes []kikoeru.Track) {
		for index, node := range nodes {
			title := strings.TrimSpace(node.Title)
			if title == "" {
				title = fmt.Sprintf("Track %d", index+1)
			}
			path := cleanRemoteRelativePath(joinRemotePath(basePath, title))
			kind := remoteTrackKind(node.Type)
			if len(node.Children) > 0 || kind == "folder" {
				walk(path, node.Children)
				continue
			}
			sourceURL := firstNonEmpty(node.MediaDownloadURL, node.MediaStreamURL, node.StreamLowQualityURL)
			if sourceURL == "" {
				continue
			}
			var size *int64
			if node.Size > 0 {
				value := node.Size
				size = &value
			}
			files = append(files, remoteSaveFile{
				Path:        path,
				Kind:        kind,
				StreamURL:   firstNonEmpty(node.MediaStreamURL, node.StreamLowQualityURL),
				DownloadURL: node.MediaDownloadURL,
				SizeBytes:   size,
			})
		}
	}
	walk("", tracks)
	return files
}

func cleanRemoteRelativePath(path string) string {
	parts := strings.Split(strings.ReplaceAll(path, "\\", "/"), "/")
	clean := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || part == "." || part == ".." {
			continue
		}
		clean = append(clean, filepath.Base(part))
	}
	return filepath.ToSlash(filepath.Join(clean...))
}

func existingFileMatches(path string, expectedSize *int64) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return expectedSize == nil || info.Size() == *expectedSize
}

func (s *Server) findRemoteCacheFile(ctx context.Context, sourceID int64, sourceCode string, workCode string, remotePath string, expectedSize *int64) (string, bool) {
	cacheRelPath := cacheMediaRelPath(sourceCode, workCode, remotePath)
	rows, err := s.db.QueryContext(ctx, `
		SELECT path
		FROM media_file_location
		WHERE file_source_id = ?
			AND location_type = 'cache'
			AND availability = 'available'
	`, sourceID)
	if err != nil {
		return "", false
	}
	defer rows.Close()
	for rows.Next() {
		var path string
		if err := rows.Scan(&path); err != nil {
			continue
		}
		if filepath.ToSlash(path) != cacheRelPath {
			continue
		}
		if existingFileMatches(filepath.Join(s.cfg.CacheRoot, filepath.FromSlash(path)), expectedSize) {
			return path, true
		}
	}
	return "", false
}

func summarizeRemoteSavePlan(items []remoteWorkSavePlanItem) remoteWorkSaveSummary {
	summary := remoteWorkSaveSummary{Total: len(items)}
	for _, item := range items {
		switch item.Action {
		case "skip":
			summary.SkipExisting++
		case "copy_from_cache":
			summary.CopyCache++
		case "download":
			summary.Download++
		}
	}
	return summary
}

func updateWorkflowJobProgress(ctx context.Context, db *sql.DB, jobID int64, current int, total int) error {
	_, err := db.ExecContext(ctx, `
		UPDATE workflow_job
		SET progress_current = ?,
			progress_total = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, current, total, jobID)
	return err
}

func finishWorkflowRunSimple(ctx context.Context, db *sql.DB, runID int64, nodeID int64, jobID int64, status string, errorMessage string, current int, total int, summary remoteWorkSaveSummary) error {
	output := mustJSON(map[string]any{"plan": summary, "error": errorMessage})
	if _, err := db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, errorMessage, nodeID); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, "UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", status, current, total, errorMessage, jobID); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, runID)
	return err
}

func copyFile(sourcePath string, targetPath string) error {
	source, err := os.Open(sourcePath)
	if err != nil {
		return err
	}
	defer source.Close()
	tempPath := targetPath + ".tmp"
	target, err := os.Create(tempPath)
	if err != nil {
		return err
	}
	if _, err := io.Copy(target, source); err != nil {
		_ = target.Close()
		_ = os.Remove(tempPath)
		return err
	}
	if err := target.Close(); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	if err := os.Rename(tempPath, targetPath); err != nil {
		_ = os.Remove(tempPath)
		return err
	}
	return nil
}

func (s *Server) upsertSavedLocalLocation(ctx context.Context, workID int64, localSourceID int64, item remoteWorkSavePlanItem, targetAbsPath string) error {
	var mediaItemID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT item.id
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.work_id = ?
			AND location.location_type = 'remote_stream'
			AND location.path = ?
		ORDER BY item.id ASC
		LIMIT 1
	`, workID, item.Path).Scan(&mediaItemID); err != nil {
		return err
	}
	info, err := os.Stat(targetAbsPath)
	if err != nil {
		return err
	}
	var size any
	if info.Size() > 0 {
		size = info.Size()
	}
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO media_file_location (
			media_item_id,
			file_source_id,
			location_type,
			path,
			size_bytes,
			availability,
			last_checked_at
		)
		SELECT ?, ?, 'local', ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1
			FROM media_file_location
			WHERE media_item_id = ?
				AND file_source_id = ?
				AND location_type = 'local'
				AND path = ?
		)
	`, mediaItemID, localSourceID, item.TargetPath, size, mediaItemID, localSourceID, item.TargetPath); err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, size, mediaItemID, localSourceID, item.TargetPath)
	return err
}

func (s *Server) remoteWorkDetail(ctx context.Context, source remoteSourceForUse, work kikoeru.Work, tracks []kikoeru.Track) (remoteWorkDetail, error) {
	code := normalizedRemoteWorkCode(work)
	var workID sql.NullInt64
	if code != "" {
		if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return remoteWorkDetail{}, err
		}
	}
	tags := make([]string, 0, len(work.Tags))
	for _, tag := range work.Tags {
		if strings.TrimSpace(tag.Name) != "" {
			tags = append(tags, tag.Name)
		}
	}
	voiceActors := make([]string, 0, len(work.VAs))
	for _, va := range work.VAs {
		if strings.TrimSpace(va.Name) != "" {
			voiceActors = append(voiceActors, va.Name)
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
	var duration *int64
	if work.Duration != nil && *work.Duration > 0 {
		value := int64(*work.Duration)
		duration = &value
	}
	releaseDate := ""
	if value, ok := normalizeDate(work.Release).(string); ok {
		releaseDate = value
	}
	locationState, err := s.remoteTrackLocationState(ctx, source.ID, code)
	if err != nil {
		return remoteWorkDetail{}, err
	}
	return remoteWorkDetail{
		SourceID:        source.ID,
		SourceCode:      source.Code,
		SourceName:      source.DisplayName,
		RemoteID:        strconv.FormatInt(work.ID, 10),
		PrimaryCode:     code,
		Title:           firstNonEmpty(work.Title, work.Name, code),
		CoverURL:        firstNonEmpty(work.MainCoverURL, work.SamCoverURL, work.ThumbnailCoverURL),
		SourceURL:       work.SourceURL,
		Circle:          circle,
		Rating:          work.RateAverage2DP,
		Sales:           work.DLCount,
		ReleaseDate:     releaseDate,
		DurationSeconds: duration,
		Tags:            tags,
		VoiceActors:     voiceActors,
		ImportStatus:    status,
		WorkID:          nullableInt64(workID),
		Tracks:          remoteTrackDetails(source.Code, code, tracks, "", locationState),
	}, nil
}

type remoteTrackLocationState struct {
	ID        int64
	Path      string
	Available bool
}

type remoteTrackLocationStates struct {
	Cache map[string]remoteTrackLocationState
	Local map[string]remoteTrackLocationState
}

func (s *Server) remoteTrackLocationState(ctx context.Context, remoteSourceID int64, workCode string) (remoteTrackLocationStates, error) {
	states := remoteTrackLocationStates{
		Cache: map[string]remoteTrackLocationState{},
		Local: map[string]remoteTrackLocationState{},
	}
	if workCode == "" {
		return states, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.location_type, location.path, location.availability
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		INNER JOIN work ON work.id = item.work_id
		WHERE work.primary_code = ?
			AND location.location_type IN ('cache', 'local')
			AND (
				location.file_source_id = ?
				OR location.location_type = 'local'
			)
	`, workCode, remoteSourceID)
	if err != nil {
		return states, err
	}
	defer rows.Close()
	for rows.Next() {
		var id int64
		var locationType string
		var path string
		var availability string
		if err := rows.Scan(&id, &locationType, &path, &availability); err != nil {
			return states, err
		}
		state := remoteTrackLocationState{ID: id, Path: filepath.ToSlash(path), Available: availability == "available"}
		switch locationType {
		case "cache":
			states.Cache[state.Path] = state
		case "local":
			states.Local[state.Path] = state
		}
	}
	return states, rows.Err()
}

func remoteTrackDetails(sourceCode string, workCode string, tracks []kikoeru.Track, basePath string, locationState remoteTrackLocationStates) []remoteTrackDetail {
	result := make([]remoteTrackDetail, 0, len(tracks))
	for index, track := range tracks {
		title := strings.TrimSpace(track.Title)
		if title == "" {
			title = fmt.Sprintf("Track %d", index+1)
		}
		path := cleanRemoteRelativePath(joinRemotePath(basePath, title))
		var duration *int64
		if track.Duration > 0 {
			value := int64(track.Duration)
			duration = &value
		}
		var size *int64
		if track.Size > 0 {
			value := track.Size
			size = &value
		}
		detail := remoteTrackDetail{
			Type:            remoteTrackKind(track.Type),
			Title:           title,
			Hash:            track.Hash,
			StreamURL:       firstNonEmpty(track.MediaStreamURL, track.StreamLowQualityURL),
			DownloadURL:     track.MediaDownloadURL,
			DurationSeconds: duration,
			SizeBytes:       size,
			Children:        []remoteTrackDetail{},
		}
		if len(track.Children) > 0 || detail.Type == "folder" {
			detail.Children = remoteTrackDetails(sourceCode, workCode, track.Children, path, locationState)
		} else {
			cachePath := cacheMediaRelPath(sourceCode, workCode, path)
			if state, ok := locationState.Cache[cachePath]; ok {
				detail.CacheLocationID = &state.ID
				detail.CachePath = state.Path
				detail.CacheAvailable = state.Available
			}
			if state, ok := locationState.localForRemotePath(path); ok {
				detail.LocalLocationID = &state.ID
				detail.LocalPath = state.Path
				detail.LocalAvailable = state.Available
			}
		}
		result = append(result, detail)
	}
	return result
}

func (states remoteTrackLocationStates) localForRemotePath(remotePath string) (remoteTrackLocationState, bool) {
	if state, ok := states.Local[remotePath]; ok {
		return state, true
	}
	for localPath, state := range states.Local {
		if strings.HasSuffix(localPath, "/"+remotePath) {
			return state, true
		}
	}
	return remoteTrackLocationState{}, false
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
	if remoteWork.Circle != nil && strings.TrimSpace(remoteWork.Circle.Name) != "" {
		var partyID int64
		if err := tx.QueryRowContext(ctx, `
			SELECT id
			FROM party
			WHERE party_type IN ('circle', 'brand', 'maker')
				AND LOWER(display_name) = LOWER(?)
			ORDER BY id ASC
			LIMIT 1
		`, strings.TrimSpace(remoteWork.Circle.Name)).Scan(&partyID); err == nil {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
				VALUES (?, ?, 'circle', ?, ?, CURRENT_TIMESTAMP)
				ON CONFLICT(work_id, party_id, role) DO UPDATE SET
					provider_id = excluded.provider_id,
					source = excluded.source,
					updated_at = CURRENT_TIMESTAMP
			`, workID, partyID, providerID, "remote_source"); err != nil {
				return 0, err
			}
		} else if !errors.Is(err, sql.ErrNoRows) {
			return 0, err
		}
	}
	return workID, nil
}

func (s *Server) downloadRemoteCover(ctx context.Context, workCode string, coverURL string) error {
	coverURL = strings.TrimSpace(coverURL)
	if coverURL == "" {
		return nil
	}
	parsedURL, err := url.Parse(coverURL)
	if err != nil {
		return nil
	}
	extension := strings.ToLower(filepath.Ext(parsedURL.Path))
	if extension == "" || len(extension) > 6 {
		extension = ".jpg"
	}
	if err := os.MkdirAll(filepath.Join(s.cfg.CacheRoot, "cover"), 0o755); err != nil {
		return err
	}
	targetPath := filepath.Join(s.cfg.CacheRoot, "cover", strings.ToUpper(workCode)+extension)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, coverURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", "Kikoto/0.1 Kikoeru-compatible client")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("cover download returned HTTP %d", response.StatusCode)
	}
	file, err := os.Create(targetPath)
	if err != nil {
		return err
	}
	defer file.Close()
	_, err = io.Copy(file, response.Body)
	return err
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

func isNotFoundLikeError(err error) bool {
	if err == nil {
		return false
	}
	message := strings.ToLower(err.Error())
	return strings.Contains(message, "404") || strings.Contains(message, "not found") || strings.Contains(message, "no rows")
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
		LocalScanDepth:        s.settingInt(r, "local_scan_depth", s.cfg.LocalScanDepth),
		AutoSyncRemote:        s.settingBool(r, "remote_auto_sync_enabled", false) || s.settingBool(r, "remote_cache_enabled", false),
		CacheEnabled:          s.settingBool(r, "remote_cache_enabled", false),
		CacheLimitGB:          s.settingInt(r, "remote_cache_limit_gb", 20),
		RemoteSaveTemplate:    s.settingString(r, "remote_save_root_template", "/data/<source_name>/<work_code>"),
		RemoteDelayBase:       s.settingFloat(r, "remote_request_delay_base_seconds", 0.5),
		RemoteDelayRandom:     s.settingFloat(r, "remote_request_delay_random_seconds", 1.5),
		RemoteBackoff:         s.settingFloat(r, "remote_rate_limit_backoff_seconds", 30),
		RemoteMaxBackoff:      s.settingFloat(r, "remote_max_backoff_seconds", 300),
		CircleAutoRefreshDays: s.settingInt(r, "circle_auto_refresh_days", 30),
		DataRoot:              s.cfg.DataRoot,
		CacheRoot:             s.cfg.CacheRoot,
		FileSources:           sources,
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

func (s *Server) settingFloat(r *http.Request, key string, fallback float64) float64 {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value float64
	if err := json.Unmarshal([]byte(raw), &value); err != nil {
		return fallback
	}
	return value
}

func (s *Server) settingFloatContext(ctx context.Context, key string, fallback float64) float64 {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var value float64
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
