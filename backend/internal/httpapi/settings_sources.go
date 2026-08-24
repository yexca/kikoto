package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
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

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/workflow"
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

var defaultDLsiteMetadataLanguages = []string{dlsite.OriginMetadataLanguage}

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
	sourceID, err := insertAndID(ctx, tx, `
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

type appSettingsResponse struct {
	AnonymousAccessEnabled    bool                         `json:"anonymousAccessEnabled"`
	LocalScanDepth            int                          `json:"localScanDepth"`
	CacheEnabled              bool                         `json:"cacheEnabled"`
	CacheLimitGB              int                          `json:"cacheLimitGb"`
	RemoteDownloadLimitGB     int                          `json:"remoteDownloadLimitGb"`
	FetchStagingRetentionDays int                          `json:"fetchStagingRetentionDays"`
	RemoteSaveTemplate        string                       `json:"remoteSaveTemplate"`
	RemoteDelayBase           float64                      `json:"remoteDelayBaseSeconds"`
	RemoteDelayRandom         float64                      `json:"remoteDelayRandomSeconds"`
	RemoteBackoff             float64                      `json:"remoteBackoffSeconds"`
	RemoteMaxBackoff          float64                      `json:"remoteMaxBackoffSeconds"`
	CatalogFreshnessDays      int                          `json:"catalogFreshnessDays"`
	DLsiteMetadataLanguage    string                       `json:"dlsiteMetadataLanguage"`
	DLsiteMetadataLanguages   []string                     `json:"dlsiteMetadataLanguages"`
	DirectoryRoutingRules     []directoryRule              `json:"directoryRoutingRules"`
	RecommendationThreshold   int                          `json:"recommendationThreshold"`
	RecommendationConfig      library.RecommendationConfig `json:"recommendationConfig"`
	RecommendationDefaults    library.RecommendationConfig `json:"recommendationDefaults"`
	DataRoot                  string                       `json:"dataRoot"`
	CacheRoot                 string                       `json:"cacheRoot"`
	FileSources               []fileSourceSummary          `json:"fileSources"`
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

type remoteWorksResponse struct {
	SourceID    int64               `json:"sourceId"`
	Works       []remoteWorkSummary `json:"works"`
	Page        int                 `json:"page"`
	PageSize    int                 `json:"pageSize"`
	Total       int                 `json:"total"`
	Status      string              `json:"status"`
	Error       *remoteWorksError   `json:"error,omitempty"`
	Sort        string              `json:"sort"`
	Direction   string              `json:"direction"`
	SortApplied bool                `json:"sortApplied"`
}

type remoteWorksError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	URL       string `json:"url,omitempty"`
	Retryable bool   `json:"retryable"`
}

const (
	remoteSourceDisabledMessage    = "Remote source is disabled. Enable it in source settings before browsing."
	remoteSourceUnavailableMessage = "Remote source service is unavailable. Check the configured endpoint and try again."
)

type librarySource struct {
	ID          int64  `json:"id"`
	Code        string `json:"code"`
	DisplayName string `json:"displayName"`
	SourceType  string `json:"sourceType"`
	Enabled     bool   `json:"enabled"`
}

type remoteWorkSummary struct {
	RemoteID        string            `json:"remoteId"`
	PrimaryCode     string            `json:"primaryCode"`
	RemoteCode      string            `json:"remoteCode"`
	Title           string            `json:"title"`
	ReleaseDate     string            `json:"releaseDate"`
	UpdatedAt       string            `json:"updatedAt"`
	CoverURL        string            `json:"coverUrl"`
	Circle          string            `json:"circle"`
	CircleRef       *remoteEntityRef  `json:"circleRef,omitempty"`
	AgeRating       string            `json:"ageRating"`
	Rating          *float64          `json:"rating"`
	RatingCount     *int64            `json:"ratingCount"`
	Sales           *int64            `json:"sales"`
	HasNonOrigin    bool              `json:"hasAvailableNonOriginEdition,omitempty"`
	Price           *int64            `json:"price"`
	Tags            []string          `json:"tags"`
	VoiceActors     []string          `json:"voiceActors"`
	VoiceRefs       []remoteEntityRef `json:"voiceRefs"`
	ImportStatus    string            `json:"importStatus"`
	RemotePlayable  bool              `json:"remotePlayable"`
	WorkID          *int64            `json:"workId"`
	Favorite        bool              `json:"favorite"`
	ListeningStatus string            `json:"listeningStatus"`
	RecommendScore  int               `json:"recommendScore"`
	DurationSeconds *int64            `json:"-"`
	SearchUserTags  []string          `json:"-"`
}

type remoteWorkDetail struct {
	SourceID         int64                    `json:"sourceId"`
	SourceCode       string                   `json:"sourceCode"`
	SourceName       string                   `json:"sourceName"`
	RemoteID         string                   `json:"remoteId"`
	PrimaryCode      string                   `json:"primaryCode"`
	RemoteCode       string                   `json:"remoteCode"`
	Title            string                   `json:"title"`
	CoverURL         string                   `json:"coverUrl"`
	SourceURL        string                   `json:"sourceUrl"`
	PublicWorkURL    string                   `json:"publicWorkUrl"`
	Circle           string                   `json:"circle"`
	CircleRef        *remoteEntityRef         `json:"circleRef,omitempty"`
	Rating           *float64                 `json:"rating"`
	RatingCount      *int64                   `json:"ratingCount"`
	Sales            *int64                   `json:"sales"`
	Price            *int64                   `json:"price"`
	AgeRating        string                   `json:"ageRating"`
	ReleaseDate      string                   `json:"releaseDate"`
	DurationSeconds  *int64                   `json:"durationSeconds"`
	Tags             []string                 `json:"tags"`
	VoiceActors      []string                 `json:"voiceActors"`
	VoiceRefs        []remoteEntityRef        `json:"voiceRefs"`
	ImportStatus     string                   `json:"importStatus"`
	WorkID           *int64                   `json:"workId"`
	MetadataView     workMetadataPresentation `json:"metadataPresentation"`
	Tracks           []remoteTrackDetail      `json:"tracks,omitempty"`
	LanguageEditions []remoteLanguageEdition  `json:"languageEditions"`
}

type remoteWorkTracksDetail struct {
	SourceID    int64               `json:"sourceId"`
	SourceCode  string              `json:"sourceCode"`
	SourceName  string              `json:"sourceName"`
	RemoteID    string              `json:"remoteId"`
	PrimaryCode string              `json:"primaryCode"`
	RemoteCode  string              `json:"remoteCode"`
	Tracks      []remoteTrackDetail `json:"tracks"`
}

type remoteLanguageEdition struct {
	RemoteCode   string `json:"remoteCode"`
	Language     string `json:"language"`
	Label        string `json:"label"`
	DisplayOrder int    `json:"displayOrder"`
	Current      bool   `json:"current"`
	Origin       bool   `json:"origin"`
}

type remoteEntityRef struct {
	SourceID   int64  `json:"sourceId"`
	ExternalID string `json:"externalId"`
	Name       string `json:"name"`
}

type sourceAvailabilityResponse struct {
	WorkCode  string                      `json:"workCode"`
	CheckedAt string                      `json:"checkedAt"`
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
	HasTracked  bool   `json:"hasTracked"`
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
	Tracked          bool   `json:"tracked"`
	SyncedMediaItems int    `json:"syncedMediaItems"`
	SyncedLocations  int    `json:"syncedLocations"`
	TriggerReason    string `json:"triggerReason"`
}

type remoteWorkTrackResult struct {
	RunID         int64  `json:"runId"`
	JobID         int64  `json:"jobId"`
	WorkID        *int64 `json:"workId"`
	PrimaryCode   string `json:"primaryCode"`
	Status        string `json:"status"`
	TriggerReason string `json:"triggerReason"`
	Deduplicated  bool   `json:"deduplicated"`
}

type remoteWorkTrackJobPayload struct {
	RequestedByUserID int64  `json:"requested_by_user_id,omitempty"`
	SourceID          int64  `json:"source_id"`
	WorkCode          string `json:"work_code"`
	TriggerReason     string `json:"trigger_reason"`
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
	SourceID        int64  `json:"sourceId"`
	Action          string `json:"action"`
	Limit           int    `json:"limit"`
	TagName         string `json:"tagName"`
	TagNameTemplate string `json:"tagNameTemplate"`
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
	Tagged          int      `json:"tagged"`
	Failed          int      `json:"failed"`
	ChildRuns       []int64  `json:"childRuns"`
	Failures        []string `json:"failures"`
	ExpectedMaximum int      `json:"expectedMaximum"`
	ReturnedCount   int      `json:"returnedCount"`
	TagName         string   `json:"tagName"`
}

type remoteCollectionJobCheckpoint struct {
	CompletedCodes []string                  `json:"completedCodes"`
	Candidates     []kikoeru.Work            `json:"candidates"`
	Result         remoteCollectionRunResult `json:"result"`
}

type remoteCollectionJobPayload struct {
	UserID   int64  `json:"user_id"`
	SourceID int64  `json:"source_id"`
	Action   string `json:"action"`
	Limit    int    `json:"limit"`
	TagName  string `json:"tag_name"`
}

type remoteWorkSaveRequest struct {
	Paths        []string                  `json:"paths"`
	LocalPaths   []string                  `json:"localPaths"`
	TargetRoot   string                    `json:"targetRoot"`
	RequestID    string                    `json:"requestId"`
	Decisions    []remoteFetchFileDecision `json:"decisions"`
	MinFreeBytes int64                     `json:"minFreeBytes"`
}

type remoteWorkFetchJobPayload struct {
	RequestedByUserID int64                     `json:"requested_by_user_id,omitempty"`
	SourceID          int64                     `json:"source_id"`
	WorkCode          string                    `json:"work_code"`
	Paths             []string                  `json:"paths"`
	LocalPaths        []string                  `json:"local_paths"`
	TargetRoot        string                    `json:"target_root"`
	RequestID         string                    `json:"request_id"`
	Decisions         []remoteFetchFileDecision `json:"decisions"`
	MinFreeBytes      int64                     `json:"min_free_bytes"`
}

type remoteWorkTracksSnapshot struct {
	Source    remoteSourceForUse
	Work      kikoeru.Work
	Tracks    []kikoeru.Track
	ExpiresAt time.Time
}

type remoteWorkSnapshot struct {
	Source    remoteSourceForUse
	Work      kikoeru.Work
	ExpiresAt time.Time
}

type remoteFetchFileDecision struct {
	ItemKey    string `json:"itemKey"`
	SourceID   int64  `json:"sourceId"`
	Resolution string `json:"resolution"`
	TargetPath string `json:"targetPath"`
}

type remoteFetchSourceOption struct {
	SourceID   int64  `json:"sourceId"`
	SourceCode string `json:"sourceCode"`
	SourceName string `json:"sourceName"`
	Path       string `json:"path"`
	SizeBytes  *int64 `json:"sizeBytes"`
	SourcePath string `json:"-"`
	Kind       string `json:"-"`
	Hash       string `json:"-"`
}

type remoteWorkSavePlan struct {
	SourceID    int64                     `json:"sourceId"`
	PrimaryCode string                    `json:"primaryCode"`
	SaveRoot    string                    `json:"saveRoot"`
	FetchRoot   remoteFetchRootReview     `json:"fetchRoot"`
	LocalFiles  []remoteWorkSaveLocalFile `json:"localFiles"`
	Items       []remoteWorkSavePlanItem  `json:"items"`
	Summary     remoteWorkSaveSummary     `json:"summary"`
	Preparation remoteFetchPreparation    `json:"preparation"`
}

type remoteWorkSaveLocalFile struct {
	MediaItemID int64  `json:"mediaItemId"`
	Path        string `json:"path"`
	SizeBytes   *int64 `json:"sizeBytes"`
	Available   bool   `json:"available"`
}

type remoteWorkSavePlanItem struct {
	ItemKey              string                    `json:"itemKey"`
	Path                 string                    `json:"path"`
	Kind                 string                    `json:"kind"`
	SizeBytes            *int64                    `json:"sizeBytes"`
	SourceKind           string                    `json:"sourceKind"`
	Action               string                    `json:"action"`
	Status               string                    `json:"status"`
	SourcePath           string                    `json:"sourcePath"`
	LocalSourcePath      string                    `json:"localSourcePath"`
	CachePath            string                    `json:"cachePath"`
	TargetPath           string                    `json:"targetPath"`
	MediaItemID          int64                     `json:"mediaItemId"`
	LocalPaths           []string                  `json:"localPaths"`
	TargetExists         bool                      `json:"targetExists"`
	TargetConflict       bool                      `json:"targetConflict"`
	TargetConflictReason string                    `json:"targetConflictReason"`
	TargetSizeBytes      *int64                    `json:"targetSizeBytes"`
	OriginalTargetPath   string                    `json:"originalTargetPath"`
	Resolution           string                    `json:"resolution"`
	RemoteSourceID       int64                     `json:"remoteSourceId"`
	RemoteSourceCode     string                    `json:"remoteSourceCode"`
	RemoteSourceName     string                    `json:"remoteSourceName"`
	RemotePath           string                    `json:"remotePath"`
	SourceOptions        []remoteFetchSourceOption `json:"sourceOptions"`
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
	RequestID     string                `json:"requestId"`
	Deduplicated  bool                  `json:"deduplicated"`
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
var remoteRequestLanguagePattern = regexp.MustCompile(`^[A-Za-z]{2,8}(?:[-_][A-Za-z0-9]{2,8})*$`)
var remoteFetchRequestIDPattern = regexp.MustCompile(`^[A-Za-z0-9._:-]{8,128}$`)

type settingsUpdatePayload struct {
	LocalScanDepth            *int             `json:"localScanDepth"`
	CacheEnabled              *bool            `json:"cacheEnabled"`
	CacheLimitGB              *int             `json:"cacheLimitGb"`
	RemoteDownloadLimitGB     *int             `json:"remoteDownloadLimitGb"`
	FetchStagingRetentionDays *int             `json:"fetchStagingRetentionDays"`
	RemoteSaveTemplate        *string          `json:"remoteSaveTemplate"`
	RemoteDelayBase           *float64         `json:"remoteDelayBaseSeconds"`
	RemoteDelayRandom         *float64         `json:"remoteDelayRandomSeconds"`
	RemoteBackoff             *float64         `json:"remoteBackoffSeconds"`
	RemoteMaxBackoff          *float64         `json:"remoteMaxBackoffSeconds"`
	CatalogFreshnessDays      *int             `json:"catalogFreshnessDays"`
	DLsiteMetadataLanguage    *string          `json:"dlsiteMetadataLanguage"`
	DLsiteMetadataLanguages   *[]string        `json:"dlsiteMetadataLanguages"`
	DirectoryRoutingRules     *[]directoryRule `json:"directoryRoutingRules"`
	RecommendationThreshold   *int             `json:"recommendationThreshold"`
	RecommendationConfig      json.RawMessage  `json:"recommendationConfig"`
}

type settingsValidationError struct{ message string }

func (err *settingsValidationError) Error() string { return err.message }

func invalidSettings(message string) error {
	return &settingsValidationError{message: message}
}

func writeSettingsUpdateError(w http.ResponseWriter, err error) {
	var validationErr *settingsValidationError
	if errors.As(err, &validationErr) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": validationErr.Error()})
		return
	}
	writeError(w, err)
}

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
	configuredAnonymousAccessEnabled := s.configuredAnonymousAccessEnabled()
	effectiveAnonymousAccessEnabled := s.anonymousAccessEnabled()
	response := map[string]any{
		"anonymousAccessEnabled": configuredAnonymousAccessEnabled,
		"mode":                   s.cfg.RuntimeMode(),
		"demoMode":               s.cfg.IsDemo(),
	}
	if _, authenticated := userFromContext(r.Context()); !authenticated && !effectiveAnonymousAccessEnabled && !s.cfg.IsDevelopment() && !s.cfg.IsDemo() {
		writeJSON(w, http.StatusOK, response)
		return
	}
	response["cacheEnabled"] = s.settingBool(r, "remote_cache_enabled", false)
	response["directoryRoutingRules"] = s.settingDirectoryRules(r, "directory_routing_rules", defaultDirectoryRoutingRules())
	response["recommendationThreshold"] = s.settingInt(r, "recommendation_threshold", 50)
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) updateSettings(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	var payload settingsUpdatePayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	recommendationConfig, err := s.parseRecommendationConfig(r.Context(), payload.RecommendationConfig)
	if err != nil {
		writeSettingsUpdateError(w, err)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.applySettingsUpdate(r, tx, payload, recommendationConfig); err != nil {
		writeSettingsUpdateError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	if payload.LocalScanDepth != nil || payload.RemoteSaveTemplate != nil {
		s.notifyFilesystemTriggerConfigChanged()
	}
	if payload.DLsiteMetadataLanguages != nil || payload.DLsiteMetadataLanguage != nil {
		if err := metasync.ProjectDLsiteMetadata(r.Context(), s.db, s.preferredMetadataLanguages(r.Context())); err != nil {
			writeError(w, err)
			return
		}
	}
	settings, err := s.loadAppSettings(r)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, settings)
}

func (s *Server) parseRecommendationConfig(ctx context.Context, raw json.RawMessage) (*library.RecommendationConfig, error) {
	if value := strings.TrimSpace(string(raw)); value == "" || value == "null" {
		return nil, nil
	}
	var config library.RecommendationConfig
	if err := json.Unmarshal(raw, &config); err != nil {
		return nil, invalidSettings("invalid JSON body")
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, invalidSettings("invalid JSON body")
	}
	if _, present := fields["explorationAmplitude"]; !present {
		config.ExplorationAmplitude = s.libraryStore.LoadRecommendationConfig(ctx).ExplorationAmplitude
	}
	return &config, nil
}

func (s *Server) applySettingsUpdate(
	r *http.Request,
	tx *sql.Tx,
	payload settingsUpdatePayload,
	recommendationConfig *library.RecommendationConfig,
) error {
	if err := applyGeneralSettings(r, tx, payload); err != nil {
		return err
	}
	if err := applyMetadataSettings(r, tx, payload); err != nil {
		return err
	}
	if err := applyRecommendationSettings(r, tx, payload, recommendationConfig); err != nil {
		return err
	}
	if payload.LocalScanDepth != nil && !s.cfg.IsDemo() {
		if _, err := s.upsertLocalFileSource(r.Context(), tx, *payload.LocalScanDepth); err != nil {
			return err
		}
	}
	return nil
}

func applyGeneralSettings(r *http.Request, tx *sql.Tx, payload settingsUpdatePayload) error {
	intSettings := []struct {
		value     *int
		key       string
		minimum   int
		maximum   int
		errorText string
	}{
		{payload.LocalScanDepth, "local_scan_depth", 1, 8, "localScanDepth must be between 1 and 8"},
		{payload.CacheLimitGB, "remote_cache_limit_gb", 0, 4096, "cacheLimitGb must be between 0 and 4096"},
		{payload.RemoteDownloadLimitGB, "remote_download_limit_gb", minimumRemoteDownloadLimitGB, maximumRemoteDownloadLimitGB, "remoteDownloadLimitGb must be between 1 and 2048"},
		{payload.FetchStagingRetentionDays, "fetch_staging_retention_days", minimumFetchStagingRetentionDays, maximumFetchStagingRetentionDays, "fetchStagingRetentionDays must be between 1 and 365"},
		{payload.CatalogFreshnessDays, "catalog_freshness_days", minimumCatalogFreshnessDays, maximumCatalogFreshnessDays, "catalogFreshnessDays must be between 1 and 365"},
	}
	for _, setting := range intSettings {
		if err := upsertOptionalIntSetting(r, tx, setting.value, setting.key, setting.minimum, setting.maximum, setting.errorText); err != nil {
			return err
		}
	}
	if err := upsertOptionalBoolSetting(r, tx, payload.CacheEnabled, "remote_cache_enabled"); err != nil {
		return err
	}
	if payload.RemoteSaveTemplate != nil {
		value := strings.TrimSpace(*payload.RemoteSaveTemplate)
		if value == "" {
			value = defaultRemoteSaveRootTemplate
		}
		if err := upsertSetting(r, tx, "remote_save_root_template", value); err != nil {
			return err
		}
	}
	floatSettings := []struct {
		value     *float64
		key       string
		maximum   float64
		errorText string
	}{
		{payload.RemoteDelayBase, "remote_request_delay_base_seconds", 60, "remoteDelayBaseSeconds must be between 0 and 60"},
		{payload.RemoteDelayRandom, "remote_request_delay_random_seconds", 60, "remoteDelayRandomSeconds must be between 0 and 60"},
		{payload.RemoteBackoff, "remote_rate_limit_backoff_seconds", 3600, "remoteBackoffSeconds must be between 0 and 3600"},
		{payload.RemoteMaxBackoff, "remote_max_backoff_seconds", 3600, "remoteMaxBackoffSeconds must be between 0 and 3600"},
	}
	for _, setting := range floatSettings {
		if err := upsertOptionalFloatSetting(r, tx, setting.value, setting.key, setting.maximum, setting.errorText); err != nil {
			return err
		}
	}
	return nil
}

func applyMetadataSettings(r *http.Request, tx *sql.Tx, payload settingsUpdatePayload) error {
	if payload.DLsiteMetadataLanguages != nil || payload.DLsiteMetadataLanguage != nil {
		languages, err := requestedDLsiteMetadataLanguages(payload)
		if err != nil {
			return err
		}
		if err := upsertSetting(r, tx, dlsiteMetadataLanguagesSetting, languages); err != nil {
			return err
		}
		// Keep the legacy scalar in sync so older clients and deployments can still read the preference.
		if err := upsertSetting(r, tx, dlsiteMetadataLanguageSetting, languages[0]); err != nil {
			return err
		}
	}
	if payload.DirectoryRoutingRules != nil {
		rules := normalizeDirectoryRoutingRules(*payload.DirectoryRoutingRules)
		if len(rules) > 20 {
			return invalidSettings("directoryRoutingRules must contain at most 20 rules")
		}
		if err := upsertSetting(r, tx, "directory_routing_rules", rules); err != nil {
			return err
		}
	}
	return nil
}

func requestedDLsiteMetadataLanguages(payload settingsUpdatePayload) ([]string, error) {
	if payload.DLsiteMetadataLanguages != nil {
		languages, err := validateDLsiteMetadataLanguages(*payload.DLsiteMetadataLanguages)
		if err != nil {
			return nil, invalidSettings(err.Error())
		}
		return languages, nil
	}
	language := normalizeDLsiteLanguage(*payload.DLsiteMetadataLanguage)
	if language == "" {
		return nil, invalidSettings("unsupported dlsiteMetadataLanguage")
	}
	return completeDLsiteMetadataLanguages([]string{language}), nil
}

func applyRecommendationSettings(
	r *http.Request,
	tx *sql.Tx,
	payload settingsUpdatePayload,
	recommendationConfig *library.RecommendationConfig,
) error {
	if err := upsertOptionalIntSetting(r, tx, payload.RecommendationThreshold, "recommendation_threshold", 1, 100, "recommendationThreshold must be between 1 and 100"); err != nil {
		return err
	}
	if recommendationConfig == nil {
		return nil
	}
	if err := library.ValidateRecommendationConfig(*recommendationConfig); err != nil {
		return invalidSettings(err.Error())
	}
	return upsertSetting(r, tx, "recommendation_config", *recommendationConfig)
}

func upsertOptionalIntSetting(r *http.Request, tx *sql.Tx, value *int, key string, minimum int, maximum int, errorText string) error {
	if value == nil {
		return nil
	}
	if *value < minimum || *value > maximum {
		return invalidSettings(errorText)
	}
	return upsertSetting(r, tx, key, *value)
}

func upsertOptionalFloatSetting(r *http.Request, tx *sql.Tx, value *float64, key string, maximum float64, errorText string) error {
	if value == nil {
		return nil
	}
	if *value < 0 || *value > maximum {
		return invalidSettings(errorText)
	}
	return upsertSetting(r, tx, key, *value)
}

func upsertOptionalBoolSetting(r *http.Request, tx *sql.Tx, value *bool, key string) error {
	if value == nil {
		return nil
	}
	return upsertSetting(r, tx, key, *value)
}

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

	sourceID, err := insertAndID(r.Context(), tx, `
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
		go s.runSourceChangeAvailabilityChecks(context.Background(), source.ID, "source_updated")
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
	diagnosticURL := remoteSourceDiagnosticURL(r.Context(), source.Endpoint)
	if !source.Enabled {
		s.writeRemoteWorksDisabled(w, id, r, diagnosticURL)
		return
	}
	request := newRemoteSourceWorksRequest(r, source.SourceType, remoteSourceRequestLanguages(source.Config.RequestLanguage))
	if err := s.serveRemoteSourceWorksPage(w, r, userID, source, diagnosticURL, request); err != nil {
		writeError(w, err)
	}
}

