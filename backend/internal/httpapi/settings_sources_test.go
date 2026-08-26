package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

func TestLegacyNumber178SourceTypeCannotBeCreated(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/file-sources", strings.NewReader(`{
		"displayName":"Legacy source",
		"sourceType":"kikoeru_compatible_number178",
		"endpoint":{"apiUrl":"https://remote.example"}
	}`))
	response := httptest.NewRecorder()
	if _, ok := parseFileSourcePayload(response, request, false, false); ok {
		t.Fatal("legacy number178 source type was accepted for creation")
	}
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadRequest)
	}
}

func TestFileSourcePayloadEnforcesOutboundURLContract(t *testing.T) {
	tests := []struct {
		name       string
		apiURL     string
		wantOK     bool
		wantStatus int
	}{
		{name: "configured private origin", apiURL: "http://127.0.0.1:7659", wantOK: true, wantStatus: http.StatusOK},
		{name: "embedded credentials", apiURL: "https://synthetic-user:synthetic-password@example.invalid", wantStatus: http.StatusBadRequest},
		{name: "unsupported scheme", apiURL: "ftp://example.invalid/files", wantStatus: http.StatusBadRequest},
		{name: "protocol relative", apiURL: "//example.invalid/api", wantStatus: http.StatusBadRequest},
		{name: "fragment", apiURL: "https://example.invalid/api#internal", wantStatus: http.StatusBadRequest},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			body := fmt.Sprintf(`{
				"displayName":"Example Remote",
				"sourceType":"kikoeru_compatible",
				"endpoint":{"apiUrl":%q}
			}`, test.apiURL)
			request := httptest.NewRequest(http.MethodPost, "/api/file-sources", strings.NewReader(body))
			response := httptest.NewRecorder()
			_, ok := parseFileSourcePayload(response, request, false, false)
			if ok != test.wantOK {
				t.Fatalf("accepted = %t, want %t; response = %s", ok, test.wantOK, response.Body.String())
			}
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d", response.Code, test.wantStatus)
			}
		})
	}
}

func TestFileSourcePayloadNormalizesOutboundHostPatterns(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/file-sources", strings.NewReader(`{
		"displayName":"Example Remote",
		"sourceType":"kikoeru_compatible",
		"endpoint":{
			"apiUrl":"https://api.example.invalid",
			"restrictOutboundHosts":true,
			"allowedHostPatterns":[" CDN.Example.Invalid. ","*.Media.Example.Invalid","cdn.example.invalid"]
		}
	}`))
	response := httptest.NewRecorder()
	payload, ok := parseFileSourcePayload(response, request, false, false)
	if !ok {
		t.Fatalf("payload rejected: %s", response.Body.String())
	}
	if !payload.Endpoint.RestrictOutboundHosts {
		t.Fatal("strict outbound host setting was not retained")
	}
	want := []string{"cdn.example.invalid", "*.media.example.invalid"}
	if fmt.Sprint(payload.Endpoint.AllowedHostPatterns) != fmt.Sprint(want) {
		t.Fatalf("allowed host patterns = %v, want %v", payload.Endpoint.AllowedHostPatterns, want)
	}
}

func TestFileSourcePayloadRejectsInvalidOutboundHostPattern(t *testing.T) {
	request := httptest.NewRequest(http.MethodPost, "/api/file-sources", strings.NewReader(`{
		"displayName":"Example Remote",
		"sourceType":"kikoeru_compatible",
		"endpoint":{
			"apiUrl":"https://api.example.invalid",
			"restrictOutboundHosts":true,
			"allowedHostPatterns":["https://media.example.invalid/path"]
		}
	}`))
	response := httptest.NewRecorder()
	if _, ok := parseFileSourcePayload(response, request, false, false); ok {
		t.Fatal("URL was accepted as an outbound host pattern")
	}
	if response.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", response.Code)
	}
}

func TestCreateFileSourcePersistsOutboundPolicy(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/file-sources", strings.NewReader(`{
		"displayName":"Example Remote",
		"sourceType":"kikoeru_compatible",
		"priority":30,
		"enabled":false,
		"config":{},
		"endpoint":{
			"baseUrl":"https://www.example.invalid",
			"apiUrl":"https://api.example.invalid",
			"fallbackUrl":"https://fallback.example.invalid",
			"workUrlTemplate":"/work/{code}",
			"restrictOutboundHosts":true,
			"allowedHostPatterns":["cdn.example.invalid","*.media.example.invalid"]
		}
	}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.createFileSource(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var source fileSourceSummary
	if err := json.Unmarshal(response.Body.Bytes(), &source); err != nil {
		t.Fatal(err)
	}
	if !source.Endpoint.RestrictOutboundHosts || fmt.Sprint(source.Endpoint.AllowedHostPatterns) != "[cdn.example.invalid *.media.example.invalid]" {
		t.Fatalf("persisted endpoint = %+v", source.Endpoint)
	}
	if source.Config.RequestLanguage != defaultRemoteRequestLanguage {
		t.Fatalf("request language = %q, want %q", source.Config.RequestLanguage, defaultRemoteRequestLanguage)
	}
}

func TestCreateFileSourcePersistsConfiguredRequestLanguage(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/file-sources", strings.NewReader(`{
		"displayName":"Example Remote",
		"sourceType":"kikoeru_compatible",
		"config":{"requestLanguage":"zh_hant"},
		"endpoint":{"apiUrl":"https://example.invalid/api"}
	}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.createFileSource(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var source fileSourceSummary
	if err := json.Unmarshal(response.Body.Bytes(), &source); err != nil {
		t.Fatal(err)
	}
	if source.Config.RequestLanguage != "zh-Hant" {
		t.Fatalf("request language = %q, want zh-Hant", source.Config.RequestLanguage)
	}
}

