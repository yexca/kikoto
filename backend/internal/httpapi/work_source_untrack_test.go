package httpapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestRunWorkSourceUntrackDoesNotExposeCachePaths(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible');
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work');
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (1, 1, 'tracked', 'available');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'track.mp3', 'untrack-cache-test');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'cache', 'media/example_remote/RJ/RJ00000000/track.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}

	result, err := server.runWorkSourceUntrack(context.Background(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	document, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(document), "cachePaths") || strings.Contains(string(document), "media/example_remote") {
		t.Fatalf("untrack response leaks cache layout: %s", document)
	}
}

// Untracking a source while a Fetch of the work is queued keeps the cache files
// that Fetch still stages; the other cache files of the source are cleared.
func TestRunWorkSourceUntrackKeepsCacheAnActiveFetchNeeds(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	const fetched, other = "media/example_remote/RJ/RJ00000000/fetched.mp3", "media/example_remote/RJ/RJ00000000/other.mp3"
	for _, path := range []string{fetched, other} {
		absolute := filepath.Join(server.cfg.CacheRoot, filepath.FromSlash(path))
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(absolute, []byte("audio"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	plan := remoteWorkSavePlan{SourceID: 1, PrimaryCode: "RJ00000000", Items: []remoteWorkSavePlanItem{{
		Path: "fetched.mp3", Action: "cache_hit", CachePath: fetched, RemoteSourceID: 1, TargetPath: "Library/RJ00000000/fetched.mp3",
	}}}
	for _, statement := range []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible'), (2, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (1, 1, 'tracked', 'available')`,
		`INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (1, 1, 'audio', 'fetched.mp3', 'untrack-fetched'), (2, 1, 'audio', 'other.mp3', 'untrack-other')`,
		`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 1, 'cache', '` + fetched + `', 'available'), (2, 2, 1, 'cache', '` + other + `', 'available')`,
		`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES (1, 'remote_work_fetch', 'Example Fetch', 'queued', 'manual')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status) VALUES (1, 1, 'remote_work_fetch', 'queued')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	tx, err := db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createRemoteFetchManifest(context.Background(), tx, 1, 1, "synthetic-request", 1, 1, 2, plan); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}

	result, err := server.runWorkSourceUntrack(context.Background(), 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if result.ClearedCaches != 1 {
		t.Fatalf("cleared caches = %d, want 1", result.ClearedCaches)
	}
	if _, err := os.Stat(filepath.Join(server.cfg.CacheRoot, filepath.FromSlash(fetched))); err != nil {
		t.Fatalf("the Fetch's cache file was removed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(server.cfg.CacheRoot, filepath.FromSlash(other))); !os.IsNotExist(err) {
		t.Fatalf("the other cache file stayed: %v", err)
	}
	var fetchedAvailability string
	if err := db.QueryRow(`SELECT availability FROM media_file_location WHERE id = 1`).Scan(&fetchedAvailability); err != nil || fetchedAvailability != "available" {
		t.Fatalf("the Fetch's cache location = %q, %v", fetchedAvailability, err)
	}
}
