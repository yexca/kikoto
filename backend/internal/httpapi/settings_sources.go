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
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

const (
	sourceTypeKikoeruCompatible    = "kikoeru_compatible"
	sourceTypeKikoeruCompatible178 = "kikoeru_compatible_number178"
	historicalMisspelled178Type    = "kikoeru_compilable_number178"
	sourceTypeLocalFolder          = "local_folder"
	defaultRemoteWorkURLTemplate   = "/work/{code}"
	maxRemoteAllowedHostPatterns   = 64
	defaultDLsiteMetadataLanguage  = "ja-jp"
	defaultRemoteRequestLanguage   = "ja-JP"
	maxDLsiteMetadataLanguages     = 6
	dlsiteMetadataLanguageSetting  = "dlsite_metadata_language"
	dlsiteMetadataLanguagesSetting = "dlsite_metadata_languages"
)

func isKikoeruSourceType(sourceType string) bool {
	return sourceType == sourceTypeKikoeruCompatible || sourceType == sourceTypeKikoeruCompatible178
}

func (s *Server) SeedRemoteSourcesFromConfig(ctx context.Context) error {
	if len(s.cfg.RemoteSourceSeeds) == 0 {
		return nil
	}
	var existing int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM file_source
		WHERE source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
	`).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, seed := range s.cfg.RemoteSourceSeeds {
		normalized, err := normalizeRemoteSourceSeed(seed)
		if err != nil {
			return err
		}
		if normalized == nil {
			continue
		}
		if err := insertRemoteSourceSeed(ctx, tx, *normalized); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type normalizedRemoteSourceSeed struct {
	Code            string
	DisplayName     string
	SourceType      string
	RequestLanguage string
	Priority        int
	Enabled         bool
	BaseURL         string
	APIURL          string
	FallbackURL     string
	WorkURLTemplate string
}

func normalizeRemoteSourceSeed(seed config.RemoteSourceSeed) (*normalizedRemoteSourceSeed, error) {
	sourceType := strings.TrimSpace(seed.SourceType)
	if sourceType == sourceTypeKikoeruCompatible178 || sourceType == historicalMisspelled178Type {
		return nil, fmt.Errorf("remote source type %q is retained for compatibility but disabled for new configuration", sourceType)
	}
	if !isKikoeruSourceType(sourceType) {
		sourceType = sourceTypeKikoeruCompatible
	}
	displayName := strings.TrimSpace(seed.DisplayName)
	apiURL := strings.TrimSpace(seed.APIURL)
	if displayName == "" || apiURL == "" {
		return nil, nil
	}
	baseURL := strings.TrimSpace(seed.BaseURL)
	fallbackURL := strings.TrimSpace(seed.FallbackURL)
	requestLanguage := strings.TrimSpace(seed.RequestLanguage)
	if requestLanguage == "" {
		requestLanguage = defaultRemoteRequestLanguage
	} else {
		requestLanguage = normalizeRemoteRequestLanguage(requestLanguage)
		if requestLanguage == "" {
			return nil, fmt.Errorf("remote source seed has an invalid request language")
		}
	}
	for _, candidate := range []string{apiURL, baseURL, fallbackURL} {
		if candidate == "" {
			continue
		}
		if _, err := outbound.ParseHTTPURL(candidate); err != nil {
			return nil, fmt.Errorf("remote source seed has an invalid endpoint: %w", err)
		}
	}
	if baseURL == "" {
		baseURL = apiURL
	}
	code := stableSourceCode(displayName)
	if code == "" {
		code = slugSourceCode(displayName)
	}
	return &normalizedRemoteSourceSeed{
		Code: code, DisplayName: displayName, SourceType: sourceType,
		RequestLanguage: requestLanguage,
		Priority:        sourcePriority(seed.Priority), Enabled: seed.Enabled,
		BaseURL: baseURL, APIURL: apiURL, FallbackURL: fallbackURL,
		WorkURLTemplate: remoteWorkURLTemplate(seed.WorkURLTemplate),
	}, nil
}

func insertRemoteSourceSeed(ctx context.Context, tx *sql.Tx, seed normalizedRemoteSourceSeed) error {
	sourceID, err := sqlutil.InsertID(ctx, tx, `
		INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`, seed.Code, seed.DisplayName, seed.SourceType, seed.Priority, seed.Enabled, mustJSON(fileSourceConfig{RequestLanguage: seed.RequestLanguage}))
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, fallback_url, work_url_template)
		VALUES (?, ?, ?, ?, ?)
	`, sourceID, seed.BaseURL, seed.APIURL, seed.FallbackURL, seed.WorkURLTemplate)
	return err
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

