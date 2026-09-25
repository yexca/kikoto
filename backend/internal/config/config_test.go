package config

import (
	"net/netip"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
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
	t.Setenv("KIKOTO_LOGIN_CONCURRENCY", "3")
	t.Setenv("KIKOTO_SHUTDOWN_TIMEOUT_SECONDS", "45")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalScanDepth != 5 || !cfg.SessionCookieSecure || cfg.LoginConcurrency != 3 || cfg.ShutdownTimeout != 45*time.Second {
		t.Fatalf("parsed config = depth %d secure %t login concurrency %d shutdown %s, want 5/true/3/45s", cfg.LocalScanDepth, cfg.SessionCookieSecure, cfg.LoginConcurrency, cfg.ShutdownTimeout)
	}

	t.Setenv("KIKOTO_LOCAL_SCAN_DEPTH", "0")
	t.Setenv("KIKOTO_SESSION_COOKIE_SECURE", "not-a-boolean")
	t.Setenv("KIKOTO_LOGIN_CONCURRENCY", "-1")
	t.Setenv("KIKOTO_SHUTDOWN_TIMEOUT_SECONDS", "0")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LocalScanDepth != 3 || cfg.SessionCookieSecure || cfg.LoginConcurrency != 8 || cfg.ShutdownTimeout != 20*time.Second {
		t.Fatalf("invalid config fallback = depth %d secure %t login concurrency %d shutdown %s, want 3/false/8/20s", cfg.LocalScanDepth, cfg.SessionCookieSecure, cfg.LoginConcurrency, cfg.ShutdownTimeout)
	}
}

func TestLoadStartsProductionWithoutRootPassword(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "production")
	t.Setenv("KIKOTO_ROOT_USERNAME", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD_RESET", "")
	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RootPassword != "" || cfg.RootPasswordReset || cfg.DevelopmentUsername() != "root" {
		t.Fatalf("root config = password set %t reset %t development user %q", cfg.RootPassword != "", cfg.RootPasswordReset, cfg.DevelopmentUsername())
	}
}

func TestLoadValidatesRootPasswordReset(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "production")
	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD_RESET", "true")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted a password reset without a password")
	}

	t.Setenv("KIKOTO_ROOT_PASSWORD", "synthetic-reset-password")
	t.Setenv("KIKOTO_ROOT_PASSWORD_RESET", "ture")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted a mistyped password reset switch")
	}

	t.Setenv("KIKOTO_ROOT_PASSWORD_RESET", "ON")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if !cfg.RootPasswordReset || cfg.RootPassword != "synthetic-reset-password" {
		t.Fatalf("reset config = reset %t password set %t", cfg.RootPasswordReset, cfg.RootPassword != "")
	}
}

func TestLoadValidatesRootAccountMode(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "production")
	t.Setenv("KIKOTO_ROOT_USERNAME", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD_RESET", "")
	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "Environment")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted environment mode without a password")
	}
	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "env")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted an unknown root account mode")
	}

	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "environment")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "synthetic-root-password")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RootAccountMode != RootAccountEnvironment || cfg.EnvironmentManagedUsername() != "root" {
		t.Fatalf("root account config = mode %q managed user %q", cfg.RootAccountMode, cfg.EnvironmentManagedUsername())
	}

	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "")
	cfg, err = Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.RootAccountMode != RootAccountSetup || cfg.EnvironmentManagedUsername() != "" {
		t.Fatalf("default root account config = mode %q managed user %q", cfg.RootAccountMode, cfg.EnvironmentManagedUsername())
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

func TestLoadParsesTrustedProxiesAndRejectsInvalidEntries(t *testing.T) {
	t.Setenv("KIKOTO_MODE", "development")
	t.Setenv("KIKOTO_TRUSTED_PROXIES", " 192.0.2.1 , 198.51.100.7/24, 2001:db8::/48 ")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := []netip.Prefix{
		netip.MustParsePrefix("192.0.2.1/32"),
		netip.MustParsePrefix("198.51.100.0/24"),
		netip.MustParsePrefix("2001:db8::/48"),
	}
	if !reflect.DeepEqual(cfg.TrustedProxies, want) {
		t.Fatalf("trusted proxies = %v, want %v", cfg.TrustedProxies, want)
	}

	t.Setenv("KIKOTO_TRUSTED_PROXIES", "proxy.example.invalid")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted a trusted proxy that is not an address or CIDR prefix")
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

func TestRemoteSourceSeedFilePathsUseFixedDefaults(t *testing.T) {
	want := []string{
		"/config/remote-sources.yml",
		"../config/remote-sources.yml",
		"../config/remote-sources.yaml",
	}
	if got := remoteSourceSeedFilePaths(); !reflect.DeepEqual(got, want) {
		t.Fatalf("remoteSourceSeedFilePaths() = %#v, want %#v", got, want)
	}
}

func TestLoadRemoteSourceSeedsRequiresOptInAndReadsSeedFile(t *testing.T) {
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
	t.Setenv("KIKOTO_REMOTE_SOURCES_ENABLED", "false")
	if seeds := loadRemoteSourceSeedsFromPaths([]string{seedPath}); seeds != nil {
		t.Fatalf("disabled remote source seeds = %#v, want nil", seeds)
	}

	t.Setenv("KIKOTO_REMOTE_SOURCES_ENABLED", "true")
	seeds := loadRemoteSourceSeedsFromPaths([]string{seedPath})
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
