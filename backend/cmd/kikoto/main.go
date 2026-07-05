package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/httpapi"
	"github.com/yexca/kikoto/backend/internal/storage"
)

func main() {
	cfg := config.Load()

	db, err := storage.Open(cfg.DatabasePath)
	if err != nil {
		slog.Error("open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := storage.Migrate(db, "migrations"); err != nil {
		slog.Error("run migrations", "error", err)
		os.Exit(1)
	}

	server := httpapi.NewServer(db, cfg)
	if err := server.BootstrapRoot(nil); err != nil {
		slog.Error("bootstrap root user", "error", err)
		os.Exit(1)
	}
	if err := server.SeedRemoteSourcesFromConfig(context.Background()); err != nil {
		slog.Error("seed remote sources", "error", err)
		os.Exit(1)
	}
	if cfg.DevMode {
		slog.Warn("dev mode enabled; requests authenticate as root user", "username", cfg.RootUsername)
	}
	if err := server.RunStartupWorkflows(context.Background()); err != nil {
		slog.Error("run startup workflows", "error", err)
	}
	slog.Info("kikoto api listening", "addr", cfg.HTTPAddr)

	if err := http.ListenAndServe(cfg.HTTPAddr, server.Routes()); err != nil {
		slog.Error("http server stopped", "error", err)
		os.Exit(1)
	}
}
