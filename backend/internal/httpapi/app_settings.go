package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

var defaultDLsiteMetadataLanguages = []string{dlsite.OriginMetadataLanguage}

type appSettingsResponse struct {
	AnonymousAccessEnabled    bool                         `json:"anonymousAccessEnabled"`
	LocalScanDepth            int                          `json:"localScanDepth"`
	CacheEnabled              bool                         `json:"cacheEnabled"`
	CacheLimitGB              int                          `json:"cacheLimitGb"`
	TranscodeCacheLimitGB     int                          `json:"transcodeCacheLimitGb"`
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

type settingsUpdatePayload struct {
	LocalScanDepth            *int             `json:"localScanDepth"`
	CacheEnabled              *bool            `json:"cacheEnabled"`
	CacheLimitGB              *int             `json:"cacheLimitGb"`
	TranscodeCacheLimitGB     *int             `json:"transcodeCacheLimitGb"`
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
	preferences, err := s.loadUserPreferences(r, optionalUserID(r.Context()))
	if err != nil {
		writeError(w, err)
		return
	}
	response["directoryRoutingRules"] = preferences.DirectoryRoutingRules
	response["recommendationThreshold"] = preferences.RecommendationThreshold
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
	if payload.TranscodeCacheLimitGB != nil {
		if _, err := s.enforceTranscodeCacheLimit(r.Context(), 0); err != nil {
			slog.Warn("transcode cache limit enforcement failed after settings update", "error", err)
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
		{payload.TranscodeCacheLimitGB, transcodeCacheLimitSetting, 1, 4096, "transcodeCacheLimitGb must be between 1 and 4096"},
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
		TranscodeCacheLimitGB:     s.settingInt(r, transcodeCacheLimitSetting, defaultTranscodeCacheLimitGB),
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
