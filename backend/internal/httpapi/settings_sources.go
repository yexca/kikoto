package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	sourceTypeKikoeruCompatible    = "kikoeru_compatible"
	sourceTypeKikoeruCompilable178 = "kikoeru_compilable_number178"
	sourceTypeLocalFolder          = "local_folder"
)

func isKikoeruSourceType(sourceType string) bool {
	return sourceType == sourceTypeKikoeruCompatible || sourceType == sourceTypeKikoeruCompilable178
}

func kikoeruClientForSource(source remoteSourceForUse) *kikoeru.Client {
	if source.SourceType == sourceTypeKikoeruCompilable178 {
		return kikoeru.NewNumber178Client(source.Endpoint.APIURL, nil)
	}
	return kikoeru.NewClient(source.Endpoint.APIURL, nil)
}

func (s *Server) SeedRemoteSourcesFromConfig(ctx context.Context) error {
	if len(s.cfg.RemoteSourceSeeds) == 0 {
		return nil
	}
	var existing int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM file_source
		WHERE source_type IN ('kikoeru_compatible', 'kikoeru_compilable_number178')
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
		sourceType := strings.TrimSpace(seed.SourceType)
		if !isKikoeruSourceType(sourceType) {
			sourceType = sourceTypeKikoeruCompatible
		}
		displayName := strings.TrimSpace(seed.DisplayName)
		apiURL := strings.TrimSpace(seed.APIURL)
		if displayName == "" || apiURL == "" {
			continue
		}
		code := stableSourceCode(displayName)
		if code == "" {
			code = slugSourceCode(displayName)
		}
		configJSON := mustJSON(fileSourceConfig{})
		sourceID, err := insertAndID(ctx, tx, `
			INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
			VALUES (?, ?, ?, ?, ?, ?)
		`, code, displayName, sourceType, sourcePriority(seed.Priority), seed.Enabled, configJSON)
		if err != nil {
			return err
		}
		baseURL := strings.TrimSpace(seed.BaseURL)
		if baseURL == "" {
			baseURL = apiURL
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, fallback_url)
			VALUES (?, ?, ?, ?)
		`, sourceID, baseURL, apiURL, strings.TrimSpace(seed.FallbackURL)); err != nil {
			return err
		}
	}
	return tx.Commit()
}

type appSettingsResponse struct {
	LocalScanDepth         int                 `json:"localScanDepth"`
	CacheEnabled           bool                `json:"cacheEnabled"`
	CacheLimitGB           int                 `json:"cacheLimitGb"`
	RemoteSaveTemplate     string              `json:"remoteSaveTemplate"`
	RemoteDelayBase        float64             `json:"remoteDelayBaseSeconds"`
	RemoteDelayRandom      float64             `json:"remoteDelayRandomSeconds"`
	RemoteBackoff          float64             `json:"remoteBackoffSeconds"`
	RemoteMaxBackoff       float64             `json:"remoteMaxBackoffSeconds"`
	CircleAutoRefreshDays  int                 `json:"circleAutoRefreshDays"`
	DLsiteMetadataLanguage string              `json:"dlsiteMetadataLanguage"`
	DirectoryRoutingRules  []directoryRule     `json:"directoryRoutingRules"`
	DataRoot               string              `json:"dataRoot"`
	CacheRoot              string              `json:"cacheRoot"`
	FileSources            []fileSourceSummary `json:"fileSources"`
}

type directoryRule struct {
	ID              string   `json:"id"`
	Label           string   `json:"label"`
	Weight          int      `json:"weight"`
	Aliases         []string `json:"aliases"`
	NegativeAliases []string `json:"negativeAliases"`
	Enabled         bool     `json:"enabled"`
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
	CacheEnabled     *bool  `json:"cacheEnabled,omitempty"`
	CacheLimitGB     *int   `json:"cacheLimitGb,omitempty"`
	SaveRootTemplate string `json:"saveRootTemplate,omitempty"`
	ScanDepth        *int   `json:"scanDepth,omitempty"`
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
	ID           int64  `json:"id"`
	Code         string `json:"code"`
	DisplayName  string `json:"displayName"`
	SourceType   string `json:"sourceType"`
	Enabled      bool   `json:"enabled"`
	CacheEnabled bool   `json:"cacheEnabled"`
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
	Favorite       bool     `json:"favorite"`
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
	AgeRating       string              `json:"ageRating"`
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

type sourceAvailabilityCheckRequest struct {
	SourceID int64 `json:"sourceId"`
	Force    bool  `json:"force"`
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

type workSourceUntrackResult struct {
	WorkID         int64    `json:"workId"`
	SourceID       int64    `json:"sourceId"`
	Status         string   `json:"status"`
	ClearedCaches  int      `json:"clearedCaches"`
	DeletedFiles   int      `json:"deletedFiles"`
	CachePaths     []string `json:"cachePaths"`
	TrackedCleared bool     `json:"trackedCleared"`
	WorkPreserved  bool     `json:"workPreserved"`
	LocalPreserved bool     `json:"localPreserved"`
}

type remoteCollectionRunRequest struct {
	SourceID int64  `json:"sourceId"`
	Action   string `json:"action"`
	Limit    int    `json:"limit"`
}

type remoteCollectionRunResult struct {
	RunID           int64    `json:"runId"`
	SourceID        int64    `json:"sourceId"`
	CollectionKind  string   `json:"collectionKind"`
	Action          string   `json:"action"`
	Status          string   `json:"status"`
	Discovered      int      `json:"discovered"`
	Accepted        int      `json:"accepted"`
	Skipped         int      `json:"skipped"`
	Tracked         int      `json:"tracked"`
	Fetched         int      `json:"fetched"`
	Failed          int      `json:"failed"`
	ChildRuns       []int64  `json:"childRuns"`
	Failures        []string `json:"failures"`
	ExpectedMaximum int      `json:"expectedMaximum"`
	ReturnedCount   int      `json:"returnedCount"`
}

type remoteWorkSaveRequest struct {
	Paths      []string `json:"paths"`
	LocalPaths []string `json:"localPaths"`
}

type remoteWorkFetchJobPayload struct {
	SourceID   int64    `json:"source_id"`
	WorkCode   string   `json:"work_code"`
	Paths      []string `json:"paths"`
	LocalPaths []string `json:"local_paths"`
}

type remoteWorkSavePlan struct {
	SourceID    int64                     `json:"sourceId"`
	PrimaryCode string                    `json:"primaryCode"`
	SaveRoot    string                    `json:"saveRoot"`
	LocalFiles  []remoteWorkSaveLocalFile `json:"localFiles"`
	Items       []remoteWorkSavePlanItem  `json:"items"`
	Summary     remoteWorkSaveSummary     `json:"summary"`
}

type remoteWorkSaveLocalFile struct {
	MediaItemID int64  `json:"mediaItemId"`
	Path        string `json:"path"`
	SizeBytes   *int64 `json:"sizeBytes"`
	Available   bool   `json:"available"`
}

type remoteWorkSavePlanItem struct {
	Path                 string   `json:"path"`
	Kind                 string   `json:"kind"`
	SizeBytes            *int64   `json:"sizeBytes"`
	SourceKind           string   `json:"sourceKind"`
	Action               string   `json:"action"`
	Status               string   `json:"status"`
	SourcePath           string   `json:"sourcePath"`
	LocalSourcePath      string   `json:"localSourcePath"`
	CachePath            string   `json:"cachePath"`
	TargetPath           string   `json:"targetPath"`
	MediaItemID          int64    `json:"mediaItemId"`
	LocalPaths           []string `json:"localPaths"`
	TargetExists         bool     `json:"targetExists"`
	TargetConflict       bool     `json:"targetConflict"`
	TargetConflictReason string   `json:"targetConflictReason"`
	TargetSizeBytes      *int64   `json:"targetSizeBytes"`
}

type remoteWorkSaveSummary struct {
	Total         int `json:"total"`
	SkipExisting  int `json:"skipExisting"`
	CacheHit      int `json:"cacheHit"`
	CacheDownload int `json:"cacheDownload"`
	Promote       int `json:"promote"`
	Conflict      int `json:"conflict"`
}

type remoteWorkSaveResult struct {
	RunID         int64                 `json:"runId"`
	JobID         int64                 `json:"jobId"`
	WorkID        int64                 `json:"workId"`
	PrimaryCode   string                `json:"primaryCode"`
	Status        string                `json:"status"`
	SaveRoot      string                `json:"saveRoot"`
	SavedFiles    int                   `json:"savedFiles"`
	SkippedFiles  int                   `json:"skippedFiles"`
	CachedFiles   int                   `json:"cachedFiles"`
	PromotedFiles int                   `json:"promotedFiles"`
	Plan          remoteWorkSaveSummary `json:"plan"`
}

type remoteWorkSaveConflictError struct {
	Summary remoteWorkSaveSummary
}

func (err remoteWorkSaveConflictError) Error() string {
	if err.Summary.Conflict == 1 {
		return "fetch plan has 1 target conflict; review the selected files before fetching"
	}
	return fmt.Sprintf("fetch plan has %d target conflicts; review the selected files before fetching", err.Summary.Conflict)
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
	writeJSON(w, http.StatusOK, map[string]any{
		"cacheEnabled":          s.settingBool(r, "remote_cache_enabled", false),
		"directoryRoutingRules": s.settingDirectoryRules(r, "directory_routing_rules", defaultDirectoryRoutingRules()),
	})
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var payload struct {
		LocalScanDepth         *int             `json:"localScanDepth"`
		CacheEnabled           *bool            `json:"cacheEnabled"`
		CacheLimitGB           *int             `json:"cacheLimitGb"`
		RemoteSaveTemplate     *string          `json:"remoteSaveTemplate"`
		RemoteDelayBase        *float64         `json:"remoteDelayBaseSeconds"`
		RemoteDelayRandom      *float64         `json:"remoteDelayRandomSeconds"`
		RemoteBackoff          *float64         `json:"remoteBackoffSeconds"`
		RemoteMaxBackoff       *float64         `json:"remoteMaxBackoffSeconds"`
		CircleAutoRefreshDays  *int             `json:"circleAutoRefreshDays"`
		DLsiteMetadataLanguage *string          `json:"dlsiteMetadataLanguage"`
		DirectoryRoutingRules  *[]directoryRule `json:"directoryRoutingRules"`
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
	if payload.RemoteSaveTemplate != nil {
		value := strings.TrimSpace(*payload.RemoteSaveTemplate)
		if value == "" {
			value = "/data/<source_name>/<code_prefix>/<code_group>/<work_code>"
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
	if payload.DLsiteMetadataLanguage != nil {
		value := normalizeDLsiteLanguage(*payload.DLsiteMetadataLanguage)
		if value == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported dlsiteMetadataLanguage"})
			return
		}
		if err := upsertSetting(r, tx, "dlsite_metadata_language", value); err != nil {
			writeError(w, err)
			return
		}
	}
	if payload.DirectoryRoutingRules != nil {
		rules := normalizeDirectoryRoutingRules(*payload.DirectoryRoutingRules)
		if len(rules) > 20 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "directoryRoutingRules must contain at most 20 rules"})
			return
		}
		if err := upsertSetting(r, tx, "directory_routing_rules", rules); err != nil {
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
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, code, display_name, source_type, enabled, config_json
		FROM file_source
		WHERE source_type IN ('kikoeru_compatible', 'kikoeru_compilable_number178')
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
	if source.Enabled {
		go s.runSourceChangeAvailabilityChecks(context.Background(), source.ID, "source_created")
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
	if existingSourceType == sourceTypeLocalFolder || payload.SourceType == sourceTypeLocalFolder {
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
	if source.Enabled {
		go s.runSourceChangeAvailabilityChecks(context.Background(), source.ID, "source_updated")
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
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) listRemoteSourceWorks(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
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
	if !isKikoeruSourceType(source.SourceType) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is not a supported kikoeru source"})
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
	plan := planRemoteSourceQuery(r.URL.Query().Get("q"))
	client := kikoeruClientForSource(source)
	remotePage, err := client.ListWorks(r.Context(), page, pageSize, plan.PushdownQuery)
	if err != nil {
		_ = s.updateSourceHealth(r.Context(), id, "unavailable")
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	_ = s.updateSourceHealth(r.Context(), id, "healthy")
	works, err := s.remoteWorkSummaries(r.Context(), userID, remotePage.Works)
	if err != nil {
		writeError(w, err)
		return
	}
	if len(plan.PostFilterTokens) > 0 {
		works = filterRemoteWorkSummaries(works, plan.PostFilterTokens)
	}
	total := remotePage.Pagination.TotalCount
	if total == 0 {
		total = remotePage.Pagination.Total
	}
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
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
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
	if !isKikoeruSourceType(source.SourceType) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is not a supported kikoeru source"})
		return
	}
	if !source.Enabled {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is disabled"})
		return
	}
	client := kikoeruClientForSource(source)
	remoteWork, _, err := s.resolveKikoeruWork(r.Context(), client, code)
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
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	response, err := s.readWorkSourceAvailability(r.Context(), code)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) checkWorkSourceAvailabilityNow(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return
	}
	var payload sourceAvailabilityCheckRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	response, err := s.checkWorkSourceAvailabilityForSources(r.Context(), code, payload.SourceID, "manual", "work_detail_source_check")
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) checkWorkSourceAvailability(ctx context.Context, code string, triggerType string, triggerReason string) (sourceAvailabilityResponse, error) {
	return s.checkWorkSourceAvailabilityForSources(ctx, code, 0, triggerType, triggerReason)
}

func (s *Server) checkWorkSourceAvailabilityForSources(ctx context.Context, code string, onlySourceID int64, triggerType string, triggerReason string) (sourceAvailabilityResponse, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return sourceAvailabilityResponse{}, err
	}
	checkedAt := time.Now().UTC().Format(time.RFC3339)
	results := make([]sourceAvailabilitySummary, 0, len(sources))
	for _, source := range sources {
		if onlySourceID > 0 && source.ID != onlySourceID {
			continue
		}
		result := sourceAvailabilitySummary{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName, Status: "disabled",
		}
		started := time.Now()
		if !isKikoeruSourceType(source.SourceType) {
			result.Status = "unavailable"
			result.Error = "source is not a supported kikoeru source"
			if err := s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code); err != nil {
				return sourceAvailabilityResponse{}, err
			}
			results = append(results, result)
			continue
		}
		if !source.Enabled {
			if err := s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code); err != nil {
				return sourceAvailabilityResponse{}, err
			}
			results = append(results, result)
			continue
		}
		remoteWork, err := s.checkRemoteWorkAvailability(ctx, source, code)
		result.ElapsedMS = time.Since(started).Milliseconds()
		if err != nil {
			result.Status = "error"
			result.Error = err.Error()
			if isNotFoundLikeError(err) {
				result.Status = "not_found"
			}
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			if err := s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code); err != nil {
				return sourceAvailabilityResponse{}, err
			}
			results = append(results, result)
			continue
		}
		_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		workCode := normalizedRemoteWorkCode(remoteWork)
		if workCode == "" {
			workCode = code
		}
		result.Status = "available"
		result.RemoteID = strconv.FormatInt(remoteWork.ID, 10)
		result.PrimaryCode = workCode
		result.Title = firstNonEmpty(remoteWork.Title, remoteWork.Name, workCode)
		result.CoverURL = firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL)
		if err := s.attachSourceAvailabilityFlags(ctx, &result, source.ID, workCode); err != nil {
			return sourceAvailabilityResponse{}, err
		}
		results = append(results, result)
	}
	runID, err := s.recordSourceAvailabilityWorkflow(ctx, code, checkedAt, results, triggerType, triggerReason)
	if err != nil {
		return sourceAvailabilityResponse{}, err
	}
	return sourceAvailabilityResponse{
		WorkCode: code, CheckedAt: checkedAt, RunID: runID, Sources: results,
	}, nil
}

func (s *Server) readWorkSourceAvailability(ctx context.Context, code string) (sourceAvailabilityResponse, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return sourceAvailabilityResponse{}, err
	}
	checkedAt, err := s.latestSourceAvailabilityCheckedAt(ctx, code)
	if err != nil {
		return sourceAvailabilityResponse{}, err
	}
	results := make([]sourceAvailabilitySummary, 0, len(sources))
	for _, source := range sources {
		result := sourceAvailabilitySummary{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName, Status: "unknown",
		}
		if !isKikoeruSourceType(source.SourceType) {
			result.Status = "unavailable"
			result.Error = "source is not a supported kikoeru source"
		} else if !source.Enabled {
			result.Status = "disabled"
		}
		if err := s.attachCachedSourcePresence(ctx, &result, source.ID, code); err != nil {
			return sourceAvailabilityResponse{}, err
		}
		if err := s.attachSourceAvailabilityFlags(ctx, &result, source.ID, firstNonEmpty(result.PrimaryCode, code)); err != nil {
			return sourceAvailabilityResponse{}, err
		}
		results = append(results, result)
	}
	return sourceAvailabilityResponse{WorkCode: code, CheckedAt: checkedAt, Sources: results}, nil
}

func (s *Server) latestSourceAvailabilityCheckedAt(ctx context.Context, code string) (string, error) {
	var checkedAt sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT MAX(presence.last_checked_at)
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE work.primary_code = ?
			AND presence.presence_type = ?
	`, code, sourcePresenceTypeRemoteSource).Scan(&checkedAt)
	if err != nil {
		return "", err
	}
	if !checkedAt.Valid {
		return "", nil
	}
	return checkedAt.String, nil
}