func TestRuntimeSettingsExposeDeploymentMode(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeDemo})
	request := httptest.NewRequest(http.MethodGet, "/api/runtime-settings", nil)
	response := httptest.NewRecorder()

	server.getRuntimeSettings(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		Mode     string `json:"mode"`
		DemoMode bool   `json:"demoMode"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	if payload.Mode != "demo" || !payload.DemoMode {
		t.Fatalf("runtime mode = %q demo = %t", payload.Mode, payload.DemoMode)
	}
}

func TestLoadAppSettingsIsReadOnly(t *testing.T) {
	db := openMigratedTestDB(t)
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 3})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.EnsureLocalSource(ctx); err != nil {
		t.Fatalf("EnsureLocalSource() error = %v", err)
	}
	if _, err := db.Exec("PRAGMA query_only = ON"); err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/settings", nil)
	settings, err := server.loadAppSettings(request)
	if err != nil {
		t.Fatalf("loadAppSettings() attempted a write or failed: %v", err)
	}
	if settings.LocalScanDepth != 3 {
		t.Fatalf("local scan depth = %d, want 3", settings.LocalScanDepth)
	}
	if settings.RemoteSaveTemplate != defaultRemoteSaveRootTemplate {
		t.Fatalf("remote save template = %q, want %q", settings.RemoteSaveTemplate, defaultRemoteSaveRootTemplate)
	}
	if settings.RemoteDownloadLimitGB != defaultRemoteDownloadLimitGB || settings.FetchStagingRetentionDays != defaultFetchStagingRetentionDays {
		t.Fatalf("transfer settings = %d GB / %d days", settings.RemoteDownloadLimitGB, settings.FetchStagingRetentionDays)
	}
	if settings.TranscodeCacheLimitGB != defaultTranscodeCacheLimitGB {
		t.Fatalf("transcode cache limit = %d GB, want %d GB", settings.TranscodeCacheLimitGB, defaultTranscodeCacheLimitGB)
	}
	localSources := 0
	for _, source := range settings.FileSources {
		if source.Code == "main_local_library" {
			localSources++
		}
	}
	if localSources != 1 {
		t.Fatalf("local source count = %d, want 1", localSources)
	}
}

func TestUpdateSettingsRecommendationConfigPreservesOrExplicitlySetsExplorationAmplitude(t *testing.T) {
	for _, test := range []struct {
		name                 string
		includeExploration   bool
		submittedExploration int
		wantExploration      int
	}{
		{name: "old client preserves existing value", wantExploration: 27},
		{name: "explicit zero disables exploration", includeExploration: true, submittedExploration: 0, wantExploration: 0},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{})
			existing := library.DefaultRecommendationConfig()
			existing.ExplorationAmplitude = 27
			existingJSON, err := json.Marshal(existing)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := db.Exec("INSERT INTO app_setting (key, value_json) VALUES ('recommendation_config', ?)", string(existingJSON)); err != nil {
				t.Fatal(err)
			}

			submitted := existing
			submitted.JitterAmplitude = 8
			submitted.ExplorationAmplitude = test.submittedExploration
			submittedJSON, err := json.Marshal(submitted)
			if err != nil {
				t.Fatal(err)
			}
			if !test.includeExploration {
				var fields map[string]json.RawMessage
				if err := json.Unmarshal(submittedJSON, &fields); err != nil {
					t.Fatal(err)
				}
				delete(fields, "explorationAmplitude")
				submittedJSON, err = json.Marshal(fields)
				if err != nil {
					t.Fatal(err)
				}
			}

			request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(`{"recommendationConfig":`+string(submittedJSON)+`}`))
			request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
			response := httptest.NewRecorder()
			server.updateSettings(response, request)
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			stored := server.libraryStore.LoadRecommendationConfig(context.Background())
			if stored.ExplorationAmplitude != test.wantExploration || stored.JitterAmplitude != 8 {
				t.Fatalf("stored recommendation config = %+v", stored)
			}
		})
	}
}

func TestDLsiteMetadataLanguagePriorityUsesArrayAndLegacyFallback(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(`{"dlsiteMetadataLanguages":["zh-cn","en-us","ja-jp"]}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.updateSettings(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var settings appSettingsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
		t.Fatal(err)
	}
	want := []string{"zh-cn", "en-us", "ja-jp", "origin"}
	if !reflect.DeepEqual(settings.DLsiteMetadataLanguages, want) || settings.DLsiteMetadataLanguage != want[0] {
		t.Fatalf("language settings = %v / %q, want %v / %q", settings.DLsiteMetadataLanguages, settings.DLsiteMetadataLanguage, want, want[0])
	}
	var stored []string
	var legacy string
	var raw string
	if err := db.QueryRow("SELECT value_json FROM app_setting WHERE key = ?", dlsiteMetadataLanguagesSetting).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(raw), &stored); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT value_json FROM app_setting WHERE key = ?", dlsiteMetadataLanguageSetting).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(raw), &legacy); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(stored, want) || legacy != want[0] {
		t.Fatalf("stored language settings = %v / %q", stored, legacy)
	}

	legacyDB := openMigratedTestDB(t)
	if _, err := legacyDB.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('dlsite_metadata_language', '"en-us"')`); err != nil {
		t.Fatal(err)
	}
	legacyServer := NewServer(legacyDB, config.Config{})
	loaded := legacyServer.preferredMetadataLanguages(context.Background())
	if !reflect.DeepEqual(loaded, []string{"en-us", "origin"}) {
		t.Fatalf("legacy preference = %v", loaded)
	}
	freshDB := openMigratedTestDB(t)
	freshServer := NewServer(freshDB, config.Config{})
	if loaded := freshServer.preferredMetadataLanguages(context.Background()); !reflect.DeepEqual(loaded, []string{"origin"}) {
		t.Fatalf("fresh preference = %v", loaded)
	}
}

func TestDLsiteMetadataLanguagePriorityRejectsInvalidLists(t *testing.T) {
	for _, body := range []string{
		`{"dlsiteMetadataLanguages":[]}`,
		`{"dlsiteMetadataLanguages":["fr-fr"]}`,
		`{"dlsiteMetadataLanguages":["ja-jp","en-us","zh-cn","zh-tw","ko-kr","ja-jp"]}`,
	} {
		db := openMigratedTestDB(t)
		server := NewServer(db, config.Config{})
		request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
		response := httptest.NewRecorder()
		server.updateSettings(response, request)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("body %s status = %d, want %d", body, response.Code, http.StatusBadRequest)
		}
	}
}

func TestDLsiteLanguageFallbacksAreIndependentOfDisplayPriority(t *testing.T) {
	first := dlsiteLanguageFallbacksForLanguages([]string{"zh-cn", "en-us"})
	second := dlsiteLanguageFallbacksForLanguages([]string{"ko-kr", "ja-jp"})
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("discovery fallbacks changed with display priority: %v vs %v", first, second)
	}
	want := []string{"ja-jp", "en-us", "zh-cn", "zh-tw", "ko-kr", ""}
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("fallbacks = %v, want %v", first, want)
	}
}

func TestUpdateSettingsValidatesAndPersistsFetchTransferLimits(t *testing.T) {
	for _, test := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{name: "valid", body: `{"remoteDownloadLimitGb":256,"fetchStagingRetentionDays":14}`, wantStatus: http.StatusOK},
		{name: "download too small", body: `{"remoteDownloadLimitGb":0}`, wantStatus: http.StatusBadRequest},
		{name: "retention too large", body: `{"fetchStagingRetentionDays":366}`, wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{})
			request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(test.body))
			request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
			response := httptest.NewRecorder()
			server.updateSettings(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if test.name != "valid" {
				return
			}
			var settings appSettingsResponse
			if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
				t.Fatal(err)
			}
			if settings.RemoteDownloadLimitGB != 256 || settings.FetchStagingRetentionDays != 14 {
				t.Fatalf("settings = %d GB / %d days", settings.RemoteDownloadLimitGB, settings.FetchStagingRetentionDays)
			}
		})
	}
}

func TestUpdateSettingsValidatesAndPersistsTranscodeCacheLimit(t *testing.T) {
	for _, test := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{name: "valid", body: `{"transcodeCacheLimitGb":12}`, wantStatus: http.StatusOK},
		{name: "zero", body: `{"transcodeCacheLimitGb":0}`, wantStatus: http.StatusBadRequest},
		{name: "too large", body: `{"transcodeCacheLimitGb":4097}`, wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
			request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(test.body))
			request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
			response := httptest.NewRecorder()
			server.updateSettings(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if test.name == "valid" {
				var settings appSettingsResponse
				if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
					t.Fatal(err)
				}
				if settings.TranscodeCacheLimitGB != 12 {
					t.Fatalf("transcode cache limit = %d GB, want 12 GB", settings.TranscodeCacheLimitGB)
				}
			}
		})
	}
}

func TestUpdateSettingsValidatesAndPersistsCatalogFreshnessDays(t *testing.T) {
	for _, test := range []struct {
		name       string
		body       string
		wantStatus int
	}{
		{name: "valid", body: `{"catalogFreshnessDays":14}`, wantStatus: http.StatusOK},
		{name: "zero", body: `{"catalogFreshnessDays":0}`, wantStatus: http.StatusBadRequest},
		{name: "too large", body: `{"catalogFreshnessDays":366}`, wantStatus: http.StatusBadRequest},
	} {
		t.Run(test.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{})
			request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(test.body))
			request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
			response := httptest.NewRecorder()
			server.updateSettings(response, request)
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
			}
			if test.name != "valid" {
				return
			}
			var settings appSettingsResponse
			if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil {
				t.Fatal(err)
			}
			if settings.CatalogFreshnessDays != 14 {
				t.Fatalf("catalog freshness days = %d, want 14", settings.CatalogFreshnessDays)
			}
		})
	}
}

func TestDirectoryRoutingRulesPreserveExplicitEmptySetting(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('directory_routing_rules', '[]')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/runtime-settings", nil)
	rules := server.settingDirectoryRules(request, "directory_routing_rules", defaultDirectoryRoutingRules())
	if len(rules) != 0 {
		t.Fatalf("rules = %+v, want explicit empty list", rules)
	}
}

func TestLegacyNumber178SourceTypesCannotBeSeededFromConfig(t *testing.T) {
	for _, sourceType := range []string{"kikoeru_compatible_number178", "kikoeru_compilable_number178"} {
		t.Run(sourceType, func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{RemoteSourceSeeds: []config.RemoteSourceSeed{{
				DisplayName: "Legacy source",
				APIURL:      "https://remote.example",
				SourceType:  sourceType,
			}}})
			if err := server.SeedRemoteSourcesFromConfig(context.Background()); err == nil {
				t.Fatalf("source type %q was accepted from configuration", sourceType)
			}
		})
	}
}

func TestRemoteSourceSeedRejectsUnsafeEndpoint(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{RemoteSourceSeeds: []config.RemoteSourceSeed{{
		DisplayName: "Example Remote",
		APIURL:      "https://synthetic-user:synthetic-password@example.invalid/api",
		SourceType:  sourceTypeKikoeruCompatible,
	}}})
	if err := server.SeedRemoteSourcesFromConfig(context.Background()); err == nil {
		t.Fatal("seed accepted an endpoint with embedded credentials")
	}
	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM file_source WHERE source_type = 'kikoeru_compatible'`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("persisted remote source count = %d, want 0", count)
	}
}

