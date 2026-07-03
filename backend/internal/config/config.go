package config

import "os"

type Config struct {
	HTTPAddr     string
	DatabasePath string
	DataRoot     string
}

func Load() Config {
	return Config{
		HTTPAddr:     env("KIKOTO_HTTP_ADDR", "127.0.0.1:7659"),
		DatabasePath: env("KIKOTO_DB_PATH", "../config/kikoto.db"),
		DataRoot:     env("KIKOTO_DATA_ROOT", "../data"),
	}
}

func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
