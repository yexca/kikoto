package main

import (
	"context"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/httpapi"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/migrations"
)

func main() {
	cfg, err := config.Load()
	if err != nil {
		slog.Error("load configuration", "error", err)
		os.Exit(1)
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	db, err := storage.Open(cfg.DatabasePath)
	if err != nil {
		slog.Error("open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := storage.MigrateFS(db, migrations.Files, buildinfo.Version); err != nil {
		slog.Error("run migrations", "error", err)
		os.Exit(1)
	}

	server := httpapi.NewServer(db, cfg)
	if err := server.LoadAccessPolicy(ctx); err != nil {
		slog.Error("load access policy", "error", err)
		os.Exit(1)
	}
	if !cfg.IsDemo() {
		if err := server.EnsureLocalSource(ctx); err != nil {
			slog.Error("initialize local source", "error", err)
			os.Exit(1)
		}
		if err := server.RecoverInterruptedWorkflows(ctx); err != nil {
			slog.Error("recover interrupted workflows", "error", err)
			os.Exit(1)
		}
	}
	if cfg.IsDemo() {
		if err := server.BootstrapDemo(ctx); err != nil {
			slog.Error("bootstrap demo user", "error", err)
			os.Exit(1)
		}
	} else if err := server.BootstrapRoot(ctx); err != nil {
		slog.Error("bootstrap root user", "error", err)
		os.Exit(1)
	}
	if err := server.SeedRemoteSourcesFromConfig(ctx); err != nil {
		slog.Error("seed remote sources", "error", err)
		os.Exit(1)
	}
	if cfg.IsDemo() {
		result, err := server.RunDemoLibraryScan(ctx)
		if err != nil {
			slog.Error("run demo library scan", "error", err)
			os.Exit(1)
		}
		slog.Info("demo library scan finished",
			"status", result.Status,
			"detected_works", result.DetectedWorks,
			"eligible_works", result.EligibleWorks,
			"discarded_works", result.DiscardedWorks,
			"failed_works", result.FailedWorks,
			"indexed_files", result.IndexedFiles,
		)
	}
	if err := storage.RecordSuccessfulStart(db, buildinfo.Version); err != nil {
		slog.Error("record successful application start", "error", err)
		os.Exit(1)
	}
	if cfg.IsDevelopment() {
		slog.Warn("dev mode enabled; requests authenticate as root user", "username", cfg.RootUsername)
	}
	if cfg.IsDemo() {
		slog.Info("demo mode enabled; requests authenticate as the restricted demo user")
	}
	slog.Info("kikoto api listening", "addr", cfg.HTTPAddr)
	if !cfg.IsDemo() {
		go func() {
			if err := server.RunStartupWorkflows(ctx); err != nil && ctx.Err() == nil {
				slog.Error("run startup workflows", "error", err)
			}
		}()
		go server.StartJobRunner(ctx)
	}

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