func TestPublicRemoteWorkURL(t *testing.T) {
	tests := []struct {
		name     string
		endpoint fileSourceEndpoint
		code     string
		want     string
	}{
		{
			name:     "default code route",
			endpoint: fileSourceEndpoint{BaseURL: "https://remote.example/"},
			code:     "RJ00000000",
			want:     "https://remote.example/work/RJ00000000",
		},
		{
			name:     "configured lower-case route",
			endpoint: fileSourceEndpoint{BaseURL: "https://remote.example", WorkURLTemplate: "/{codeLower}"},
			code:     "VJ00000000",
			want:     "https://remote.example/vj00000000",
		},
		{
			name:     "configured alternate route",
			endpoint: fileSourceEndpoint{BaseURL: "https://remote.example", WorkURLTemplate: "/library/{code}"},
			code:     "RJ00000000",
			want:     "https://remote.example/library/RJ00000000",
		},
		{
			name:     "reject non-http base",
			endpoint: fileSourceEndpoint{BaseURL: "javascript:alert(1)"},
			code:     "RJ00000000",
			want:     "",
		},
		{
			name:     "reject embedded credentials",
			endpoint: fileSourceEndpoint{BaseURL: "https://synthetic-user:synthetic-password@example.invalid"},
			code:     "RJ00000000",
			want:     "",
		},
		{
			name:     "reject absolute template",
			endpoint: fileSourceEndpoint{BaseURL: "https://remote.example", WorkURLTemplate: "https://other.example/{code}"},
			code:     "RJ00000000",
			want:     "",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := publicRemoteWorkURL(test.endpoint, test.code); got != test.want {
				t.Fatalf("publicRemoteWorkURL() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestListRemoteSourceWorksReturnsDisabledStatusWithEndpointURL(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'remote', 'Example Remote', 'kikoeru_compatible', 0)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, api_url, base_url)
		VALUES (1, 'https://remote.example/api?token=synthetic-token', 'https://remote.example')
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/1/works?page=2&pageSize=12", nil)
	request.SetPathValue("id", "1")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.listRemoteSourceWorks(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var page remoteWorksResponse
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Status != "disabled" || len(page.Works) != 0 || page.Error == nil || page.Error.Code != "disabled" {
		t.Fatalf("page = %+v, want disabled empty result", page)
	}
	if page.Error.URL != "https://remote.example/api" || strings.Contains(page.Error.URL, "token") {
		t.Fatalf("diagnostic URL = %q, want query-free configured URL", page.Error.URL)
	}
}

func TestListRemoteSourceWorksReturnsUnavailableStatusWithoutUpstreamBody(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "synthetic upstream body must not be returned", http.StatusBadGateway)
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'remote', 'Example Remote', 'kikoeru_compatible', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/1/works", nil)
	request.SetPathValue("id", "1")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"system:admin"}}))
	response := httptest.NewRecorder()
	server.listRemoteSourceWorks(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", response.Code, response.Body.String())
	}
	var page remoteWorksResponse
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.Status != "unavailable" || len(page.Works) != 0 || page.Error == nil || page.Error.Code != "unavailable" {
		t.Fatalf("page = %+v, want unavailable empty result", page)
	}
	if page.Error.URL != remote.URL || strings.Contains(page.Error.Message, "synthetic upstream") || strings.Contains(response.Body.String(), "synthetic upstream") {
		t.Fatalf("public response leaked upstream detail: %s", response.Body.String())
	}
}

