package httpapi

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func requireCaseDistinctScanDirectories(t *testing.T, root string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(root, "A"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "a"), 0o755); errors.Is(err, os.ErrExist) {
		t.Skip("requires a case-sensitive filesystem")
	} else if err != nil {
		t.Fatal(err)
	}
}

func writeCaseScanTrack(t *testing.T, root, relative string) {
	t.Helper()
	path := filepath.Join(root, filepath.FromSlash(relative), "track.wav")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("synthetic audio"), 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertCaseScanState(t *testing.T, server *Server, root, availability, folderState string) {
	t.Helper()
	var presence, folder, media string
	if err := server.db.QueryRow(`
		SELECT presence.availability, folder.state, location.availability
		FROM work_folder_location AS folder
		JOIN work_source_presence AS presence ON presence.work_id = folder.work_id AND presence.file_source_id = folder.file_source_id
		JOIN media_file_location AS location ON location.file_source_id = folder.file_source_id AND location.path = folder.root_path || '/track.wav'
		WHERE folder.root_path = ?
	`, root).Scan(&presence, &folder, &media); err != nil {
		t.Fatal(err)
	}
	if presence != availability || folder != folderState || media != availability {
		t.Fatalf("%s: presence=%q folder=%q media=%q, want %q/%q/%q", root, presence, folder, media, availability, folderState, availability)
	}
}

func TestIncrementalLocalScanPreservesCaseDistinctScopes(t *testing.T) {
	root := t.TempDir()
	requireCaseDistinctScanDirectories(t, root)
	upper := "A/" + testfixture.WorkCode(testfixture.PrefixRJ, 0)
	lower := "a/" + testfixture.WorkCode(testfixture.PrefixRJ, 1)
	writeCaseScanTrack(t, root, upper)
	writeCaseScanTrack(t, root, lower)
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: root, LocalScanDepth: 2})
	executeIncrementalLocalScanForTest(t, server, upper)
	executeIncrementalLocalScanForTest(t, server, lower)

	// Exercise the watcher-to-job path as well as discovery's scope map.
	changes, err := relativeFilesystemChangePaths(root, []string{filepath.Join(root, "A"), filepath.Join(root, "a")})
	if err != nil {
		t.Fatal(err)
	}
	if len(changes) != 2 {
		t.Fatalf("case-distinct watcher changes = %v, want both directories", changes)
	}
	executeIncrementalLocalScanForTest(t, server, changes...)
	assertCaseScanState(t, server, upper, "available", "active")
	assertCaseScanState(t, server, lower, "available", "active")

	// A scan of A cannot decide anything about a, even if a disappeared.
	if err := os.RemoveAll(filepath.Join(root, "a")); err != nil {
		t.Fatal(err)
	}
	executeIncrementalLocalScanForTest(t, server, "A")
	assertCaseScanState(t, server, lower, "available", "active")
	executeIncrementalLocalScanForTest(t, server, "a")
	assertCaseScanState(t, server, upper, "available", "active")
	assertCaseScanState(t, server, lower, "missing", "missing")
}

func TestIncrementalLocalScanReconcilesCaseDistinctDuplicateRoots(t *testing.T) {
	root := t.TempDir()
	requireCaseDistinctScanDirectories(t, root)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	upper, lower := "A/"+code, "a/"+code
	writeCaseScanTrack(t, root, upper)
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: root, LocalScanDepth: 2})
	executeIncrementalLocalScanForTest(t, server, "A")
	writeCaseScanTrack(t, root, lower)
	runID := executeIncrementalLocalScanForTest(t, server, "a")
	var reason string
	if err := server.db.QueryRow(`SELECT json_extract(summary_json, '$.full_fallback_reason') FROM workflow_run WHERE id = ?`, runID).Scan(&reason); err != nil {
		t.Fatal(err)
	}
	if reason != "duplicate_work_roots" {
		t.Fatalf("fallback reason = %q", reason)
	}
	var folders int
	if err := server.db.QueryRow(`SELECT COUNT(*) FROM work_folder_location WHERE state = 'active'`).Scan(&folders); err != nil {
		t.Fatal(err)
	}
	if folders != 2 {
		t.Fatalf("active duplicate folders = %d, want 2", folders)
	}
	// Both paths are still separate candidates when scanned together.
	executeIncrementalLocalScanForTest(t, server, "A", "a")
	if err := os.RemoveAll(filepath.Join(root, "A")); err != nil {
		t.Fatal(err)
	}
	executeIncrementalLocalScanForTest(t, server, "A")
	var upperState, lowerState, availability string
	if err := server.db.QueryRow(`SELECT state FROM work_folder_location WHERE root_path = ?`, upper).Scan(&upperState); err != nil {
		t.Fatal(err)
	}
	if err := server.db.QueryRow(`SELECT state FROM work_folder_location WHERE root_path = ?`, lower).Scan(&lowerState); err != nil {
		t.Fatal(err)
	}
	if err := server.db.QueryRow(`SELECT availability FROM work_source_presence WHERE presence_type = 'local'`).Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if upperState != "missing" || lowerState != "active" || availability != "available" {
		t.Fatalf("duplicate removal: folders=%q/%q presence=%q", upperState, lowerState, availability)
	}
}
