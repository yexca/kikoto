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
}

func Load() Config {
	return Config{
		HTTPAddr:       env("KIKOTO_HTTP_ADDR", "127.0.0.1:7659"),
		DatabasePath:   env("KIKOTO_DB_PATH", "../config/kikoto.db"),
		DataRoot:       env("KIKOTO_DATA_ROOT", "../data"),
		CacheRoot:      env("KIKOTO_CACHE_ROOT", "../config/cached"),
		LocalScanDepth: envInt("KIKOTO_LOCAL_SCAN_DEPTH", 2),
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