func TestPublicRemoteSourceURLRemovesQueryAndCredentials(t *testing.T) {
	if got := publicRemoteSourceURL(fileSourceEndpoint{APIURL: "https://remote.example/api?token=synthetic-token"}); got != "https://remote.example/api" {
		t.Fatalf("publicRemoteSourceURL() = %q", got)
	}
	if got := publicRemoteSourceURL(fileSourceEndpoint{APIURL: "https://synthetic-user:synthetic-password@remote.example/api"}); got != "" {
		t.Fatalf("publicRemoteSourceURL accepted credentials: %q", got)
	}
}

func TestRemoteSourceDiagnosticURLRequiresSourceAdministration(t *testing.T) {
	endpoint := fileSourceEndpoint{APIURL: "https://remote.example/api?token=synthetic-token"}
	tests := []struct {
		name        string
		permissions []string
		want        string
	}{
		{name: "anonymous"},
		{name: "library reader", permissions: []string{"library:read"}},
		{name: "administrator", permissions: []string{"sources:write"}, want: "https://remote.example/api"},
		{name: "super administrator", permissions: []string{"system:admin"}, want: "https://remote.example/api"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			if test.permissions != nil {
				ctx = context.WithValue(ctx, currentUserKey, currentUser{ID: 1, Permissions: test.permissions})
			}
			if got := remoteSourceDiagnosticURL(ctx, endpoint); got != test.want {
				t.Fatalf("remoteSourceDiagnosticURL() = %q, want %q", got, test.want)
			}
		})
	}
}

