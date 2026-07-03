package config

import (
	"os"
	"strconv"
)

type Config struct {
	HTTPAddr       string
	DatabasePath   string
	DataRoot       string
	CacheRoot      string
	LocalScanDepth int
	DevMode        bool
	RootUsername   string
	RootPassword   string
}

func Load() Config {
	return Config{
		HTTPAddr:       env("KIKOTO_HTTP_ADDR", "127.0.0.1:7659"),
		DatabasePath:   env("KIKOTO_DB_PATH", "../config/kikoto.db"),
		DataRoot:       env("KIKOTO_DATA_ROOT", "../data"),
		CacheRoot:      env("KIKOTO_CACHE_ROOT", "../config/cached"),
		LocalScanDepth: envInt("KIKOTO_LOCAL_SCAN_DEPTH", 2),
		DevMode:        envBool("KIKOTO_DEV_MODE", false),
		RootUsername:   env("KIKOTO_ROOT_USERNAME", "root"),
		RootPassword:   env("KIKOTO_ROOT_PASSWORD", "change-me"),
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
