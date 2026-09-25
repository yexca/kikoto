package config

import (
	"fmt"
	"net/netip"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Mode is development (root auth bypass), production (normal auth), or demo (restricted demo identity).
type Mode string

const (
	ModeDevelopment Mode = "development"
	ModeProduction  Mode = "production"
	ModeDemo        Mode = "demo"
)

// RootAccountMode selects who owns the root administrator credential. In setup
// mode the first administrator is created through initial setup and managed in
// the app. In environment mode KIKOTO_ROOT_USERNAME and KIKOTO_ROOT_PASSWORD
// define that account on every start and the app cannot change it.
type RootAccountMode string

const (
	RootAccountSetup       RootAccountMode = "setup"
	RootAccountEnvironment RootAccountMode = "environment"
)

type Config struct {
	HTTPAddr     string
	DatabasePath string
	// DatabaseBackupDir holds database backups, or is empty when the database
	// is not a plain file and cannot be backed up.
	DatabaseBackupDir   string
	DataRoot            string
	CacheRoot           string
	StaticDir           string
	LocalScanDepth      int
	Mode                Mode
	SessionCookieSecure bool
	AllowedOrigins      []string
	TrustedProxies      []netip.Prefix
	LoginConcurrency    int
	ShutdownTimeout     time.Duration
	RootAccountMode     RootAccountMode
	// RootUsername is the explicitly configured administrator username, or
	// empty. Development mode authenticates as it, and the environment-managed
	// account and an environment password reset use it.
	RootUsername string
	// RootPassword defines the environment-managed account in environment mode.
	// In setup mode it is applied only when RootPasswordReset is set.
	RootPassword      string
	RootPasswordReset bool
	RemoteSourceSeeds []RemoteSourceSeed
}

type RemoteSourceSeed struct {
	DisplayName     string
	APIURL          string
	BaseURL         string
	FallbackURL     string
	WorkURLTemplate string
	RequestLanguage string
	SourceType      string
	Priority        int
	Enabled         bool
}

func Load() (Config, error) {
	mode, err := parseMode(os.Getenv("KIKOTO_MODE"))
	if err != nil {
		return Config{}, err
	}
	rootMode, err := parseRootAccountMode(os.Getenv("KIKOTO_ROOT_ACCOUNT_MODE"))
	if err != nil {
		return Config{}, err
	}
	rootPassword := strings.TrimSpace(os.Getenv("KIKOTO_ROOT_PASSWORD"))
	reset, err := parseSwitch("KIKOTO_ROOT_PASSWORD_RESET")
	if err != nil {
		return Config{}, err
	}
	if rootMode == RootAccountEnvironment && rootPassword == "" {
		return Config{}, fmt.Errorf("KIKOTO_ROOT_ACCOUNT_MODE=environment requires KIKOTO_ROOT_PASSWORD")
	}
	if rootMode == RootAccountSetup && reset && rootPassword == "" {
		return Config{}, fmt.Errorf("KIKOTO_ROOT_PASSWORD_RESET requires KIKOTO_ROOT_PASSWORD")
	}
	trustedProxies, err := parseTrustedProxies(os.Getenv("KIKOTO_TRUSTED_PROXIES"))
	if err != nil {
		return Config{}, err
	}
	databasePath := env("KIKOTO_DB_PATH", "../config/kikoto.db")
	return Config{
		HTTPAddr:            env("KIKOTO_HTTP_ADDR", "127.0.0.1:7659"),
		DatabasePath:        databasePath,
		DatabaseBackupDir:   env("KIKOTO_DB_BACKUP_DIR", defaultDatabaseBackupDir(databasePath)),
		DataRoot:            env("KIKOTO_DATA_ROOT", "../data"),
		CacheRoot:           env("KIKOTO_CACHE_ROOT", "../cache"),
		StaticDir:           env("KIKOTO_STATIC_DIR", ""),
		LocalScanDepth:      envInt("KIKOTO_LOCAL_SCAN_DEPTH", 3),
		Mode:                mode,
		SessionCookieSecure: envBool("KIKOTO_SESSION_COOKIE_SECURE", false),
		AllowedOrigins:      envList("KIKOTO_ALLOWED_ORIGINS"),
		TrustedProxies:      trustedProxies,
		LoginConcurrency:    envInt("KIKOTO_LOGIN_CONCURRENCY", 8),
		ShutdownTimeout:     time.Duration(envInt("KIKOTO_SHUTDOWN_TIMEOUT_SECONDS", 20)) * time.Second,
		RootAccountMode:     rootMode,
		RootUsername:        strings.TrimSpace(os.Getenv("KIKOTO_ROOT_USERNAME")),
		RootPassword:        rootPassword,
		RootPasswordReset:   reset,
		RemoteSourceSeeds:   loadRemoteSourceSeeds(),
	}, nil
}

// defaultDatabaseBackupDir keeps backups beside the database, on the same
// durable volume, and never in the disposable cache or the media library.
func defaultDatabaseBackupDir(databasePath string) string {
	databasePath = strings.TrimSpace(databasePath)
	if databasePath == "" || databasePath == ":memory:" || strings.HasPrefix(databasePath, "file:") {
		return ""
	}
	return filepath.Join(filepath.Dir(databasePath), "backups")
}

// DevelopmentUsername is the account development mode authenticates every
// request as.
func (c Config) DevelopmentUsername() string {
	if username := strings.TrimSpace(c.RootUsername); username != "" {
		return username
	}
	return "root"
}

// EnvironmentManagedUsername is the account whose credential, role, and
// enabled state the environment owns, or empty in setup mode.
func (c Config) EnvironmentManagedUsername() string {
	if c.RootAccountMode != RootAccountEnvironment {
		return ""
	}
	return c.DevelopmentUsername()
}

func (c Config) IsDevelopment() bool {
	return c.Mode == ModeDevelopment
}

func (c Config) IsDemo() bool {
	return c.Mode == ModeDemo
}

func (c Config) RuntimeMode() Mode {
	if c.Mode == "" {
		return ModeProduction
	}
	return c.Mode
}

func parseMode(value string) (Mode, error) {
	switch mode := Mode(strings.ToLower(strings.TrimSpace(value))); mode {
	case "", ModeProduction:
		return ModeProduction, nil
	case ModeDevelopment, ModeDemo:
		return mode, nil
	default:
		return "", fmt.Errorf("invalid KIKOTO_MODE %q: expected development, production, or demo", value)
	}
}

func parseRootAccountMode(value string) (RootAccountMode, error) {
	switch mode := RootAccountMode(strings.ToLower(strings.TrimSpace(value))); mode {
	case "", RootAccountSetup:
		return RootAccountSetup, nil
	case RootAccountEnvironment:
		return mode, nil
	default:
		return "", fmt.Errorf("invalid KIKOTO_ROOT_ACCOUNT_MODE %q: expected setup or environment", value)
	}
}

// parseTrustedProxies reads comma-separated reverse-proxy addresses or CIDR
// prefixes. An invalid entry is a startup error rather than a silently
// narrower or wider trust boundary.
func parseTrustedProxies(value string) ([]netip.Prefix, error) {
	prefixes := []netip.Prefix{}
	for _, item := range strings.Split(value, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		if strings.Contains(item, "/") {
			prefix, err := netip.ParsePrefix(item)
			if err != nil {
				return nil, fmt.Errorf("invalid KIKOTO_TRUSTED_PROXIES entry %q: expected an IP address or CIDR prefix", item)
			}
			prefixes = append(prefixes, prefix.Masked())
			continue
		}
		addr, err := netip.ParseAddr(item)
		if err != nil {
			return nil, fmt.Errorf("invalid KIKOTO_TRUSTED_PROXIES entry %q: expected an IP address or CIDR prefix", item)
		}
		addr = addr.Unmap()
		prefixes = append(prefixes, netip.PrefixFrom(addr, addr.BitLen()))
	}
	return prefixes, nil
}

func envList(key string) []string {
	values := []string{}
	seen := map[string]bool{}
	for _, value := range strings.Split(os.Getenv(key), ",") {
		value = strings.TrimRight(strings.TrimSpace(value), "/")
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		values = append(values, value)
	}
	return values
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

// parseSwitch reads an opt-in boolean. Unlike envBool, an unrecognized value is
// an error, so a mistyped value cannot silently leave the switch off.
func parseSwitch(key string) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	switch strings.ToLower(value) {
	case "", "0", "false", "no", "off":
		return false, nil
	case "1", "true", "yes", "on":
		return true, nil
	default:
		return false, fmt.Errorf("invalid %s %q: expected true or false", key, value)
	}
}

func envBool(key string, fallback bool) bool {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	switch value {
	case "1", "true", "TRUE", "yes", "YES", "on", "ON":
		return true
	case "0", "false", "FALSE", "no", "NO", "off", "OFF":
		return false
	default:
		return fallback
	}
}

func loadRemoteSourceSeeds() []RemoteSourceSeed {
	return loadRemoteSourceSeedsFromPaths(remoteSourceSeedFilePaths())
}

func remoteSourceSeedFilePaths() []string {
	return []string{
		"/config/remote-sources.yml",
		"../config/remote-sources.yml",
		"../config/remote-sources.yaml",
	}
}

func loadRemoteSourceSeedsFromPaths(paths []string) []RemoteSourceSeed {
	if !envBool("KIKOTO_REMOTE_SOURCES_ENABLED", false) {
		return nil
	}
	for _, path := range paths {
		rawBytes, err := os.ReadFile(path)
		if err == nil {
			return parseRemoteSourceSeedYAML(string(rawBytes))
		}
	}
	return nil
}

func parseRemoteSourceSeedYAML(raw string) []RemoteSourceSeed {
	seeds := []RemoteSourceSeed{}
	current := RemoteSourceSeed{}
	hasCurrent := false
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimSpace(stripYAMLComment(rawLine))
		if line == "" || line == "sources:" || line == "remote_sources:" {
			continue
		}
		if strings.HasPrefix(line, "- ") {
			if hasCurrent {
				if seed, ok := finalizeRemoteSourceSeed(current); ok {
					seeds = append(seeds, seed)
				}
				current = RemoteSourceSeed{}
				hasCurrent = false
			}
			hasCurrent = true
			line = strings.TrimSpace(strings.TrimPrefix(line, "- "))
			if line == "" {
				continue
			}
		}
		key, value, ok := strings.Cut(line, ":")
		if !ok {
			continue
		}
		hasCurrent = true
		key = normalizeSeedYAMLKey(key)
		value = trimYAMLValue(value)
		applyRemoteSourceSeedYAMLField(&current, key, value)
	}
	if hasCurrent {
		if seed, ok := finalizeRemoteSourceSeed(current); ok {
			seeds = append(seeds, seed)
		}
	}
	return seeds
}