type remoteSourceWorksRequest struct {
	Page                  int
	PageSize              int
	Query                 string
	Seed                  string
	Plan                  remoteSourceQueryPlan
	Sort                  string
	UpstreamOrder         string
	Direction             string
	Languages             []string
	IncludeRecommendation bool
}

func newRemoteSourceWorksRequest(r *http.Request, sourceType string, languages []string) remoteSourceWorksRequest {
	page := queryInt(r, "page", 1)
	pageSize := queryInt(r, "pageSize", 24)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 24
	}
	query := r.URL.Query().Get("q")
	sortName, upstreamOrder := remoteSourceSort(r.URL.Query().Get("sort"))
	return remoteSourceWorksRequest{
		Page: page, PageSize: pageSize, Query: query, Seed: r.URL.Query().Get("seed"),
		Plan: planRemoteSourceQuery(query, sourceType), Sort: sortName, UpstreamOrder: upstreamOrder,
		Direction: remoteSortDirection(r.URL.Query().Get("direction")), Languages: languages,
		IncludeRecommendation: r.URL.Query().Get("recommendBadges") == "true" && !strings.EqualFold(r.URL.Query().Get("sort"), "recommend"),
	}
}

func (s *Server) writeRemoteWorksDisabled(w http.ResponseWriter, sourceID int64, r *http.Request, diagnosticURL string) {
	sortName, _ := remoteSourceSort(r.URL.Query().Get("sort"))
	writeJSON(w, http.StatusOK, remoteWorksResponse{
		SourceID: sourceID, Works: []remoteWorkSummary{}, Page: queryInt(r, "page", 1), PageSize: queryInt(r, "pageSize", 24),
		Status: "disabled", Error: &remoteWorksError{Code: "disabled", Message: remoteSourceDisabledMessage, URL: diagnosticURL, Retryable: false},
		Sort: sortName, Direction: remoteSortDirection(r.URL.Query().Get("direction")),
	})
}

func (s *Server) serveRemoteSourceWorksPage(w http.ResponseWriter, r *http.Request, userID int64, source remoteSourceForUse, diagnosticURL string, request remoteSourceWorksRequest) error {
	ctx := r.Context()
	client := s.kikoeruClientForSource(source)
	if s.cfg.IsDemo() {
		works, total, sortApplied, err := s.demoRemoteSourcePageWithLanguages(ctx, userID, source.ID, client, source.SourceType, request.Query, request.UpstreamOrder, request.Direction, request.Seed, request.Page, request.PageSize, request.Languages, request.IncludeRecommendation)
		return s.writeRemoteSourceWorksResult(w, ctx, source, diagnosticURL, request, works, total, sortApplied, err)
	}
	if len(request.Plan.PostFilterClauses) > 0 {
		works, total, sortApplied, err := s.remotePostFilteredPageWithLanguages(ctx, userID, source.ID, client, request.Plan, request.UpstreamOrder, request.Direction, request.Seed, request.Page, request.PageSize, request.Languages)
		return s.writeRemoteSourceWorksResult(w, ctx, source, diagnosticURL, request, works, total, sortApplied, err)
	}
	remotePage, err := client.ListWorksSortedSeeded(ctx, request.Page, request.PageSize, request.Plan.PushdownQuery, request.UpstreamOrder, request.Direction, request.Seed)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		s.writeRemoteWorksUnavailable(w, source, request.Page, request.PageSize, request.Sort, request.Direction, diagnosticURL, err)
		return nil
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	works, err := s.remoteWorkSummariesWithLanguages(ctx, userID, source.ID, remotePage.Works, request.Languages, request.IncludeRecommendation)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, remoteWorksResponse{SourceID: source.ID, Works: works, Page: request.Page, PageSize: request.PageSize, Total: remotePageTotal(remotePage), Status: "ok", Sort: request.Sort, Direction: request.Direction, SortApplied: remotePage.SortApplied})
	return nil
}

func (s *Server) writeRemoteSourceWorksResult(w http.ResponseWriter, ctx context.Context, source remoteSourceForUse, diagnosticURL string, request remoteSourceWorksRequest, works []remoteWorkSummary, total int, sortApplied bool, err error) error {
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		s.writeRemoteWorksUnavailable(w, source, request.Page, request.PageSize, request.Sort, request.Direction, diagnosticURL, err)
		return nil
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	writeJSON(w, http.StatusOK, remoteWorksResponse{SourceID: source.ID, Works: works, Page: request.Page, PageSize: request.PageSize, Total: total, Status: "ok", Sort: request.Sort, Direction: request.Direction, SortApplied: sortApplied})
	return nil
}

func remotePageTotal(page kikoeru.WorksPage) int {
	if page.Pagination.TotalCount > 0 {
		return page.Pagination.TotalCount
	}
	if page.Pagination.Total > 0 {
		return page.Pagination.Total
	}
	return page.Pagination.Count
}

func (s *Server) writeRemoteWorksUnavailable(
	w http.ResponseWriter,
	source remoteSourceForUse,
	page int,
	pageSize int,
	sortName string,
	direction string,
	diagnosticURL string,
	err error,
) {
	// Keep the upstream detail in protected logs while returning a stable,
	// source-local status that the library can render without exposing it.
	slog.Error("remote source works request failed", "source_id", source.ID, "error", err)
	writeJSON(w, http.StatusOK, remoteWorksResponse{
		SourceID: source.ID,
		Works:    []remoteWorkSummary{},
		Page:     page,
		PageSize: pageSize,
		Total:    0,
		Status:   "unavailable",
		Error: &remoteWorksError{
			Code:      "unavailable",
			Message:   remoteSourceUnavailableMessage,
			URL:       diagnosticURL,
			Retryable: true,
		},
		Sort:      sortName,
		Direction: direction,
	})
}

func (s *Server) demoRemoteSourcePage(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	sourceType string,
	query string,
	upstreamOrder string,
	direction string,
	seed string,
	page int,
	pageSize int,
	language string,
	includeRecommendation bool,
) ([]remoteWorkSummary, int, bool, error) {
	return s.demoRemoteSourcePageWithLanguages(ctx, userID, sourceID, client, sourceType, query, upstreamOrder, direction, seed, page, pageSize, []string{language}, includeRecommendation)
}

func (s *Server) demoRemoteSourcePageWithLanguages(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	sourceType string,
	query string,
	upstreamOrder string,
	direction string,
	seed string,
	page int,
	pageSize int,
	languages []string,
	includeRecommendation bool,
) ([]remoteWorkSummary, int, bool, error) {
	plan := demoRemoteSourceQueryPlan(query, sourceType)
	if len(plan.PostFilterClauses) > 0 {
		return s.remotePostFilteredPageWithLanguages(ctx, userID, sourceID, client, plan, upstreamOrder, direction, seed, page, pageSize, languages, includeRecommendation)
	}
	remotePage, err := client.SearchWorksSortedSeeded(ctx, page, pageSize, plan.PushdownQuery, upstreamOrder, direction, seed)
	if err != nil {
		return nil, 0, false, err
	}
	works, err := s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, remotePage.Works, languages, includeRecommendation)
	if err != nil {
		return nil, 0, false, err
	}
	return works, firstPositiveInt(remotePage.Pagination.TotalCount, remotePage.Pagination.Total, remotePage.Pagination.Count), remotePage.SortApplied, nil
}

func (s *Server) remotePostFilteredPage(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	plan remoteSourceQueryPlan,
	order string,
	direction string,
	seed string,
	page int,
	pageSize int,
	language string,
	includeRecommendation ...bool,
) ([]remoteWorkSummary, int, bool, error) {
	return s.remotePostFilteredPageWithLanguages(ctx, userID, sourceID, client, plan, order, direction, seed, page, pageSize, []string{language}, includeRecommendation...)
}

func (s *Server) remotePostFilteredPageWithLanguages(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	plan remoteSourceQueryPlan,
	order string,
	direction string,
	seed string,
	page int,
	pageSize int,
	languages []string,
	includeRecommendation ...bool,
) ([]remoteWorkSummary, int, bool, error) {
	const upstreamPageSize = 100
	const maxUpstreamPages = 100
	filtered := []remoteWorkSummary{}
	seen := map[string]bool{}
	sortApplied := true
	for upstreamPage := 1; upstreamPage <= maxUpstreamPages; upstreamPage++ {
		var result kikoeru.WorksPage
		var err error
		if s.cfg.IsDemo() {
			result, err = client.SearchWorksSortedSeeded(ctx, upstreamPage, upstreamPageSize, plan.PushdownQuery, order, direction, seed)
		} else {
			result, err = client.ListWorksSortedSeeded(ctx, upstreamPage, upstreamPageSize, plan.PushdownQuery, order, direction, seed)
		}
		if err != nil {
			return nil, 0, false, err
		}
		sortApplied = sortApplied && result.SortApplied
		summaries, err := s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, result.Works, languages, includeRecommendation...)
		if err != nil {
			return nil, 0, false, err
		}
		for _, work := range filterRemoteWorkSummaries(summaries, plan.PostFilterClauses) {
			key := strings.ToUpper(strings.TrimSpace(work.PrimaryCode)) + ":" + work.RemoteID
			if seen[key] {
				continue
			}
			seen[key] = true
			filtered = append(filtered, work)
		}
		upstreamTotal := firstPositiveInt(result.Pagination.TotalCount, result.Pagination.Total, result.Pagination.Count)
		if len(result.Works) == 0 || len(result.Works) < upstreamPageSize || (upstreamTotal > 0 && upstreamPage*upstreamPageSize >= upstreamTotal) {
			break
		}
		if upstreamPage == maxUpstreamPages {
			return nil, 0, false, fmt.Errorf("remote filtered query exceeded %d upstream works", maxUpstreamPages*upstreamPageSize)
		}
	}
	total := len(filtered)
	start := (page - 1) * pageSize
	if start >= total {
		return []remoteWorkSummary{}, total, sortApplied, nil
	}
	end := min(start+pageSize, total)
	return filtered[start:end], total, sortApplied, nil
}

func firstPositiveInt(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func remoteSourceSort(value string) (string, string) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "code":
		return "code", "id"
	case "random":
		return "random", "random"
	case "release":
		return "release", "release"
	case "rating":
		return "rating", "rate_average_2dp"
	case "sales":
		return "sales", "dl_count"
	default:
		return "recent", "create_date"
	}
}

func remoteSortDirection(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "asc") {
		return "asc"
	}
	return "desc"
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
	source, remoteWork, err := s.loadRemoteWorkCached(r.Context(), id, code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeUpstreamError(w, err)
		return
	}
	languages := remoteSourceRequestLanguages(source.Config.RequestLanguage)
	detail, err := s.remoteWorkDetailWithLanguages(r.Context(), source, remoteWork, languages)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

func (s *Server) getRemoteSourceWorkTracks(w http.ResponseWriter, r *http.Request) {
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
	source, remoteWork, tracks, err := s.loadRemoteWorkTracksCached(r.Context(), id, code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeUpstreamError(w, err)
		return
	}
	detail, err := s.remoteWorkTracksDetail(r.Context(), source, remoteWork, tracks)
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
	if !s.requireDemoWorkCode(w, r, code) {
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
	if !s.requireDemoWorkCode(w, r, code) {
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
	return s.checkWorkSourceAvailabilityForSourcesWithHealth(ctx, code, onlySourceID, nil, triggerType, triggerReason)
}

func (s *Server) checkWorkSourceAvailabilityForSourcesWithHealth(ctx context.Context, code string, onlySourceID int64, allowedSourceIDs map[int64]bool, triggerType string, triggerReason string) (sourceAvailabilityResponse, error) {
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
		if allowedSourceIDs != nil && !allowedSourceIDs[source.ID] {
			continue
		}
		result, err := s.checkOneWorkSourceAvailability(ctx, source, code, triggerType)
		if err != nil {
			return sourceAvailabilityResponse{}, err
		}
		results = append(results, result)
	}
	if err := s.recordSourceAvailabilityObservation(ctx, code, results); err != nil {
		return sourceAvailabilityResponse{}, err
	}
	return sourceAvailabilityResponse{
		WorkCode: code, CheckedAt: checkedAt, Sources: results,
	}, nil
}

func (s *Server) checkOneWorkSourceAvailability(ctx context.Context, source remoteSourceForUse, code, triggerType string) (sourceAvailabilitySummary, error) {
	result := sourceAvailabilitySummary{SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName, Status: "disabled"}
	if !isKikoeruSourceType(source.SourceType) {
		result.Status = "unavailable"
		result.Error = "source is not a supported kikoeru source"
		return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code)
	}
	if !source.Enabled {
		return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code)
	}
	requestClass := sourceRequestCrawl
	if triggerType == "manual" {
		requestClass = sourceRequestInteractive
	}
	started := time.Now()
	remoteWork, err := s.checkRemoteWorkAvailabilityWithClass(ctx, source, code, requestClass)
	result.ElapsedMS = time.Since(started).Milliseconds()
	if err != nil {
		result.Status = "error"
		result.Error = "remote source request failed"
		if isNotFoundLikeError(err) {
			result.Status = "not_found"
			result.Error = "work was not found"
		}
		slog.Warn("remote source availability check failed", "source_id", source.ID, "work_code", code, "error", err)
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, code)
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
	return result, s.attachSourceAvailabilityFlags(ctx, &result, source.ID, workCode)
}

func (s *Server) recordSourceAvailabilityObservation(ctx context.Context, code string, results []sourceAvailabilitySummary) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := s.recordAvailabilityPresence(ctx, tx, code, results); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) healthyRemoteSourceIDsForAvailability(ctx context.Context, onlySourceID int64) (map[int64]bool, error) {
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	healthy := map[int64]bool{}
	for _, source := range sources {
		if onlySourceID > 0 && source.ID != onlySourceID {
			continue
		}
		if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
			continue
		}
		if strings.TrimSpace(source.Endpoint.APIURL) == "" {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			continue
		}
		checkCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
		err := s.checkRemoteSourceHealthWithClass(checkCtx, source, sourceRequestCrawl)
		cancel()
		if err != nil {
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			continue
		}
		_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		healthy[source.ID] = true
	}
	return healthy, nil
}

func (s *Server) checkRemoteSourceHealth(ctx context.Context, source remoteSourceForUse) error {
	return s.checkRemoteSourceHealthWithClass(ctx, source, sourceRequestInteractive)
}

func (s *Server) checkRemoteSourceHealthWithClass(ctx context.Context, source remoteSourceForUse, class sourceRequestClass) error {
	client := s.kikoeruClientForSourceClass(source, class)
	if err := client.Health(ctx); err == nil {
		return nil
	}
	_, err := client.ListWorks(ctx, 1, 1, "")
	return err
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
	result.HasTracked = flags.HasTracked
	result.HasCache = flags.HasCache
	result.HasLocal = flags.HasLocal
	return nil
}

func (s *Server) planRemoteSourceWorkSave(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "downloads:manage"); !ok {
		return
	}
	sourceID, code, payload, ok := parseRemoteWorkSaveRequest(w, r)
	if !ok {
		return
	}
	metadataErr := s.ensureRemoteFetchMetadata(r.Context(), code)
	preparation := s.prepareRemoteFetch(r.Context(), code)
	if metadataErr != nil {
		preparation.MetadataStatus = "degraded"
		preparation.Warnings = append(preparation.Warnings, "metadata refresh: "+metadataErr.Error())
	}
	plan, err := s.buildRemoteWorkSavePlan(r.Context(), sourceID, code, payload.Paths, payload.LocalPaths, payload.TargetRoot, payload.Decisions)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	if err := s.ensureRemoteWorkSaveDiskReserve(plan, payload.MinFreeBytes); err != nil {
		writeError(w, err)
		return
	}
	attachRemoteFetchPreparation(&plan, preparation)
	writeJSON(w, http.StatusOK, plan)
}