func (s *Server) attachCachedSourcePresence(ctx context.Context, result *sourceAvailabilitySummary, sourceID int64, workCode string) error {
	var availability, remoteID, rawJSON sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT presence.availability, presence.remote_id, presence.raw_json
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		WHERE work.primary_code = ?
			AND presence.file_source_id = ?
			AND presence.presence_type = ?
	`, workCode, sourceID, sourcePresenceTypeRemoteSource).Scan(&availability, &remoteID, &rawJSON)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	switch availability.String {
	case "available":
		result.Status = "available"
	case "missing":
		result.Status = "not_found"
	case "disabled":
		result.Status = "disabled"
	case "unavailable":
		result.Status = "error"
	case "unknown":
		if result.Status == "" {
			result.Status = "unknown"
		}
	}
	result.RemoteID = remoteID.String
	if rawJSON.Valid {
		var cached struct {
			PrimaryCode string `json:"primary_code"`
			Title       string `json:"title"`
			CoverURL    string `json:"cover_url"`
			Error       string `json:"error"`
			ElapsedMS   int64  `json:"elapsed_ms"`
		}
		if json.Unmarshal([]byte(rawJSON.String), &cached) == nil {
			result.PrimaryCode = cached.PrimaryCode
			result.Title = cached.Title
			result.CoverURL = cached.CoverURL
			result.Error = cached.Error
			result.ElapsedMS = cached.ElapsedMS
		}
	}
	return nil
}

func (s *Server) attachSourceAvailabilityFlags(ctx context.Context, result *sourceAvailabilitySummary, sourceID int64, workCode string) error {
	flags, err := s.sourceAvailabilityFlags(ctx, sourceID, workCode)
	if err != nil {
		return err
	}
	result.WorkID = flags.WorkID
	result.HasRemote = flags.HasRemote
	result.HasCache = flags.HasCache
	result.HasLocal = flags.HasLocal
	return nil
}

func (s *Server) planRemoteSourceWorkSave(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	sourceID, code, payload, ok := parseRemoteWorkSaveRequest(w, r)
	if !ok {
		return
	}
	plan, err := s.buildRemoteWorkSavePlan(r.Context(), sourceID, code, payload.Paths, payload.LocalPaths)
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
	result, err := s.enqueueRemoteWorkSave(context.WithoutCancel(r.Context()), sourceID, code, payload.Paths, payload.LocalPaths)
	if err != nil {
		var conflict remoteWorkSaveConflictError
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "summary": conflict.Summary})
			return
		}
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
	code := remoteWorkCodeFromPath(r)
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

func (s *Server) untrackWorkSource(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil || workID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	sourceID, err := parseInt64PathValue(r, "sourceId")
	if err != nil || sourceID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	result, err := s.runWorkSourceUntrack(r.Context(), workID, sourceID)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, result)
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
	code := remoteWorkCodeFromPath(r)
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
	cacheResult, err := s.enqueueRemoteMediaCache(r.Context(), locationID)
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
		WHERE source.source_type IN ('kikoeru_compatible', 'kikoeru_compilable_number178')
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
	client := kikoeruClientForSource(source)
	remoteWork, _, err := s.resolveKikoeruWork(ctx, client, code)
	return remoteWork, err
}

type sourceAvailabilityState struct {
	WorkID    *int64
	HasRemote bool
	HasCache  bool
	HasLocal  bool
}

type workSourcePresence struct {
	WorkID       int64
	FileSourceID int64
	PresenceType string
	RemoteID     string
	SourceURL    string
	Availability string
	RawJSON      string
}

const sourcePresenceTypeRemoteSource = "source"

func upsertWorkSourcePresence(ctx context.Context, tx *sql.Tx, presence workSourcePresence) error {
	presence.PresenceType = strings.TrimSpace(presence.PresenceType)
	if presence.PresenceType == "" {
		presence.PresenceType = "location"
	}
	presence.Availability = strings.TrimSpace(presence.Availability)
	if presence.Availability == "" {
		presence.Availability = "unknown"
	}
	presence.RawJSON = strings.TrimSpace(presence.RawJSON)
	if presence.RawJSON == "" {
		presence.RawJSON = "{}"
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO work_source_presence (
			work_id,
			file_source_id,
			presence_type,
			remote_id,
			source_url,
			availability,
			raw_json,
			last_seen_at,
			last_checked_at,
			updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, file_source_id, presence_type) DO UPDATE SET
			remote_id = excluded.remote_id,
			source_url = excluded.source_url,
			availability = excluded.availability,
			raw_json = excluded.raw_json,
			last_seen_at = CASE
				WHEN excluded.availability = 'available' THEN excluded.last_seen_at
				ELSE work_source_presence.last_seen_at
			END,
			last_checked_at = excluded.last_checked_at,
			updated_at = CURRENT_TIMESTAMP
	`, presence.WorkID, presence.FileSourceID, presence.PresenceType, presence.RemoteID, presence.SourceURL, presence.Availability, presence.RawJSON)
	return err
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
	if !flags.HasRemote {
		flags.HasRemote = s.workHasSourcePresence(ctx, workID.Int64, sourceID, sourcePresenceTypeRemoteSource, "available")
	}
	flags.HasCache = s.workHasLocationType(ctx, workID.Int64, sourceID, "cache")
	flags.HasLocal = s.workHasLocationType(ctx, workID.Int64, 0, "local")
	if !flags.HasLocal {
		flags.HasLocal = s.workHasSourcePresence(ctx, workID.Int64, 0, "local", "available")
	}
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

