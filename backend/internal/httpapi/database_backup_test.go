package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestDatabaseBackupWorkflowWritesListedBackup(t *testing.T) {
	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	backupDir := t.TempDir()
	server := NewServer(db, config.Config{DatabaseBackupDir: backupDir})

	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodPost, "/api/maintenance/database/backups", `{}`))
	if response.Code != http.StatusAccepted {
		t.Fatalf("backup status = %d, body = %s", response.Code, response.Body.String())
	}
	var queued databaseOptimizeQueuedResult
	if err := json.Unmarshal(response.Body.Bytes(), &queued); err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatalf("run backup job: %v", err)
	}
	var status string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status); err != nil || status != "succeeded" {
		t.Fatalf("run status = %q, err = %v", status, err)
	}
	assertUnlinkedMaintenanceCount(t, db, "SELECT COUNT(*) FROM audit_log WHERE action = 'database.backup' AND actor_user_id = 1", 1)

	response = httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodGet, "/api/maintenance/database/backups", ""))
	if response.Code != http.StatusOK {
		t.Fatalf("list status = %d", response.Code)
	}
	if strings.Contains(response.Body.String(), filepath.ToSlash(backupDir)) || strings.Contains(response.Body.String(), backupDir) {
		t.Fatalf("backup list must not reveal the backup directory: %s", response.Body.String())
	}
	var listed databaseBackupListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if !listed.Available || len(listed.Backups) != 1 || listed.Backups[0].Kind != storage.BackupKindManual || listed.Backups[0].SizeBytes <= 0 {
		t.Fatalf("listed backups = %+v", listed)
	}
}

func TestDatabaseBackupUnavailableWithoutBackupDirectory(t *testing.T) {
	db := openMigratedTestDB(t)
	insertUnlinkedMaintenanceUser(t, db, 1)
	server := NewServer(db, config.Config{})
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, databaseMaintenanceRequest(http.MethodPost, "/api/maintenance/database/backups", `{}`))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "database_backup_unavailable") {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestQueueDueDatabaseBackupHonorsRecentRoutineBackup(t *testing.T) {
	db := openMigratedTestDB(t)
	backupDir := t.TempDir()
	server := NewServer(db, config.Config{DatabaseBackupDir: backupDir})
	now := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	countQueued := func() int {
		t.Helper()
		var count int
		if err := db.QueryRow("SELECT COUNT(*) FROM workflow_job WHERE worker_type = 'database_backup'").Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	write := func(name string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(backupDir, name), []byte("x"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	// A recent pre-migration snapshot is not a routine backup.
	write(storage.BackupFileName(storage.BackupKindPreMigration, now.Add(-time.Hour), "v001-to-v002"))
	write(storage.BackupFileName(storage.BackupKindManual, now.Add(-2*time.Hour), ""))
	server.queueDueDatabaseBackup(context.Background(), now)
	if got := countQueued(); got != 0 {
		t.Fatalf("a manual backup within the period must defer the scheduled one, queued = %d", got)
	}
	server.queueDueDatabaseBackup(context.Background(), now.Add(23*time.Hour))
	if got := countQueued(); got != 1 {
		t.Fatalf("a backup older than the period must queue one, queued = %d", got)
	}
	server.queueDueDatabaseBackup(context.Background(), now.Add(23*time.Hour))
	if got := countQueued(); got != 1 {
		t.Fatalf("an active backup run must be reused, queued = %d", got)
	}
}
