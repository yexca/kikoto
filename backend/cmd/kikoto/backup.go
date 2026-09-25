package main

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"path/filepath"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
)

// preMigrationBackupsKept bounds the snapshots taken before schema upgrades.
// Each is a full database copy, and older ones only matter for older releases.
const preMigrationBackupsKept = 3

// preMigrationBackup snapshots the database before a schema upgrade. Numbered
// migrations are irreversible, so a failed snapshot stops startup instead of
// upgrading without a way back. A database without a backup directory, such
// as an in-memory one, upgrades without a snapshot.
func preMigrationBackup(ctx context.Context, db *sql.DB, backupDir string) func(int, int) error {
	if backupDir == "" {
		return nil
	}
	return func(fromVersion int, toVersion int) error {
		name := storage.BackupFileName(storage.BackupKindPreMigration, time.Now(), fmt.Sprintf("v%03d-to-v%03d", fromVersion, toVersion))
		size, err := storage.BackupInto(ctx, db, filepath.Join(backupDir, name))
		if err != nil {
			return fmt.Errorf("back up database before upgrading (free disk space or set KIKOTO_DB_BACKUP_DIR): %w", err)
		}
		slog.Info("database backed up before schema upgrade", "file", name, "bytes", size, "from", fromVersion, "to", toVersion)
		if _, err := storage.PruneBackups(backupDir, storage.BackupKindPreMigration, preMigrationBackupsKept); err != nil {
			slog.Warn("prune pre-migration database backups", "error", err)
		}
		return nil
	}
}
