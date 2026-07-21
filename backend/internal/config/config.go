package config

import (
	"fmt"
	"os"
	"strconv"
	"strings"
)

// Mode is development (root auth bypass), production (normal auth), or demo (read-only root).
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
	return Config{
		HTTPAddr:            env("KIKOTO_HTTP_ADDR", "127.0.0.1:7659"),
		DatabasePath:        env("KIKOTO_DB_PATH", "../config/kikoto.db"),
		DataRoot:            env("KIKOTO_DATA_ROOT", "../data"),
		CacheRoot:           env("KIKOTO_CACHE_ROOT", "../cache"),
		StaticDir:           env("KIKOTO_STATIC_DIR", ""),
		LocalScanDepth:      envInt("KIKOTO_LOCAL_SCAN_DEPTH", 2),
		Mode:                mode,
		SessionCookieSecure: envBool("KIKOTO_SESSION_COOKIE_SECURE", false),
		AllowedOrigins:      envList("KIKOTO_ALLOWED_ORIGINS"),
		RootUsername:        env("KIKOTO_ROOT_USERNAME", "root"),
		RootPassword:        env("KIKOTO_ROOT_PASSWORD", "change-me"),
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
	flush := func() {
		if strings.TrimSpace(current.DisplayName) != "" && strings.TrimSpace(current.APIURL) != "" {
			if current.SourceType == "" {
				current.SourceType = "kikoeru_compatible"
			}
			if current.Priority <= 0 {
				current.Priority = 30
			}
			if current.BaseURL == "" {
				current.BaseURL = current.APIURL
			}
			seeds = append(seeds, current)
		}
		current = RemoteSourceSeed{}
		hasCurrent = false
	}
	for _, rawLine := range strings.Split(raw, "\n") {
		line := strings.TrimSpace(stripYAMLComment(rawLine))
		if line == "" || line == "sources:" || line == "remote_sources:" {
			continue
		}
		if strings.HasPrefix(line, "- ") {
			if hasCurrent {
				flush()
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
		switch key {
		case "display_name", "displayname", "name":
			current.DisplayName = value
		case "api_url", "apiurl":
			current.APIURL = value
		case "base_url", "baseurl":
			current.BaseURL = value
		case "fallback_url", "fallbackurl":
			current.FallbackURL = value
		case "work_url_template", "workurltemplate":
			current.WorkURLTemplate = value
		case "source_type", "sourcetype", "type":
			current.SourceType = value
		case "priority":
			current.Priority = parsePositiveInt(value, current.Priority)
		case "enabled":
			current.Enabled = parseBool(value, true)
		}
	}
	if hasCurrent {
		flush()
	}
	return seeds
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