func (s *Server) workHasSourcePresence(ctx context.Context, workID int64, sourceID int64, presenceType string, availability string) bool {
	query := `
		SELECT 1
		FROM work_source_presence
		WHERE work_id = ?
			AND presence_type = ?
			AND availability = ?
	`
	args := []any{workID, presenceType, availability}
	if sourceID > 0 {
		query += " AND file_source_id = ?"
		args = append(args, sourceID)
	}
	query += " LIMIT 1"
	var found int
	return s.db.QueryRowContext(ctx, query, args...).Scan(&found) == nil
}

func (s *Server) recordSourceAvailabilityWorkflow(ctx context.Context, code string, checkedAt string, results []sourceAvailabilitySummary, triggerType string, triggerReason string) (int64, error) {
	triggerType = strings.TrimSpace(triggerType)
	if triggerType == "" {
		triggerType = "manual"
	}
	triggerReason = strings.TrimSpace(triggerReason)
	if triggerReason == "" {
		triggerReason = "source_availability_check"
	}
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
	if err := s.recordAvailabilityPresence(ctx, tx, code, results); err != nil {
		return 0, err
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "source_availability_check", "Check source availability", "succeeded", triggerType, triggerReason, input, summary)
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

func (s *Server) recordAvailabilityPresence(ctx context.Context, tx *sql.Tx, code string, results []sourceAvailabilitySummary) error {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return nil
	}
	var workID int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	for _, result := range results {
		if result.SourceID <= 0 {
			continue
		}
		availability := "unknown"
		switch result.Status {
		case "available":
			availability = "available"
		case "not_found":
			availability = "missing"
		case "disabled":
			availability = "disabled"
		case "error", "unavailable":
			availability = "unavailable"
		}
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID:       workID,
			FileSourceID: result.SourceID,
			PresenceType: sourcePresenceTypeRemoteSource,
			RemoteID:     result.RemoteID,
			Availability: availability,
			RawJSON: mustJSON(map[string]any{
				"status":       result.Status,
				"primary_code": result.PrimaryCode,
				"title":        result.Title,
				"cover_url":    result.CoverURL,
				"error":        result.Error,
				"elapsed_ms":   result.ElapsedMS,
			}),
		}); err != nil {
			return err
		}
	}
	return nil
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

type remoteSourceQueryPlan struct {
	PushdownQuery    string
	PushdownToken    *listSearchToken
	PostFilterTokens []listSearchToken
}

func planRemoteSourceQuery(query string) remoteSourceQueryPlan {
	tokens := parseListSearchTokens(query)
	if len(tokens) == 0 {
		return remoteSourceQueryPlan{}
	}
	pushdownIndex := -1
	bestRank := 999
	for index, token := range tokens {
		rank := remoteSourcePushdownRank(token)
		if rank < bestRank {
			bestRank = rank
			pushdownIndex = index
		}
	}
	plan := remoteSourceQueryPlan{}
	for index, token := range tokens {
		if index == pushdownIndex {
			pushdown := remoteSourcePushdownQuery(token)
			if pushdown != "" {
				plan.PushdownQuery = pushdown
				copyToken := token
				plan.PushdownToken = &copyToken
				continue
			}
		}
		plan.PostFilterTokens = append(plan.PostFilterTokens, token)
	}
	return plan
}

func remoteSourcePushdownRank(token listSearchToken) int {
	switch token.Kind {
	case "code":
		return 1
	case "circle", "voice_actor", "tag":
		return 2
	case "text":
		return 3
	case "rating_min", "sales_min", "duration_min", "duration_max", "age", "language":
		return 4
	default:
		return 999
	}
}

func remoteSourcePushdownQuery(token listSearchToken) string {
	switch token.Kind {
	case "circle":
		return "$circle:" + token.Value + "$"
	case "voice_actor":
		return "$va:" + token.Value + "$"
	case "tag":
		return "$tag:" + token.Value + "$"
	case "rating_min":
		return "$rate:" + token.Value + "$"
	case "sales_min":
		return "$sell:" + token.Value + "$"
	case "duration_min":
		return "$duration:" + token.Value + "$"
	case "duration_max":
		return "$-duration:" + token.Value + "$"
	case "age":
		return "$age:" + token.Value + "$"
	case "language":
		return "$lang:" + token.Value + "$"
	case "code", "text":
		return token.Value
	default:
		return ""
	}
}

func filterRemoteWorkSummaries(works []remoteWorkSummary, tokens []listSearchToken) []remoteWorkSummary {
	result := make([]remoteWorkSummary, 0, len(works))
	for _, work := range works {
		if remoteWorkSummaryMatchesTokens(work, tokens) {
			result = append(result, work)
		}
	}
	return result
}

func remoteWorkSummaryMatchesTokens(work remoteWorkSummary, tokens []listSearchToken) bool {
	for _, token := range tokens {
		if !remoteWorkSummaryMatchesToken(work, token) {
			return false
		}
	}
	return true
}

func remoteWorkSummaryMatchesToken(work remoteWorkSummary, token listSearchToken) bool {
	needle := strings.ToLower(strings.TrimSpace(token.Value))
	if needle == "" {
		return true
	}
	switch token.Kind {
	case "code":
		return strings.Contains(strings.ToLower(work.PrimaryCode), needle) || strings.Contains(strings.ToLower(work.RemoteID), needle)
	case "circle":
		return strings.Contains(strings.ToLower(work.Circle), needle)
	case "tag":
		return stringSliceContainsSubstringFold(work.Tags, needle)
	case "exclude_tag":
		return !stringSliceContainsSubstringFold(work.Tags, needle)
	case "rating_min":
		return work.Rating != nil && *work.Rating >= numericListTokenValue(needle)
	case "sales_min":
		return work.Sales != nil && float64(*work.Sales) >= numericListTokenValue(needle)
	case "voice_actor", "duration_min", "duration_max", "age", "language":
		return true
	default:
		return stringSliceContainsSubstringFold([]string{work.PrimaryCode, work.RemoteID, work.Title, work.Circle, work.ReleaseDate}, needle) ||
			stringSliceContainsSubstringFold(work.Tags, needle)
	}
}