func TestUpdateSourceHealthOnlyWritesSameStatusAfterThrottleWindow(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, base_url, health_status, last_checked_at)
		VALUES (1, 'https://example.invalid', 'healthy', '2026-01-01 00:00:00')
	`); err != nil {
		t.Fatalf("insert endpoint: %v", err)
	}
	server := NewServer(db, config.Config{})
	if err := server.updateSourceHealth(context.Background(), 1, "healthy"); err != nil {
		t.Fatal(err)
	}
	var firstChecked string
	if err := db.QueryRow(`SELECT last_checked_at FROM file_source_endpoint WHERE file_source_id = 1`).Scan(&firstChecked); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE file_source_endpoint SET last_checked_at = '2099-01-02 00:00:00' WHERE file_source_id = 1`); err != nil {
		t.Fatal(err)
	}
	if err := server.updateSourceHealth(context.Background(), 1, "healthy"); err != nil {
		t.Fatal(err)
	}
	var unchanged string
	if err := db.QueryRow(`SELECT last_checked_at FROM file_source_endpoint WHERE file_source_id = 1`).Scan(&unchanged); err != nil {
		t.Fatal(err)
	}
	if unchanged != "2099-01-02 00:00:00" {
		t.Fatalf("same status refreshed too soon: %q", unchanged)
	}
	if err := server.updateSourceHealth(context.Background(), 1, "unavailable"); err != nil {
		t.Fatal(err)
	}
	var status string
	var changedAt sql.NullString
	if err := db.QueryRow(`SELECT health_status, last_checked_at FROM file_source_endpoint WHERE file_source_id = 1`).Scan(&status, &changedAt); err != nil {
		t.Fatal(err)
	}
	if status != "unavailable" || !changedAt.Valid || changedAt.String == unchanged {
		t.Fatalf("transition was not persisted: status=%q checked=%q", status, changedAt.String)
	}
	if firstChecked == "" || firstChecked == "2026-01-01 00:00:00" {
		t.Fatalf("stale same-status check was not refreshed: %q", firstChecked)
	}
}

func TestManualFileSourceHealthCheckRefreshesStatus(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/health" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode("ok")
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'remote', 'Example Remote', 'kikoeru_compatible', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url, health_status, last_checked_at)
		VALUES (1, ?, ?, 'unknown', NULL)
	`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/file-sources/1/health-check", nil)
	request.SetPathValue("id", "1")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.checkFileSourceHealth(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var result fileSourceHealthCheckResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.Healthy || result.HealthStatus != "healthy" || result.LastCheckedAt == nil {
		t.Fatalf("health result = %+v", result)
	}
}

func TestRemoteWorkSyncForksTrackTree(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workInfo/RJ00000008":
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 10, SourceID: "RJ00000008", Title: "Forked work"})
		case "/api/tracks/10":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: "track.mp3", MediaStreamURL: "/media/track.mp3"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	result, err := server.runRemoteWorkSync(context.Background(), 1, "RJ00000008", "test_fork")
	if err != nil {
		t.Fatal(err)
	}
	if !result.Tracked {
		t.Fatal("track sync reported tracked=false")
	}
	if result.SyncedMediaItems != 1 || result.SyncedLocations != 1 {
		t.Fatalf("sync counts = %d items, %d locations", result.SyncedMediaItems, result.SyncedLocations)
	}
	var locations int
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE file_source_id = 1 AND location_type = 'remote_stream' AND availability = 'available'`).Scan(&locations); err != nil {
		t.Fatal(err)
	}
	if locations != 1 {
		t.Fatalf("remote stream locations = %d, want 1", locations)
	}
	var trackedPresence, sourcePresence int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE file_source_id = 1 AND presence_type = 'tracked' AND availability = 'available'`).Scan(&trackedPresence); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE file_source_id = 1 AND presence_type = 'source' AND availability = 'available'`).Scan(&sourcePresence); err != nil {
		t.Fatal(err)
	}
	if trackedPresence != 1 || sourcePresence != 1 {
		t.Fatalf("presence counts = tracked %d source %d, want 1 each", trackedPresence, sourcePresence)
	}
}