func (s *Server) saveRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	sourceID, code, payload, ok := parseRemoteWorkSaveRequest(w, r)
	if !ok {
		return
	}
	payload.RequestID = strings.TrimSpace(payload.RequestID)
	if payload.RequestID != "" && !validRemoteFetchRequestID(payload.RequestID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid fetch request id"})
		return
	}
	if payload.RequestID != "" {
		if existing, found, err := s.remoteFetchRequestResult(r.Context(), payload.RequestID, sourceID, code); err != nil {
			writeError(w, err)
			return
		} else if found {
			writeJSON(w, http.StatusAccepted, existing)
			return
		}
	}
	operationCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()
	result, err := s.enqueueRemoteWorkSave(operationCtx, sourceID, code, payload.Paths, payload.LocalPaths, payload.TargetRoot, payload.RequestID, payload.Decisions, payload.MinFreeBytes, actor.ID, workflow.JobPriorityUserInitiated)
	if err != nil {
		if payload.RequestID != "" {
			if existing, found, lookupErr := s.remoteFetchRequestResult(r.Context(), payload.RequestID, sourceID, code); lookupErr == nil && found {
				writeJSON(w, http.StatusAccepted, existing)
				return
			}
		}
		var conflict remoteWorkSaveConflictError
		if errors.As(err, &conflict) {
			writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "summary": conflict.Summary})
			return
		}
		writeUpstreamError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) trackRemoteSourceWork(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:read")
	if !ok {
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
		payload.TriggerReason = "manual_track"
	}
	operationCtx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 2*time.Minute)
	defer cancel()
	result, err := s.enqueueRemoteWorkTrack(operationCtx, actor.ID, id, code, payload.TriggerReason)
	if err != nil {
		writeUpstreamError(w, err)
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
	result, err := s.runRemoteWorkMaterialize(r.Context(), id, code, payload.TriggerReason)
	if err != nil {
		writeUpstreamError(w, err)
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
		writeError(w, err)
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
		writeUpstreamError(w, err)
		return
	}
	locationID, err := s.findRemoteMediaLocationByPath(r.Context(), syncResult.WorkID, sourceID, remotePath)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "remote media was not found", false)
		return
	}
	cacheResult, err := s.enqueueRemoteMediaCache(r.Context(), locationID)
	if err != nil {
		writeError(w, err)
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
	var configJSON, allowedHostPatternsJSON string
	if err := s.db.QueryRowContext(ctx, `
		SELECT source.id, source.code, source.display_name, source.source_type, source.enabled, source.config_json,
			COALESCE(endpoint.api_url, ''), COALESCE(endpoint.base_url, ''), COALESCE(endpoint.fallback_url, ''),
			COALESCE(endpoint.work_url_template, ''), COALESCE(endpoint.restrict_outbound_hosts, 0),
			COALESCE(endpoint.allowed_host_patterns_json, '[]')
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
		&source.Endpoint.WorkURLTemplate,
		&source.Endpoint.RestrictOutboundHosts,
		&allowedHostPatternsJSON,
	); err != nil {
		return remoteSourceForUse{}, err
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		source.Endpoint.APIURL = source.Endpoint.BaseURL
	}
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

func (s *Server) loadRemoteSourcesForAvailability(ctx context.Context) ([]remoteSourceForUse, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source.id, source.code, source.display_name, source.source_type, source.enabled, source.config_json,
			COALESCE(endpoint.api_url, ''), COALESCE(endpoint.base_url, ''), COALESCE(endpoint.fallback_url, ''),
			COALESCE(endpoint.work_url_template, ''), COALESCE(endpoint.restrict_outbound_hosts, 0),
			COALESCE(endpoint.allowed_host_patterns_json, '[]')
		FROM file_source AS source
		LEFT JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		WHERE source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
		ORDER BY source.priority ASC, source.id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	sources := []remoteSourceForUse{}
	for rows.Next() {
		var source remoteSourceForUse
		var configJSON, allowedHostPatternsJSON string
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
			&source.Endpoint.WorkURLTemplate,
			&source.Endpoint.RestrictOutboundHosts,
			&allowedHostPatternsJSON,
		); err != nil {
			return nil, err
		}
		if strings.TrimSpace(source.Endpoint.APIURL) == "" {
			source.Endpoint.APIURL = source.Endpoint.BaseURL
		}
		if strings.TrimSpace(configJSON) != "" {
			_ = json.Unmarshal([]byte(configJSON), &source.Config)
		}
		normalizeFileSourceConfig(&source.Config, source.SourceType)
		_ = json.Unmarshal([]byte(allowedHostPatternsJSON), &source.Endpoint.AllowedHostPatterns)
		if source.Endpoint.AllowedHostPatterns == nil {
			source.Endpoint.AllowedHostPatterns = []string{}
		}
		sources = append(sources, source)
	}
	return sources, rows.Err()
}

func (s *Server) checkRemoteWorkAvailabilityWithClass(ctx context.Context, source remoteSourceForUse, code string, class sourceRequestClass) (kikoeru.Work, error) {
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return kikoeru.Work{}, fmt.Errorf("source has no API endpoint")
	}
	client := s.kikoeruClientForSourceClass(source, class)
	remoteWork, _, err := s.resolveKikoeruWork(ctx, client, code)
	return remoteWork, err
}

type sourceAvailabilityState struct {
	WorkID     *int64
	HasRemote  bool
	HasTracked bool
	HasCache   bool
	HasLocal   bool
}

type workSourcePresence struct {
	WorkID       int64
	FileSourceID int64
	PresenceType string
	RemoteID     string
	RemoteCode   string
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
	presence.RemoteCode = normalizeDLsiteCode(presence.RemoteCode)
	if presence.RemoteCode == "" {
		presence.RemoteCode = normalizeDLsiteCode(remoteCodeFromRawJSON(presence.RawJSON))
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO work_source_presence (
			work_id,
			file_source_id,
			presence_type,
			remote_id,
			remote_code,
			source_url,
			availability,
			raw_json,
			last_seen_at,
			last_checked_at,
			updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, file_source_id, presence_type) DO UPDATE SET
			remote_id = excluded.remote_id,
			remote_code = excluded.remote_code,
			source_url = excluded.source_url,
			availability = excluded.availability,
			raw_json = excluded.raw_json,
			last_seen_at = CASE
				WHEN excluded.availability = 'available' THEN excluded.last_seen_at
				ELSE work_source_presence.last_seen_at
			END,
			last_checked_at = excluded.last_checked_at,
			updated_at = CURRENT_TIMESTAMP
	`, presence.WorkID, presence.FileSourceID, presence.PresenceType, presence.RemoteID, presence.RemoteCode, presence.SourceURL, presence.Availability, presence.RawJSON)
	return err
}

func (s *Server) sourceAvailabilityFlags(ctx context.Context, sourceID int64, workCode string) (sourceAvailabilityState, error) {
	var flags sourceAvailabilityState
	ref, err := s.canonicalWorkForCode(ctx, workCode)
	if err != nil {
		return flags, err
	}
	if !ref.Known || ref.WorkID <= 0 {
		return flags, nil
	}
	flags.WorkID = &ref.WorkID
	ids, err := s.familyWorkIDsForCode(ctx, ref.Code)
	if err != nil {
		return flags, err
	}
	for _, workID := range ids {
		flags.HasRemote = flags.HasRemote || s.workHasLocationType(ctx, workID, sourceID, "remote_stream") || s.workHasSourcePresence(ctx, workID, sourceID, sourcePresenceTypeRemoteSource, "available")
		flags.HasTracked = flags.HasTracked || s.workHasSourcePresence(ctx, workID, sourceID, "tracked", "available")
		flags.HasCache = flags.HasCache || s.workHasLocationType(ctx, workID, sourceID, "cache")
		flags.HasLocal = flags.HasLocal || s.workHasLocationType(ctx, workID, 0, "local") || s.workHasSourcePresence(ctx, workID, 0, "local", "available")
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
			RemoteCode:   result.PrimaryCode,
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
	PushdownQuery     string
	PushdownClause    *listSearchClause
	PostFilterClauses []listSearchClause
}

func planRemoteSourceQuery(query string, sourceType string) remoteSourceQueryPlan {
	clauses := parseListSearchClauses(query)
	if len(clauses) == 0 {
		return remoteSourceQueryPlan{}
	}
	if sourceType == sourceTypeKikoeruCompatible {
		plan := remoteSourceQueryPlan{}
		pushdown := make([]string, 0, len(clauses))
		for _, clause := range clauses {
			value := remoteSourcePushdownQuery(clause)
			if value == "" {
				plan.PostFilterClauses = append(plan.PostFilterClauses, clause)
				continue
			}
			if plan.PushdownClause == nil {
				copyClause := clause
				plan.PushdownClause = &copyClause
			}
			pushdown = append(pushdown, value)
		}
		plan.PushdownQuery = strings.Join(pushdown, " ")
		return plan
	}
	pushdownIndex := -1
	bestRank := 999
	for index, clause := range clauses {
		rank := remoteSourcePushdownRank(clause)
		if rank < bestRank {
			bestRank = rank
			pushdownIndex = index
		}
	}
	plan := remoteSourceQueryPlan{}
	for index, clause := range clauses {
		if index == pushdownIndex {
			pushdown := remoteSourcePushdownQuery(clause)
			if pushdown != "" {
				plan.PushdownQuery = pushdown
				copyClause := clause
				plan.PushdownClause = &copyClause
				continue
			}
		}
		plan.PostFilterClauses = append(plan.PostFilterClauses, clause)
	}
	return plan
}

func remoteSourcePushdownRank(clause listSearchClause) int {
	switch clause.Kind {
	case "language":
		return 0
	case "code":
		return 1
	case "circle", "voice_actor", "tag":
		return 2
	case "text":
		return 3
	case "rating_min", "sales_min", "duration_min", "duration_max", "age":
		return 4
	default:
		return 999
	}
}

func remoteSourcePushdownQuery(clause listSearchClause) string {
	switch clause.Kind {
	case "circle":
		return "$circle:" + clause.Value + "$"
	case "voice_actor":
		return "$va:" + clause.Value + "$"
	case "tag":
		return "$tag:" + clause.Value + "$"
	case "exclude_tag":
		return "$-tag:" + clause.Value + "$"
	case "rating_min":
		return "$rate:" + clause.Value + "$"
	case "sales_min":
		return "$sell:" + clause.Value + "$"
	case "duration_min":
		return "$duration:" + clause.Value + "$"
	case "duration_max":
		return "$-duration:" + clause.Value + "$"
	case "age":
		return "$age:" + clause.Value + "$"
	case "language":
		return "$lang:" + clause.Value + "$"
	case "code", "text":
		return clause.Value
	default:
		return ""
	}
}

func filterRemoteWorkSummaries(works []remoteWorkSummary, clauses []listSearchClause) []remoteWorkSummary {
	result := make([]remoteWorkSummary, 0, len(works))
	for _, work := range works {
		if remoteWorkSummaryMatchesClauses(work, clauses) {
			result = append(result, work)
		}
	}
	return result
}

func remoteWorkSummaryMatchesClauses(work remoteWorkSummary, clauses []listSearchClause) bool {
	for _, clause := range clauses {
		if !remoteWorkSummaryMatchesClause(work, clause) {
			return false
		}
	}
	return true
}

func remoteWorkSummaryMatchesClause(work remoteWorkSummary, clause listSearchClause) bool {
	needle := strings.ToLower(strings.TrimSpace(clause.Value))
	if needle == "" {
		return true
	}
	switch clause.Kind {
	case "code", "circle", "age":
		return remoteWorkSummaryMatchesTextClause(work, clause.Kind, needle)
	case "tag", "exclude_tag", "voice_actor", "user_tag", "exclude_user_tag":
		return remoteWorkSummaryMatchesTagClause(work, clause.Kind, needle)
	case "rating_min", "sales_min", "duration_min", "duration_max":
		return remoteWorkSummaryMatchesNumericClause(work, clause.Kind, needle)
	case "language":
		return false
	default:
		return remoteWorkSummaryMatchesFreeText(work, needle)
	}
}

func remoteWorkSummaryMatchesTextClause(work remoteWorkSummary, kind, needle string) bool {
	switch kind {
	case "code":
		return strings.Contains(strings.ToLower(work.PrimaryCode), needle) || strings.Contains(strings.ToLower(work.RemoteCode), needle) || strings.Contains(strings.ToLower(work.RemoteID), needle)
	case "circle":
		return strings.Contains(strings.ToLower(work.Circle), needle)
	default:
		return strings.Contains(strings.ToLower(work.AgeRating), needle)
	}
}

func remoteWorkSummaryMatchesTagClause(work remoteWorkSummary, kind, needle string) bool {
	var values []string
	switch kind {
	case "tag", "exclude_tag":
		values = work.Tags
	case "voice_actor":
		values = work.VoiceActors
	default:
		values = work.SearchUserTags
	}
	matched := stringSliceContainsSubstringFold(values, needle)
	if kind == "exclude_tag" || kind == "exclude_user_tag" {
		return !matched
	}
	return matched
}

func remoteWorkSummaryMatchesNumericClause(work remoteWorkSummary, kind, needle string) bool {
	threshold := numericListClauseValue(needle)
	switch kind {
	case "rating_min":
		return work.Rating != nil && *work.Rating >= threshold
	case "sales_min":
		return work.Sales != nil && float64(*work.Sales) >= threshold
	case "duration_min":
		return work.DurationSeconds != nil && float64(*work.DurationSeconds) >= threshold
	default:
		return work.DurationSeconds != nil && float64(*work.DurationSeconds) <= threshold
	}
}

func remoteWorkSummaryMatchesFreeText(work remoteWorkSummary, needle string) bool {
	return stringSliceContainsSubstringFold([]string{work.PrimaryCode, work.RemoteCode, work.RemoteID, work.Title, work.Circle, work.ReleaseDate, work.AgeRating}, needle) ||
		stringSliceContainsSubstringFold(work.Tags, needle) || stringSliceContainsSubstringFold(work.VoiceActors, needle) ||
		stringSliceContainsSubstringFold(work.SearchUserTags, needle)
}

func (s *Server) remoteWorkSummaries(ctx context.Context, userID int64, sourceID int64, works []kikoeru.Work, language string, includeRecommendation ...bool) ([]remoteWorkSummary, error) {
	return s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, works, []string{language}, includeRecommendation...)
}

func (s *Server) remoteWorkSummariesWithLanguages(ctx context.Context, userID int64, sourceID int64, works []kikoeru.Work, languages []string, includeRecommendation ...bool) ([]remoteWorkSummary, error) {
	result := make([]remoteWorkSummary, 0, len(works))
	seen := map[string]int{}
	projector := newRemoteCatalogProjectorWithLanguages(languages)
	for _, work := range works {
		item, err := s.buildRemoteWorkSummary(ctx, userID, sourceID, projector, work, includeRecommendation...)
		if err != nil {
			return nil, err
		}
		key := strings.ToUpper(strings.TrimSpace(item.PrimaryCode))
		if index, ok := seen[key]; ok {
			mergeRemoteWorkSummary(&result[index], item)
			continue
		}
		seen[key] = len(result)
		result = append(result, item)
	}
	return s.enrichRemoteWorkSummaries(ctx, userID, result)
}

func (s *Server) buildRemoteWorkSummary(ctx context.Context, userID, sourceID int64, projector remoteCatalogProjector, work kikoeru.Work, includeRecommendation ...bool) (remoteWorkSummary, error) {
	projected := projector.project(sourceID, work)
	code := projected.RemoteCode
	displayCode := code
	ref, err := s.canonicalWorkForCode(ctx, code)
	if err != nil {
		return remoteWorkSummary{}, err
	}
	if ref.Code != "" {
		displayCode = ref.Code
	}
	var workID *int64
	var favorite bool
	listeningStatus := "none"
	if ref.Known && ref.WorkID > 0 {
		workID = &ref.WorkID
		var favoriteInt int
		if err := s.db.QueryRowContext(ctx, `
			SELECT COALESCE(favorite, 0), COALESCE(listening_status, 'none')
			FROM user_work_state
			WHERE user_id = ? AND work_id = ?
		`, userID, *workID).Scan(&favoriteInt, &listeningStatus); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return remoteWorkSummary{}, err
		} else if err == nil {
			favorite = favoriteInt != 0
		}
	}
	recommendScore := 0
	if workID != nil && len(includeRecommendation) > 0 && includeRecommendation[0] {
		recommendScore, err = s.workRecommendationScore(ctx, userID, *workID)
		if err != nil {
			return remoteWorkSummary{}, err
		}
	}
	status := "remote_only"
	if workID != nil {
		status = "synced"
	}
	return remoteWorkSummary{
		RemoteID: projected.RemoteID, PrimaryCode: displayCode, RemoteCode: code,
		Title: firstNonEmpty(projected.Title, displayCode), ReleaseDate: projected.ReleaseDate,
		UpdatedAt: projected.ReleaseDate, CoverURL: projected.CoverURL, Circle: projected.Circle,
		CircleRef: projected.CircleRef, AgeRating: projected.AgeRating, Rating: projected.Rating,
		RatingCount: projected.RatingCount, Sales: projected.Sales, Price: projected.Price,
		Tags: projected.Tags, VoiceActors: projected.VoiceActors, VoiceRefs: projected.VoiceRefs,
		ImportStatus: status, RemotePlayable: true, WorkID: workID, Favorite: favorite,
		ListeningStatus: listeningStatus, RecommendScore: recommendScore, DurationSeconds: projected.DurationSeconds,
	}, nil
}

func mergeRemoteWorkSummary(existing *remoteWorkSummary, item remoteWorkSummary) {
	existing.RemotePlayable = existing.RemotePlayable || item.RemotePlayable
	existing.Favorite = existing.Favorite || item.Favorite
	if existing.ListeningStatus == "none" {
		existing.ListeningStatus = item.ListeningStatus
	}
	if existing.WorkID == nil {
		existing.WorkID, existing.ImportStatus = item.WorkID, item.ImportStatus
	}
	if existing.Price == nil {
		existing.Price = item.Price
	}
	if existing.RemoteCode == "" || strings.EqualFold(item.RemoteCode, item.PrimaryCode) {
		existing.RemoteCode, existing.RemoteID = item.RemoteCode, item.RemoteID
	}
}

func (s *Server) enrichRemoteWorkSummaries(ctx context.Context, userID int64, result []remoteWorkSummary) ([]remoteWorkSummary, error) {
	workIDs := make([]int64, 0, len(result))
	for _, item := range result {
		if item.WorkID != nil {
			workIDs = append(workIDs, *item.WorkID)
		}
	}
	userTagsByWork, err := s.loadWorkUserTagsBatch(ctx, userID, workIDs)
	if err != nil {
		return nil, err
	}
	availableNonOriginEditions, err := s.loadAvailableNonOriginEditions(ctx, workIDs)
	if err != nil {
		return nil, err
	}
	for index := range result {
		if result[index].WorkID == nil {
			result[index].SearchUserTags = []string{}
			continue
		}
		for _, tag := range userTagsByWork[*result[index].WorkID] {
			result[index].SearchUserTags = append(result[index].SearchUserTags, tag.Name)
		}
		result[index].HasNonOrigin = availableNonOriginEditions[*result[index].WorkID]
	}
	return result, nil
}

func (s *Server) enqueueRemoteWorkTrack(ctx context.Context, userID int64, sourceID int64, code string, triggerReason string) (remoteWorkTrackResult, error) {
	s.remoteTrackMu.Lock()
	defer s.remoteTrackMu.Unlock()

	requestedCode, triggerReason, err := normalizeRemoteWorkTrackRequest(code, triggerReason)
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteWorkTrackResult{}, fmt.Errorf("source not found")
		}
		return remoteWorkTrackResult{}, err
	}
	if err := validateRemoteWorkTrackSource(source); err != nil {
		return remoteWorkTrackResult{}, err
	}
	if existing, ok, err := reuseRemoteWorkTrack(ctx, s.db, userID, sourceID, requestedCode); err != nil {
		return remoteWorkTrackResult{}, err
	} else if ok {
		return existing, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	if existing, ok, err := reuseRemoteWorkTrack(ctx, tx, userID, sourceID, requestedCode); err != nil {
		return remoteWorkTrackResult{}, err
	} else if ok {
		if err := tx.Commit(); err != nil {
			return remoteWorkTrackResult{}, err
		}
		return existing, nil
	}
	result, err := enqueueRemoteWorkTrackTx(ctx, tx, source, userID, requestedCode, triggerReason)
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkTrackResult{}, err
	}
	return result, nil
}

func normalizeRemoteWorkTrackRequest(code string, triggerReason string) (string, string, error) {
	requestedCode := strings.ToUpper(strings.TrimSpace(code))
	if requestedCode == "" {
		return "", "", fmt.Errorf("work code is required")
	}
	triggerReason = strings.TrimSpace(triggerReason)
	if triggerReason == "" {
		triggerReason = "manual_track"
	}
	return requestedCode, triggerReason, nil
}

func validateRemoteWorkTrackSource(source remoteSourceForUse) error {
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return fmt.Errorf("source has no API endpoint")
	}
	return nil
}

type remoteWorkTrackQueryer interface {
	rowQueryer
	contextExecer
}

func reuseRemoteWorkTrack(ctx context.Context, queryer remoteWorkTrackQueryer, userID, sourceID int64, requestedCode string) (remoteWorkTrackResult, bool, error) {
	existing, ok, err := activeRemoteWorkTrack(ctx, queryer, sourceID, requestedCode)
	if err != nil || !ok {
		return existing, ok, err
	}
	if err := subscribeRemoteTrackNotification(ctx, queryer, userID, existing.RunID, existing.WorkID, requestedCode); err != nil {
		return remoteWorkTrackResult{}, false, err
	}
	existing.Deduplicated = true
	return existing, true, nil
}