type fileSourceHealthCheckResult struct {
	Healthy       bool    `json:"healthy"`
	HealthStatus  string  `json:"healthStatus"`
	LastCheckedAt *string `json:"lastCheckedAt"`
	ElapsedMS     int64   `json:"elapsedMs"`
}

type fileSourceConfig struct {
	SaveRootTemplate string `json:"saveRootTemplate,omitempty"`
	ScanDepth        *int   `json:"scanDepth,omitempty"`
	RequestLanguage  string `json:"requestLanguage,omitempty"`
}

type fileSourceEndpoint struct {
	BaseURL               string   `json:"baseUrl"`
	APIURL                string   `json:"apiUrl"`
	FallbackURL           string   `json:"fallbackUrl"`
	WorkURLTemplate       string   `json:"workUrlTemplate"`
	RestrictOutboundHosts bool     `json:"restrictOutboundHosts"`
	AllowedHostPatterns   []string `json:"allowedHostPatterns"`
}

type librarySource struct {
	ID          int64  `json:"id"`
	Code        string `json:"code"`
	DisplayName string `json:"displayName"`
	SourceType  string `json:"sourceType"`
	Enabled     bool   `json:"enabled"`
}

var sourceCodePattern = regexp.MustCompile(`[^a-z0-9_]+`)
var remoteRequestLanguagePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})*$`)

func (s *Server) listLibrarySources(w http.ResponseWriter, r *http.Request) {
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, code, display_name, source_type, enabled
		FROM file_source
		WHERE source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
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
	payload, ok := parseFileSourcePayload(w, r, false, false)
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

	sourceID, err := sqlutil.InsertID(r.Context(), tx, `
		INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES (?, ?, ?, ?, ?, ?)
	`, code, payload.DisplayName, payload.SourceType, payload.Priority, payload.Enabled, mustJSON(payload.Config))
	if err != nil {
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO file_source_endpoint (
			file_source_id, base_url, api_url, fallback_url, work_url_template,
			restrict_outbound_hosts, allowed_host_patterns_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`, sourceID, payload.Endpoint.BaseURL, payload.Endpoint.APIURL, payload.Endpoint.FallbackURL, payload.Endpoint.WorkURLTemplate,
		payload.Endpoint.RestrictOutboundHosts, mustJSON(payload.Endpoint.AllowedHostPatterns)); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	s.notifyFilesystemTriggerConfigChanged()
	source, err := s.loadFileSource(r, sourceID)
	if err != nil {
		writeError(w, err)
		return
	}
	if source.Enabled {
		s.Go(func(ctx context.Context) {
			s.runSourceChangeAvailabilityChecks(ctx, source.ID, "source_created")
		})
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
	payload, ok := parseFileSourcePayload(w, r, true, true)
	if !ok {
		return
	}
	if err := s.validateFileSourceUpdate(r.Context(), id, payload); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found"})
			return
		}
		if errors.Is(err, errLocalFolderSourceManaged) || errors.Is(err, errLegacySourceTypeSelection) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeError(w, err)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	updated, err := updateFileSourceTx(r.Context(), tx, id, payload)
	if err != nil {
		writeError(w, err)
		return
	}
	if !updated {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found"})
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	s.notifyFilesystemTriggerConfigChanged()
	s.invalidateRemoteWorkCache(id)
	source, err := s.loadFileSource(r, id)
	if err != nil {
		writeError(w, err)
		return
	}
	if source.Enabled {
		s.Go(func(ctx context.Context) {
			s.runSourceChangeAvailabilityChecks(ctx, source.ID, "source_updated")
		})
	}
	writeJSON(w, http.StatusOK, source)
}

var (
	errLocalFolderSourceManaged  = errors.New("local folder source is managed by local scan settings")
	errLegacySourceTypeSelection = errors.New("legacy number178 sources cannot be selected")
)

