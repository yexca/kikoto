package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLocalMediaDeleteStaysQueuedWhileLibraryFoldersChange(t *testing.T) {
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	locationID := insertTestLocalMediaLocation(t, db, "track.mp3")

	// A scan, Edit files job, Fetch publication, or custom work holds the
	// library folders, so the delete must not run beside it.
	server.mediaCleanupMu.Lock()
	result, err := server.runLocalMediaDelete(context.Background(), locationID)
	server.mediaCleanupMu.Unlock()
	if err != nil {
		t.Fatalf("runLocalMediaDelete() error = %v", err)
	}
	if result.Status != "queued" {
		t.Fatalf("delete while library folders change = %q, want queued", result.Status)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "track.mp3")); err != nil {
		t.Fatalf("file changed while library folders were held: %v", err)
	}
	var status string
	if err := db.QueryRow("SELECT status FROM workflow_job WHERE workflow_run_id = ?", result.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "queued" {
		t.Fatalf("job status = %q, want queued for the background worker", status)
	}
}

func TestLocalMediaDeleteReleasesLibraryFoldersOnceSettled(t *testing.T) {
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	locationID := insertTestLocalMediaLocation(t, db, "track.mp3")

	result, err := server.runLocalMediaDelete(context.Background(), locationID)
	if err != nil {
		t.Fatalf("runLocalMediaDelete() error = %v", err)
	}
	if result.Status == "queued" || !result.Deleted {
		t.Fatalf("inline delete = %+v, want the file deleted inline", result)
	}
	if !server.mediaCleanupMu.TryLock() {
		t.Fatal("an inline delete kept the library folders held after it settled")
	}
	server.mediaCleanupMu.Unlock()
}