func (s *Server) remoteWorkSummaries(ctx context.Context, userID int64, works []kikoeru.Work) ([]remoteWorkSummary, error) {
	result := make([]remoteWorkSummary, 0, len(works))
	for _, work := range works {
		code := normalizedRemoteWorkCode(work)
		var workID sql.NullInt64
		var favorite bool
		if code != "" {
			if err := s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE primary_code = ?", code).Scan(&workID); err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, err
			}
			if workID.Valid {
				var favoriteInt int
				if err := s.db.QueryRowContext(ctx, `
					SELECT COALESCE(favorite, 0)
					FROM user_work_state
					WHERE user_id = ? AND work_id = ?
				`, userID, workID.Int64).Scan(&favoriteInt); err != nil && !errors.Is(err, sql.ErrNoRows) {
					return nil, err
				} else if err == nil {
					favorite = favoriteInt != 0
				}
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
			Favorite:       favorite,
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
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return remoteWorkSyncResult{}, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := kikoeruClientForSource(source)
	remoteWork, rawWork, err := s.resolveKikoeruWork(ctx, client, code)
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

	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_source_sync", "Track remote source", "Discover remote works, filter candidates, match works, and track remote metadata.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "discover", "type": "discover_remote_works"},
			{"id": "filter", "type": "filter_candidates"},
			{"id": "match", "type": "match_works"},
			{"id": "metadata", "type": "sync_metadata"},
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
	runSummary := map[string]any{"remote_work_id": remoteWork.ID, "tracked": true}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_source_sync", "Track remote source", "succeeded", "manual", triggerReason, runInput, runSummary)
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
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: "tracked",
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		SourceURL:    remoteWork.SourceURL,
		Availability: "available",
		RawJSON:      string(rawWork),
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := s.downloadRemoteCover(ctx, workCode, firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL)); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Discover remote works", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"remote_work_id": remoteWork.ID},
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
		Input: map[string]any{"work_id": workID}, Output: map[string]any{"snapshot_bytes": len(rawWork)},
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
		SyncedMediaItems: 0,
		SyncedLocations:  0,
		TriggerReason:    triggerReason,
	}, nil
}

func (s *Server) runWorkSourceUntrack(ctx context.Context, workID int64, sourceID int64) (workSourceUntrackResult, error) {
	var found int
	if err := s.db.QueryRowContext(ctx, `
		SELECT 1
		FROM work_source_presence
		WHERE work_id = ?
			AND file_source_id = ?
			AND presence_type = 'tracked'
			AND availability = 'available'
		LIMIT 1
	`, workID, sourceID).Scan(&found); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return workSourceUntrackResult{}, fmt.Errorf("tracked source not found")
		}
		return workSourceUntrackResult{}, err
	}

	cacheLocations, err := s.cacheLocationsForWorkSource(ctx, workID, sourceID)
	if err != nil {
		return workSourceUntrackResult{}, err
	}
	deletedFiles := 0
	cachePaths := make([]string, 0, len(cacheLocations))
	for _, location := range cacheLocations {
		cachePaths = append(cachePaths, location.Path)
		targetPath, err := safeCachePath(s.cfg.CacheRoot, location.Path)
		if err != nil {
			return workSourceUntrackResult{}, err
		}
		if err := os.Remove(targetPath); err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				return workSourceUntrackResult{}, err
			}
			continue
		}
		deletedFiles++
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workSourceUntrackResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ?
			AND file_source_id = ?
			AND presence_type = 'tracked'
	`, workID, sourceID); err != nil {
		return workSourceUntrackResult{}, err
	}
	for _, location := range cacheLocations {
		if _, err := tx.ExecContext(ctx, `
			UPDATE media_file_location
			SET availability = 'unavailable',
				last_checked_at = CURRENT_TIMESTAMP
			WHERE id = ?
				AND location_type = 'cache'
		`, location.ID); err != nil {
			return workSourceUntrackResult{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return workSourceUntrackResult{}, err
	}
	return workSourceUntrackResult{
		WorkID:         workID,
		SourceID:       sourceID,
		Status:         "succeeded",
		ClearedCaches:  len(cacheLocations),
		DeletedFiles:   deletedFiles,
		CachePaths:     cachePaths,
		TrackedCleared: true,
		WorkPreserved:  true,
		LocalPreserved: true,
	}, nil
}

type cacheLocationForCleanup struct {
	ID   int64
	Path string
}

func (s *Server) cacheLocationsForWorkSource(ctx context.Context, workID int64, sourceID int64) ([]cacheLocationForCleanup, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'cache'
			AND location.availability = 'available'
		ORDER BY location.id ASC
	`, workID, sourceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	locations := []cacheLocationForCleanup{}
	for rows.Next() {
		var location cacheLocationForCleanup
		if err := rows.Scan(&location.ID, &location.Path); err != nil {
			return nil, err
		}
		locations = append(locations, location)
	}
	return locations, rows.Err()
}

func (s *Server) runRemotePopularWorkflow(ctx context.Context, payload remoteCollectionRunRequest) (remoteCollectionRunResult, error) {
	action := normalizeRemoteCollectionAction(payload.Action)
	if action == "" {
		return remoteCollectionRunResult{}, fmt.Errorf("action must be track or fetch")
	}
	source, err := s.remoteCollectionSource(ctx, payload.SourceID)
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return remoteCollectionRunResult{}, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return remoteCollectionRunResult{}, fmt.Errorf("source has no API endpoint")
	}
	limit := payload.Limit
	if limit <= 0 || limit > 100 {
		limit = 100
	}
	page, err := kikoeruClientForSource(source).PopularWorks(ctx, 1, limit)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		return remoteCollectionRunResult{}, err
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	candidates := uniqueRemoteCollectionWorks(page.Works, limit)
	expectedMaximum := 100
	result := remoteCollectionRunResult{
		SourceID:        source.ID,
		CollectionKind:  "popular",
		Action:          action,
		Status:          "succeeded",
		Discovered:      len(page.Works),
		Accepted:        len(candidates),
		ExpectedMaximum: expectedMaximum,
		ReturnedCount:   len(page.Works),
		ChildRuns:       []int64{},
		Failures:        []string{},
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_popular_collection", "Run popular remote collection", "Discover popular works from a configured compatible source, then track or fetch accepted works.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "discover", "type": "discover_remote_collection"},
			{"id": "filter", "type": "filter_candidates"},
			{"id": "dispatch", "type": "dispatch_child_workflows"},
		},
	})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	input := map[string]any{"source_id": source.ID, "collection_kind": "popular", "action": action, "limit": limit}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_popular_collection", "Run popular remote collection", "running", "manual", action, input, map[string]any{"source_id": source.ID, "collection_kind": "popular", "action": action, "expected_maximum": expectedMaximum})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	result.RunID = runID
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"source_id": source.ID, "source_code": source.Code},
	}); err != nil {
		return remoteCollectionRunResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_collection", DisplayName: "Discover popular works", Position: 2, Status: "succeeded",
		Input: map[string]any{"collection_kind": "popular", "page": 1, "page_size": limit}, Output: map[string]any{"returned": len(page.Works), "accepted": len(candidates), "pagination": page.Pagination},
	}); err != nil {
		return remoteCollectionRunResult{}, err
	}
	dispatchNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "dispatch", NodeType: "dispatch_child_workflows", DisplayName: "Dispatch accepted works", Position: 4, Status: "running",
		Input: map[string]any{"action": action, "works": len(candidates)}, Output: nil,
	})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: dispatchNodeID, WorkerType: "remote_popular_collection", Status: "running", Payload: input, ProgressCurrent: 0, ProgressTotal: len(candidates),
	})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteCollectionRunResult{}, err
	}

	for index, work := range candidates {
		code := normalizedRemoteWorkCode(work)
		if code == "" {
			result.Skipped++
			result.Failures = append(result.Failures, "remote work missing stable code")
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(candidates))
			continue
		}
		if action == "track" {
			workID, err := s.trackRemoteCollectionWork(ctx, source, work, "popular", runID)
			if err != nil {
				result.Failed++
				result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, err.Error()))
			} else if workID > 0 {
				result.Tracked++
			}
		} else {
			fetchResult, err := s.runRemoteWorkSave(ctx, source.ID, code, []string{})
			if err != nil {
				result.Failed++
				result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", code, err.Error()))
			} else {
				result.Fetched++
				result.ChildRuns = append(result.ChildRuns, fetchResult.RunID)
			}
		}
		_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(candidates))
	}
	result.Status = "succeeded"
	if result.Failed > 0 {
		result.Status = "partial"
	}
	if err := s.finishRemoteCollectionWorkflow(ctx, runID, dispatchNodeID, jobID, result); err != nil {
		return remoteCollectionRunResult{}, err
	}
	return result, nil
}

func (s *Server) remoteCollectionSource(ctx context.Context, sourceID int64) (remoteSourceForUse, error) {
	if sourceID > 0 {
		source, err := s.loadRemoteSourceForUse(ctx, sourceID)
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, fmt.Errorf("source not found")
		}
		return source, err
	}
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return remoteSourceForUse{}, err
	}
	for _, source := range sources {
		if isKikoeruSourceType(source.SourceType) && source.Enabled && strings.TrimSpace(source.Endpoint.APIURL) != "" {
			return source, nil
		}
	}
	return remoteSourceForUse{}, fmt.Errorf("no enabled kikoeru-compatible source is configured")
}

func normalizeRemoteCollectionAction(action string) string {
	switch strings.TrimSpace(action) {
	case "", "track", "tracked":
		return "track"
	case "fetch", "local":
		return "fetch"
	default:
		return ""
	}
}

func uniqueRemoteCollectionWorks(works []kikoeru.Work, limit int) []kikoeru.Work {
	result := make([]kikoeru.Work, 0, len(works))
	seen := map[string]bool{}
	for _, work := range works {
		code := normalizedRemoteWorkCode(work)
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		result = append(result, work)
		if limit > 0 && len(result) >= limit {
			break
		}
	}
	return result
}