func (s *Server) validateFileSourceUpdate(ctx context.Context, id int64, payload fileSourcePayload) error {
	var existingSourceType string
	if err := s.db.QueryRowContext(ctx, "SELECT source_type FROM file_source WHERE id = ?", id).Scan(&existingSourceType); err != nil {
		return err
	}
	if existingSourceType == sourceTypeLocalFolder || payload.SourceType == sourceTypeLocalFolder {
		return errLocalFolderSourceManaged
	}
	if payload.SourceType == sourceTypeKikoeruCompatible178 && existingSourceType != sourceTypeKikoeruCompatible178 {
		return errLegacySourceTypeSelection
	}
	return nil
}

func updateFileSourceTx(ctx context.Context, tx *sql.Tx, id int64, payload fileSourcePayload) (bool, error) {
	result, err := tx.ExecContext(ctx, `
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
		return false, err
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		return false, nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO file_source_endpoint (
			file_source_id, base_url, api_url, fallback_url, work_url_template,
			restrict_outbound_hosts, allowed_host_patterns_json
		)
		VALUES (?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(file_source_id) DO UPDATE SET
			base_url = excluded.base_url,
			api_url = excluded.api_url,
			fallback_url = excluded.fallback_url,
			work_url_template = excluded.work_url_template,
			restrict_outbound_hosts = excluded.restrict_outbound_hosts,
			allowed_host_patterns_json = excluded.allowed_host_patterns_json
	`, id, payload.Endpoint.BaseURL, payload.Endpoint.APIURL, payload.Endpoint.FallbackURL, payload.Endpoint.WorkURLTemplate,
		payload.Endpoint.RestrictOutboundHosts, mustJSON(payload.Endpoint.AllowedHostPatterns)); err != nil {
		return false, err
	}
	return true, nil
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
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM file_source WHERE id = ? AND source_type <> ?", id, sourceTypeLocalFolder)
	if err != nil {
		writeError(w, err)
		return
	}
	affected, _ := result.RowsAffected()
	if affected == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found or cannot be deleted"})
		return
	}
	s.notifyFilesystemTriggerConfigChanged()
	s.invalidateRemoteWorkCache(id)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) checkFileSourceHealth(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil || id <= 0 {
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
	if !source.Enabled {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "source is disabled"})
		return
	}
	if !isKikoeruSourceType(source.SourceType) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source type does not support health checks"})
		return
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source API endpoint is not configured"})
		return
	}

	started := time.Now()
	checkCtx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	probeErr := s.checkRemoteSourceHealth(checkCtx, source)
	cancel()
	status := "healthy"
	if probeErr != nil {
		status = "unavailable"
	}
	if _, err := s.db.ExecContext(r.Context(), `
		UPDATE file_source_endpoint
		SET health_status = ?, last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
	`, status, id); err != nil {
		writeError(w, err)
		return
	}
	updated, err := s.loadFileSource(r, id)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, fileSourceHealthCheckResult{
		Healthy:       probeErr == nil,
		HealthStatus:  updated.HealthStatus,
		LastCheckedAt: updated.LastCheckedAt,
		ElapsedMS:     time.Since(started).Milliseconds(),
	})
}

