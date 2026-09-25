package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/httpapi"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/migrations"
)

func main() {
	if err := run(); err != nil {
		slog.Error("kikoto stopped", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load configuration: %w", err)
	}
	account.SetPasswordCheckConcurrency(cfg.LoginConcurrency)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// After the first stop signal, restore default signal handling so a second
	// one ends the process immediately instead of waiting for the drain.
	context.AfterFunc(ctx, stop)

	db, err := storage.Open(cfg.DatabasePath)
	if err != nil {
		return fmt.Errorf("open database: %w", err)
	}
	defer db.Close()

	if err := storage.MigrateFS(db, migrations.Files, buildinfo.Version); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	server := httpapi.NewServer(db, cfg)
	if err := server.LoadAccessPolicy(ctx); err != nil {
		return fmt.Errorf("load access policy: %w", err)
	}
	if !cfg.IsDemo() {
		if err := server.EnsureLocalSource(ctx); err != nil {
			return fmt.Errorf("initialize local source: %w", err)
		}
		if err := server.RecoverInterruptedWorkflows(ctx); err != nil {
			return fmt.Errorf("recover interrupted workflows: %w", err)
		}
	}
	if cfg.IsDemo() {
		if err := server.BootstrapDemo(ctx); err != nil {
			return fmt.Errorf("bootstrap demo user: %w", err)
		}
	} else if err := server.BootstrapRoot(ctx); err != nil {
		return fmt.Errorf("bootstrap root user: %w", err)
	}
	if err := server.SeedRemoteSourcesFromConfig(ctx); err != nil {
		return fmt.Errorf("seed remote sources: %w", err)
	}
	if cfg.IsDemo() {
		result, err := server.RunDemoStartupWorkflows(ctx)
		if err != nil {
			return fmt.Errorf("run demo startup workflows: %w", err)
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
		return fmt.Errorf("record successful application start: %w", err)
	}
	if cfg.IsDevelopment() {
		slog.Warn("dev mode enabled; requests authenticate as root user", "username", cfg.RootUsername)
	}
	if cfg.IsDemo() {
		slog.Info("demo mode enabled; requests authenticate as the restricted demo user")
	}

	listener, err := net.Listen("tcp", cfg.HTTPAddr)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	slog.Info("kikoto api listening", "addr", cfg.HTTPAddr)
	server.Go(func(ctx context.Context) {
		if err := server.WarmSearchIndex(ctx); err != nil && ctx.Err() == nil {
			slog.Warn("warm search index", "error", err)
		}
	})
	if !cfg.IsDemo() {
		server.Go(func(ctx context.Context) {
			if err := server.RunStartupWorkflows(ctx); err != nil && ctx.Err() == nil {
				slog.Error("run startup workflows", "error", err)
			}
		})
		server.Go(server.StartJobRunner)
	}

	return serveUntilStopped(ctx, listener, newHTTPServer(server.Routes()), server, cfg.ShutdownTimeout)
}