func TestRemoteWorkMaterializeSyncKeepsSourceWithoutTracking(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workInfo/RJ00000009":
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 11, SourceID: "RJ00000009", Title: "Materialized work"})
		case "/api/tracks/11":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: "track.mp3", MediaStreamURL: "/media/track.mp3"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	request := httptest.NewRequest(http.MethodPost, "/api/remote-sources/1/works/RJ00000009/sync", strings.NewReader(`{"triggerReason":"test_materialize"}`))
	request.SetPathValue("id", "1")
	request.SetPathValue("code", "RJ00000009")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"library:read"}}))
	response := httptest.NewRecorder()
	server.syncRemoteSourceWork(response, request)
	if response.Code != http.StatusAccepted {
		t.Fatalf("sync status = %d, body = %s", response.Code, response.Body.String())
	}
	var result remoteWorkSyncResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if result.Tracked {
		t.Fatal("materialize sync reported tracked=true")
	}
	var trackedPresence, sourcePresence, locations int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE file_source_id = 1 AND presence_type = 'tracked' AND availability = 'available'`).Scan(&trackedPresence); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE file_source_id = 1 AND presence_type = 'source' AND availability = 'available'`).Scan(&sourcePresence); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE file_source_id = 1 AND location_type = 'remote_stream' AND availability = 'available'`).Scan(&locations); err != nil {
		t.Fatal(err)
	}
	if trackedPresence != 0 || sourcePresence != 1 || locations != 1 {
		t.Fatalf("presence/locations = tracked %d source %d locations %d, want 0/1/1", trackedPresence, sourcePresence, locations)
	}
}

func TestRemoteFetchEnqueueDoesNotReenterConnectionPoolInsideTransaction(t *testing.T) {
	const code = "TEST-WORK-001"
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workInfo/" + code:
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 10, SourceID: code, Title: "Remote fetch work"})
		case "/api/tracks/10":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{
				Type: "audio", Title: "track.mp3", MediaDownloadURL: "/media/track.mp3", Size: 3,
			}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir(), LocalScanDepth: 2})
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	result, err := server.enqueueRemoteWorkSave(ctx, 1, code, nil, nil, "", "", nil, 0, 0, workflow.JobPriorityUserInitiated)
	if err != nil {
		t.Fatalf("enqueueRemoteWorkSave() error = %v", err)
	}
	if result.RunID <= 0 || result.JobID <= 0 || result.WorkID <= 0 || result.Status != "queued" {
		t.Fatalf("queued remote fetch = %+v", result)
	}
}

func TestRemoteWorkTrackQueuesDeduplicatesForksAndNotifiesSubscribers(t *testing.T) {
	requests := 0
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch r.URL.Path {
		case "/api/workInfo/RJ00000006":
			_ = json.NewEncoder(w).Encode(kikoeru.Work{
				ID: 15, SourceID: "RJ00000006", Title: "Queued track work", ReviewCount: trackTestInt64Pointer(27),
			})
		case "/api/tracks/15":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: "queued-track.mp3", MediaStreamURL: "/media/queued-track.mp3"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	for _, username := range []string{"track-owner", "track-subscriber"} {
		if _, err := db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES (?, ?, 'user')`, username, username); err != nil {
			t.Fatal(err)
		}
	}
	var ownerID, subscriberID int64
	if err := db.QueryRow(`SELECT id FROM user_account WHERE username = 'track-owner'`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM user_account WHERE username = 'track-subscriber'`).Scan(&subscriberID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	queued, err := server.enqueueRemoteWorkTrack(context.Background(), ownerID, 1, "RJ00000006", "manual_track")
	if err != nil {
		t.Fatal(err)
	}
	if queued.Status != "queued" || queued.RunID == 0 || queued.JobID == 0 || queued.WorkID != nil {
		t.Fatalf("queued result = %+v", queued)
	}
	if requests != 0 {
		t.Fatalf("enqueue performed %d upstream requests, want 0", requests)
	}
	reused, err := server.enqueueRemoteWorkTrack(context.Background(), subscriberID, 1, "rj00000006", "manual_track")
	if err != nil {
		t.Fatal(err)
	}
	if !reused.Deduplicated || reused.RunID != queued.RunID || reused.JobID != queued.JobID {
		t.Fatalf("deduplicated result = %+v, queued = %+v", reused, queued)
	}

	if err := server.runNextQueuedWorkflowJob(context.Background(), "track-test-runner"); err != nil {
		t.Fatal(err)
	}
	var runStatus string
	if err := db.QueryRow(`SELECT status FROM workflow_run WHERE id = ?`, queued.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "succeeded" {
		t.Fatalf("run status = %q", runStatus)
	}
	var trackedPresence, remoteLocations int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE file_source_id = 1 AND presence_type = 'tracked' AND availability = 'available'`).Scan(&trackedPresence); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE file_source_id = 1 AND location_type = 'remote_stream' AND availability = 'available'`).Scan(&remoteLocations); err != nil {
		t.Fatal(err)
	}
	if trackedPresence != 1 || remoteLocations != 1 {
		t.Fatalf("tracked presence = %d, remote locations = %d", trackedPresence, remoteLocations)
	}
	var completedNotifications int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM workflow_notification
		WHERE workflow_run_id = ? AND notification_type = 'remote_track' AND status = 'succeeded'
	`, queued.RunID).Scan(&completedNotifications); err != nil {
		t.Fatal(err)
	}
	if completedNotifications != 2 {
		t.Fatalf("completed notifications = %d, want 2", completedNotifications)
	}

	statusRequest := httptest.NewRequest(http.MethodGet, "/api/remote-track-runs/"+strconv.FormatInt(queued.RunID, 10), nil)
	statusRequest.SetPathValue("id", strconv.FormatInt(queued.RunID, 10))
	statusRequest = statusRequest.WithContext(context.WithValue(statusRequest.Context(), currentUserKey, currentUser{ID: subscriberID, Permissions: []string{"library:read"}}))
	statusResponse := httptest.NewRecorder()
	server.getRemoteTrackRunStatus(statusResponse, statusRequest)
	if statusResponse.Code != http.StatusOK || !strings.Contains(statusResponse.Body.String(), `"status":"succeeded"`) {
		t.Fatalf("status response = %d %s", statusResponse.Code, statusResponse.Body.String())
	}
}