func (s *Server) updateSourceHealth(ctx context.Context, sourceID int64, status string) error {
	if s.cfg.IsDemo() {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE file_source_endpoint
		SET health_status = ?,
			last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
			AND (
				health_status IS NULL
				OR health_status <> ?
				OR last_checked_at IS NULL
				OR last_checked_at <= datetime('now', '-10 minutes')
			)
	`, status, sourceID, status)
	return err
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
			COALESCE(endpoint.work_url_template, ''),
			COALESCE(endpoint.restrict_outbound_hosts, 0),
			COALESCE(endpoint.allowed_host_patterns_json, '[]'),
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
			COALESCE(endpoint.work_url_template, ''),
			COALESCE(endpoint.restrict_outbound_hosts, 0),
			COALESCE(endpoint.allowed_host_patterns_json, '[]'),
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
	var configJSON, allowedHostPatternsJSON string
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
		&source.Endpoint.WorkURLTemplate,
		&source.Endpoint.RestrictOutboundHosts,
		&allowedHostPatternsJSON,
		&source.HealthStatus,
		&lastCheckedAt,
	); err != nil {
		return fileSourceSummary{}, err
	}
	source.LastCheckedAt = sqlutil.String(lastCheckedAt)
	if strings.TrimSpace(configJSON) != "" {
		_ = json.Unmarshal([]byte(configJSON), &source.Config)
	}
	normalizeFileSourceConfig(&source.Config, source.SourceType)
	_ = json.Unmarshal([]byte(allowedHostPatternsJSON), &source.Endpoint.AllowedHostPatterns)
	if source.Endpoint.AllowedHostPatterns == nil {
		source.Endpoint.AllowedHostPatterns = []string{}
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

func parseFileSourcePayload(w http.ResponseWriter, r *http.Request, allowLocal bool, allowLegacy bool) (fileSourcePayload, bool) {
	payload, err := decodeFileSourcePayload(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return fileSourcePayload{}, false
	}
	normalizeFileSourcePayload(&payload)
	if err := validateFileSourcePayload(&payload, allowLocal, allowLegacy); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return fileSourcePayload{}, false
	}
	return payload, true
}

func decodeFileSourcePayload(r *http.Request) (fileSourcePayload, error) {
	var payload fileSourcePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return fileSourcePayload{}, errors.New("invalid JSON body")
	}
	return payload, nil
}

func normalizeFileSourcePayload(payload *fileSourcePayload) {
	payload.DisplayName = strings.TrimSpace(payload.DisplayName)
	payload.SourceType = strings.TrimSpace(payload.SourceType)
	payload.Endpoint.BaseURL = strings.TrimSpace(payload.Endpoint.BaseURL)
	payload.Endpoint.APIURL = strings.TrimSpace(payload.Endpoint.APIURL)
	payload.Endpoint.FallbackURL = strings.TrimSpace(payload.Endpoint.FallbackURL)
	payload.Endpoint.WorkURLTemplate = remoteWorkURLTemplate(payload.Endpoint.WorkURLTemplate)
	if payload.SourceType == "" {
		payload.SourceType = sourceTypeKikoeruCompatible
	}
	if payload.Priority <= 0 {
		payload.Priority = 30
	}
	normalizeFileSourceConfig(&payload.Config, payload.SourceType)
}

func validateFileSourcePayload(payload *fileSourcePayload, allowLocal, allowLegacy bool) error {
	if payload.DisplayName == "" {
		return errors.New("displayName is required")
	}
	if payload.SourceType == sourceTypeKikoeruCompatible178 && !allowLegacy {
		return errors.New("legacy number178 sources are disabled")
	}
	if !isKikoeruSourceType(payload.SourceType) && !(allowLocal && payload.SourceType == sourceTypeLocalFolder) {
		return errors.New("unsupported sourceType")
	}
	if isKikoeruSourceType(payload.SourceType) {
		if strings.TrimSpace(payload.Config.RequestLanguage) == "" {
			return errors.New("config.requestLanguage must be a valid BCP-47-like language tag")
		}
		if err := validateRemoteFileSourceEndpoint(&payload.Endpoint); err != nil {
			return err
		}
	}
	if payload.Endpoint.AllowedHostPatterns == nil {
		payload.Endpoint.AllowedHostPatterns = []string{}
	}
	return nil
}

func normalizeFileSourceConfig(config *fileSourceConfig, sourceType string) {
	if !isKikoeruSourceType(sourceType) {
		return
	}
	raw := strings.TrimSpace(config.RequestLanguage)
	if raw == "" {
		config.RequestLanguage = defaultRemoteRequestLanguage
		return
	}
	config.RequestLanguage = normalizeRemoteRequestLanguage(raw)
}

func normalizeRemoteRequestLanguage(value string) string {
	value = strings.TrimSpace(strings.ReplaceAll(value, "_", "-"))
	if value == "" {
		return defaultRemoteRequestLanguage
	}
	if !remoteRequestLanguagePattern.MatchString(value) {
		return ""
	}
	parts := strings.Split(value, "-")
	parts[0] = strings.ToLower(parts[0])
	for index := 1; index < len(parts); index++ {
		if len(parts[index]) == 4 {
			parts[index] = strings.ToUpper(parts[index][:1]) + strings.ToLower(parts[index][1:])
		} else if len(parts[index]) == 2 || len(parts[index]) == 3 {
			parts[index] = strings.ToUpper(parts[index])
		} else {
			parts[index] = strings.ToLower(parts[index])
		}
	}
	return strings.Join(parts, "-")
}

func validateRemoteFileSourceEndpoint(endpoint *fileSourceEndpoint) error {
	for _, candidate := range []string{endpoint.BaseURL, endpoint.APIURL, endpoint.FallbackURL} {
		if candidate == "" {
			continue
		}
		if _, err := outbound.ParseHTTPURL(candidate); err != nil {
			return errors.New("endpoint URLs must be absolute HTTP(S) URLs without credentials")
		}
	}
	if !validRemoteWorkURLTemplate(endpoint.WorkURLTemplate) {
		return errors.New("workUrlTemplate must be a relative path containing {code} or {codeLower}")
	}
	if len(endpoint.AllowedHostPatterns) > maxRemoteAllowedHostPatterns {
		return errors.New("allowedHostPatterns must contain at most 64 entries")
	}
	normalizedPatterns := make([]string, 0, len(endpoint.AllowedHostPatterns))
	seenPatterns := make(map[string]bool, len(endpoint.AllowedHostPatterns))
	for _, value := range endpoint.AllowedHostPatterns {
		if strings.TrimSpace(value) == "" {
			continue
		}
		normalized, err := outbound.NormalizeHostPattern(value)
		if err != nil {
			return errors.New("allowedHostPatterns entries must be hostnames or leading-wildcard patterns such as *.media.example.invalid")
		}
		if !seenPatterns[normalized] {
			seenPatterns[normalized] = true
			normalizedPatterns = append(normalizedPatterns, normalized)
		}
	}
	endpoint.AllowedHostPatterns = normalizedPatterns
	return nil
}

func remoteWorkURLTemplate(value string) string {
	if value = strings.TrimSpace(value); value != "" {
		return value
	}
	return defaultRemoteWorkURLTemplate
}

func validRemoteWorkURLTemplate(value string) bool {
	value = remoteWorkURLTemplate(value)
	if !strings.HasPrefix(value, "/") || strings.HasPrefix(value, "//") {
		return false
	}
	if !strings.Contains(value, "{code}") && !strings.Contains(value, "{codeLower}") {
		return false
	}
	remainder := strings.NewReplacer("{code}", "", "{codeLower}", "").Replace(value)
	return !strings.ContainsAny(remainder, "{}")
}

// publicRemoteSourceURL returns a diagnostic destination derived from the
// configured source endpoint. Query strings are intentionally removed because
// an operator may use them for tokens or other private request metadata.
func publicRemoteSourceURL(endpoint fileSourceEndpoint) string {
	for _, candidate := range []string{endpoint.APIURL, endpoint.BaseURL, endpoint.FallbackURL} {
		parsed, err := outbound.ParseHTTPURL(candidate)
		if err != nil {
			continue
		}
		parsed.User = nil
		parsed.RawQuery = ""
		parsed.ForceQuery = false
		parsed.Fragment = ""
		return strings.TrimRight(parsed.String(), "/")
	}
	return ""
}

func remoteSourceDiagnosticURL(ctx context.Context, endpoint fileSourceEndpoint) string {
	actor, ok := userFromContext(ctx)
	if !ok || !userHasPermission(actor, "sources:write") {
		return ""
	}
	return publicRemoteSourceURL(endpoint)
}

func publicRemoteWorkURL(endpoint fileSourceEndpoint, code string) string {
	baseURL, err := outbound.ParseHTTPURL(endpoint.BaseURL)
	if err != nil {
		return ""
	}
	template := remoteWorkURLTemplate(endpoint.WorkURLTemplate)
	if !validRemoteWorkURLTemplate(template) {
		return ""
	}
	code = strings.TrimSpace(code)
	if code == "" {
		return ""
	}
	path := strings.NewReplacer(
		"{code}", url.PathEscape(code),
		"{codeLower}", url.PathEscape(strings.ToLower(code)),
	).Replace(template)
	reference, err := url.Parse(path)
	if err != nil {
		return ""
	}
	return baseURL.ResolveReference(reference).String()
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

func stableSourceCode(displayName string) string {
	base := strings.ToLower(strings.TrimSpace(displayName))
	base = sourceCodePattern.ReplaceAllString(base, "_")
	base = strings.Trim(base, "_")
	if base == "" {
		return ""
	}
	if !strings.HasPrefix(base, "remote_") {
		base = "remote_" + base
	}
	return base
}

func sourcePriority(value int) int {
	if value <= 0 {
		return 30
	}
	return value
}

func (s *Server) listFileSources(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	sources, err := s.loadFileSources(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sources)
}