func enqueueRemoteWorkTrackTx(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, userID int64, requestedCode, triggerReason string) (remoteWorkTrackResult, error) {
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_source_sync", "Track remote source", "Track one remote work and fork its selected-source directory in a recoverable background job.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source", "displayName": "Select remote source"},
			{"id": "discover", "type": "discover_remote_works", "displayName": "Resolve remote work"},
			{"id": "filter", "type": "filter_candidates", "displayName": "Validate candidate"},
			{"id": "match", "type": "match_works", "displayName": "Track work"},
			{"id": "metadata", "type": "sync_metadata", "displayName": "Record source metadata"},
			{"id": "sync", "type": "sync_file_locations", "displayName": "Fork remote directory"},
		},
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	payload := remoteWorkTrackJobPayload{
		RequestedByUserID: userID,
		SourceID:          source.ID,
		WorkCode:          requestedCode,
		TriggerReason:     triggerReason,
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_source_sync", "Track "+requestedCode, "queued", "manual", triggerReason, payload, map[string]any{
		"source_id": source.ID, "requested_work_code": requestedCode, "tracked": false,
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: payload, Output: map[string]any{"file_source_id": source.ID, "source_code": source.Code},
	}); err != nil {
		return remoteWorkTrackResult{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Resolve remote work", Position: 2, Status: "queued",
		Input: map[string]any{"work_code": requestedCode},
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Validate candidate", Position: 3, Status: "queued", Input: map[string]any{"work_code": requestedCode}},
		{NodeID: "match", NodeType: "match_works", DisplayName: "Track work", Position: 4, Status: "queued", Input: map[string]any{"work_code": requestedCode}},
		{NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Record source metadata", Position: 5, Status: "queued", Input: map[string]any{"work_code": requestedCode}},
		{NodeID: "sync", NodeType: "sync_file_locations", DisplayName: "Fork remote directory", Position: 6, Status: "queued", Input: map[string]any{"source_id": source.ID, "work_code": requestedCode}},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return remoteWorkTrackResult{}, err
		}
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: discoverNodeID, WorkerType: "remote_source_track", Status: "queued", Priority: workflow.JobPriorityUserInitiated,
		ResourceKey: sourceResourceKey(source.Endpoint.APIURL), Payload: payload,
		Checkpoint: map[string]any{"phase": "queued", "workCode": requestedCode}, Recoverable: true, MaxRetries: 3, ProgressTotal: 5,
	})
	if err != nil {
		return remoteWorkTrackResult{}, err
	}
	if err := subscribeRemoteTrackNotification(ctx, tx, userID, runID, nil, requestedCode); err != nil {
		return remoteWorkTrackResult{}, err
	}
	return remoteWorkTrackResult{
		RunID: runID, JobID: jobID, PrimaryCode: requestedCode, Status: "queued", TriggerReason: triggerReason,
	}, nil
}

func activeRemoteWorkTrack(ctx context.Context, queryer rowQueryer, sourceID int64, requestedCode string) (remoteWorkTrackResult, bool, error) {
	var result remoteWorkTrackResult
	var workID sql.NullInt64
	err := queryer.QueryRowContext(ctx, `
		SELECT run.id, job.id, run.status,
			NULLIF(CAST(json_extract(run.summary_json, '$.work_id') AS INTEGER), 0)
		FROM workflow_run AS run
		INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id
		WHERE run.workflow_code = 'remote_source_sync'
			AND run.status IN ('queued', 'running')
			AND job.worker_type = 'remote_source_track'
			AND CAST(json_extract(run.input_json, '$.source_id') AS INTEGER) = ?
			AND UPPER(CAST(json_extract(run.input_json, '$.work_code') AS TEXT)) = ?
		ORDER BY run.id DESC
		LIMIT 1
	`, sourceID, strings.ToUpper(strings.TrimSpace(requestedCode))).Scan(&result.RunID, &result.JobID, &result.Status, &workID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkTrackResult{}, false, nil
	}
	if err != nil {
		return remoteWorkTrackResult{}, false, err
	}
	if workID.Valid {
		result.WorkID = &workID.Int64
	}
	result.PrimaryCode = strings.ToUpper(strings.TrimSpace(requestedCode))
	return result, true, nil
}

type preparedRemoteWorkTrack struct {
	RequestedCode string
	WorkCode      string
	Source        remoteSourceForUse
	RemoteWork    kikoeru.Work
	RawWork       json.RawMessage
	Tracks        []kikoeru.Track
	CoverCached   bool
}

func (s *Server) prepareRemoteWorkTrack(ctx context.Context, sourceID int64, code string) (preparedRemoteWorkTrack, error) {
	requestedCode := strings.ToUpper(strings.TrimSpace(code))
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return preparedRemoteWorkTrack{}, fmt.Errorf("source not found")
		}
		return preparedRemoteWorkTrack{}, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return preparedRemoteWorkTrack{}, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := s.kikoeruCrawlClientForSource(source)
	remoteWork, rawWork, err := s.resolveRemoteWorkForAccess(ctx, client, requestedCode)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		}
		return preparedRemoteWorkTrack{}, err
	}
	tracks, _, err := client.Tracks(ctx, remoteWork.ID)
	if err != nil {
		_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		return preparedRemoteWorkTrack{}, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	workCode := strings.ToUpper(strings.TrimSpace(normalizedRemoteWorkCode(remoteWork)))
	if workCode == "" {
		workCode = requestedCode
	}
	coverCached := true
	coverURL := firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL)
	if coverURL != "" {
		coverCached = s.downloadRemoteCover(ctx, source, workCode, coverURL) == nil
	}
	return preparedRemoteWorkTrack{
		RequestedCode: requestedCode,
		WorkCode:      workCode,
		Source:        source,
		RemoteWork:    remoteWork,
		RawWork:       rawWork,
		Tracks:        tracks,
		CoverCached:   coverCached,
	}, nil
}

func persistRemoteWorkSync(ctx context.Context, tx *sql.Tx, prepared preparedRemoteWorkTrack, tracked bool) (int64, int, int, error) {
	workID, err := upsertRemoteWork(ctx, tx, prepared.Source, prepared.RemoteWork, prepared.RawWork, true)
	if err != nil {
		return 0, 0, 0, err
	}
	if err := upsertAvailableRemoteSourcePresence(ctx, tx, prepared.Source, prepared.RemoteWork, workID); err != nil {
		return 0, 0, 0, err
	}
	if tracked {
		if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
			WorkID:       workID,
			FileSourceID: prepared.Source.ID,
			PresenceType: "tracked",
			RemoteID:     strconv.FormatInt(prepared.RemoteWork.ID, 10),
			RemoteCode:   prepared.WorkCode,
			SourceURL:    prepared.RemoteWork.SourceURL,
			Availability: "available",
			RawJSON:      string(prepared.RawWork),
		}); err != nil {
			return 0, 0, 0, err
		}
	}
	syncedMediaItems, syncedLocations, err := syncRemoteTrackTree(ctx, tx, prepared.Source.ID, workID, prepared.WorkCode, prepared.Tracks)
	if err != nil {
		return 0, 0, 0, err
	}
	return workID, syncedMediaItems, syncedLocations, nil
}

func persistRemoteWorkTrack(ctx context.Context, tx *sql.Tx, prepared preparedRemoteWorkTrack) (int64, int, int, error) {
	return persistRemoteWorkSync(ctx, tx, prepared, true)
}

func (s *Server) runRemoteWorkMaterialize(ctx context.Context, sourceID int64, code string, triggerReason string) (remoteWorkSyncResult, error) {
	return s.runRemoteWorkSyncWithIntent(ctx, sourceID, code, triggerReason, false)
}

func (s *Server) runRemoteWorkSync(ctx context.Context, sourceID int64, code string, triggerReason string) (remoteWorkSyncResult, error) {
	return s.runRemoteWorkSyncWithIntent(ctx, sourceID, code, triggerReason, true)
}

func (s *Server) runRemoteWorkSyncWithIntent(ctx context.Context, sourceID int64, code string, triggerReason string, tracked bool) (remoteWorkSyncResult, error) {
	prepared, err := s.prepareRemoteWorkTrack(ctx, sourceID, code)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	workCode := prepared.WorkCode

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	defer func() { _ = tx.Rollback() }()

	runID, jobID, err := createRemoteWorkSyncWorkflow(ctx, tx, prepared, triggerReason, tracked)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	workID, syncedMediaItems, syncedLocations, err := persistRemoteWorkSync(ctx, tx, prepared, tracked)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := recordRemoteWorkSyncWorkflow(ctx, tx, runID, prepared, tracked, workID, syncedMediaItems, syncedLocations); err != nil {
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
		Tracked:          tracked,
		SyncedMediaItems: syncedMediaItems,
		SyncedLocations:  syncedLocations,
		TriggerReason:    triggerReason,
	}, nil
}

func createRemoteWorkSyncWorkflow(ctx context.Context, tx *sql.Tx, prepared preparedRemoteWorkTrack, triggerReason string, tracked bool) (int64, int64, error) {
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_source_sync", "Track remote source", "Discover remote works, filter candidates, match works, and track remote metadata.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"}, {"id": "discover", "type": "discover_remote_works"},
			{"id": "filter", "type": "filter_candidates"}, {"id": "match", "type": "match_works"},
			{"id": "metadata", "type": "sync_metadata"}, {"id": "tree", "type": "fetch_remote_tree"},
		},
	})
	if err != nil {
		return 0, 0, err
	}
	runInput := map[string]any{
		"file_source_id": prepared.Source.ID, "source_code": prepared.Source.Code, "work_code": prepared.WorkCode,
		"requested_work_code": prepared.RequestedCode, "trigger_reason": triggerReason, "tracked": tracked,
	}
	runDisplayName := "Sync remote source"
	if tracked {
		runDisplayName = "Track remote source"
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_source_sync", runDisplayName, "succeeded", "manual", triggerReason, runInput, map[string]any{"remote_work_id": prepared.RemoteWork.ID, "tracked": tracked})
	if err != nil {
		return 0, 0, err
	}
	selectNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_remote_source", DisplayName: "Select remote source", Position: 1, Status: "succeeded",
		Input: runInput, Output: map[string]any{"file_source_id": prepared.Source.ID, "api_url": prepared.Source.Endpoint.APIURL},
	})
	if err != nil {
		return 0, 0, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: selectNodeID, WorkerType: "kikoeru_remote_sync", Status: "succeeded", Payload: runInput, ProgressCurrent: 1, ProgressTotal: 1,
	})
	return runID, jobID, err
}