func trackTestInt64Pointer(value int64) *int64 {
	return &value
}

func TestRemoteFetchDeduplicatesActiveWorkBeforeLoadingSource(t *testing.T) {
	db := openMigratedTestDB(t)
	result, err := db.Exec(`
		INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type, input_json)
		VALUES ('remote_work_fetch', 'Fetch remote work', 'queued', 'manual', '{"work_code":"RJ00000007"}')
	`)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := result.LastInsertId()
	result, err = db.Exec(`
		INSERT INTO workflow_job (workflow_run_id, worker_type, status)
		VALUES (?, 'remote_work_fetch', 'queued')
	`, runID)
	if err != nil {
		t.Fatal(err)
	}
	jobID, _ := result.LastInsertId()

	server := NewServer(db, config.Config{})
	fetch, err := server.enqueueRemoteWorkSave(context.Background(), 999, "rj00000007", nil, nil, "", "", nil, 0, 0, workflow.JobPriorityUserInitiated)
	if err != nil {
		t.Fatal(err)
	}
	if !fetch.Deduplicated || fetch.RunID != runID || fetch.JobID != jobID || fetch.PrimaryCode != "RJ00000007" {
		t.Fatalf("deduplicated fetch = %+v", fetch)
	}
	var runs int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_run WHERE workflow_code = 'remote_work_fetch'`).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 1 {
		t.Fatalf("fetch runs = %d, want 1", runs)
	}
}

func TestRemoteFetchDeduplicatesOriginReviewBeforeLoadingSource(t *testing.T) {
	db := openMigratedTestDB(t)
	result, err := db.Exec(`
		INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type, input_json)
		VALUES ('remote_work_fetch', 'Fetch remote work', 'partial', 'manual', '{"work_code":"RJ00000001"}')
	`)
	if err != nil {
		t.Fatal(err)
	}
	runID, _ := result.LastInsertId()
	result, err = db.Exec(`
		INSERT INTO workflow_job (workflow_run_id, worker_type, status, recoverable)
		VALUES (?, 'remote_work_fetch', 'failed', 1)
	`, runID)
	if err != nil {
		t.Fatal(err)
	}
	jobID, _ := result.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO workflow_candidate (workflow_run_id, candidate_type, external_key, status, payload_json)
		VALUES (?, 'remote_origin_blocked', 'https://media.example.invalid:443', 'pending', '{"origin":"https://media.example.invalid:443","source_id":1}')
	`, runID); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	fetch, err := server.enqueueRemoteWorkSave(context.Background(), 999, "rj00000001", nil, nil, "", "", nil, 0, 0, workflow.JobPriorityUserInitiated)
	if err != nil {
		t.Fatal(err)
	}
	if !fetch.Deduplicated || fetch.RunID != runID || fetch.JobID != jobID || fetch.Status != "partial" {
		t.Fatalf("deduplicated review Fetch = %+v", fetch)
	}
}

func TestSelectedRemotePathMatches(t *testing.T) {
	tests := []struct {
		name     string
		selected []string
		filePath string
		want     bool
	}{
		{
			name:     "exact file",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "directory prefix",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "sibling directory is not selected",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/wav/01.wav",
			want:     false,
		},
		{
			name:     "same basename in other directory is not selected",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "bonus/mp3/01.mp3",
			want:     false,
		},
		{
			name:     "cleans path traversal",
			selected: []string{"honhen/../mp3"},
			filePath: "mp3/01.mp3",
			want:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			selected := normalizeSelectedRemotePaths(test.selected)
			got := selectedRemotePathMatches(selected, test.filePath)
			if got != test.want {
				t.Fatalf("selectedRemotePathMatches(%v, %q) = %v, want %v", test.selected, test.filePath, got, test.want)
			}
		})
	}
}

func TestRemoteSourceSortMapping(t *testing.T) {
	tests := []struct {
		input string
		name  string
		order string
	}{
		{input: "recent", name: "recent", order: "create_date"},
		{input: "code", name: "code", order: "id"},
		{input: "release", name: "release", order: "release"},
		{input: "rating", name: "rating", order: "rate_average_2dp"},
		{input: "sales", name: "sales", order: "dl_count"},
		{input: "title", name: "recent", order: "create_date"},
	}
	for _, test := range tests {
		name, order := remoteSourceSort(test.input)
		if name != test.name || order != test.order {
			t.Fatalf("remoteSourceSort(%q) = (%q, %q), want (%q, %q)", test.input, name, order, test.name, test.order)
		}
	}
}

func TestRemotePostFilterUsesExactRemoteCodeAndPersonalTags(t *testing.T) {
	work := remoteWorkSummary{
		PrimaryCode:    "RJ00000002",
		RemoteCode:     "RJ00000003",
		RemoteID:       "42",
		SearchUserTags: []string{"Sleep aid"},
	}
	for _, clause := range []listSearchClause{
		{Kind: "code", Value: "RJ00000003"},
		{Kind: "user_tag", Value: "sleep"},
		{Kind: "exclude_user_tag", Value: "archived"},
	} {
		if !remoteWorkSummaryMatchesClause(work, clause) {
			t.Fatalf("clause %#v did not match %#v", clause, work)
		}
	}
	if remoteWorkSummaryMatchesClause(work, listSearchClause{Kind: "user_tag", Value: "archived"}) {
		t.Fatal("unassigned personal tag matched remote work")
	}
}