func (s *Server) trackRemoteCollectionWork(ctx context.Context, source remoteSourceForUse, remoteWork kikoeru.Work, collectionKind string, runID int64) (int64, error) {
	rawWork, _ := json.Marshal(remoteWork)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, rawWork)
	if err != nil {
		return 0, err
	}
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: "tracked",
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		SourceURL:    remoteWork.SourceURL,
		Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"collection_kind": collectionKind,
			"primary_code":    normalizedRemoteWorkCode(remoteWork),
			"remote_work_id":  remoteWork.ID,
		}),
	}); err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'remote_work', ?, 'accepted', ?)
	`, runID, normalizedRemoteWorkCode(remoteWork), mustJSON(map[string]any{"collection_kind": collectionKind, "remote_work_id": remoteWork.ID})); err != nil {
		return 0, err
	}
	return workID, tx.Commit()
}

func (s *Server) finishRemoteCollectionWorkflow(ctx context.Context, runID int64, dispatchNodeID int64, jobID int64, result remoteCollectionRunResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, mustJSON(result), dispatchNodeID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, result.Accepted, result.Accepted, strings.Join(result.Failures, "\n"), jobID); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter collection candidates", Position: 3, Status: "succeeded",
		Input: map[string]any{"discovered": result.Discovered}, Output: map[string]any{"accepted": result.Accepted, "skipped": result.Skipped},
	}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, mustJSON(result), runID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) buildRemoteWorkSavePlan(ctx context.Context, sourceID int64, code string, selectedPaths []string, selectedLocalPaths []string) (remoteWorkSavePlan, error) {
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
	selectedLocal := normalizeSelectedLocalPaths(selectedLocalPaths)
	files := flattenRemoteSaveFiles(tracks)
	locationState, err := s.remoteTrackLocationState(ctx, source.ID, workCode)
	if err != nil {
		return remoteWorkSavePlan{}, err
	}
	items := make([]remoteWorkSavePlanItem, 0, len(files))
	seenTargets := map[string]string{}
	for _, file := range files {
		if len(selected) == 0 && len(selectedLocal) > 0 {
			continue
		}
		if len(selected) > 0 && !selectedRemotePathMatches(selected, file.Path) {
			continue
		}
		targetRelPath := joinRemotePath(saveRoot, file.Path)
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, targetRelPath)
		if err != nil {
			return remoteWorkSavePlan{}, err
		}
		cacheRelPath := cacheMediaRelPath(source.Code, workCode, file.Path)
		item := remoteWorkSavePlanItem{
			Path:       file.Path,
			Kind:       file.Kind,
			SizeBytes:  file.SizeBytes,
			SourceKind: "remote",
			SourcePath: firstNonEmpty(file.DownloadURL, file.StreamURL),
			CachePath:  cacheRelPath,
			TargetPath: filepath.ToSlash(targetRelPath),
			LocalPaths: []string{},
		}
		if state, ok := locationState.localForRemotePath(file.Path); ok {
			item.LocalPaths = append(item.LocalPaths, state.Path)
		}
		if info, err := os.Stat(targetAbsPath); err == nil {
			if info.IsDir() {
				item.TargetExists = true
				item.TargetConflict = true
				item.TargetConflictReason = "target is a directory"
				item.Action = "conflict"
				item.Status = "target_conflict"
			} else {
				size := info.Size()
				item.TargetExists = true
				item.TargetSizeBytes = &size
				if file.SizeBytes == nil || size == *file.SizeBytes {
					item.Action = "skip"
					item.Status = "local_exists"
				} else {
					item.TargetConflict = true
					item.TargetConflictReason = "target exists with a different size"
					item.Action = "conflict"
					item.Status = "target_conflict"
				}
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			item.TargetConflict = true
			item.TargetConflictReason = err.Error()
			item.Action = "conflict"
			item.Status = "target_conflict"
		}
		if previous, exists := seenTargets[item.TargetPath]; exists && !item.TargetConflict {
			item.TargetConflict = true
			item.TargetConflictReason = "multiple remote files resolve to the same target path: " + previous
			item.Action = "conflict"
			item.Status = "duplicate_target"
		} else {
			seenTargets[item.TargetPath] = file.Path
		}
		if item.Action != "" {
			items = append(items, item)
			continue
		}
		if existingFileMatches(targetAbsPath, file.SizeBytes) {
			item.Action = "skip"
			item.Status = "local_exists"
		} else if cachePath, ok := s.findRemoteCacheFile(ctx, source.ID, source.Code, workCode, file.Path, file.SizeBytes); ok {
			item.Action = "cache_hit"
			item.Status = "cache_hit"
			item.CachePath = filepath.ToSlash(cachePath)
		} else {
			item.Action = "cache_download"
			item.Status = "remote_only"
		}
		items = append(items, item)
	}
	localFiles := remoteWorkSaveLocalFiles(locationState)
	for _, localFile := range localFiles {
		if len(selectedLocal) == 0 {
			continue
		}
		if len(selectedLocal) > 0 && !selectedLocalPathMatches(selectedLocal, localFile.Path) {
			continue
		}
		targetRelPath := joinRemotePath(saveRoot, trimLocalPathToWorkRoot(localFile.Path, localFiles))
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, targetRelPath)
		if err != nil {
			return remoteWorkSavePlan{}, err
		}
		item := remoteWorkSavePlanItem{
			Path:            trimLocalPathToWorkRoot(localFile.Path, localFiles),
			Kind:            mediaKindFromPath(localFile.Path),
			SizeBytes:       localFile.SizeBytes,
			SourceKind:      "local",
			LocalSourcePath: localFile.Path,
			TargetPath:      filepath.ToSlash(targetRelPath),
			MediaItemID:     localFile.MediaItemID,
			LocalPaths:      []string{localFile.Path},
		}
		if info, err := os.Stat(targetAbsPath); err == nil {
			if info.IsDir() {
				item.TargetExists = true
				item.TargetConflict = true
				item.TargetConflictReason = "target is a directory"
				item.Action = "conflict"
				item.Status = "target_conflict"
			} else {
				size := info.Size()
				item.TargetExists = true
				item.TargetSizeBytes = &size
				if filepath.ToSlash(localFile.Path) == item.TargetPath {
					item.Action = "skip"
					item.Status = "local_source_already_target"
				} else {
					item.TargetConflict = true
					item.TargetConflictReason = "target exists"
					item.Action = "conflict"
					item.Status = "target_conflict"
				}
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			item.TargetConflict = true
			item.TargetConflictReason = err.Error()
			item.Action = "conflict"
			item.Status = "target_conflict"
		}
		if previous, exists := seenTargets[item.TargetPath]; exists && !item.TargetConflict {
			item.TargetConflict = true
			item.TargetConflictReason = "multiple selected files resolve to the same target path: " + previous
			item.Action = "conflict"
			item.Status = "duplicate_target"
		} else {
			seenTargets[item.TargetPath] = localFile.Path
		}
		if item.Action == "" {
			item.Action = "copy_local"
			item.Status = "copy_local"
		}
		items = append(items, item)
	}
	plan := remoteWorkSavePlan{
		SourceID:    source.ID,
		PrimaryCode: workCode,
		SaveRoot:    saveRoot,
		LocalFiles:  localFiles,
		Items:       items,
	}
	plan.Summary = summarizeRemoteSavePlan(items)
	return plan, nil
}

func (s *Server) enqueueRemoteWorkSave(ctx context.Context, sourceID int64, code string, selectedPaths []string, selectedLocalPaths []string) (remoteWorkSaveResult, error) {
	source, remoteWork, tracks, err := s.loadRemoteWorkTracks(ctx, sourceID, code)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = strings.ToUpper(strings.TrimSpace(code))
	}
	plan, err := s.buildRemoteWorkSavePlan(ctx, sourceID, workCode, selectedPaths, selectedLocalPaths)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if plan.Summary.Conflict > 0 {
		return remoteWorkSaveResult{}, remoteWorkSaveConflictError{Summary: plan.Summary}
	}
	rawWork, _ := json.Marshal(remoteWork)
	rawTracks, _ := json.Marshal(tracks)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_work_fetch", "Fetch remote work", "Select remote files, cache them, promote cache files to the local library, and sync local locations.", remoteWorkFetchDefinition())
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	runInput := remoteWorkFetchJobPayload{SourceID: sourceID, WorkCode: workCode, Paths: selectedPaths, LocalPaths: selectedLocalPaths}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_work_fetch", "Fetch remote work", "queued", "manual", "fetch_selected", runInput, map[string]any{"plan": plan.Summary})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: runInput, Output: map[string]any{"source_id": sourceID, "work_code": workCode},
	}); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "tree", NodeType: "fetch_remote_tree", DisplayName: "Fetch remote tree", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"tracks": len(tracks), "snapshot_bytes": len(rawWork) + len(rawTracks)},
	}); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "plan", NodeType: "plan_save", DisplayName: "Plan save", Position: 3, Status: "succeeded",
		Input: map[string]any{"paths": selectedPaths, "local_paths": selectedLocalPaths}, Output: plan,
	}); err != nil {
		return remoteWorkSaveResult{}, err
	}
	cacheNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cache", NodeType: "materialize_cache", DisplayName: "Cache selected files", Position: 4, Status: "queued",
		Input: map[string]any{"items": len(plan.Items)}, Output: nil,
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "promote", NodeType: "promote_cache_to_local", DisplayName: "Move cache files to local library", Position: 5, Status: "queued",
		Input: map[string]any{"items": len(plan.Items)}, Output: nil,
	}); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync fetched locations", Position: 6, Status: "queued",
		Input: map[string]any{"items": len(plan.Items)}, Output: nil,
	}); err != nil {
		return remoteWorkSaveResult{}, err
	}
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, rawWork)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, _, err := syncRemoteTrackTree(ctx, tx, source.ID, workID, workCode, tracks); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.upsertLocalFileSource(ctx, tx, s.configuredLocalScanDepth(ctx)); err != nil {
		return remoteWorkSaveResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: cacheNodeID, WorkerType: "remote_work_fetch", Status: "queued", Payload: runInput, ProgressCurrent: 0, ProgressTotal: len(plan.Items) * 2,
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkSaveResult{}, err
	}
	return remoteWorkSaveResult{
		RunID:       runID,
		JobID:       jobID,
		WorkID:      workID,
		PrimaryCode: workCode,
		Status:      "queued",
		SaveRoot:    plan.SaveRoot,
		Plan:        plan.Summary,
	}, nil
}

func remoteWorkFetchDefinition() map[string]any {
	return map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "tree", "type": "fetch_remote_tree"},
			{"id": "plan", "type": "plan_save"},
			{"id": "cache", "type": "materialize_cache"},
			{"id": "promote", "type": "promote_cache_to_local"},
			{"id": "sync", "type": "sync_file_locations"},
		},
	}
}

func (s *Server) executeRemoteWorkFetchJob(ctx context.Context, job workflowJobRecord) error {
	var payload remoteWorkFetchJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, err := s.runRemoteWorkFetchJob(ctx, job.RunID, job.ID, payload.SourceID, payload.WorkCode, payload.Paths, payload.LocalPaths)
	if err != nil {
		slog.Error("remote work fetch job failed", "run_id", job.RunID, "job_id", job.ID, "error", err)
		return err
	}
	slog.Info("remote work fetch job completed", "run_id", result.RunID, "job_id", result.JobID, "work_code", result.PrimaryCode)
	return nil
}

func (s *Server) runRemoteWorkFetchJob(ctx context.Context, runID int64, jobID int64, sourceID int64, code string, selectedPaths []string, selectedLocalPaths []string) (remoteWorkSaveResult, error) {
	source, remoteWork, tracks, err := s.loadRemoteWorkTracks(ctx, sourceID, code)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, workflowJobRecord{ID: jobID, RunID: runID}, err.Error())
		return remoteWorkSaveResult{}, err
	}
	workCode := normalizedRemoteWorkCode(remoteWork)
	if workCode == "" {
		workCode = strings.ToUpper(strings.TrimSpace(code))
	}
	plan, err := s.buildRemoteWorkSavePlan(ctx, sourceID, workCode, selectedPaths, selectedLocalPaths)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, workflowJobRecord{ID: jobID, RunID: runID}, err.Error())
		return remoteWorkSaveResult{}, err
	}
	if plan.Summary.Conflict > 0 {
		err := remoteWorkSaveConflictError{Summary: plan.Summary}
		_ = s.failClaimedWorkflowJob(ctx, workflowJobRecord{ID: jobID, RunID: runID}, err.Error())
		return remoteWorkSaveResult{}, err
	}
	rawWork, _ := json.Marshal(remoteWork)
	rawTracks, _ := json.Marshal(tracks)
	workID, localSourceID, cacheNodeID, promoteNodeID, syncNodeID, err := s.prepareRemoteWorkFetchJob(ctx, runID, source, remoteWork, tracks, rawWork, workCode)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, workflowJobRecord{ID: jobID, RunID: runID}, err.Error())
		return remoteWorkSaveResult{}, err
	}

	skipped, cacheHits, cacheDownloads := 0, 0, 0
	for index, item := range plan.Items {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "skip" {
			skipped++
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items)*2)
			continue
		}
		if item.Action == "copy_local" {
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items)*2)
			continue
		}
		cacheAbsPath, err := safeCachePath(s.cfg.CacheRoot, item.CachePath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "cache_hit" {
			cacheHits++
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items)*2)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(cacheAbsPath), 0o755); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		written, err := s.downloadToFile(ctx, item.SourcePath, cacheAbsPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		mediaItemID, err := s.mediaItemIDForRemotePath(ctx, workID, item.Path)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		cacheLocationID, err := s.upsertCacheLocation(ctx, mediaItemID, source.ID, item.CachePath, "", item.SizeBytes, nil, written)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		_, _ = s.runCacheLimitCleanup(ctx, source.ID, cacheLocationID)
		cacheDownloads++
		_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items)*2)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"skipped": skipped, "cache_hits": cacheHits, "cache_downloads": cacheDownloads}), cacheNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", promoteNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	promoted := 0
	for index, item := range plan.Items {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "skip" {
			continue
		}
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if existingFileMatches(targetAbsPath, item.SizeBytes) {
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, len(plan.Items)+index+1, len(plan.Items)*2)
			continue
		}
		if info, err := os.Stat(targetAbsPath); err == nil {
			reason := fmt.Sprintf("target already exists with size %d: %s", info.Size(), item.TargetPath)
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", reason, len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, errors.New(reason)
		} else if !errors.Is(err, os.ErrNotExist) {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if err := os.MkdirAll(filepath.Dir(targetAbsPath), 0o755); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "copy_local" {
			localAbsPath, err := safeDataPath(s.cfg.DataRoot, item.LocalSourcePath)
			if err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
				return remoteWorkSaveResult{}, err
			}
			if err := copyFile(localAbsPath, targetAbsPath); err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
				return remoteWorkSaveResult{}, err
			}
		} else {
			cacheAbsPath, err := safeCachePath(s.cfg.CacheRoot, item.CachePath)
			if err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
				return remoteWorkSaveResult{}, err
			}
			if err := moveFile(cacheAbsPath, targetAbsPath); err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
				return remoteWorkSaveResult{}, err
			}
			if err := s.markCacheLocationUnavailable(ctx, source.ID, item.CachePath); err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
				return remoteWorkSaveResult{}, err
			}
		}
		promoted++
		_ = updateWorkflowJobProgress(ctx, s.db, jobID, len(plan.Items)+index+1, len(plan.Items)*2)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"promoted": promoted}), promoteNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_job SET progress_current = ?, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", len(plan.Items)*2, len(plan.Items)*2, jobID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", syncNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	syncedLocations := 0
	for index, item := range plan.Items {
		if err := s.ensureWorkflowRunActive(ctx, runID); err != nil {
			return remoteWorkSaveResult{}, err
		}
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if _, err := os.Stat(targetAbsPath); err != nil {
			if item.Action == "skip" && errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
				return remoteWorkSaveResult{}, err
			}
		}
		if err := s.upsertSavedLocalLocation(ctx, workID, localSourceID, item, targetAbsPath); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		syncedLocations++
	}
	if err := s.finishFetchPresence(ctx, workID, source.ID, localSourceID, workCode); err != nil {
		_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)*2, len(plan.Items)*2, plan.Summary)
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"locations": syncedLocations}), syncNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'succeeded',
			progress_current = ?,
			progress_total = ?,
			locked_by = '',
			locked_at = NULL,
			heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, len(plan.Items)*2, len(plan.Items)*2, jobID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"plan": plan.Summary, "skipped": skipped, "cache_hits": cacheHits, "cache_downloads": cacheDownloads, "promoted": promoted, "snapshot_bytes": len(rawWork) + len(rawTracks)}), runID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if err := s.insertFetchCleanupCandidate(ctx, runID, workID, localSourceID, workCode, plan.Items); err != nil {
		return remoteWorkSaveResult{}, err
	}
	return remoteWorkSaveResult{
		RunID:         runID,
		JobID:         jobID,
		WorkID:        workID,
		PrimaryCode:   workCode,
		Status:        "succeeded",
		SaveRoot:      plan.SaveRoot,
		SavedFiles:    promoted,
		SkippedFiles:  skipped,
		CachedFiles:   cacheHits + cacheDownloads,
		PromotedFiles: promoted,
		Plan:          plan.Summary,
	}, nil
}

func (s *Server) prepareRemoteWorkFetchJob(ctx context.Context, runID int64, source remoteSourceForUse, remoteWork kikoeru.Work, tracks []kikoeru.Track, rawWork []byte, workCode string) (int64, int64, int64, int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, 0, 0, 0, err
	}
	defer func() { _ = tx.Rollback() }()
	workCode = strings.ToUpper(strings.TrimSpace(workCode))
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, rawWork)
	if err != nil {
		return 0, 0, 0, 0, 0, err
	}
	if _, _, err := syncRemoteTrackTree(ctx, tx, source.ID, workID, workCode, tracks); err != nil {
		return 0, 0, 0, 0, 0, err
	}
	localSourceID, err := s.upsertLocalFileSource(ctx, tx, s.configuredLocalScanDepth(ctx))
	if err != nil {
		return 0, 0, 0, 0, 0, err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, tx, runID)
	if err != nil {
		return 0, 0, 0, 0, 0, err
	}
	cacheNodeID := nodeIDs["cache"]
	promoteNodeID := nodeIDs["promote"]
	syncNodeID := nodeIDs["sync"]
	if cacheNodeID == 0 || promoteNodeID == 0 || syncNodeID == 0 {
		return 0, 0, 0, 0, 0, fmt.Errorf("remote fetch workflow nodes are incomplete")
	}
	return workID, localSourceID, cacheNodeID, promoteNodeID, syncNodeID, tx.Commit()
}

func workflowNodeIDsByNodeID(ctx context.Context, tx *sql.Tx, runID int64) (map[string]int64, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT node_id, id
		FROM workflow_node_run
		WHERE workflow_run_id = ?
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]int64{}
	for rows.Next() {
		var nodeID string
		var id int64
		if err := rows.Scan(&nodeID, &id); err != nil {
			return nil, err
		}
		result[nodeID] = id
	}
	return result, rows.Err()
}

func (s *Server) ensureWorkflowRunActive(ctx context.Context, runID int64) error {
	var status string
	if err := s.db.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&status); err != nil {
		return err
	}
	if status == "queued" || status == "running" {
		return nil
	}
	return fmt.Errorf("workflow run is %s", status)
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
	plan, err := s.buildRemoteWorkSavePlan(ctx, sourceID, workCode, selectedPaths, nil)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	if plan.Summary.Conflict > 0 {
		return remoteWorkSaveResult{}, remoteWorkSaveConflictError{Summary: plan.Summary}
	}
	rawWork, _ := json.Marshal(remoteWork)
	rawTracks, _ := json.Marshal(tracks)

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_work_fetch", "Fetch remote work", "Select remote files, cache them, promote cache files to the local library, and sync local locations.", remoteWorkFetchDefinition())
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	runInput := map[string]any{"source_id": sourceID, "work_code": workCode, "paths": selectedPaths}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_work_fetch", "Fetch remote work", "running", "manual", "fetch_selected", runInput, map[string]any{"plan": plan.Summary})
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
		NodeRunID: selectNodeID, WorkerType: "remote_work_fetch", Status: "running", Payload: runInput, ProgressCurrent: 0, ProgressTotal: len(plan.Items) * 2,
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
	cacheNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "cache", NodeType: "materialize_cache", DisplayName: "Cache selected files", Position: 4, Status: "running",
		Input: map[string]any{"items": len(plan.Items)}, Output: nil,
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	promoteNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "promote", NodeType: "promote_cache_to_local", DisplayName: "Move cache files to local library", Position: 5, Status: "queued",
		Input: map[string]any{"items": len(plan.Items)}, Output: nil,
	})
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	syncNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Sync fetched locations", Position: 6, Status: "queued",
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

	skipped, cacheHits, cacheDownloads := 0, 0, 0
	for index, item := range plan.Items {
		if item.Action == "skip" {
			skipped++
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items)*2)
			continue
		}
		cacheAbsPath, err := safeCachePath(s.cfg.CacheRoot, item.CachePath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if item.Action == "cache_hit" {
			cacheHits++
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items)*2)
			continue
		}
		if err := os.MkdirAll(filepath.Dir(cacheAbsPath), 0o755); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		written, err := s.downloadToFile(ctx, item.SourcePath, cacheAbsPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		mediaItemID, err := s.mediaItemIDForRemotePath(ctx, workID, item.Path)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		cacheLocationID, err := s.upsertCacheLocation(ctx, mediaItemID, source.ID, item.CachePath, "", item.SizeBytes, nil, written)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, cacheNodeID, jobID, "failed", err.Error(), index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		_, _ = s.runCacheLimitCleanup(ctx, source.ID, cacheLocationID)
		cacheDownloads++
		_ = updateWorkflowJobProgress(ctx, s.db, jobID, index+1, len(plan.Items)*2)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"skipped": skipped, "cache_hits": cacheHits, "cache_downloads": cacheDownloads}), cacheNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", promoteNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	promoted := 0
	for index, item := range plan.Items {
		if item.Action == "skip" {
			continue
		}
		cacheAbsPath, err := safeCachePath(s.cfg.CacheRoot, item.CachePath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if existingFileMatches(targetAbsPath, item.SizeBytes) {
			_ = updateWorkflowJobProgress(ctx, s.db, jobID, len(plan.Items)+index+1, len(plan.Items)*2)
			continue
		}
		if info, err := os.Stat(targetAbsPath); err == nil {
			reason := fmt.Sprintf("target already exists with size %d: %s", info.Size(), item.TargetPath)
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", reason, len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, errors.New(reason)
		} else if !errors.Is(err, os.ErrNotExist) {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if err := os.MkdirAll(filepath.Dir(targetAbsPath), 0o755); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if err := moveFile(cacheAbsPath, targetAbsPath); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if err := s.markCacheLocationUnavailable(ctx, source.ID, item.CachePath); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, promoteNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		promoted++
		_ = updateWorkflowJobProgress(ctx, s.db, jobID, len(plan.Items)+index+1, len(plan.Items)*2)
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"promoted": promoted}), promoteNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'succeeded',
			progress_current = ?,
			progress_total = ?,
			locked_by = '',
			locked_at = NULL,
			heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, len(plan.Items)*2, len(plan.Items)*2, jobID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?", syncNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	syncedLocations := 0
	for index, item := range plan.Items {
		targetAbsPath, err := safeDataPath(s.cfg.DataRoot, item.TargetPath)
		if err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		if _, err := os.Stat(targetAbsPath); err != nil {
			if item.Action == "skip" && errors.Is(err, os.ErrNotExist) {
				continue
			}
			if err != nil {
				_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
				return remoteWorkSaveResult{}, err
			}
		}
		if err := s.upsertSavedLocalLocation(ctx, workID, localSourceID, item, targetAbsPath); err != nil {
			_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)+index, len(plan.Items)*2, plan.Summary)
			return remoteWorkSaveResult{}, err
		}
		syncedLocations++
	}
	if err := s.finishFetchPresence(ctx, workID, source.ID, localSourceID, workCode); err != nil {
		_ = finishWorkflowRunSimple(ctx, s.db, runID, syncNodeID, jobID, "failed", err.Error(), len(plan.Items)*2, len(plan.Items)*2, plan.Summary)
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"locations": syncedLocations}), syncNodeID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"plan": plan.Summary, "skipped": skipped, "cache_hits": cacheHits, "cache_downloads": cacheDownloads, "promoted": promoted, "snapshot_bytes": len(rawWork) + len(rawTracks)}), runID); err != nil {
		return remoteWorkSaveResult{}, err
	}
	if err := s.insertFetchCleanupCandidate(ctx, runID, workID, localSourceID, workCode, plan.Items); err != nil {
		return remoteWorkSaveResult{}, err
	}
	return remoteWorkSaveResult{
		RunID:         runID,
		JobID:         jobID,
		WorkID:        workID,
		PrimaryCode:   workCode,
		Status:        "succeeded",
		SaveRoot:      plan.SaveRoot,
		SavedFiles:    promoted,
		SkippedFiles:  skipped,
		CachedFiles:   cacheHits + cacheDownloads,
		PromotedFiles: promoted,
		Plan:          plan.Summary,
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
	code := remoteWorkCodeFromPath(r)
	if code == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code is required"})
		return 0, "", remoteWorkSaveRequest{}, false
	}
	var payload remoteWorkSaveRequest
	_ = json.NewDecoder(r.Body).Decode(&payload)
	return id, code, payload, true
}

func remoteWorkCodeFromPath(r *http.Request) string {
	return strings.TrimSpace(r.PathValue("code"))
}

func (s *Server) loadRemoteWorkTracks(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, kikoeru.Work{}, nil, fmt.Errorf("source not found")
		}
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := kikoeruClientForSource(source)
	remoteWork, _, err := s.resolveKikoeruWork(ctx, client, code)
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

func (s *Server) resolveKikoeruWork(ctx context.Context, client *kikoeru.Client, code string) (kikoeru.Work, json.RawMessage, error) {
	remoteWork, rawWork, err := client.WorkInfo(ctx, code)
	if err == nil {
		return remoteWork, rawWork, nil
	}
	fallbackWork, fallbackRaw, fallbackErr := client.FindWorkByCode(ctx, code)
	if fallbackErr == nil {
		return fallbackWork, fallbackRaw, nil
	}
	return kikoeru.Work{}, nil, err
}

func (s *Server) remoteSaveRoot(source remoteSourceForUse, workCode string) string {
	template := strings.TrimSpace(source.Config.SaveRootTemplate)
	if template == "" {
		template = s.settingStringContext(context.Background(), "remote_save_root_template", "/data/<source_name>/<code_prefix>/<code_group>/<work_code>")
	}
	if template == "" {
		template = "/data/<source_name>/<code_prefix>/<code_group>/<work_code>"
	}
	prefix, group := workCodeShard(workCode)
	value := strings.ReplaceAll(template, "<source_name>", source.Code)
	value = strings.ReplaceAll(value, "<work_code>", strings.ToUpper(strings.TrimSpace(workCode)))
	value = strings.ReplaceAll(value, "<code_prefix>", prefix)
	value = strings.ReplaceAll(value, "<code_group>", group)
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

func normalizeSelectedLocalPaths(paths []string) map[string]bool {
	result := map[string]bool{}
	for _, path := range paths {
		path = strings.Trim(filepath.ToSlash(strings.TrimSpace(path)), "/")
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

func selectedLocalPathMatches(selected map[string]bool, filePath string) bool {
	filePath = strings.Trim(filepath.ToSlash(strings.TrimSpace(filePath)), "/")
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
		cachePath, err := safeCachePath(s.cfg.CacheRoot, path)
		if err != nil {
			continue
		}
		if existingFileMatches(cachePath, expectedSize) {
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
		case "cache_hit":
			summary.CacheHit++
			summary.Promote++
		case "cache_download":
			summary.CacheDownload++
			summary.Promote++
		case "copy_local":
			summary.Promote++
		case "conflict":
			summary.Conflict++
		}
	}
	return summary
}

func updateWorkflowJobProgress(ctx context.Context, db *sql.DB, jobID int64, current int, total int) error {
	_, err := db.ExecContext(ctx, `
		UPDATE workflow_job
		SET progress_current = ?,
			progress_total = ?,
			heartbeat_at = CASE WHEN status = 'running' THEN CURRENT_TIMESTAMP ELSE heartbeat_at END,
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
	if _, err := db.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?,
			progress_current = ?,
			progress_total = ?,
			error_message = ?,
			locked_by = '',
			locked_at = NULL,
			heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, current, total, errorMessage, jobID); err != nil {
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

func moveFile(sourcePath string, targetPath string) error {
	if err := os.Rename(sourcePath, targetPath); err == nil {
		return nil
	}
	if err := copyFile(sourcePath, targetPath); err != nil {
		return err
	}
	return os.Remove(sourcePath)
}

func (s *Server) mediaItemIDForRemotePath(ctx context.Context, workID int64, remotePath string) (int64, error) {
	var mediaItemID int64
	err := s.db.QueryRowContext(ctx, `
		SELECT item.id
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.work_id = ?
			AND location.location_type = 'remote_stream'
			AND location.path = ?
		ORDER BY item.id ASC
		LIMIT 1
	`, workID, remotePath).Scan(&mediaItemID)
	return mediaItemID, err
}

func (s *Server) markCacheLocationUnavailable(ctx context.Context, sourceID int64, cachePath string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
			AND location_type = 'cache'
			AND path = ?
	`, sourceID, cachePath)
	return err
}

func (s *Server) upsertSavedLocalLocation(ctx context.Context, workID int64, localSourceID int64, item remoteWorkSavePlanItem, targetAbsPath string) error {
	mediaItemID := item.MediaItemID
	if mediaItemID == 0 {
		var err error
		mediaItemID, err = s.mediaItemIDForRemotePath(ctx, workID, item.Path)
		if err != nil {
			return err
		}
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

func (s *Server) finishFetchPresence(ctx context.Context, workID int64, remoteSourceID int64, localSourceID int64, workCode string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET availability = 'unavailable',
			updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ?
			AND file_source_id = ?
			AND presence_type = 'tracked'
	`, workID, remoteSourceID); err != nil {
		return err
	}
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: localSourceID,
		PresenceType: "local",
		RemoteID:     "",
		Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"primary_code": workCode,
			"source":       "remote_fetch",
		}),
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) insertFetchCleanupCandidate(ctx context.Context, runID int64, workID int64, localSourceID int64, workCode string, items []remoteWorkSavePlanItem) error {
	targets := map[string]bool{}
	for _, item := range items {
		if item.TargetPath != "" {
			targets[filepath.ToSlash(item.TargetPath)] = true
		}
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			location.id,
			location.media_item_id,
			location.path,
			location.size_bytes,
			item.title,
			item.kind
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ?
			AND location.file_source_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
		ORDER BY location.path ASC
	`, workID, localSourceID)
	if err != nil {
		return err
	}
	defer rows.Close()
	candidates := []map[string]any{}
	locationIDs := []int64{}
	for rows.Next() {
		var id int64
		var mediaItemID int64
		var path string
		var size sql.NullInt64
		var title string
		var kind string
		if err := rows.Scan(&id, &mediaItemID, &path, &size, &title, &kind); err != nil {
			return err
		}
		if targets[filepath.ToSlash(path)] {
			continue
		}
		locationIDs = append(locationIDs, id)
		item := map[string]any{
			"location_id":   id,
			"media_item_id": mediaItemID,
			"path":          filepath.ToSlash(path),
			"title":         title,
			"kind":          kind,
		}
		if size.Valid {
			item["size_bytes"] = size.Int64
		}
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(candidates) == 0 {
		return nil
	}
	_, err = s.db.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'local_fetch_merge_cleanup', ?, 'pending', ?)
	`, runID, workCode, mustJSON(map[string]any{
		"work_id":                workID,
		"work_code":              workCode,
		"local_source_id":        localSourceID,
		"candidate_locations":    candidates,
		"candidate_location_ids": locationIDs,
		"fetched_targets":        sortedStringKeys(targets),
		"message":                "Fetch completed while other local files for this work still exist. Review before deleting or hiding old local files.",
	}))
	return err
}

func sortedStringKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
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
		AgeRating:       work.AgeCategoryString,
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
	ID          int64
	MediaItemID int64
	Path        string
	SizeBytes   *int64
	Available   bool
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
		SELECT location.id, location.media_item_id, location.location_type, location.path, location.size_bytes, location.availability
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
		var mediaItemID int64
		var locationType string
		var path string
		var size sql.NullInt64
		var availability string
		if err := rows.Scan(&id, &mediaItemID, &locationType, &path, &size, &availability); err != nil {
			return states, err
		}
		state := remoteTrackLocationState{ID: id, MediaItemID: mediaItemID, Path: filepath.ToSlash(path), Available: availability == "available"}
		if size.Valid {
			value := size.Int64
			state.SizeBytes = &value
		}
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

func remoteWorkSaveLocalFiles(states remoteTrackLocationStates) []remoteWorkSaveLocalFile {
	files := make([]remoteWorkSaveLocalFile, 0, len(states.Local))
	for _, state := range states.Local {
		files = append(files, remoteWorkSaveLocalFile{
			MediaItemID: state.MediaItemID,
			Path:        state.Path,
			SizeBytes:   state.SizeBytes,
			Available:   state.Available,
		})
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].Path < files[j].Path
	})
	return files
}

func trimLocalPathToWorkRoot(path string, files []remoteWorkSaveLocalFile) string {
	root := commonLocalDirectoryPrefix(files)
	normalized := filepath.ToSlash(path)
	if root == "" {
		return filepath.Base(normalized)
	}
	if normalized == root {
		return filepath.Base(normalized)
	}
	if strings.HasPrefix(normalized, root+"/") {
		return strings.TrimPrefix(normalized, root+"/")
	}
	return normalized
}

