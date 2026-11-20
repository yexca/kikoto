package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// A source that declares no size cannot confirm an existing file. A cache
// file counts only at its recorded size and is otherwise downloaded again; a
// target file counts only at its recorded size and is otherwise a target
// conflict for the user to resolve, never replaced silently.
func TestFetchPlanTrustsAnUnsizedFileOnlyAtItsRecordedSize(t *testing.T) {
	ctx := context.Background()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	code := testfixture.WorkCode(testfixture.PrefixRJ, 2)
	root := "Library/" + code
	cachePath := cacheMediaRelPath("example_remote", code, "track.mp3")
	execFetchTestStatements(t, db,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru'), (2, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, '`+code+`', 'Example Work')`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Track')`,
	)
	writeFetchTestFile(t, server.cfg.CacheRoot, cachePath, "partial")
	plan := func() remoteWorkSavePlanItem {
		t.Helper()
		item := remoteWorkSavePlanItem{
			ItemKey: "remote:track.mp3", Path: "track.mp3", SourceKind: "remote",
			TargetPath: root + "/track.mp3", CachePath: cachePath, RemoteSourceID: 1, RemoteSourceCode: "example_remote",
		}
		if err := applyRemoteFetchRemoteTargetState(server.cfg.DataRoot, &item, map[string]string{}, server.recordedFileSize(ctx, "local", 0, item.TargetPath)); err != nil {
			t.Fatal(err)
		}
		if item.Action == "" {
			if err := server.defaultRemoteFetchAction(ctx, &item, code); err != nil {
				t.Fatal(err)
			}
		}
		return item
	}

	// No target file: the cache file counts only at its recorded size.
	if item := plan(); item.Action != "cache_download" {
		t.Fatalf("unrecorded cache: action = %q, want cache_download", item.Action)
	}
	execFetchTestStatements(t, db, `INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, size_bytes, availability) VALUES (1, 1, 'cache', '`+cachePath+`', 100, 'available')`)
	if item := plan(); item.Action != "cache_download" {
		t.Fatalf("mismatched recorded cache size: action = %q, want cache_download", item.Action)
	}
	execFetchTestStatements(t, db, `UPDATE media_file_location SET size_bytes = 7 WHERE location_type = 'cache'`)
	if item := plan(); item.Action != "cache_hit" {
		t.Fatalf("recorded cache size: action = %q, want cache_hit", item.Action)
	}

	// A target file without a matching recorded size is a conflict.
	writeFetchTestFile(t, server.cfg.DataRoot, root+"/track.mp3", "partial")
	if item := plan(); item.Action != "conflict" || !item.TargetConflict || item.Status != "target_conflict" {
		t.Fatalf("unrecorded target: action = %q status = %q, want a target conflict", item.Action, item.Status)
	}
	execFetchTestStatements(t, db, `INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, size_bytes, availability) VALUES (1, 2, 'local', '`+root+`/track.mp3', 100, 'available')`)
	if item := plan(); item.Action != "conflict" || !item.TargetConflict {
		t.Fatalf("mismatched recorded target size: action = %q, want a target conflict", item.Action)
	}
	execFetchTestStatements(t, db, `UPDATE media_file_location SET size_bytes = 7 WHERE location_type = 'local'`)
	if item := plan(); item.Action != "skip" || item.Status != "local_exists" {
		t.Fatalf("recorded target size: action = %q status = %q, want skip local_exists", item.Action, item.Status)
	}
}