func recordRemoteWorkSyncWorkflow(ctx context.Context, tx *sql.Tx, runID int64, prepared preparedRemoteWorkTrack, tracked bool, workID int64, syncedMediaItems, syncedLocations int) error {
	workCode := prepared.WorkCode
	remoteWork := prepared.RemoteWork
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_works", DisplayName: "Discover remote works", Position: 2, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"remote_work_id": remoteWork.ID},
	}); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter candidates", Position: 3, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"accepted": 1, "rejected": 0},
	}); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'remote_work', ?, 'accepted', ?)
	`, runID, workCode, mustJSON(map[string]any{"work_code": workCode, "remote_work_id": remoteWork.ID})); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "match", NodeType: "match_works", DisplayName: "Match works", Position: 4, Status: "succeeded",
		Input: map[string]any{"work_code": workCode}, Output: map[string]any{"work_id": workID, "tracked": tracked},
	}); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "metadata", NodeType: "sync_metadata", DisplayName: "Sync metadata", Position: 5, Status: "succeeded",
		Input: map[string]any{"work_id": workID}, Output: map[string]any{"snapshot_bytes": len(prepared.RawWork)},
	}); err != nil {
		return err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "tree", NodeType: "fetch_remote_tree", DisplayName: "Sync remote directory", Position: 6, Status: "succeeded",
		Input: map[string]any{"work_id": workID, "source_id": prepared.Source.ID}, Output: map[string]any{"media_items": syncedMediaItems, "locations": syncedLocations, "tracked": tracked},
	}); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "UPDATE workflow_run SET summary_json = ? WHERE id = ?", mustJSON(map[string]any{
		"remote_work_id": remoteWork.ID, "tracked": tracked, "media_items": syncedMediaItems, "locations": syncedLocations,
	}), runID)
	return err
}

func (s *Server) executeRemoteWorkTrackJob(ctx context.Context, job workflowJobRecord) error {
	var payload remoteWorkTrackJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if err := s.updateWorkflowJobCheckpoint(ctx, job.ID, "resolving", map[string]any{
		"sourceId": payload.SourceID, "workCode": payload.WorkCode,
	}, 0, 5); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	prepared, err := s.prepareRemoteWorkTrack(ctx, payload.SourceID, payload.WorkCode)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, err := s.finishRemoteWorkTrackJob(ctx, job, payload, prepared)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}

	metadataResult, metadataErr := s.enqueueWorkMetadataSync(context.WithoutCancel(ctx), result.WorkID)
	if metadataErr != nil {
		_ = s.recordWorkflowRunEvent(context.WithoutCancel(ctx), job.RunID, "warn", "track.metadata_followup_failed", "Track succeeded, but metadata refresh could not be queued", map[string]any{
			"work_id": result.WorkID,
		})
		return nil
	}
	_ = s.recordWorkflowRunEvent(context.WithoutCancel(ctx), job.RunID, "info", "track.metadata_followup", "Metadata refresh follow-up recorded", map[string]any{
		"work_id": result.WorkID, "metadata_run_id": metadataResult.RunID, "status": metadataResult.Status,
	})
	return nil
}

func (s *Server) finishRemoteWorkTrackJob(ctx context.Context, job workflowJobRecord, payload remoteWorkTrackJobPayload, prepared preparedRemoteWorkTrack) (remoteWorkSyncResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	workID, syncedMediaItems, syncedLocations, err := persistRemoteWorkTrack(ctx, tx, prepared)
	if err != nil {
		return remoteWorkSyncResult{}, err
	}
	outputs := map[string]any{
		"discover": map[string]any{"remote_work_id": prepared.RemoteWork.ID, "primary_code": prepared.WorkCode},
		"filter":   map[string]any{"accepted": 1, "rejected": 0},
		"match":    map[string]any{"work_id": workID, "tracked": true},
		"metadata": map[string]any{"snapshot_bytes": len(prepared.RawWork), "cover_cached": prepared.CoverCached},
		"sync":     map[string]any{"media_items": syncedMediaItems, "locations": syncedLocations, "forked": true},
	}
	for nodeID, output := range outputs {
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_node_run
			SET status = 'succeeded', output_json = ?, error_message = '',
				started_at = COALESCE(started_at, CURRENT_TIMESTAMP), finished_at = CURRENT_TIMESTAMP
			WHERE workflow_run_id = ? AND node_id = ?
		`, mustJSON(output), job.RunID, nodeID); err != nil {
			return remoteWorkSyncResult{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO workflow_candidate (workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json)
		SELECT ?, id, 'remote_work', ?, 'accepted', ?
		FROM workflow_node_run
		WHERE workflow_run_id = ? AND node_id = 'filter'
	`, job.RunID, prepared.WorkCode, mustJSON(map[string]any{
		"work_code": prepared.WorkCode, "remote_work_id": prepared.RemoteWork.ID,
	}), job.RunID); err != nil {
		return remoteWorkSyncResult{}, err
	}
	summary := map[string]any{
		"source_id": prepared.Source.ID, "source_code": prepared.Source.Code,
		"requested_work_code": prepared.RequestedCode, "primary_code": prepared.WorkCode,
		"remote_work_id": prepared.RemoteWork.ID, "work_id": workID,
		"tracked": true, "forked": true, "media_items": syncedMediaItems, "locations": syncedLocations,
		"cover_cached": prepared.CoverCached,
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'succeeded', progress_current = 5, progress_total = 5,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL,
			checkpoint_json = ?, error_message = '', updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(map[string]any{"phase": "completed", "detail": summary, "progressCurrent": 5, "progressTotal": 5}), job.ID); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(summary), job.RunID); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: "info", Type: "track.completed",
		Message: "Tracked remote work and forked its directory", Detail: summary,
	}); err != nil {
		return remoteWorkSyncResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteWorkSyncResult{}, err
	}
	return remoteWorkSyncResult{
		RunID: job.RunID, JobID: job.ID, WorkID: workID, PrimaryCode: prepared.WorkCode,
		Status: "succeeded", Tracked: true, SyncedMediaItems: syncedMediaItems, SyncedLocations: syncedLocations,
		TriggerReason: payload.TriggerReason,
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
	lockPaths := make([]string, 0, len(cacheLocations))
	seenLockPaths := make(map[string]struct{}, len(cacheLocations))
	for _, location := range cacheLocations {
		cachePaths = append(cachePaths, location.Path)
		lockPath := filepath.ToSlash(strings.TrimSpace(location.Path))
		if _, ok := seenLockPaths[lockPath]; !ok {
			seenLockPaths[lockPath] = struct{}{}
			lockPaths = append(lockPaths, lockPath)
		}
	}
	sort.Strings(lockPaths)
	locks := make([]func(), 0, len(lockPaths))
	defer func() {
		for index := len(locks) - 1; index >= 0; index-- {
			locks[index]()
		}
	}()
	for _, lockPath := range lockPaths {
		release, acquireErr := s.acquireCachePathLock(ctx, lockPath)
		if acquireErr != nil {
			return workSourceUntrackResult{}, acquireErr
		}
		locks = append(locks, release)
	}
	for _, location := range cacheLocations {
		deleted, _, err := s.removeCacheFileUnlocked(location.Path)
		if err != nil {
			return workSourceUntrackResult{}, err
		}
		if !deleted {
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

func (s *Server) runRemotePopularWorkflow(ctx context.Context, userID int64, payload remoteCollectionRunRequest) (remoteCollectionRunResult, error) {
	return s.runRemotePopularWorkflowWithTrigger(ctx, userID, payload, workflowRunTrigger{Type: "manual", Reason: normalizeRemoteCollectionAction(payload.Action)})
}

func (s *Server) runRemotePopularWorkflowWithTrigger(ctx context.Context, userID int64, payload remoteCollectionRunRequest, trigger workflowRunTrigger) (remoteCollectionRunResult, error) {
	action, source, payload, err := s.prepareRemotePopularWorkflow(ctx, payload)
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	return s.enqueueRemotePopularWorkflow(ctx, userID, source, payload, action, trigger)
}

func (s *Server) prepareRemotePopularWorkflow(ctx context.Context, payload remoteCollectionRunRequest) (string, remoteSourceForUse, remoteCollectionRunRequest, error) {
	action := normalizeRemoteCollectionAction(payload.Action)
	if action == "" {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("action must be track or fetch")
	}
	if payload.SourceID <= 0 {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("sourceId is required")
	}
	if payload.Limit <= 0 || payload.Limit > 100 {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("limit must be between 1 and 100")
	}
	source, err := s.remoteCollectionSource(ctx, payload.SourceID)
	if err != nil {
		return "", remoteSourceForUse{}, payload, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("source is not an enabled compatible remote source")
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("source has no API endpoint")
	}
	payload.TagNameTemplate = strings.TrimSpace(payload.TagNameTemplate)
	if payload.TagNameTemplate != "" {
		payload.TagName, err = renderWorkflowTagNameTemplate(payload.TagNameTemplate, map[string]string{
			"date": time.Now().UTC().Format("060102"), "remote_name": workflowTagFragment(source.DisplayName),
			"source_code": workflowTagFragment(source.Code), "action": action,
		})
		if err != nil {
			return "", remoteSourceForUse{}, payload, err
		}
	}
	payload.TagName = strings.TrimSpace(payload.TagName)
	if payload.TagName == "" {
		return "", remoteSourceForUse{}, payload, fmt.Errorf("tagName or tagNameTemplate is required")
	}
	if runes := []rune(payload.TagName); len(runes) > 40 {
		payload.TagName = string(runes[:40])
	}
	return action, source, payload, nil
}

func (s *Server) enqueueRemotePopularWorkflow(ctx context.Context, userID int64, source remoteSourceForUse, payload remoteCollectionRunRequest, action string, trigger workflowRunTrigger) (remoteCollectionRunResult, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "remote_popular_collection", "Collect popular remote works", "Discover popular works from a selected compatible source, track or fetch them, and append a user tag.", remotePopularCollectionDefinition())
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	input := map[string]any{"source_id": source.ID, "collection_kind": "popular", "action": action, "limit": payload.Limit, "tag_name": payload.TagName, "user_id": userID}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "remote_popular_collection", "Collect popular remote works", "queued", trigger.Type, trigger.Reason, input, map[string]any{"source_id": source.ID, "action": action, "limit": payload.Limit, "tag_name": payload.TagName})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	if trigger.ID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", trigger.ID, runID); err != nil {
			return remoteCollectionRunResult{}, err
		}
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "configure", NodeType: "select_remote_source", DisplayName: "Configure remote collection", Position: 1, Status: "succeeded",
		Input: input, Output: map[string]any{"source_id": source.ID, "source_code": source.Code, "action": action, "limit": payload.Limit, "tag_name": payload.TagName},
	}); err != nil {
		return remoteCollectionRunResult{}, err
	}
	discoverNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "discover", NodeType: "discover_remote_collection", DisplayName: "Discover popular works", Position: 2, Status: "queued",
		Input: map[string]any{"source_id": source.ID, "collection_kind": "popular", "page": 1, "page_size": payload.Limit},
	})
	if err != nil {
		return remoteCollectionRunResult{}, err
	}
	for _, node := range []workflow.NodeRunSpec{
		{NodeID: "filter", NodeType: "filter_candidates", DisplayName: "Filter collection candidates", Position: 3, Status: "queued", Input: map[string]any{"limit": payload.Limit}},
		{NodeID: "dispatch", NodeType: "dispatch_child_workflows", DisplayName: "Dispatch accepted works", Position: 4, Status: "queued", Input: map[string]any{"action": action}},
		{NodeID: "tag", NodeType: "assign_user_tags", DisplayName: "Add user tag", Position: 5, Status: "queued", Input: map[string]any{"tag_name": payload.TagName, "user_id": userID}},
	} {
		if _, err := workflow.InsertNodeRun(ctx, tx, runID, node); err != nil {
			return remoteCollectionRunResult{}, err
		}
	}
	result := remoteCollectionRunResult{
		RunID: runID, SourceID: source.ID, CollectionKind: "popular", Action: action, Status: "queued",
		ChildRuns: []int64{}, Failures: []string{}, ExpectedMaximum: payload.Limit, TagName: payload.TagName,
	}
	jobPayload := remoteCollectionJobPayload{UserID: userID, SourceID: source.ID, Action: action, Limit: payload.Limit, TagName: payload.TagName}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: discoverNodeID, WorkerType: "remote_popular_collection", Status: "queued", Priority: workflowJobPriorityForTrigger(trigger.Type), ResourceKey: sourceResourceKey(source.Endpoint.APIURL), Payload: jobPayload,
		Checkpoint: remoteCollectionJobCheckpoint{CompletedCodes: []string{}, Candidates: nil, Result: result}, Recoverable: true, MaxRetries: 3,
	}); err != nil {
		return remoteCollectionRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return remoteCollectionRunResult{}, err
	}
	return result, nil
}

func remotePopularCollectionDefinition() map[string]any {
	return map[string]any{"nodes": []map[string]string{
		{"id": "configure", "type": "select_remote_source", "displayName": "Configure remote collection"},
		{"id": "discover", "type": "discover_remote_collection", "displayName": "Discover popular works"},
		{"id": "filter", "type": "filter_candidates", "displayName": "Filter collection candidates"},
		{"id": "dispatch", "type": "dispatch_child_workflows", "displayName": "Dispatch accepted works"},
		{"id": "tag", "type": "assign_user_tags", "displayName": "Add user tag"},
	}}
}

func (s *Server) executeRemotePopularCollectionJob(ctx context.Context, job workflowJobRecord) error {
	payload, checkpoint, source, nodeIDs, err := s.loadRemotePopularJobState(ctx, job)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result := checkpoint.Result
	result.RunID = job.RunID
	result.SourceID = source.ID
	result.Action = normalizeRemoteCollectionAction(payload.Action)
	result.CollectionKind = "popular"
	result.TagName = payload.TagName
	result.ExpectedMaximum = payload.Limit
	result.Status = "running"
	_, _ = s.db.ExecContext(ctx, "UPDATE workflow_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", job.RunID)

	result, checkpoint, err = s.discoverRemotePopularCandidates(ctx, job, payload, source, nodeIDs, result, checkpoint)
	if err != nil {
		return err
	}

	_, _ = s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id IN (?, ?)", nodeIDs["dispatch"], nodeIDs["tag"])
	result, checkpoint, err = s.dispatchRemotePopularCandidates(ctx, job, payload, source, result, checkpoint)
	if err != nil {
		return err
	}
	result.Status = remoteCollectionResultStatus(result)
	return s.finishRemotePopularCollectionJob(ctx, job, nodeIDs, result)
}

func (s *Server) loadRemotePopularJobState(ctx context.Context, job workflowJobRecord) (remoteCollectionJobPayload, remoteCollectionJobCheckpoint, remoteSourceForUse, map[string]int64, error) {
	var payload remoteCollectionJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		return payload, remoteCollectionJobCheckpoint{}, remoteSourceForUse{}, nil, err
	}
	checkpoint := remoteCollectionJobCheckpoint{}
	if err := decodeWorkflowJobCheckpointDetail(job.CheckpointJSON, &checkpoint); err != nil {
		return payload, checkpoint, remoteSourceForUse{}, nil, err
	}
	source, err := s.remoteCollectionSource(ctx, payload.SourceID)
	if err != nil {
		return payload, checkpoint, remoteSourceForUse{}, nil, err
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	return payload, checkpoint, source, nodeIDs, err
}

func (s *Server) discoverRemotePopularCandidates(ctx context.Context, job workflowJobRecord, payload remoteCollectionJobPayload, source remoteSourceForUse, nodeIDs map[string]int64, result remoteCollectionRunResult, checkpoint remoteCollectionJobCheckpoint) (remoteCollectionRunResult, remoteCollectionJobCheckpoint, error) {
	if checkpoint.Candidates != nil {
		result.Accepted = len(checkpoint.Candidates)
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP) WHERE id = ?", mustJSON(map[string]any{"returned": result.ReturnedCount, "resumed": true}), nodeIDs["discover"])
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP) WHERE id = ?", mustJSON(map[string]any{"accepted": result.Accepted, "skipped": result.Skipped, "resumed": true}), nodeIDs["filter"])
		return result, checkpoint, nil
	}
	_, _ = s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP) WHERE id = ?", nodeIDs["discover"])
	page, err := s.kikoeruCrawlClientForSource(source).PopularWorks(ctx, 1, payload.Limit)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return result, checkpoint, err
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	checkpoint.Candidates = uniqueRemoteCollectionWorks(page.Works, payload.Limit)
	result.Discovered = len(page.Works)
	result.ReturnedCount = len(page.Works)
	result.Accepted = len(checkpoint.Candidates)
	result.Skipped = max(0, len(page.Works)-len(checkpoint.Candidates))
	checkpoint.Result = result
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"returned": len(page.Works), "pagination": page.Pagination}), nodeIDs["discover"]); err != nil {
		return result, checkpoint, err
	}
	if _, err := s.db.ExecContext(ctx, "UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", mustJSON(map[string]any{"accepted": result.Accepted, "skipped": result.Skipped}), nodeIDs["filter"]); err != nil {
		return result, checkpoint, err
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "discovered", checkpoint, len(checkpoint.CompletedCodes), len(checkpoint.Candidates))
	return result, checkpoint, nil
}

type remotePopularCandidateOutcome struct {
	code       string
	workID     int64
	childRunID int64
	tracked    bool
	fetched    bool
	tagged     bool
	failure    string
}

func (s *Server) dispatchRemotePopularCandidates(ctx context.Context, job workflowJobRecord, payload remoteCollectionJobPayload, source remoteSourceForUse, result remoteCollectionRunResult, checkpoint remoteCollectionJobCheckpoint) (remoteCollectionRunResult, remoteCollectionJobCheckpoint, error) {
	completed := make(map[string]bool, len(checkpoint.CompletedCodes))
	for _, code := range checkpoint.CompletedCodes {
		completed[strings.ToUpper(strings.TrimSpace(code))] = true
	}
	for index, work := range checkpoint.Candidates {
		if err := s.ensureWorkflowRunActive(ctx, job.RunID); err != nil {
			return result, checkpoint, err
		}
		code := normalizedRemoteWorkCode(work)
		if code == "" {
			result.Skipped++
			result.Failures = append(result.Failures, "remote work missing stable code")
			continue
		}
		if completed[code] {
			continue
		}
		outcome := s.dispatchRemotePopularCandidate(ctx, job, payload, source, work, code, result.Action)
		if outcome.tracked {
			result.Tracked++
		}
		if outcome.fetched {
			result.Fetched++
			result.ChildRuns = append(result.ChildRuns, outcome.childRunID)
		}
		if outcome.failure != "" {
			result.Failed++
			result.Failures = append(result.Failures, outcome.failure)
		}
		if outcome.tagged {
			result.Tagged++
		}
		completed[code] = true
		checkpoint.CompletedCodes = sortedStringKeys(completed)
		checkpoint.Result = result
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "dispatch", checkpoint, index+1, len(checkpoint.Candidates))
	}
	return result, checkpoint, nil
}

func (s *Server) dispatchRemotePopularCandidate(ctx context.Context, job workflowJobRecord, payload remoteCollectionJobPayload, source remoteSourceForUse, work kikoeru.Work, code, action string) remotePopularCandidateOutcome {
	outcome := remotePopularCandidateOutcome{code: code}
	if action == "track" {
		workID, err := s.trackRemoteCollectionWork(ctx, source, work, "popular", job.RunID)
		if err != nil {
			outcome.failure = fmt.Sprintf("%s: %s", code, err.Error())
			return outcome
		}
		outcome.workID, outcome.tracked = workID, workID > 0
	} else {
		fetchResult, err := s.enqueueRemoteWorkSave(ctx, source.ID, code, []string{}, nil, "", "", nil, 0, payload.UserID, workflow.JobPriorityBackground)
		if err != nil {
			outcome.failure = fmt.Sprintf("%s: %s", code, err.Error())
			return outcome
		}
		outcome.workID, outcome.childRunID, outcome.fetched = fetchResult.WorkID, fetchResult.RunID, true
		_, _ = s.db.ExecContext(ctx, `
			INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
			VALUES (?, 'remote_work', ?, 'accepted', ?)
		`, job.RunID, code, mustJSON(map[string]any{"collection_kind": "popular", "remote_work_id": work.ID, "child_run_id": fetchResult.RunID}))
	}
	if outcome.workID <= 0 {
		outcome.failure = fmt.Sprintf("%s: work was not persisted", code)
		return outcome
	}
	if _, err := s.addWorkUserTag(ctx, payload.UserID, []int64{outcome.workID}, payload.TagName); err != nil {
		outcome.failure = fmt.Sprintf("%s tag: %s", code, err.Error())
		return outcome
	}
	outcome.tagged = true
	return outcome
}

func remoteCollectionResultStatus(result remoteCollectionRunResult) string {
	succeeded := result.Tracked + result.Fetched
	if result.Failed > 0 && succeeded == 0 {
		return "failed"
	}
	if result.Failed > 0 {
		return "partial"
	}
	return "succeeded"
}

func (s *Server) finishRemotePopularCollectionJob(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, result remoteCollectionRunResult) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, mustJSON(map[string]any{"action": result.Action, "tracked": result.Tracked, "fetched": result.Fetched, "child_runs": result.ChildRuns, "failed": result.Failed}), strings.Join(result.Failures, "\n"), nodeIDs["dispatch"]); err != nil {
		return err
	}
	tagStatus := "succeeded"
	succeeded := result.Tracked + result.Fetched
	if result.Tagged < succeeded {
		tagStatus = "partial"
	}
	if result.Tagged == 0 && succeeded > 0 {
		tagStatus = "failed"
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", tagStatus, mustJSON(map[string]any{"tag_name": result.TagName, "tagged": result.Tagged}), nodeIDs["tag"]); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, result.Status, result.Accepted, result.Accepted, strings.Join(result.Failures, "\n"), job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", result.Status, mustJSON(result), job.RunID); err != nil {
		return err
	}
	if result.Status == "succeeded" {
		if err := updateCustomWorkflowTriggerSuccess(ctx, tx, job.RunID); err != nil {
			return err
		}
	} else if err := updateCustomWorkflowTriggerFailure(ctx, tx, job.RunID, strings.Join(result.Failures, "; ")); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) remoteCollectionSource(ctx context.Context, sourceID int64) (remoteSourceForUse, error) {
	if sourceID <= 0 {
		return remoteSourceForUse{}, fmt.Errorf("sourceId is required")
	}
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteSourceForUse{}, fmt.Errorf("source not found")
	}
	return source, err
}

func normalizeRemoteCollectionAction(action string) string {
	switch strings.TrimSpace(action) {
	case "track", "tracked":
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
	workID, err := upsertRemoteWork(ctx, tx, source, remoteWork, rawWork, true)
	if err != nil {
		return 0, err
	}
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: "tracked",
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		RemoteCode:   normalizedRemoteWorkCode(remoteWork),
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

func (s *Server) buildRemoteWorkSavePlan(ctx context.Context, sourceID int64, code string, selectedPaths []string, selectedLocalPaths []string, requestedTargetRoot string, decisions []remoteFetchFileDecision) (remoteWorkSavePlan, error) {
	source, remoteWork, tracks, err := s.loadRemoteWorkTracksCached(ctx, sourceID, code)
	if err != nil {
		return remoteWorkSavePlan{}, err
	}
	return s.buildRemoteWorkSavePlanFromSnapshot(ctx, source, remoteWork, tracks, code, selectedPaths, selectedLocalPaths, requestedTargetRoot, decisions)
}

func (s *Server) buildRemoteWorkSavePlanFromSnapshot(ctx context.Context, source remoteSourceForUse, remoteWork kikoeru.Work, tracks []kikoeru.Track, code string, selectedPaths []string, selectedLocalPaths []string, requestedTargetRoot string, decisions []remoteFetchFileDecision) (remoteWorkSavePlan, error) {
	inputs, err := s.prepareRemoteFetchPlanInputs(ctx, source, remoteWork, tracks, code, selectedPaths, selectedLocalPaths, requestedTargetRoot, decisions)
	if err != nil {
		return remoteWorkSavePlan{}, err
	}
	seenTargets := map[string]string{}
	remoteItems, err := s.buildRemoteFetchPlanItems(ctx, source, inputs, seenTargets)
	if err != nil {
		return remoteWorkSavePlan{}, err
	}
	localItems, err := s.buildLocalFetchPlanItems(inputs, seenTargets)
	if err != nil {
		return remoteWorkSavePlan{}, err
	}
	items := append(remoteItems, localItems...)
	plan := remoteWorkSavePlan{
		SourceID: source.ID, PrimaryCode: inputs.workCode, SaveRoot: inputs.saveRoot,
		LocalFiles: inputs.localFiles, Items: items,
	}
	validateResolvedFetchTargets(plan.Items)
	plan.Summary = summarizeRemoteSavePlan(plan.Items)
	if err := s.attachRemoteFetchRootReview(ctx, source, &plan); err != nil {
		return remoteWorkSavePlan{}, err
	}
	return plan, nil
}

func (s *Server) enqueueRemoteWorkSave(ctx context.Context, sourceID int64, code string, selectedPaths []string, selectedLocalPaths []string, targetRoot string, requestID string, decisions []remoteFetchFileDecision, minFreeBytes int64, requestedByUserID int64, jobPriority int) (remoteWorkSaveResult, error) {
	requestedCode := strings.ToUpper(strings.TrimSpace(code))
	if existing, found, err := activeRemoteFetchResult(ctx, s.db, requestedCode); err != nil {
		return remoteWorkSaveResult{}, err
	} else if found {
		if err := subscribeRemoteFetchNotification(ctx, s.db, requestedByUserID, existing.RunID, existing.WorkID, existing.PrimaryCode); err != nil {
			return remoteWorkSaveResult{}, err
		}
		return existing, nil
	}
	if s.db != nil {
		// Background Fetch runs may not have a preceding plan request.
		_ = s.ensureRemoteFetchMetadata(ctx, requestedCode)
	}
	prep, err := s.prepareRemoteWorkSaveEnqueue(ctx, sourceID, code, selectedPaths, selectedLocalPaths, targetRoot, requestID, decisions, minFreeBytes, requestedByUserID, jobPriority)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	return s.enqueuePreparedRemoteWorkSave(ctx, prep)
}

type rowQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func activeRemoteFetchResult(ctx context.Context, queryer rowQueryer, workCode string) (remoteWorkSaveResult, bool, error) {
	workCode = strings.ToUpper(strings.TrimSpace(workCode))
	if workCode == "" {
		return remoteWorkSaveResult{}, false, nil
	}
	var result remoteWorkSaveResult
	var planJSON string
	err := queryer.QueryRowContext(ctx, `
		SELECT run.id,
			job.id,
			COALESCE(manifest.work_id, 0),
			COALESCE(CAST(json_extract(run.input_json, '$.work_code') AS TEXT), ''),
			run.status,
			COALESCE(manifest.target_root, ''),
			COALESCE(manifest.plan_json, '{}'),
			COALESCE(CAST(json_extract(run.input_json, '$.request_id') AS TEXT), '')
		FROM workflow_run AS run
		INNER JOIN workflow_job AS job
			ON job.workflow_run_id = run.id AND job.worker_type = 'remote_work_fetch'
		LEFT JOIN remote_fetch_manifest AS manifest ON manifest.workflow_run_id = run.id
		WHERE run.workflow_code = 'remote_work_fetch'
			AND (
				run.status IN ('queued', 'running')
				OR (
					run.status = 'partial'
					AND EXISTS (
						SELECT 1
						FROM workflow_candidate AS candidate
						WHERE candidate.workflow_run_id = run.id
							AND candidate.candidate_type = 'remote_origin_blocked'
							AND candidate.status = 'pending'
					)
				)
			)
			AND UPPER(COALESCE(CAST(json_extract(run.input_json, '$.work_code') AS TEXT), '')) = ?
		ORDER BY run.id ASC
		LIMIT 1
	`, workCode).Scan(&result.RunID, &result.JobID, &result.WorkID, &result.PrimaryCode, &result.Status, &result.SaveRoot, &planJSON, &result.RequestID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkSaveResult{}, false, nil
	}
	if err != nil {
		return remoteWorkSaveResult{}, false, err
	}
	var plan remoteWorkSavePlan
	if json.Unmarshal([]byte(planJSON), &plan) == nil {
		result.Plan = plan.Summary
	}
	result.Deduplicated = true
	return result, true, nil
}

func upsertAvailableRemoteSourcePresence(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, remoteWork kikoeru.Work, workID int64) error {
	code := normalizedRemoteWorkCode(remoteWork)
	return upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: sourcePresenceTypeRemoteSource,
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		RemoteCode:   code,
		SourceURL:    remoteWork.SourceURL,
		Availability: "available",
		RawJSON: mustJSON(map[string]any{
			"status":       "available",
			"primary_code": code,
			"title":        firstNonEmpty(remoteWork.Title, remoteWork.Name, code),
			"cover_url":    firstNonEmpty(remoteWork.MainCoverURL, remoteWork.SamCoverURL, remoteWork.ThumbnailCoverURL),
		}),
	})
}

func remoteWorkFetchDefinition() map[string]any {
	return map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_remote_source"},
			{"id": "tree", "type": "fetch_remote_tree"},
			{"id": "plan", "type": "plan_save"},
			{"id": "cache", "type": "materialize_cache"},
			{"id": "stage", "type": "stage_fetch_result"},
			{"id": "verify", "type": "verify_files"},
			{"id": "promote", "type": "publish_staged_fetch"},
			{"id": "sync", "type": "sync_file_locations"},
			{"id": "cleanup", "type": "cleanup_cache"},
		},
	}
}

func (s *Server) executeRemoteWorkFetchJob(ctx context.Context, job workflowJobRecord) error {
	var payload remoteWorkFetchJobPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, err := s.runRemoteWorkFetchJob(ctx, job.RunID, job.ID, payload)
	if err != nil {
		var reviewErr remoteOriginReviewError
		if errors.As(err, &reviewErr) {
			slog.Info("remote work fetch paused for source policy review", "run_id", job.RunID, "job_id", job.ID, "origin", reviewErr.Origin)
			return err
		}
		slog.Error("remote work fetch job failed", "run_id", job.RunID, "job_id", job.ID, "error", err)
		return err
	}
	slog.Info("remote work fetch job completed", "run_id", result.RunID, "job_id", result.JobID, "work_code", result.PrimaryCode)
	return nil
}

func (s *Server) runRemoteWorkFetchJob(ctx context.Context, runID int64, jobID int64, payload remoteWorkFetchJobPayload) (remoteWorkSaveResult, error) {
	execution, err := s.prepareRemoteWorkFetchExecution(ctx, runID, jobID, payload)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, workflowJobRecord{ID: jobID, RunID: runID}, err.Error())
		return remoteWorkSaveResult{}, err
	}
	counts, err := s.materializeRemoteWorkFetch(ctx, runID, jobID, execution)
	if err != nil {
		return remoteWorkSaveResult{}, err
	}
	// Materialization can downgrade a stale cache hit to a download after the
	// durable plan was created. Recompute the summary before publication and
	// the terminal workflow result reflects the action that actually ran.
	execution.plan.Summary = summarizeRemoteSavePlan(execution.plan.Items)
	return s.finalizeRemoteWorkFetch(ctx, runID, jobID, execution, counts)
}

func (s *Server) updateRemoteFetchCacheProgress(ctx context.Context, nodeRunID int64, current int, total int, item remoteWorkSavePlanItem, written int64) error {
	output := map[string]any{
		"current": current, "total": total, "item_key": item.ItemKey,
		"action": item.Action, "cache_path": item.CachePath, "target_path": item.TargetPath,
	}
	var bytesCurrent, bytesTotal int64
	var unknownItems int
	if err := s.db.QueryRowContext(ctx, `
		SELECT progress_bytes_current, progress_bytes_total, progress_bytes_unknown_items
		FROM workflow_job
		WHERE workflow_node_run_id = ? AND worker_type = 'remote_work_fetch'
		ORDER BY id DESC LIMIT 1
	`, nodeRunID).Scan(&bytesCurrent, &bytesTotal, &unknownItems); err == nil {
		output["bytes_current"] = bytesCurrent
		output["bytes_total"] = bytesTotal
		output["bytes_unknown_items"] = unknownItems
	}
	if written > 0 {
		output["bytes"] = written
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'running', output_json = ?, started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
		WHERE id = ?
	`, mustJSON(output), nodeRunID)
	return err
}

