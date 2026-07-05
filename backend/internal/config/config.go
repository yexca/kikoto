package config

import (
	"os"
	"strconv"
	"strings"
)

type Config struct {
	HTTPAddr            string
	DatabasePath        string
	DataRoot            string
	CacheRoot           string
	LocalScanDepth      int
	DevMode             bool
	RootUsername        string
	RootPassword        string
	RemoteSourceSeeds   []RemoteSourceSeed
}

type RemoteSourceSeed struct {
	DisplayName string
	APIURL      string
	BaseURL     string
	FallbackURL string
	SourceType  string
	Priority    int
	Enabled     bool
}

func Load() Config {
	return Config{
		HTTPAddr:          env("KIKOTO_HTTP_ADDR", "127.0.0.1:7659"),
		DatabasePath:      env("KIKOTO_DB_PATH", "../config/kikoto.db"),
		DataRoot:          env("KIKOTO_DATA_ROOT", "../data"),
		CacheRoot:         env("KIKOTO_CACHE_ROOT", "../cache"),
		LocalScanDepth:    envInt("KIKOTO_LOCAL_SCAN_DEPTH", 2),
		DevMode:           envBool("KIKOTO_DEV_MODE", false),
		RootUsername:      env("KIKOTO_ROOT_USERNAME", "root"),
		RootPassword:      env("KIKOTO_ROOT_PASSWORD", "change-me"),
		RemoteSourceSeeds: envRemoteSourceSeeds("KIKOTO_REMOTE_SOURCES"),
	}
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

func envRemoteSourceSeeds(key string) []RemoteSourceSeed {
	raw := strings.TrimSpace(os.Getenv(key))
	if raw == "" {
		return nil
	}
	seeds := []RemoteSourceSeed{}
	for _, item := range strings.Split(raw, ";") {
		parts := strings.Split(item, "|")
		if len(parts) < 2 {
			continue
		}
		displayName := strings.TrimSpace(parts[0])
		apiURL := strings.TrimSpace(parts[1])
		if displayName == "" || apiURL == "" {
			continue
		}
		seed := RemoteSourceSeed{
			DisplayName: displayName,
			APIURL:      apiURL,
			BaseURL:     apiURL,
			SourceType:  "kikoeru_compatible",
			Priority:    30,
			Enabled:     true,
		}
		if len(parts) > 2 && strings.TrimSpace(parts[2]) != "" {
			seed.SourceType = strings.TrimSpace(parts[2])
		}
		if len(parts) > 3 {
			seed.Priority = parsePositiveInt(parts[3], seed.Priority)
		}
		if len(parts) > 4 {
			seed.Enabled = parseBool(parts[4], seed.Enabled)
		}
		if len(parts) > 5 && strings.TrimSpace(parts[5]) != "" {
			seed.BaseURL = strings.TrimSpace(parts[5])
		}
		if len(parts) > 6 {
			seed.FallbackURL = strings.TrimSpace(parts[6])
		}
		seeds = append(seeds, seed)
	}
	return seeds
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