func finalizeRemoteSourceSeed(seed RemoteSourceSeed) (RemoteSourceSeed, bool) {
	if strings.TrimSpace(seed.DisplayName) == "" || strings.TrimSpace(seed.APIURL) == "" {
		return RemoteSourceSeed{}, false
	}
	if seed.SourceType == "" {
		seed.SourceType = "kikoeru_compatible"
	}
	if seed.Priority <= 0 {
		seed.Priority = 30
	}
	if seed.BaseURL == "" {
		seed.BaseURL = seed.APIURL
	}
	return seed, true
}

func applyRemoteSourceSeedYAMLField(seed *RemoteSourceSeed, key, value string) {
	switch key {
	case "display_name", "displayname", "name":
		seed.DisplayName = value
	case "api_url", "apiurl":
		seed.APIURL = value
	case "base_url", "baseurl":
		seed.BaseURL = value
	case "fallback_url", "fallbackurl":
		seed.FallbackURL = value
	case "work_url_template", "workurltemplate":
		seed.WorkURLTemplate = value
	case "request_language", "requestlanguage", "language":
		seed.RequestLanguage = value
	case "source_type", "sourcetype", "type":
		seed.SourceType = value
	case "priority":
		seed.Priority = parsePositiveInt(value, seed.Priority)
	case "enabled":
		seed.Enabled = parseBool(value, true)
	}
}

func stripYAMLComment(value string) string {
	if before, _, ok := strings.Cut(value, "#"); ok {
		return before
	}
	return value
}

func normalizeSeedYAMLKey(value string) string {
	return strings.ToLower(strings.TrimSpace(value))
}

func trimYAMLValue(value string) string {
	value = strings.TrimSpace(value)
	value = strings.Trim(value, `"'`)
	return value
}

func parsePositiveInt(value string, fallback int) int {
	parsed, err := strconv.Atoi(strings.TrimSpace(value))
	if err != nil || parsed <= 0 {
		return fallback
	}
	return parsed
}

func parseBool(value string, fallback bool) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "1", "true", "yes", "on":
		return true
	case "0", "false", "no", "off":
		return false
	default:
		return fallback
	}
}