func (s *Server) preparePersistedRemoteWorkFetchJob(ctx context.Context, runID int64, manifest remoteFetchManifestRecord) (int64, int64, int64, int64, int64, int64, error) {
	if manifest.WorkID <= 0 || manifest.LocalSourceID <= 0 {
		return 0, 0, 0, 0, 0, 0, fmt.Errorf("remote fetch manifest is missing persisted work locations")
	}
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, runID)
	if err != nil {
		return 0, 0, 0, 0, 0, 0, err
	}
	cacheNodeID := nodeIDs["cache"]
	promoteNodeID := nodeIDs["promote"]
	syncNodeID := nodeIDs["sync"]
	if cacheNodeID == 0 || promoteNodeID == 0 || syncNodeID == 0 {
		return 0, 0, 0, 0, 0, 0, fmt.Errorf("remote fetch workflow nodes are incomplete")
	}
	return manifest.WorkID, manifest.LocalSourceID, cacheNodeID, promoteNodeID, syncNodeID, nodeIDs["cleanup"], nil
}

func (s *Server) cleanupPromotedFetchCache(ctx context.Context, plan remoteWorkSavePlan, workID int64) (int, error) {
	trackedSources, err := s.trackedFetchSourceIDs(ctx, workID)
	if err != nil {
		return 0, err
	}
	removed := 0
	seen := map[string]bool{}
	for _, item := range plan.Items {
		deleted, err := s.cleanupPromotedFetchCacheItem(ctx, plan.SourceID, item, trackedSources, seen)
		if err != nil {
			return removed, err
		}
		if deleted {
			removed++
		}
	}
	return removed, nil
}

func (s *Server) trackedFetchSourceIDs(ctx context.Context, workID int64) (map[int64]bool, error) {
	trackedSources := map[int64]bool{}
	if workID <= 0 {
		return trackedSources, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT file_source_id
		FROM work_source_presence
		WHERE work_id = ?
			AND presence_type = 'tracked'
			AND availability = 'available'
	`, workID)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var sourceID int64
		if err := rows.Scan(&sourceID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		trackedSources[sourceID] = true
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return trackedSources, nil
}

func (s *Server) cleanupPromotedFetchCacheItem(
	ctx context.Context,
	defaultSourceID int64,
	item remoteWorkSavePlanItem,
	trackedSources map[int64]bool,
	seen map[string]bool,
) (bool, error) {
	if item.Action != "cache_hit" && item.Action != "cache_download" {
		return false, nil
	}
	sourceID := item.RemoteSourceID
	if sourceID <= 0 {
		sourceID = defaultSourceID
	}
	if trackedSources[sourceID] {
		return false, nil
	}
	key := fmt.Sprintf("%d:%s", sourceID, item.CachePath)
	if seen[key] {
		return false, nil
	}
	seen[key] = true
	releaseCacheLock, err := s.acquireCachePathLock(ctx, item.CachePath)
	if err != nil {
		return false, err
	}
	defer releaseCacheLock()
	var locationID int64
	err = s.db.QueryRowContext(ctx, `
		SELECT id FROM media_file_location
		WHERE file_source_id = ? AND location_type = 'cache' AND path = ?
		ORDER BY availability = 'available' DESC, id DESC LIMIT 1
	`, sourceID, item.CachePath).Scan(&locationID)
	if errors.Is(err, sql.ErrNoRows) {
		deleted, _, removeErr := s.removeCacheFileUnlocked(item.CachePath)
		if removeErr != nil {
			return false, removeErr
		}
		if err := s.markCacheLocationUnavailable(ctx, sourceID, item.CachePath); err != nil {
			return false, err
		}
		return deleted, nil
	}
	if err != nil {
		return false, err
	}
	_, deleted, err := s.clearCacheLocationUnlocked(ctx, locationID, item.CachePath)
	return deleted, err
}

func workflowNodeIDsByNodeID(ctx context.Context, db *sql.DB, runID int64) (map[string]int64, error) {
	rows, err := db.QueryContext(ctx, `
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

type remoteSaveFile struct {
	Path        string
	Kind        string
	StreamURL   string
	DownloadURL string
	SizeBytes   *int64
	Hash        string
}

func (s *Server) remoteFetchSourceOptions(ctx context.Context, primary remoteSourceForUse, workCode string, primaryFiles []remoteSaveFile) map[string][]remoteFetchSourceOption {
	result := map[string][]remoteFetchSourceOption{}
	primaryPathByHash := primaryRemoteFetchPathsByHash(primaryFiles)
	appendRemoteFetchSourceOptions(result, primary, primaryFiles, primaryPathByHash, false)
	s.appendRemoteFetchAlternativeSources(ctx, result, primary, workCode, primaryPathByHash)
	sortRemoteFetchSourceOptions(result, primary.ID)
	return result
}

func primaryRemoteFetchPathsByHash(files []remoteSaveFile) map[string]string {
	paths := map[string]string{}
	for _, file := range files {
		if hash := strings.TrimSpace(file.Hash); hash != "" {
			if _, duplicate := paths[hash]; duplicate {
				paths[hash] = ""
			} else {
				paths[hash] = file.Path
			}
		}
	}
	return paths
}

func appendRemoteFetchSourceOptions(result map[string][]remoteFetchSourceOption, source remoteSourceForUse, files []remoteSaveFile, primaryPathByHash map[string]string, matchPrimary bool) {
	for _, file := range files {
		groupPath := file.Path
		if matchPrimary && strings.TrimSpace(file.Hash) != "" {
			if matched := primaryPathByHash[strings.TrimSpace(file.Hash)]; matched != "" {
				groupPath = matched
			}
		}
		duplicate := false
		for _, option := range result[groupPath] {
			if option.SourceID == source.ID {
				duplicate = true
				break
			}
		}
		if duplicate {
			continue
		}
		result[groupPath] = append(result[groupPath], remoteFetchSourceOption{
			SourceID: source.ID, SourceCode: source.Code, SourceName: source.DisplayName,
			Path: file.Path, SizeBytes: file.SizeBytes, SourcePath: firstNonEmpty(file.DownloadURL, file.StreamURL), Kind: file.Kind, Hash: file.Hash,
		})
	}
}

func (s *Server) appendRemoteFetchAlternativeSources(ctx context.Context, result map[string][]remoteFetchSourceOption, primary remoteSourceForUse, workCode string, primaryPathByHash map[string]string) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT source.id
		FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE UPPER(work.primary_code) = UPPER(?)
			AND presence.presence_type IN ('source', 'tracked')
			AND presence.availability = 'available'
			AND source.enabled = 1
			AND source.id <> ?
		ORDER BY source.priority ASC, source.id ASC
	`, workCode, primary.ID)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var sourceID int64
			if rows.Scan(&sourceID) != nil {
				continue
			}
			source, remoteWork, tracks, loadErr := s.loadRemoteWorkTracks(ctx, sourceID, workCode)
			if loadErr != nil || !strings.EqualFold(normalizedRemoteWorkCode(remoteWork), workCode) {
				continue
			}
			appendRemoteFetchSourceOptions(result, source, flattenRemoteSaveFiles(tracks), primaryPathByHash, true)
		}
	}
}

func sortRemoteFetchSourceOptions(result map[string][]remoteFetchSourceOption, primaryID int64) {
	for path := range result {
		sort.SliceStable(result[path], func(i, j int) bool {
			if result[path][i].SourceID == primaryID && result[path][j].SourceID != primaryID {
				return true
			}
			if result[path][j].SourceID == primaryID && result[path][i].SourceID != primaryID {
				return false
			}
			return result[path][i].SourceName < result[path][j].SourceName
		})
	}
}

func normalizeRemoteFetchDecisions(decisions []remoteFetchFileDecision) map[string]remoteFetchFileDecision {
	result := map[string]remoteFetchFileDecision{}
	for _, decision := range decisions {
		decision.ItemKey = strings.TrimSpace(decision.ItemKey)
		switch strings.ToLower(strings.TrimSpace(decision.Resolution)) {
		case "", "auto", "keep_local", "replace", "keep_both", "rename", "exclude":
			decision.Resolution = strings.ToLower(strings.TrimSpace(decision.Resolution))
			if decision.Resolution == "" {
				decision.Resolution = "auto"
			}
		default:
			decision.Resolution = "auto"
		}
		if decision.ItemKey != "" {
			result[decision.ItemKey] = decision
		}
	}
	return result
}

func applyRemoteFetchSourceDecision(item *remoteWorkSavePlanItem, decision remoteFetchFileDecision, options []remoteFetchSourceOption, fallback remoteSourceForUse, workCode string) error {
	selectedID := decision.SourceID
	if selectedID <= 0 {
		selectedID = fallback.ID
	}
	var selected *remoteFetchSourceOption
	for index := range options {
		if options[index].SourceID == selectedID {
			selected = &options[index]
			break
		}
	}
	if selected == nil {
		return fmt.Errorf("selected remote source %d does not provide %s", selectedID, item.Path)
	}
	item.RemoteSourceID = selected.SourceID
	item.RemoteSourceCode = selected.SourceCode
	item.RemoteSourceName = selected.SourceName
	item.RemotePath = selected.Path
	item.SourcePath = selected.SourcePath
	item.CachePath = cacheMediaRelPath(selected.SourceCode, workCode, selected.Path)
	item.SizeBytes = selected.SizeBytes
	if selected.Kind != "" {
		item.Kind = selected.Kind
	}
	return nil
}

func normalizeFetchDecisionTarget(saveRoot string, requested string) (string, error) {
	requested = filepath.ToSlash(strings.TrimSpace(requested))
	if requested == "" {
		return "", fmt.Errorf("renamed target path is required")
	}
	if filepath.IsAbs(requested) || filepath.VolumeName(requested) != "" {
		return "", fmt.Errorf("renamed target must stay inside the Fetch root")
	}
	cleaned := filepath.ToSlash(filepath.Clean(filepath.FromSlash(requested)))
	if cleaned == "." || cleaned == ".." || strings.HasPrefix(cleaned, "../") {
		return "", fmt.Errorf("renamed target must stay inside the Fetch root")
	}
	root := strings.Trim(filepath.ToSlash(saveRoot), "/")
	if cleaned != root && !strings.HasPrefix(cleaned, root+"/") {
		cleaned = joinRemotePath(root, cleaned)
	}
	if _, err := fetchPathRelativeToRoot(root, cleaned); err != nil {
		return "", err
	}
	return cleaned, nil
}

func (s *Server) applyRemoteFetchConflictDecision(item *remoteWorkSavePlanItem, decision remoteFetchFileDecision, saveRoot string, seenTargets map[string]string) error {
	resolution := strings.ToLower(strings.TrimSpace(decision.Resolution))
	if resolution == "" {
		resolution = "auto"
	}
	item.Resolution = resolution
	switch resolution {
	case "exclude":
		item.Action = "exclude"
		item.Status = "excluded"
		item.TargetConflict = false
		item.TargetConflictReason = ""
	case "keep_local":
		item.Action = "exclude"
		item.Status = "kept_local"
		item.TargetConflict = false
		item.TargetConflictReason = ""
	case "replace":
		item.Action = ""
		item.Status = "replace_target"
		item.TargetConflict = false
		item.TargetConflictReason = ""
	case "keep_both":
		if !item.TargetConflict {
			return nil
		}
		next, err := s.nextAvailableFetchTarget(item.TargetPath, item.RemoteSourceCode, seenTargets)
		if err != nil {
			return err
		}
		item.TargetPath = next
		item.Action = ""
		item.Status = "keep_both"
		item.TargetConflict = false
		item.TargetConflictReason = ""
		seenTargets[next] = item.Path
	case "rename":
		if _, err := fetchPathRelativeToRoot(saveRoot, item.TargetPath); err != nil {
			return err
		}
	case "auto":
		return nil
	}
	return nil
}

func (s *Server) nextAvailableFetchTarget(targetPath string, sourceCode string, seenTargets map[string]string) (string, error) {
	ext := filepath.Ext(targetPath)
	base := strings.TrimSuffix(targetPath, ext)
	label := strings.Trim(sourceCodePattern.ReplaceAllString(strings.ToLower(sourceCode), "_"), "_")
	if label == "" {
		label = "incoming"
	}
	for index := 1; index <= 9999; index++ {
		suffix := " (" + label + ")"
		if index > 1 {
			suffix = fmt.Sprintf(" (%s %d)", label, index)
		}
		candidate := base + suffix + ext
		if _, exists := seenTargets[candidate]; exists {
			continue
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, candidate)
		if err != nil {
			return "", err
		}
		if _, err := os.Stat(absolute); err == nil || !errors.Is(err, os.ErrNotExist) {
			continue
		}
		return candidate, nil
	}
	return "", fmt.Errorf("could not allocate a keep-both target for %s", targetPath)
}

func remoteFetchPlanSourceIDs(plan remoteWorkSavePlan, fallback int64) []int64 {
	seen := map[int64]bool{}
	if fallback > 0 {
		seen[fallback] = true
	}
	for _, item := range plan.Items {
		if item.RemoteSourceID > 0 && item.Action != "exclude" {
			seen[item.RemoteSourceID] = true
		}
	}
	result := make([]int64, 0, len(seen))
	for sourceID := range seen {
		result = append(result, sourceID)
	}
	sort.Slice(result, func(i, j int) bool { return result[i] < result[j] })
	return result
}

func validateResolvedFetchTargets(items []remoteWorkSavePlanItem) {
	seen := map[string]int{}
	for index := range items {
		item := &items[index]
		if item.Action == "exclude" {
			continue
		}
		if previous, exists := seen[item.TargetPath]; exists {
			item.TargetConflict = true
			item.TargetConflictReason = "multiple resolved files still use the same target path: " + items[previous].ItemKey
			item.Action = "conflict"
			item.Status = "duplicate_target"
			continue
		}
		seen[item.TargetPath] = index
	}
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

func validRemoteFetchRequestID(value string) bool {
	return remoteFetchRequestIDPattern.MatchString(strings.TrimSpace(value))
}

func (s *Server) remoteFetchRequestResult(ctx context.Context, requestID string, sourceID int64, code string) (remoteWorkSaveResult, bool, error) {
	var storedSourceID int64
	var storedCode string
	var raw string
	err := s.db.QueryRowContext(ctx, `
		SELECT source_id, work_code, result_json
		FROM remote_fetch_request
		WHERE request_id = ?
	`, requestID).Scan(&storedSourceID, &storedCode, &raw)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkSaveResult{}, false, nil
	}
	if err != nil {
		return remoteWorkSaveResult{}, false, err
	}
	if storedSourceID != sourceID || !strings.EqualFold(strings.TrimSpace(storedCode), strings.TrimSpace(code)) {
		return remoteWorkSaveResult{}, false, fmt.Errorf("fetch request id was already used for another work")
	}
	var result remoteWorkSaveResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return remoteWorkSaveResult{}, false, err
	}
	result.Deduplicated = true
	return result, true, nil
}

func remoteWorkCodeFromPath(r *http.Request) string {
	return strings.TrimSpace(r.PathValue("code"))
}

func (s *Server) loadRemoteWorkTracks(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	source, remoteWork, err := s.loadRemoteWork(ctx, sourceID, code)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	tracks, err := s.loadRemoteTracks(ctx, source, remoteWork)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	return source, remoteWork, tracks, nil
}

func (s *Server) loadRemoteWork(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, error) {
	source, err := s.loadRemoteSourceForUse(ctx, sourceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return remoteSourceForUse{}, kikoeru.Work{}, fmt.Errorf("source not found")
		}
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
		return remoteSourceForUse{}, kikoeru.Work{}, fmt.Errorf("source is not an enabled kikoeru-compatible source")
	}
	client := s.kikoeruClientForSource(source)
	remoteWork, _, err := s.resolveRemoteWorkForAccess(ctx, client, code)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			_ = s.updateSourceHealth(ctx, sourceID, "unavailable")
		}
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	_ = s.updateSourceHealth(ctx, sourceID, "healthy")
	return source, remoteWork, nil
}

func (s *Server) loadRemoteTracks(ctx context.Context, source remoteSourceForUse, work kikoeru.Work) ([]kikoeru.Track, error) {
	tracks, _, err := s.kikoeruClientForSource(source).Tracks(ctx, work.ID)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		return nil, err
	}
	return tracks, nil
}

func (s *Server) loadRemoteWorkCached(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, error) {
	key := remoteWorkCacheKey(sourceID, code)
	now := time.Now()
	s.remoteWorkCacheMu.Lock()
	snapshot, found := s.remoteWorkCache[key]
	if found && now.Before(snapshot.ExpiresAt) {
		s.remoteWorkCacheMu.Unlock()
		return snapshot.Source, snapshot.Work, nil
	}
	if found {
		delete(s.remoteWorkCache, key)
	}
	if call := s.remoteWorkCacheCalls[key]; call != nil {
		s.remoteWorkCacheMu.Unlock()
		select {
		case <-ctx.Done():
			return remoteSourceForUse{}, kikoeru.Work{}, ctx.Err()
		case <-call.done:
			return call.source, call.work, call.err
		}
	}
	call := &remoteWorkCall{done: make(chan struct{})}
	s.remoteWorkCacheCalls[key] = call
	s.remoteWorkCacheMu.Unlock()

	source, work, err := s.loadRemoteWork(ctx, sourceID, code)
	call.source, call.work, call.err = source, work, err
	defer func() {
		s.remoteWorkCacheMu.Lock()
		delete(s.remoteWorkCacheCalls, key)
		close(call.done)
		s.remoteWorkCacheMu.Unlock()
	}()
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, err
	}
	s.remoteWorkCacheMu.Lock()
	pruneRemoteWorkSnapshots(s.remoteWorkCache, now)
	if len(s.remoteWorkCache) >= 64 {
		deleteOldestRemoteWorkSnapshot(s.remoteWorkCache)
	}
	s.remoteWorkCache[key] = remoteWorkSnapshot{Source: source, Work: work, ExpiresAt: now.Add(2 * time.Minute)}
	s.remoteWorkCacheMu.Unlock()
	return source, work, nil
}

func (s *Server) loadRemoteWorkTracksCached(ctx context.Context, sourceID int64, code string) (remoteSourceForUse, kikoeru.Work, []kikoeru.Track, error) {
	source, work, err := s.loadRemoteWorkCached(ctx, sourceID, code)
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	key := remoteWorkCacheKey(sourceID, code)
	now := time.Now()
	s.remoteWorkCacheMu.Lock()
	snapshot, found := s.remoteWorkTracksCache[key]
	if found && now.Before(snapshot.ExpiresAt) {
		s.remoteWorkCacheMu.Unlock()
		return snapshot.Source, snapshot.Work, snapshot.Tracks, nil
	}
	if found {
		delete(s.remoteWorkTracksCache, key)
	}
	if call := s.remoteWorkTracksCacheCalls[key]; call != nil {
		s.remoteWorkCacheMu.Unlock()
		select {
		case <-ctx.Done():
			return remoteSourceForUse{}, kikoeru.Work{}, nil, ctx.Err()
		case <-call.done:
			return call.source, call.work, call.tracks, call.err
		}
	}
	call := &remoteWorkTracksCall{done: make(chan struct{})}
	s.remoteWorkTracksCacheCalls[key] = call
	s.remoteWorkCacheMu.Unlock()

	tracks, err := s.loadRemoteTracks(ctx, source, work)
	call.source, call.work, call.tracks, call.err = source, work, tracks, err
	defer func() {
		s.remoteWorkCacheMu.Lock()
		delete(s.remoteWorkTracksCacheCalls, key)
		close(call.done)
		s.remoteWorkCacheMu.Unlock()
	}()
	if err != nil {
		return remoteSourceForUse{}, kikoeru.Work{}, nil, err
	}
	s.remoteWorkCacheMu.Lock()
	pruneRemoteWorkTracksSnapshots(s.remoteWorkTracksCache, now)
	if len(s.remoteWorkTracksCache) >= 64 {
		deleteOldestRemoteWorkTracksSnapshot(s.remoteWorkTracksCache)
	}
	s.remoteWorkTracksCache[key] = remoteWorkTracksSnapshot{Source: source, Work: work, Tracks: tracks, ExpiresAt: now.Add(2 * time.Minute)}
	s.remoteWorkCacheMu.Unlock()
	return source, work, tracks, nil
}

type remoteWorkCall struct {
	done   chan struct{}
	source remoteSourceForUse
	work   kikoeru.Work
	err    error
}

type remoteWorkTracksCall struct {
	done   chan struct{}
	source remoteSourceForUse
	work   kikoeru.Work
	tracks []kikoeru.Track
	err    error
}

func remoteWorkCacheKey(sourceID int64, code string) string {
	return fmt.Sprintf("%d:%s", sourceID, strings.ToUpper(strings.TrimSpace(code)))
}

func pruneRemoteWorkSnapshots(snapshots map[string]remoteWorkSnapshot, now time.Time) {
	for key, snapshot := range snapshots {
		if !now.Before(snapshot.ExpiresAt) {
			delete(snapshots, key)
		}
	}
}

func pruneRemoteWorkTracksSnapshots(snapshots map[string]remoteWorkTracksSnapshot, now time.Time) {
	for key, snapshot := range snapshots {
		if !now.Before(snapshot.ExpiresAt) {
			delete(snapshots, key)
		}
	}
}

func deleteOldestRemoteWorkSnapshot(snapshots map[string]remoteWorkSnapshot) {
	oldestKey := ""
	var oldestExpiry time.Time
	for key, snapshot := range snapshots {
		if oldestKey == "" || snapshot.ExpiresAt.Before(oldestExpiry) {
			oldestKey, oldestExpiry = key, snapshot.ExpiresAt
		}
	}
	if oldestKey != "" {
		delete(snapshots, oldestKey)
	}
}

func deleteOldestRemoteWorkTracksSnapshot(snapshots map[string]remoteWorkTracksSnapshot) {
	oldestKey := ""
	var oldestExpiry time.Time
	for key, snapshot := range snapshots {
		if oldestKey == "" || snapshot.ExpiresAt.Before(oldestExpiry) {
			oldestKey, oldestExpiry = key, snapshot.ExpiresAt
		}
	}
	if oldestKey != "" {
		delete(snapshots, oldestKey)
	}
}

func (s *Server) invalidateRemoteWorkCache(sourceID int64) {
	prefix := strconv.FormatInt(sourceID, 10) + ":"
	s.remoteWorkCacheMu.Lock()
	defer s.remoteWorkCacheMu.Unlock()
	for key := range s.remoteWorkCache {
		if strings.HasPrefix(key, prefix) {
			delete(s.remoteWorkCache, key)
		}
	}
	for key := range s.remoteWorkTracksCache {
		if strings.HasPrefix(key, prefix) {
			delete(s.remoteWorkTracksCache, key)
		}
	}
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
		template = s.settingStringContext(context.Background(), "remote_save_root_template", defaultRemoteSaveRootTemplate)
	}
	if template == "" {
		template = defaultRemoteSaveRootTemplate
	}
	prefix, group := workCodeShard(workCode)
	value := replaceRemoteFetchSourceTokens(template, source.Code)
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
			kind := remoteTrackKindForPath(node.Type, path)
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
				Hash:        strings.TrimSpace(node.Hash),
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
	if _, err := db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = json_patch(COALESCE(NULLIF(output_json, ''), '{}'), ?), error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, errorMessage, nodeID); err != nil {
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
	if _, err = s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET size_bytes = ?,
			availability = 'available',
			last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ?
			AND file_source_id = ?
			AND location_type = 'local'
			AND path = ?
	`, size, mediaItemID, localSourceID, item.TargetPath); err != nil {
		return err
	}
	if item.Kind == "video" {
		duration, hasAudio, ok := s.probeMediaMetadataSeconds(ctx, targetAbsPath)
		if ok {
			var durationValue any
			if duration > 0 {
				durationValue = duration
			}
			if _, err := s.db.ExecContext(ctx, `
				UPDATE media_item SET duration_seconds = COALESCE(?, duration_seconds), has_audio = ? WHERE id = ?
			`, durationValue, hasAudio, mediaItemID); err != nil {
				return err
			}
			if _, err := s.db.ExecContext(ctx, `
				UPDATE media_file_location SET duration_seconds = COALESCE(?, duration_seconds) WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'local' AND path = ?
			`, durationValue, mediaItemID, localSourceID, item.TargetPath); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) finishFetchPresence(ctx context.Context, workID int64, remoteSourceIDs []int64, localSourceID int64, workCode string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, remoteSourceID := range remoteSourceIDs {
		if remoteSourceID <= 0 {
			continue
		}
		if err := ensureFetchSourcePresence(ctx, tx, workID, remoteSourceID, workCode); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			DELETE FROM media_file_location
			WHERE file_source_id = ? AND location_type = 'remote_stream'
				AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
		`, remoteSourceID, workID); err != nil {
			return err
		}
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
	if err := tx.Commit(); err != nil {
		return err
	}
	return s.cleanupFetchCacheWithoutTrackedPresence(ctx, workID, remoteSourceIDs)
}

// Fetch records source availability and local materialization. It does not
// create tracked intent; only an already active tracked source owns its cache.
func (s *Server) cleanupFetchCacheWithoutTrackedPresence(ctx context.Context, workID int64, sourceIDs []int64) error {
	for _, sourceID := range sourceIDs {
		if sourceID <= 0 {
			continue
		}
		var tracked int
		if err := s.db.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT 1
				FROM work_source_presence
				WHERE work_id = ? AND file_source_id = ?
					AND presence_type = 'tracked' AND availability = 'available'
			)
		`, workID, sourceID).Scan(&tracked); err != nil {
			return err
		}
		if tracked != 0 {
			continue
		}
		locations, err := s.cacheLocationsForWorkSource(ctx, workID, sourceID)
		if err != nil {
			return err
		}
		for _, location := range locations {
			if _, _, err := s.clearCacheLocation(ctx, location.ID, location.Path); err != nil {
				return err
			}
		}
	}
	return nil
}

func ensureFetchSourcePresence(ctx context.Context, tx *sql.Tx, workID int64, sourceID int64, workCode string) error {
	var found int
	err := tx.QueryRowContext(ctx, `
		SELECT 1
		FROM work_source_presence
		WHERE work_id = ? AND file_source_id = ? AND presence_type = ?
		LIMIT 1
	`, workID, sourceID, sourcePresenceTypeRemoteSource).Scan(&found)
	if err == nil {
		_, updateErr := tx.ExecContext(ctx, `
			UPDATE work_source_presence
			SET remote_code = COALESCE(NULLIF(?, ''), remote_code),
				availability = 'available',
				last_seen_at = CURRENT_TIMESTAMP,
				last_checked_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
			WHERE work_id = ? AND file_source_id = ? AND presence_type = ?
		`, normalizeDLsiteCode(workCode), workID, sourceID, sourcePresenceTypeRemoteSource)
		return updateErr
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID: workID, FileSourceID: sourceID, PresenceType: sourcePresenceTypeRemoteSource,
		RemoteCode: workCode, Availability: "available",
		RawJSON: mustJSON(map[string]any{"source": "remote_fetch", "primary_code": workCode}),
	})
}

