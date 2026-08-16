package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Mode is development (root auth bypass), production (normal auth), or demo (restricted demo identity).
type Mode string

const (
	ModeDevelopment Mode = "development"
	ModeProduction  Mode = "production"
	ModeDemo        Mode = "demo"
)

type Config struct {
	HTTPAddr            string
	DatabasePath        string
	DataRoot            string
	CacheRoot           string
	StaticDir           string
	LocalScanDepth      int
	Mode                Mode
	SessionCookieSecure bool
	AllowedOrigins      []string
	RootUsername        string
	RootPassword        string
	RemoteSourceSeeds   []RemoteSourceSeed
}

type RemoteSourceSeed struct {
	DisplayName     string
	APIURL          string
	BaseURL         string
	FallbackURL     string
	WorkURLTemplate string
	SourceType      string
	Priority        int
	Enabled         bool
}

func Load() (Config, error) {
	mode, err := parseMode(os.Getenv("KIKOTO_MODE"))
	if err != nil {
		return Config{}, err
	}
	rootPassword := strings.TrimSpace(os.Getenv("KIKOTO_ROOT_PASSWORD"))
	if rootPassword == "" {
		if mode == ModeProduction {
			return Config{}, fmt.Errorf("KIKOTO_ROOT_PASSWORD is required in production mode")
		}
		rootPassword = "change-me"
	}
	if mode == ModeProduction && rootPassword == "change-me" {
		return Config{}, fmt.Errorf("KIKOTO_ROOT_PASSWORD must not use the default value in production mode")
	}
	return Config{
		HTTPAddr:            env("KIKOTO_HTTP_ADDR", "127.0.0.1:7659"),
		DatabasePath:        env("KIKOTO_DB_PATH", "../config/kikoto.db"),
		DataRoot:            env("KIKOTO_DATA_ROOT", "../data"),
		CacheRoot:           env("KIKOTO_CACHE_ROOT", "../cache"),
		StaticDir:           env("KIKOTO_STATIC_DIR", ""),
		LocalScanDepth:      envInt("KIKOTO_LOCAL_SCAN_DEPTH", 3),
		Mode:                mode,
		SessionCookieSecure: envBool("KIKOTO_SESSION_COOKIE_SECURE", false),
		AllowedOrigins:      envList("KIKOTO_ALLOWED_ORIGINS"),
		RootUsername:        env("KIKOTO_ROOT_USERNAME", "root"),
		RootPassword:        rootPassword,
		RemoteSourceSeeds:   loadRemoteSourceSeeds(),
	}, nil
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
	if !envBool("KIKOTO_REMOTE_SOURCES_ENABLED", false) {
		return nil
	}
	paths := []string{}
	if configured := os.Getenv("KIKOTO_REMOTE_SOURCES_FILE"); configured != "" {
		paths = append(paths, configured)
	} else {
		paths = append(paths, "/config/remote-sources.yml", "../config/remote-sources.yml", "../config/remote-sources.yaml")
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