func commonLocalDirectoryPrefix(files []remoteWorkSaveLocalFile) string {
	if len(files) == 0 {
		return ""
	}
	parts := localDirectoryParts(files[0].Path)
	prefix := []string{}
	for index, part := range parts {
		if part == "" {
			continue
		}
		for _, file := range files[1:] {
			other := localDirectoryParts(file.Path)
			if index >= len(other) || other[index] != part {
				if len(prefix) <= 1 {
					return ""
				}
				return strings.Join(prefix, "/")
			}
		}
		prefix = append(prefix, part)
	}
	if len(prefix) <= 1 {
		return ""
	}
	return strings.Join(prefix, "/")
}

func localDirectoryParts(path string) []string {
	dir := filepath.ToSlash(filepath.Dir(filepath.ToSlash(path)))
	if dir == "." || dir == "/" {
		return nil
	}
	return strings.Split(strings.Trim(dir, "/"), "/")
}

func remotePathForLocalPath(localPath string, files []remoteSaveFile) string {
	localPath = filepath.ToSlash(localPath)
	for _, file := range files {
		if localPath == file.Path || strings.HasSuffix(localPath, "/"+file.Path) {
			return file.Path
		}
	}
	return ""
}

func mediaKindFromPath(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".mp3", ".wav", ".flac", ".m4a", ".ogg", ".opus", ".aac":
		return "audio"
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp":
		return "image"
	case ".txt", ".lrc", ".srt", ".vtt", ".ass":
		return "text"
	default:
		return "file"
	}
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
	return kikoeru.WorkCode(work)
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
		LocalScanDepth:         s.settingInt(r, "local_scan_depth", s.cfg.LocalScanDepth),
		CacheEnabled:           s.settingBool(r, "remote_cache_enabled", false),
		CacheLimitGB:           s.settingInt(r, "remote_cache_limit_gb", 20),
		RemoteSaveTemplate:     s.settingString(r, "remote_save_root_template", "/data/<source_name>/<code_prefix>/<code_group>/<work_code>"),
		RemoteDelayBase:        s.settingFloat(r, "remote_request_delay_base_seconds", 0.5),
		RemoteDelayRandom:      s.settingFloat(r, "remote_request_delay_random_seconds", 1.5),
		RemoteBackoff:          s.settingFloat(r, "remote_rate_limit_backoff_seconds", 30),
		RemoteMaxBackoff:       s.settingFloat(r, "remote_max_backoff_seconds", 300),
		CircleAutoRefreshDays:  s.settingInt(r, "circle_auto_refresh_days", 30),
		DLsiteMetadataLanguage: normalizeDLsiteLanguage(s.settingString(r, "dlsite_metadata_language", "ja-jp")),
		DirectoryRoutingRules:  s.settingDirectoryRules(r, "directory_routing_rules", defaultDirectoryRoutingRules()),
		DataRoot:               s.cfg.DataRoot,
		CacheRoot:              s.cfg.CacheRoot,
		FileSources:            sources,
	}, nil
}