func (s *Server) insertFetchCleanupCandidate(ctx context.Context, runID int64, workID int64, localSourceID int64, workCode string, items []remoteWorkSavePlanItem) error {
	archivedRoots, err := s.quarantineFetchLocalRoots(ctx, runID, workID, localSourceID, items)
	if err != nil {
		return err
	}
	if len(archivedRoots) > 0 {
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
			SELECT ?, 'local_fetch_merge_cleanup', ?, 'pending', ?
			WHERE NOT EXISTS (
				SELECT 1 FROM workflow_candidate
				WHERE workflow_run_id = ? AND candidate_type = 'local_fetch_merge_cleanup'
			)
		`, runID, workCode, mustJSON(map[string]any{
			"work_id": workID, "work_code": workCode, "local_source_id": localSourceID,
			"archived_roots": archivedRoots,
			"message":        "Old local roots were archived after Fetch. Keep the archive or permanently delete it after review.",
		}), runID)
		return err
	}
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

func (s *Server) quarantineFetchLocalRoots(ctx context.Context, runID int64, workID int64, localSourceID int64, items []remoteWorkSavePlanItem) ([]map[string]any, error) {
	publishedRoot, records, err := s.loadFetchRootsForQuarantine(ctx, workID, localSourceID)
	if err != nil {
		return nil, err
	}
	targetRoots := fetchPlanTargetRoots(items)
	archived := []map[string]any{}
	for _, record := range records {
		item, ok, err := s.quarantineFetchRoot(ctx, runID, workID, localSourceID, publishedRoot, targetRoots, record)
		if err != nil {
			return nil, err
		}
		if !ok {
			continue
		}
		archived = append(archived, item)
	}
	return archived, nil
}

type fetchRootRecord struct {
	id         int64
	path, role string
}

func fetchPlanTargetRoots(items []remoteWorkSavePlanItem) map[string]bool {
	targets := map[string]bool{}
	for _, item := range items {
		path := filepath.ToSlash(strings.TrimSpace(item.TargetPath))
		if path == "" {
			continue
		}
		for _, root := range fetchRootCandidatesForPath(path) {
			targets[root] = true
		}
	}
	return targets
}

func (s *Server) loadFetchRootsForQuarantine(ctx context.Context, workID, localSourceID int64) (string, []fetchRootRecord, error) {
	var publishedRoot string
	if err := s.db.QueryRowContext(ctx, `
		SELECT root_path FROM work_folder_location
		WHERE work_id = ? AND file_source_id = ? AND role = 'managed_fetch' AND state = 'active' AND is_primary = 1
		ORDER BY updated_at DESC, id DESC LIMIT 1
	`, workID, localSourceID).Scan(&publishedRoot); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", nil, err
	}
	publishedRoot = filepath.ToSlash(strings.Trim(publishedRoot, "/"))
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, root_path, role
		FROM work_folder_location
		WHERE work_id = ? AND file_source_id = ? AND state = 'active' AND root_path <> ?
		ORDER BY id ASC
	`, workID, localSourceID, publishedRoot)
	if err != nil {
		return "", nil, err
	}
	defer rows.Close()
	records := []fetchRootRecord{}
	for rows.Next() {
		var record fetchRootRecord
		if err := rows.Scan(&record.id, &record.path, &record.role); err != nil {
			return "", nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return "", nil, err
	}
	return publishedRoot, records, rows.Close()
}

func (s *Server) quarantineFetchRoot(ctx context.Context, runID, workID, localSourceID int64, publishedRoot string, targetRoots map[string]bool, record fetchRootRecord) (map[string]any, bool, error) {
	root := filepath.ToSlash(strings.Trim(record.path, "/"))
	if root == "" || fetchRootsOverlap(root, publishedRoot) || targetRoots[root] {
		return nil, false, nil
	}
	archive := filepath.ToSlash(filepath.Join(".kikoto-trash", "fetch", fmt.Sprintf("%d", runID), fmt.Sprintf("%d-%s", record.id, filepath.Base(filepath.FromSlash(root)))))
	files, totalBytes, ok, err := s.archiveFetchRoot(root, archive)
	if err != nil || !ok {
		return nil, false, err
	}
	if err := s.markFetchRootQuarantined(ctx, runID, workID, localSourceID, record.id, root); err != nil {
		return nil, false, err
	}
	return map[string]any{
		"folder_id": record.id, "original_path": root, "archive_path": archive,
		"role": record.role, "files": files, "file_count": len(files), "size_bytes": totalBytes,
	}, true, nil
}

func (s *Server) archiveFetchRoot(root, archive string) ([]map[string]any, int64, bool, error) {
	sourcePath, err := safeDataPath(s.cfg.DataRoot, root)
	if err != nil {
		return nil, 0, false, err
	}
	archivePath, err := safeDataPath(s.cfg.DataRoot, archive)
	if err != nil {
		return nil, 0, false, err
	}
	info, statErr := os.Lstat(sourcePath)
	if statErr == nil {
		if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
			return nil, 0, false, nil
		}
		files, totalBytes, err := archivedRootFileSummary(sourcePath)
		if err != nil {
			return nil, 0, false, err
		}
		if err := os.MkdirAll(filepath.Dir(archivePath), 0o755); err != nil {
			return nil, 0, false, err
		}
		if err := os.Rename(sourcePath, archivePath); err != nil {
			return nil, 0, false, fmt.Errorf("archive old fetch root %s: %w", root, err)
		}
		return files, totalBytes, true, nil
	}
	if !errors.Is(statErr, os.ErrNotExist) {
		return nil, 0, false, statErr
	}
	if _, archiveErr := os.Stat(archivePath); archiveErr != nil {
		return nil, 0, false, nil
	}
	files, totalBytes, err := archivedRootFileSummary(archivePath)
	return files, totalBytes, err == nil, err
}