func TestRemotePostFilteredPageCollectsMatchesAcrossUpstreamPages(t *testing.T) {
	upstream := make([]kikoeru.Work, 0, 102)
	for index := 1; index <= 102; index++ {
		tags := []kikoeru.Tag{{Name: "Other"}}
		if index == 1 || index == 102 {
			tags = []kikoeru.Tag{{Name: "Wanted"}}
		}
		upstream = append(upstream, kikoeru.Work{
			ID:       int64(index),
			SourceID: testfixture.WorkCodeAt(index - 1),
			Title:    fmt.Sprintf("Work %d", index),
			Tags:     tags,
		})
	}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		page, _ := strconv.Atoi(r.URL.Query().Get("page"))
		start := (page - 1) * 100
		if start < 0 {
			start = 0
		}
		end := min(start+100, len(upstream))
		works := []kikoeru.Work{}
		if start < len(upstream) {
			works = upstream[start:end]
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{
			Works: works,
			Pagination: kikoeru.Pagination{
				CurrentPage: page,
				PageSize:    100,
				TotalCount:  len(upstream),
			},
		})
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	works, total, sortApplied, err := server.remotePostFilteredPage(
		context.Background(),
		0,
		7,
		kikoeru.NewClient(remote.URL, remote.Client()),
		remoteSourceQueryPlan{PostFilterClauses: []listSearchClause{{Kind: "tag", Value: "wanted"}}},
		"create_date",
		"desc",
		"",
		2,
		1,
		"ja-jp",
	)
	if err != nil {
		t.Fatal(err)
	}
	if total != 2 || len(works) != 1 || works[0].PrimaryCode != testfixture.WorkCodeAt(101) {
		t.Fatalf("works = %+v, total = %d", works, total)
	}
	if !sortApplied {
		t.Fatal("sortApplied = false, want true")
	}
}

func TestRemoteFetchRequestIDValidation(t *testing.T) {
	if !validRemoteFetchRequestID("fetch:12345678") {
		t.Fatal("valid request id was rejected")
	}
	for _, value := range []string{"short", "contains spaces", "../../escape"} {
		if validRemoteFetchRequestID(value) {
			t.Fatalf("invalid request id %q was accepted", value)
		}
	}
}

func TestRemoteFetchRequestResultReturnsExistingRun(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	runInsert, err := db.Exec(`
		INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type)
		VALUES ('remote_work_fetch', 'Fetch remote work', 'queued', 'manual')
	`)
	if err != nil {
		t.Fatalf("insert run: %v", err)
	}
	runID, err := runInsert.LastInsertId()
	if err != nil {
		t.Fatalf("run id: %v", err)
	}
	want := remoteWorkSaveResult{RunID: runID, WorkID: 9, PrimaryCode: "RJ00000001", Status: "queued", RequestID: "fetch:12345678"}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_request (request_id, source_id, work_code, workflow_run_id, result_json)
		VALUES ('fetch:12345678', 1, 'RJ00000001', ?, ?)
	`, runID, string(raw)); err != nil {
		t.Fatalf("insert request: %v", err)
	}

	server := &Server{db: db}
	got, found, err := server.remoteFetchRequestResult(context.Background(), "fetch:12345678", 1, "rj00000001")
	if err != nil {
		t.Fatalf("remoteFetchRequestResult() error = %v", err)
	}
	if !found || got.RunID != runID || !got.Deduplicated {
		t.Fatalf("remoteFetchRequestResult() = %+v, found %v", got, found)
	}
}

func TestNormalizedRemoteLanguageEditions(t *testing.T) {
	editions := normalizedRemoteLanguageEditions(kikoeru.Work{
		SourceID: "RJ00000005",
		Title:    "Chinese title",
		LanguageEditions: []kikoeru.LanguageEdition{
			{WorkNo: "RJ00000005", Language: "CHI_HANS", Label: "Chinese", DisplayOrder: 2},
			{WorkNo: "RJ00000004", Language: "JPN", Label: "Japanese", DisplayOrder: 1},
			{WorkNo: "RJ00000006", Language: "ENG", Label: "English", DisplayOrder: 3},
			{WorkNo: "invalid", Language: "ENG", Label: "Invalid", DisplayOrder: 3},
		},
		OtherLanguageEditions: []kikoeru.OtherLanguageEdition{
			{SourceID: "RJ00000004", Language: "JPN", Title: "Japanese title", IsOriginal: true},
		},
	})
	if len(editions) != 2 || editions[0].RemoteCode != "RJ00000004" || !editions[0].Origin || editions[1].RemoteCode != "RJ00000005" || !editions[1].Current {
		t.Fatalf("editions = %+v", editions)
	}
	if editions[1].Label != "Chinese title" {
		t.Fatalf("current label = %q, want Chinese title", editions[1].Label)
	}
}

func TestNormalizedRemoteLanguageEditionsDoesNotTreatDeclaredFamilyAsAvailable(t *testing.T) {
	editions := normalizedRemoteLanguageEditions(kikoeru.Work{
		SourceID: "RJ00000000",
		LanguageEditions: []kikoeru.LanguageEdition{
			{WorkNo: "RJ00000000", Language: "JPN", Label: "Japanese", DisplayOrder: 1},
			{WorkNo: "RJ00000001", Language: "ENG", Label: "English", DisplayOrder: 2},
		},
	})
	if len(editions) != 1 || editions[0].RemoteCode != "RJ00000000" || !editions[0].Current {
		t.Fatalf("editions = %+v, want only the current confirmed edition", editions)
	}
}
