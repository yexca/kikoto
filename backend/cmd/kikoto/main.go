package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/httpapi"
	"github.com/yexca/kikoto/backend/internal/storage"
)

func main() {
	cfg := config.Load()
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

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
	if err := server.SeedRemoteSourcesFromConfig(ctx); err != nil {
		slog.Error("seed remote sources", "error", err)
		os.Exit(1)
	}
	if cfg.DevMode {
		slog.Warn("dev mode enabled; requests authenticate as root user", "username", cfg.RootUsername)
	}
	slog.Info("kikoto api listening", "addr", cfg.HTTPAddr)
	go func() {
		if err := server.RunStartupWorkflows(ctx); err != nil && ctx.Err() == nil {
			slog.Error("run startup workflows", "error", err)
		}
	}()
	go server.StartJobRunner(ctx)

	httpServer := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           server.Routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       90 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := httpServer.Shutdown(shutdownCtx); err != nil {
			slog.Error("graceful shutdown", "error", err)
		}
	}()
	if err := httpServer.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		slog.Error("http server stopped", "error", err)
		os.Exit(1)
	}
}
