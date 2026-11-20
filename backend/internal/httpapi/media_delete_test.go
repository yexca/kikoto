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

// A folder edit rewrites a location's path in place. A deletion queued before
// the edit must not delete the file that has the queued path afterwards.
func TestQueuedLocalMediaDeleteLeavesAMovedLocationAlone(t *testing.T) {
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "track.mp3"), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	locationID := insertTestLocalMediaLocation(t, db, "track.mp3")
	server.mediaCleanupMu.Lock()
	result, err := server.runLocalMediaDelete(context.Background(), locationID)
	server.mediaCleanupMu.Unlock()
	if err != nil || result.Status != "queued" {
		t.Fatalf("runLocalMediaDelete() = %+v, %v, want queued", result, err)
	}
	if err := os.Rename(filepath.Join(dataRoot, "track.mp3"), filepath.Join(dataRoot, "renamed.mp3")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "track.mp3"), []byte("another file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE media_file_location SET path = 'renamed.mp3' WHERE id = ?", locationID); err != nil {
		t.Fatal(err)
	}

	job, ok, err := server.claimNextQueuedWorkflowJob(context.Background(), "media-delete-test")
	if err != nil || !ok || job.RunID != result.RunID {
		t.Fatalf("claim delete job = %#v, %t, %v", job, ok, err)
	}
	if err := server.executeLocalMediaDeleteJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"track.mp3", "renamed.mp3"} {
		if _, err := os.Stat(filepath.Join(dataRoot, name)); err != nil {
			t.Fatalf("%s after a skipped delete: %v", name, err)
		}
	}
	var availability, runStatus string
	var events int
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", locationID).Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", result.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_event WHERE workflow_run_id = ? AND event_type = 'media_delete.location_changed'", result.RunID).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if availability != "available" || runStatus != "skipped" || events != 1 {
		t.Fatalf("moved location = %q, run %q, events %d", availability, runStatus, events)
	}
}
