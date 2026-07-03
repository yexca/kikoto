package httpapi

import (
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
)

type appSettingsResponse struct {
	LocalScanDepth int                 `json:"localScanDepth"`
	CacheEnabled   bool                `json:"cacheEnabled"`
	CacheLimitGB   int                 `json:"cacheLimitGb"`
	DataRoot       string              `json:"dataRoot"`
	CacheRoot      string              `json:"cacheRoot"`
	FileSources    []fileSourceSummary `json:"fileSources"`
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
	CacheEnabled *bool `json:"cacheEnabled,omitempty"`
	CacheLimitGB *int  `json:"cacheLimitGb,omitempty"`
	ScanDepth    *int  `json:"scanDepth,omitempty"`
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
	ID          int64  `json:"id"`
	Code        string `json:"code"`
	DisplayName string `json:"displayName"`
	SourceType  string `json:"sourceType"`
	Enabled     bool   `json:"enabled"`
}

type remoteWorkSummary struct {
	RemoteID     string   `json:"remoteId"`
	PrimaryCode  string   `json:"primaryCode"`
	Title        string   `json:"title"`
	CoverURL     string   `json:"coverUrl"`
	Circle       string   `json:"circle"`
	Tags         []string `json:"tags"`
	ImportStatus string   `json:"importStatus"`
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

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var payload struct {
		LocalScanDepth *int  `json:"localScanDepth"`
		CacheEnabled   *bool `json:"cacheEnabled"`
		CacheLimitGB   *int  `json:"cacheLimitGb"`
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
		if err := upsertSetting(r, tx, "remote_cache_enabled", *payload.CacheEnabled); err != nil {
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
		SELECT id, code, display_name, source_type, enabled
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
		if err := rows.Scan(&source.ID, &source.Code, &source.DisplayName, &source.SourceType, &source.Enabled); err != nil {
			writeError(w, err)
			return
		}
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
	var sourceType string
	var enabled bool
	if err := s.db.QueryRowContext(r.Context(), "SELECT source_type, enabled FROM file_source WHERE id = ?", id).Scan(&sourceType, &enabled); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found"})
			return
		}
		writeError(w, err)
		return
	}
	if sourceType != "kikoeru_compatible" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is not kikoeru_compatible"})
		return
	}
	page := queryInt(r, "page", 1)
	pageSize := queryInt(r, "pageSize", 24)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 24
	}
	status := "not_connected"
	if !enabled {
		status = "disabled"
	}
	writeJSON(w, http.StatusOK, remoteWorksResponse{
		SourceID: id,
		Works:    []remoteWorkSummary{},
		Page:     page,
		PageSize: pageSize,
		Total:    0,
		Status:   status,
	})
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
		LocalScanDepth: s.settingInt(r, "local_scan_depth", s.cfg.LocalScanDepth),
		CacheEnabled:   s.settingBool(r, "remote_cache_enabled", false),
		CacheLimitGB:   s.settingInt(r, "remote_cache_limit_gb", 20),
		DataRoot:       s.cfg.DataRoot,
		CacheRoot:      s.cfg.CacheRoot,
		FileSources:    sources,
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