func defaultDirectoryRoutingRules() []directoryRule {
	return []directoryRule{
		{
			ID:              "main",
			Label:           "Main story",
			Weight:          40,
			Aliases:         []string{"本編", "本篇", "honhen", "main"},
			NegativeAliases: []string{"特典", "bonus", "おまけ"},
			Enabled:         true,
		},
		{
			ID:              "with_se",
			Label:           "SEあり",
			Weight:          30,
			Aliases:         []string{"SEあり", "SE有", "SE付き", "効果音あり", "with se"},
			NegativeAliases: []string{"SEなし", "SE無", "効果音なし", "without se"},
			Enabled:         true,
		},
		{
			ID:              "mp3",
			Label:           "mp3",
			Weight:          20,
			Aliases:         []string{"mp3"},
			NegativeAliases: []string{"wav", "flac"},
			Enabled:         true,
		},
	}
}

func normalizeDirectoryRoutingRules(rules []directoryRule) []directoryRule {
	normalized := []directoryRule{}
	for index, rule := range rules {
		label := strings.TrimSpace(rule.Label)
		aliases := cleanStringList(rule.Aliases, 24)
		negativeAliases := cleanStringList(rule.NegativeAliases, 24)
		if label == "" && len(aliases) > 0 {
			label = aliases[0]
		}
		if label == "" || len(aliases) == 0 {
			continue
		}
		id := stablePreferenceID(rule.ID, label, index)
		weight := rule.Weight
		if weight < 1 {
			weight = 1
		}
		if weight > 100 {
			weight = 100
		}
		normalized = append(normalized, directoryRule{
			ID:              id,
			Label:           label,
			Weight:          weight,
			Aliases:         aliases,
			NegativeAliases: negativeAliases,
			Enabled:         rule.Enabled,
		})
	}
	return normalized
}

func cleanStringList(values []string, limit int) []string {
	cleaned := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		key := strings.ToLower(value)
		if seen[key] {
			continue
		}
		seen[key] = true
		cleaned = append(cleaned, value)
		if len(cleaned) >= limit {
			break
		}
	}
	return cleaned
}

func stablePreferenceID(value string, label string, index int) string {
	id := strings.ToLower(strings.TrimSpace(value))
	id = sourceCodePattern.ReplaceAllString(id, "_")
	id = strings.Trim(id, "_")
	if id == "" {
		id = strings.ToLower(strings.TrimSpace(label))
		id = sourceCodePattern.ReplaceAllString(id, "_")
		id = strings.Trim(id, "_")
	}
	if id == "" {
		id = fmt.Sprintf("rule_%d", index+1)
	}
	return id
}

func normalizeDLsiteLanguage(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "", "ja", "jp", "ja-jp":
		return "ja-jp"
	case "en", "en-us":
		return "en-us"
	case "zh", "zh-cn", "cn":
		return "zh-cn"
	case "zh-tw", "tw":
		return "zh-tw"
	case "ko", "ko-kr":
		return "ko-kr"
	default:
		return ""
	}
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
		payload.SourceType = sourceTypeKikoeruCompatible
	}
	if !isKikoeruSourceType(payload.SourceType) && !(allowLocal && payload.SourceType == sourceTypeLocalFolder) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "unsupported sourceType"})
		return fileSourcePayload{}, false
	}
	if payload.Priority <= 0 {
		payload.Priority = 30
	}
	if isKikoeruSourceType(payload.SourceType) {
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

func (s *Server) settingIntContext(ctx context.Context, key string, fallback int) int {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
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

func (s *Server) settingDirectoryRules(r *http.Request, key string, fallback []directoryRule) []directoryRule {
	var raw string
	if err := s.db.QueryRowContext(r.Context(), "SELECT value_json FROM app_setting WHERE key = ?", key).Scan(&raw); err != nil {
		return fallback
	}
	var rules []directoryRule
	if err := json.Unmarshal([]byte(raw), &rules); err != nil {
		return fallback
	}
	rules = normalizeDirectoryRoutingRules(rules)
	if len(rules) == 0 {
		return fallback
	}
	return rules
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