func (s *Server) markFetchRootQuarantined(ctx context.Context, runID, workID, localSourceID, folderID int64, root string) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "UPDATE work_folder_location SET state = 'pending_cleanup', cleanup_run_id = ?, is_primary = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?", runID, folderID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET availability = 'unavailable', last_checked_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ? AND location_type = 'local'
			AND media_item_id IN (SELECT id FROM media_item WHERE work_id = ?)
			AND (path = ? OR substr(path, 1, length(?) + 1) = ? || '/')
	`, localSourceID, workID, root, root, root); err != nil {
		return err
	}
	return tx.Commit()
}

func fetchRootCandidatesForPath(path string) []string {
	parts := strings.Split(strings.Trim(filepath.ToSlash(path), "/"), "/")
	result := make([]string, 0, len(parts))
	for index := 1; index < len(parts); index++ {
		result = append(result, strings.Join(parts[:index], "/"))
	}
	return result
}

func fetchRootsOverlap(left string, right string) bool {
	left = strings.Trim(filepath.ToSlash(left), "/")
	right = strings.Trim(filepath.ToSlash(right), "/")
	return left == right || strings.HasPrefix(left, right+"/") || strings.HasPrefix(right, left+"/")
}

func archivedRootFileSummary(root string) ([]map[string]any, int64, error) {
	files := []map[string]any{}
	var totalBytes int64
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("archived root contains unsupported symbolic link: %s", filepath.ToSlash(path))
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		totalBytes += info.Size()
		files = append(files, map[string]any{"path": filepath.ToSlash(relative), "size_bytes": info.Size()})
		return nil
	})
	return files, totalBytes, err
}

func sortedStringKeys(values map[string]bool) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func (s *Server) remoteWorkDetail(ctx context.Context, source remoteSourceForUse, work kikoeru.Work, language string) (remoteWorkDetail, error) {
	return s.remoteWorkDetailWithLanguages(ctx, source, work, []string{language})
}

func (s *Server) remoteWorkDetailWithLanguages(ctx context.Context, source remoteSourceForUse, work kikoeru.Work, languages []string) (remoteWorkDetail, error) {
	projected := newRemoteCatalogProjectorWithLanguages(languages).project(source.ID, work)
	code := projected.RemoteCode
	displayCode := code
	ref, err := s.canonicalWorkForCode(ctx, code)
	if err != nil {
		return remoteWorkDetail{}, err
	}
	var workID *int64
	if ref.Code != "" {
		displayCode = ref.Code
	}
	if ref.Known && ref.WorkID > 0 {
		workID = &ref.WorkID
	}
	status := "remote_only"
	if workID != nil {
		status = "synced"
	}
	releaseDate := ""
	if value, ok := normalizeDate(projected.ReleaseDate).(string); ok {
		releaseDate = value
	}
	return remoteWorkDetail{
		SourceID:         source.ID,
		SourceCode:       source.Code,
		SourceName:       source.DisplayName,
		RemoteID:         projected.RemoteID,
		PrimaryCode:      displayCode,
		RemoteCode:       code,
		Title:            firstNonEmpty(projected.Title, displayCode),
		CoverURL:         projected.CoverURL,
		SourceURL:        projected.SourceURL,
		PublicWorkURL:    publicRemoteWorkURL(source.Endpoint, code),
		Circle:           projected.Circle,
		CircleRef:        projected.CircleRef,
		Rating:           projected.Rating,
		RatingCount:      projected.RatingCount,
		Sales:            projected.Sales,
		Price:            projected.Price,
		AgeRating:        projected.AgeRating,
		ReleaseDate:      releaseDate,
		DurationSeconds:  projected.DurationSeconds,
		Tags:             projected.Tags,
		VoiceActors:      projected.VoiceActors,
		VoiceRefs:        projected.VoiceRefs,
		ImportStatus:     status,
		WorkID:           workID,
		MetadataView:     remoteWorkMetadataPresentation(work, languages),
		LanguageEditions: normalizedRemoteLanguageEditions(work),
	}, nil
}

func (s *Server) remoteWorkTracksDetail(ctx context.Context, source remoteSourceForUse, work kikoeru.Work, tracks []kikoeru.Track) (remoteWorkTracksDetail, error) {
	code := normalizedRemoteWorkCode(work)
	if code == "" {
		code = strings.TrimSpace(work.SourceID)
	}
	locationState, err := s.remoteTrackLocationState(ctx, source.ID, code)
	if err != nil {
		return remoteWorkTracksDetail{}, err
	}
	return remoteWorkTracksDetail{
		SourceID:    source.ID,
		SourceCode:  source.Code,
		SourceName:  source.DisplayName,
		RemoteID:    strconv.FormatInt(work.ID, 10),
		PrimaryCode: code,
		RemoteCode:  code,
		Tracks:      remoteTrackDetails(source.Code, code, tracks, "", locationState),
	}, nil
}

func normalizedRemoteLanguageEditions(work kikoeru.Work) []remoteLanguageEdition {
	currentCode := normalizedRemoteWorkCode(work)
	originOrder := earliestRemoteLanguageEditionOrder(work.LanguageEditions)
	declared := make(map[string]kikoeru.LanguageEdition, len(work.LanguageEditions))
	for _, edition := range work.LanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if customWorkflowWorkCodePattern.MatchString(code) {
			declared[code] = edition
		}
	}
	result := make([]remoteLanguageEdition, 0, len(work.OtherLanguageEditions)+1)
	seen := map[string]bool{}
	if currentCode != "" {
		edition, ok := declared[currentCode]
		item := newRemoteLanguageEdition(edition, currentCode, currentCode, originOrder, !ok)
		item.Label = firstNonEmpty(strings.TrimSpace(work.Title), item.Label, currentCode)
		if originalCode := strings.ToUpper(strings.TrimSpace(work.OriginalWorkNumber)); originalCode != "" {
			item.Origin = strings.EqualFold(originalCode, currentCode)
		}
		result = append(result, item)
		seen[currentCode] = true
	}
	for _, available := range work.OtherLanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(available.SourceID))
		if !customWorkflowWorkCodePattern.MatchString(code) || seen[code] {
			continue
		}
		seen[code] = true
		item := newRemoteLanguageEdition(declared[code], code, currentCode, originOrder, false)
		item.Language = firstNonEmpty(strings.TrimSpace(available.Language), item.Language)
		item.Label = firstNonEmpty(strings.TrimSpace(available.Title), item.Label, item.Language, code)
		item.Origin = available.IsOriginal || item.Origin
		result = append(result, item)
	}
	sort.SliceStable(result, func(i, j int) bool { return remoteLanguageEditionLess(result[i], result[j]) })
	return result
}

func earliestRemoteLanguageEditionOrder(editions kikoeru.LanguageEditionList) int {
	order := 0
	for _, edition := range editions {
		if edition.DisplayOrder > 0 && (order == 0 || edition.DisplayOrder < order) {
			order = edition.DisplayOrder
		}
	}
	return order
}

func newRemoteLanguageEdition(edition kikoeru.LanguageEdition, code, currentCode string, originOrder int, first bool) remoteLanguageEdition {
	origin := edition.DisplayOrder > 0 && edition.DisplayOrder == originOrder
	if originOrder == 0 && first {
		origin = true
	}
	language := strings.TrimSpace(edition.Language)
	return remoteLanguageEdition{
		RemoteCode: code, Language: language, Label: firstNonEmpty(strings.TrimSpace(edition.Label), language, code),
		DisplayOrder: edition.DisplayOrder, Current: strings.EqualFold(code, currentCode), Origin: origin,
	}
}

func remoteLanguageEditionLess(left, right remoteLanguageEdition) bool {
	if left.Origin != right.Origin {
		return left.Origin
	}
	leftOrder, rightOrder := remoteLanguageEditionOrder(left), remoteLanguageEditionOrder(right)
	if leftOrder != rightOrder {
		return leftOrder < rightOrder
	}
	return left.RemoteCode < right.RemoteCode
}

func remoteLanguageEditionOrder(edition remoteLanguageEdition) int {
	if edition.DisplayOrder <= 0 {
		return int(^uint(0) >> 1)
	}
	return edition.DisplayOrder
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
			Type:            remoteTrackKindForPath(track.Type, path),
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
	case ".mp3", ".wav", ".flac", ".m4a", ".wma", ".ogg", ".oga", ".opus", ".aac":
		return "audio"
	case ".mp4", ".m4v", ".webm", ".mkv", ".mov", ".avi", ".wmv", ".flv", ".f4v", ".mpeg", ".mpg", ".mpe", ".m2v", ".m2ts", ".mts", ".ts", ".3gp", ".3g2", ".ogv", ".asf", ".rm", ".rmvb", ".vob", ".divx", ".xvid", ".mxf", ".ogm", ".svi", ".nsv", ".wtv", ".amv", ".mjpeg", ".mjpg", ".dv", ".y4m", ".ismv", ".ism":
		return "video"
	case ".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp":
		return "image"
	case ".txt", ".lrc", ".srt", ".vtt", ".ass":
		return "text"
	default:
		return "file"
	}
}

type remoteWorkFallbackPolicy struct {
	AttachCircleFallback     bool
	UpdateNormalizedMetadata bool
}

func loadRemoteWorkFallbackPolicy(ctx context.Context, tx *sql.Tx, code string) (remoteWorkFallbackPolicy, error) {
	var workID int64
	err := tx.QueryRowContext(ctx, `
		SELECT id
		FROM work
		WHERE UPPER(primary_code) = UPPER(?)
	`, code).Scan(&workID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkFallbackPolicy{
			AttachCircleFallback:     true,
			UpdateNormalizedMetadata: true,
		}, nil
	}
	if err != nil {
		return remoteWorkFallbackPolicy{}, err
	}
	var hasHigherPriorityMetadata, hasAuthoritativeParty, hasManualCircleOverride int
	if err := tx.QueryRowContext(ctx, `
		SELECT
			EXISTS (
				SELECT 1
				FROM metadata_snapshot AS snapshot
				INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
				WHERE snapshot.work_id = ?
					AND provider.code NOT GLOB 'kikoeru_source_*'
				UNION ALL
				SELECT 1
				FROM work_edition AS edition
				INNER JOIN metadata_provider AS provider ON provider.id = edition.provider_id
				WHERE edition.work_id = ? AND provider.code = 'dlsite'
			),
			EXISTS (
				SELECT 1
				FROM work_party
				WHERE work_id = ?
					AND role IN ('circle', 'translator_circle', 'official_translation_brand')
					AND source NOT IN ('remote_source', 'circle_refresh', 'remote_source_catalog')
				UNION ALL
				SELECT 1
				FROM work_edition
				WHERE work_id = ? AND maker_id <> ''
			),
			EXISTS (
				SELECT 1
				FROM work_manual_override
				WHERE work_id = ? AND field_name = 'circle'
				UNION ALL
				SELECT 1
				FROM work_party
				WHERE work_id = ? AND role = 'circle' AND source = 'manual_override'
			)
	`, workID, workID, workID, workID, workID, workID).Scan(
		&hasHigherPriorityMetadata,
		&hasAuthoritativeParty,
		&hasManualCircleOverride,
	); err != nil {
		return remoteWorkFallbackPolicy{}, err
	}
	return remoteWorkFallbackPolicy{
		AttachCircleFallback:     hasHigherPriorityMetadata == 0 && hasAuthoritativeParty == 0 && hasManualCircleOverride == 0,
		UpdateNormalizedMetadata: hasHigherPriorityMetadata == 0,
	}, nil
}

func upsertRemoteWork(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, remoteWork kikoeru.Work, rawWork json.RawMessage, allowCircleFallback bool) (int64, error) {
	code := normalizedRemoteWorkCode(remoteWork)
	if code == "" {
		code = strings.ToUpper(strings.TrimSpace(remoteWork.SourceID))
	}
	if code == "" {
		return 0, fmt.Errorf("remote work does not expose a stable work code")
	}
	policy, err := loadRemoteWorkFallbackPolicy(ctx, tx, code)
	if err != nil {
		return 0, err
	}
	title := firstNonEmpty(remoteWork.Title, remoteWork.Name, code)
	workID, err := upsertRemoteWorkBase(ctx, tx, code, title, remoteWork, policy)
	if err != nil {
		return 0, err
	}
	providerID, err := upsertRemoteWorkMetadata(ctx, tx, source, workID, code, remoteWork, rawWork)
	if err != nil {
		return 0, err
	}
	if err := syncVoiceCreditSnapshot(ctx, tx, voiceCreditSnapshotRow{
		WorkID: workID, ProviderID: sql.NullInt64{Int64: providerID, Valid: true}, Raw: string(rawWork),
	}); err != nil {
		return 0, err
	}
	if allowCircleFallback && policy.AttachCircleFallback {
		if err := attachRemoteWorkCircleFallback(ctx, tx, remoteWork, workID, providerID); err != nil {
			return 0, err
		}
	}
	return workID, nil
}

func upsertRemoteWorkBase(ctx context.Context, tx *sql.Tx, code, title string, remoteWork kikoeru.Work, policy remoteWorkFallbackPolicy) (int64, error) {
	releaseDate := normalizeDate(remoteWork.Release)
	var duration any
	if remoteWork.Duration != nil && *remoteWork.Duration > 0 {
		duration = int64(*remoteWork.Duration)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, description, release_date, age_rating, duration_seconds)
		VALUES (?, 'audio', ?, ?, ?, ?, ?)
		ON CONFLICT(primary_code) DO UPDATE SET
			title = CASE
				WHEN TRIM(work.title) = '' OR UPPER(TRIM(work.title)) = UPPER(TRIM(work.primary_code)) THEN excluded.title
				WHEN ?
					AND TRIM(excluded.title) <> ''
					AND UPPER(TRIM(excluded.title)) <> UPPER(TRIM(work.primary_code)) THEN excluded.title
				ELSE work.title
			END,
			release_date = CASE
				WHEN ? THEN COALESCE(excluded.release_date, work.release_date)
				ELSE COALESCE(work.release_date, excluded.release_date)
			END,
			age_rating = CASE
				WHEN ? THEN COALESCE(NULLIF(excluded.age_rating, ''), work.age_rating)
				ELSE COALESCE(NULLIF(work.age_rating, ''), excluded.age_rating)
			END,
			duration_seconds = CASE
				WHEN ? THEN COALESCE(excluded.duration_seconds, work.duration_seconds)
				ELSE COALESCE(work.duration_seconds, excluded.duration_seconds)
			END,
			updated_at = CURRENT_TIMESTAMP
	`, code, title, "", releaseDate, remoteWork.AgeCategoryString, duration,
		policy.UpdateNormalizedMetadata, policy.UpdateNormalizedMetadata,
		policy.UpdateNormalizedMetadata, policy.UpdateNormalizedMetadata); err != nil {
		return 0, err
	}
	return selectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", code)
}

func upsertRemoteWorkMetadata(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, workID int64, code string, remoteWork kikoeru.Work, rawWork json.RawMessage) (int64, error) {
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
	if err := upsertRemoteMetadataSnapshot(ctx, tx, workID, providerID, code, rawWork); err != nil {
		return 0, err
	}
	return providerID, nil
}

func upsertRemoteMetadataSnapshot(ctx context.Context, tx *sql.Tx, workID, providerID int64, externalID string, raw json.RawMessage) error {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	const variantKey = "remote"
	var existingID int64
	var existingHash, existingRaw string
	err := tx.QueryRowContext(ctx, `
		SELECT id, content_hash, snapshot_json
		FROM metadata_snapshot
		WHERE work_id = ? AND provider_id = ? AND external_id = ?
		ORDER BY fetched_at DESC, id DESC
		LIMIT 1
	`, workID, providerID, externalID).Scan(&existingID, &existingHash, &existingRaw)
	if err == nil && (strings.TrimSpace(existingHash) == hash || (strings.TrimSpace(existingHash) == "" && existingRaw == string(raw))) {
		_, err = tx.ExecContext(ctx, `
			UPDATE metadata_snapshot
			SET fetched_at = CURRENT_TIMESTAMP, snapshot_json = ?, variant_key = ?, content_hash = ?
			WHERE id = ?
		`, string(raw), variantKey, hash, existingID)
		if err != nil {
			return err
		}
	} else {
		if !errors.Is(err, sql.ErrNoRows) && err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO metadata_snapshot (
				work_id, provider_id, external_id, snapshot_json,
				variant_key, content_hash
			)
			VALUES (?, ?, ?, ?, ?, ?)
		`, workID, providerID, externalID, string(raw), variantKey, hash); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `
		DELETE FROM metadata_snapshot
		WHERE id IN (
			SELECT id FROM metadata_snapshot
			WHERE work_id = ? AND provider_id = ? AND external_id = ?
			ORDER BY fetched_at DESC, id DESC
			LIMIT -1 OFFSET 2
		)
	`, workID, providerID, externalID)
	return err
}

func attachRemoteWorkCircleFallback(ctx context.Context, tx *sql.Tx, remoteWork kikoeru.Work, workID, providerID int64) error {
	if remoteWork.Circle == nil || strings.TrimSpace(remoteWork.Circle.Name) == "" {
		return nil
	}
	var partyID int64
	err := tx.QueryRowContext(ctx, `
		SELECT id
		FROM party
		WHERE party_type IN ('circle', 'brand', 'maker')
			AND LOWER(display_name) = LOWER(?)
		ORDER BY id ASC
		LIMIT 1
	`, strings.TrimSpace(remoteWork.Circle.Name)).Scan(&partyID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
		VALUES (?, ?, 'circle', ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, party_id, role) DO UPDATE SET
			provider_id = excluded.provider_id,
			source = excluded.source,
			updated_at = CURRENT_TIMESTAMP
	`, workID, partyID, providerID, "remote_source")
	return err
}

func syncRemoteTrackTree(ctx context.Context, tx *sql.Tx, fileSourceID int64, workID int64, workCode string, tracks []kikoeru.Track) (int, int, error) {
	state := remoteTrackSyncState{}
	var walk func(parentID *int64, basePath string, nodes []kikoeru.Track) error
	walk = func(parentID *int64, basePath string, nodes []kikoeru.Track) error {
		for index, node := range nodes {
			if err := syncRemoteTrackNode(ctx, tx, fileSourceID, workID, workCode, parentID, basePath, index, node, &state); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(nil, "", tracks); err != nil {
		return 0, 0, err
	}
	return state.mediaItems, state.locations, nil
}

type remoteTrackSyncState struct {
	mediaItems int
	locations  int
}

func syncRemoteTrackNode(ctx context.Context, tx *sql.Tx, fileSourceID, workID int64, workCode string, parentID *int64, basePath string, index int, node kikoeru.Track, state *remoteTrackSyncState) error {
	title := strings.TrimSpace(node.Title)
	if title == "" {
		title = fmt.Sprintf("Track %d", index+1)
	}
	path := joinRemotePath(basePath, title)
	kind := remoteTrackKindForPath(node.Type, path)
	fingerprint := fmt.Sprintf("remote:%d:%s:%s", fileSourceID, workCode, path)
	var parent any
	if parentID != nil {
		parent = *parentID
	}
	duration := nullableSeconds(node.Duration)
	hasAudio := remoteMediaHasAudio(kind)
	var size any
	if node.Size > 0 {
		size = node.Size
	}
	if err := upsertRemoteMediaItem(ctx, tx, workID, parent, kind, title, index, duration, hasAudio, size, fingerprint); err != nil {
		return err
	}
	itemID, err := selectID(ctx, tx, "SELECT id FROM media_item WHERE fingerprint = ?", fingerprint)
	if err != nil {
		return err
	}
	state.mediaItems++
	if len(node.Children) > 0 || kind == "folder" {
		childID := itemID
		return syncRemoteTrackChildren(ctx, tx, fileSourceID, workID, workCode, &childID, path, node.Children, state)
	}
	return upsertRemoteTrackLocation(ctx, tx, fileSourceID, itemID, path, node, duration, size, state)
}

func upsertRemoteMediaItem(ctx context.Context, tx *sql.Tx, workID int64, parent any, kind, title string, index int, duration, hasAudio, size any, fingerprint string) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO media_item (work_id, parent_id, kind, title, track_no, duration_seconds, has_audio, size_bytes, fingerprint)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (SELECT 1 FROM media_item WHERE fingerprint = ?)
	`, workID, parent, kind, title, index+1, duration, hasAudio, size, fingerprint, fingerprint); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET parent_id = ?, kind = ?, title = ?, track_no = ?, duration_seconds = ?,
			has_audio = COALESCE(?, has_audio), size_bytes = ?
		WHERE fingerprint = ?
	`, parent, kind, title, index+1, duration, hasAudio, size, fingerprint)
	return err
}

func syncRemoteTrackChildren(ctx context.Context, tx *sql.Tx, fileSourceID, workID int64, workCode string, parentID *int64, path string, children []kikoeru.Track, state *remoteTrackSyncState) error {
	for index, child := range children {
		if err := syncRemoteTrackNode(ctx, tx, fileSourceID, workID, workCode, parentID, path, index, child, state); err != nil {
			return err
		}
	}
	return nil
}

func upsertRemoteTrackLocation(ctx context.Context, tx *sql.Tx, fileSourceID, itemID int64, path string, node kikoeru.Track, duration, size any, state *remoteTrackSyncState) error {
	streamURL := firstNonEmpty(node.MediaStreamURL, node.StreamLowQualityURL)
	downloadURL := node.MediaDownloadURL
	if streamURL == "" && downloadURL == "" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, stream_url, download_url, remote_hash, size_bytes, duration_seconds, availability, last_checked_at)
		SELECT ?, ?, 'remote_stream', ?, ?, ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1 FROM media_file_location
			WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'remote_stream' AND path = ?
		)
	`, itemID, fileSourceID, path, streamURL, downloadURL, node.Hash, size, duration, itemID, fileSourceID, path); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET stream_url = ?, download_url = ?, remote_hash = ?, size_bytes = ?, duration_seconds = ?,
			availability = 'available', last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'remote_stream' AND path = ?
	`, streamURL, downloadURL, node.Hash, size, duration, itemID, fileSourceID, path); err != nil {
		return err
	}
	state.locations++
	return nil
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

func normalizedRemoteWorkCode(work kikoeru.Work) string {
	return kikoeru.WorkCode(work)
}

func remoteCodeFromRawJSON(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	var payload struct {
		WorkNo        string `json:"workno"`
		WorkNoAlt     string `json:"work_no"`
		ProductID     string `json:"product_id"`
		SourceID      string `json:"source_id"`
		ProductIDAlt  string `json:"productId"`
		ProductIDText string `json:"productID"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return ""
	}
	return firstNonEmpty(payload.WorkNo, payload.WorkNoAlt, payload.ProductID, payload.ProductIDAlt, payload.ProductIDText, payload.SourceID)
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
	case "text", "image", "video":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "file"
	}
}

func remoteTrackKindForPath(value string, path string) string {
	kind := remoteTrackKind(value)
	if kind != "file" {
		return kind
	}
	return mediaKindFromPath(path)
}

func remoteMediaHasAudio(kind string) any {
	if kind == "audio" {
		return true
	}
	return nil
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
	sources, err := s.loadFileSources(r)
	if err != nil {
		return appSettingsResponse{}, err
	}
	metadataLanguages := s.preferredMetadataLanguages(r.Context())
	return appSettingsResponse{
		AnonymousAccessEnabled:    s.configuredAnonymousAccessEnabled(),
		LocalScanDepth:            s.settingInt(r, "local_scan_depth", s.cfg.LocalScanDepth),
		CacheEnabled:              s.settingBool(r, "remote_cache_enabled", false),
		CacheLimitGB:              s.settingInt(r, "remote_cache_limit_gb", 20),
		RemoteDownloadLimitGB:     int(s.remoteMediaDownloadLimitBytes(r.Context()) >> 30),
		FetchStagingRetentionDays: s.configuredFetchStagingRetentionDays(r.Context()),
		RemoteSaveTemplate:        s.settingString(r, "remote_save_root_template", defaultRemoteSaveRootTemplate),
		RemoteDelayBase:           s.settingFloat(r, "remote_request_delay_base_seconds", 0.5),
		RemoteDelayRandom:         s.settingFloat(r, "remote_request_delay_random_seconds", 1.5),
		RemoteBackoff:             s.settingFloat(r, "remote_rate_limit_backoff_seconds", 30),
		RemoteMaxBackoff:          s.settingFloat(r, "remote_max_backoff_seconds", 300),
		CatalogFreshnessDays:      s.catalogFreshnessDays(r.Context()),
		DLsiteMetadataLanguage:    metadataLanguages[0],
		DLsiteMetadataLanguages:   metadataLanguages,
		DirectoryRoutingRules:     s.settingDirectoryRules(r, "directory_routing_rules", defaultDirectoryRoutingRules()),
		RecommendationThreshold:   s.settingInt(r, "recommendation_threshold", 50),
		RecommendationConfig:      s.libraryStore.LoadRecommendationConfig(r.Context()),
		RecommendationDefaults:    library.DefaultRecommendationConfig(),
		DataRoot:                  s.cfg.DataRoot,
		CacheRoot:                 s.cfg.CacheRoot,
		FileSources:               sources,
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
	value = strings.TrimSpace(value)
	if value == "" {
		return defaultDLsiteMetadataLanguage
	}
	return dlsite.NormalizeMetadataLanguage(value)
}

func normalizeDLsiteMetadataLanguages(values []string) []string {
	if normalized, ok := parseDLsiteMetadataLanguages(values); ok {
		return completeDLsiteMetadataLanguages(normalized)
	}
	return append([]string(nil), defaultDLsiteMetadataLanguages...)
}

func completeDLsiteMetadataLanguages(languages []string) []string {
	return dlsite.NormalizeMetadataPriority(languages)
}

func parseDLsiteMetadataLanguages(values []string) ([]string, bool) {
	if len(values) == 0 || len(values) > maxDLsiteMetadataLanguages {
		return nil, false
	}
	normalized := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, raw := range values {
		if strings.TrimSpace(raw) == "" {
			return nil, false
		}
		language := normalizeDLsiteLanguage(raw)
		if strings.EqualFold(strings.TrimSpace(raw), dlsite.OriginMetadataLanguage) {
			language = dlsite.OriginMetadataLanguage
		}
		if language == "" {
			return nil, false
		}
		if seen[language] {
			return nil, false
		}
		seen[language] = true
		normalized = append(normalized, language)
	}
	if len(normalized) == 0 {
		return nil, false
	}
	return normalized, true
}

func validateDLsiteMetadataLanguages(values []string) ([]string, error) {
	if len(values) == 0 {
		return nil, fmt.Errorf("dlsiteMetadataLanguages must contain at least one language")
	}
	if len(values) > maxDLsiteMetadataLanguages {
		return nil, fmt.Errorf("dlsiteMetadataLanguages must contain at most %d languages", maxDLsiteMetadataLanguages)
	}
	normalized, ok := parseDLsiteMetadataLanguages(values)
	if !ok {
		return nil, fmt.Errorf("unsupported dlsiteMetadataLanguages")
	}
	return completeDLsiteMetadataLanguages(normalized), nil
}

func (s *Server) preferredMetadataLanguages(ctx context.Context) []string {
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", dlsiteMetadataLanguagesSetting).Scan(&raw); err == nil {
		var values []string
		if json.Unmarshal([]byte(raw), &values) == nil {
			if normalized, ok := parseDLsiteMetadataLanguages(values); ok {
				return completeDLsiteMetadataLanguages(normalized)
			}
		}
	}
	var legacyRaw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", dlsiteMetadataLanguageSetting).Scan(&legacyRaw); err == nil {
		var legacy string
		if json.Unmarshal([]byte(legacyRaw), &legacy) == nil {
			if normalized := normalizeDLsiteLanguage(legacy); normalized != "" {
				return completeDLsiteMetadataLanguages([]string{normalized})
			}
		}
	}
	return append([]string(nil), defaultDLsiteMetadataLanguages...)
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
	source.LastCheckedAt = nullableString(lastCheckedAt)
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
