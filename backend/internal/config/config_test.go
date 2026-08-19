package config

import (
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestEnvListNormalizesAndDeduplicatesOrigins(t *testing.T) {
	t.Setenv("KIKOTO_ALLOWED_ORIGINS", " https://app.example/ ,http://localhost:5173,https://app.example ")
	want := []string{"https://app.example", "http://localhost:5173"}
	if got := envList("KIKOTO_ALLOWED_ORIGINS"); !reflect.DeepEqual(got, want) {
		t.Fatalf("envList() = %#v, want %#v", got, want)
	}
}

func TestLoadDefaultsToProductionMode(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "production-root-password")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RuntimeMode() != ModeProduction {
		t.Fatalf("mode = %q, want production", cfg.RuntimeMode())
	}
}

func TestLoadDefaultsLocalScanDepthToThree(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "development")
	t.Setenv("KIKOTO_LOCAL_SCAN_DEPTH", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalScanDepth != 3 {
		t.Fatalf("local scan depth = %d, want 3", cfg.LocalScanDepth)
	}
}

func TestLoadParsesConfiguredPositiveIntegerAndBooleanValues(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "development")
	t.Setenv("KIKOTO_LOCAL_SCAN_DEPTH", "5")
	t.Setenv("KIKOTO_SESSION_COOKIE_SECURE", "YES")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalScanDepth != 5 || !cfg.SessionCookieSecure {
		t.Fatalf("parsed config = depth %d secure %t, want 5/true", cfg.LocalScanDepth, cfg.SessionCookieSecure)
	}

	t.Setenv("KIKOTO_LOCAL_SCAN_DEPTH", "0")
	t.Setenv("KIKOTO_SESSION_COOKIE_SECURE", "not-a-boolean")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalScanDepth != 3 || cfg.SessionCookieSecure {
		t.Fatalf("invalid config fallback = depth %d secure %t, want 3/false", cfg.LocalScanDepth, cfg.SessionCookieSecure)
	}
}

func TestLoadRequiresExplicitProductionRootPassword(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "production")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted a missing production root password")
	}

	t.Setenv("KIKOTO_ROOT_PASSWORD", "change-me")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted the default production root password")
	}
}

func TestLoadReadsDemoMode(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "demo")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.IsDemo() {
		t.Fatal("Load() did not enable demo mode")
	}
}

func TestLoadRejectsUnknownMode(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "staging")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted an unknown runtime mode")
	}
}

func TestParseRemoteSourceSeedReadsRequestLanguage(t *testing.T) {
	seeds := parseRemoteSourceSeedYAML(`
sources:
  - display_name: Example Remote
    api_url: https://example.invalid/api
    request_language: zh-Hant
`)
	if len(seeds) != 1 || seeds[0].RequestLanguage != "zh-Hant" {
		t.Fatalf("seeds = %#v, want one zh-Hant seed", seeds)
	}
}

func TestLoadRemoteSourceSeedsRequiresOptInAndReadsConfiguredFile(t *testing.T) {
	seedPath := filepath.Join(t.TempDir(), "remote-sources.yml")
	if err := os.WriteFile(seedPath, []byte(`
sources:
  - display_name: Example Remote A
    api_url: https://source.example.invalid/api
    base_url: https://source.example.invalid
    fallback_url: https://fallback.example.invalid
    work_url_template: https://source.example.invalid/works/{id}
    request_language: ja
    source_type: kikoeru_compatible
    priority: 42
    enabled: off
  - display_name: Missing Endpoint
`), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KIKOTO_REMOTE_SOURCES_FILE", seedPath)
	t.Setenv("KIKOTO_REMOTE_SOURCES_ENABLED", "false")
	if seeds := loadRemoteSourceSeeds(); seeds != nil {
		t.Fatalf("disabled remote source seeds = %#v, want nil", seeds)
	}

	t.Setenv("KIKOTO_REMOTE_SOURCES_ENABLED", "true")
	seeds := loadRemoteSourceSeeds()
	if len(seeds) != 1 {
		t.Fatalf("seeds = %#v, want one complete seed", seeds)
	}
	want := RemoteSourceSeed{
		DisplayName:     "Example Remote A",
		APIURL:          "https://source.example.invalid/api",
		BaseURL:         "https://source.example.invalid",
		FallbackURL:     "https://fallback.example.invalid",
		WorkURLTemplate: "https://source.example.invalid/works/{id}",
		RequestLanguage: "ja",
		SourceType:      "kikoeru_compatible",
		Priority:        42,
		Enabled:         false,
	}
	if !reflect.DeepEqual(seeds[0], want) {
		t.Fatalf("seed = %#v, want %#v", seeds[0], want)
	}
}

func TestParseRemoteSourceSeedAppliesSafeFallbacks(t *testing.T) {
	seeds := parseRemoteSourceSeedYAML(`
remote_sources:
  - name: Example Remote B
    apiurl: https://source.example.invalid/api
    priority: not-a-number
    enabled: unknown
`)
	if len(seeds) != 1 {
		t.Fatalf("seeds = %#v, want one seed", seeds)
	}
	want := RemoteSourceSeed{
		DisplayName: "Example Remote B",
		APIURL:      "https://source.example.invalid/api",
		BaseURL:     "https://source.example.invalid/api",
		SourceType:  "kikoeru_compatible",
		Priority:    30,
		Enabled:     true,
	}
	if !reflect.DeepEqual(seeds[0], want) {
		t.Fatalf("seed = %#v, want %#v", seeds[0], want)
	}
}
