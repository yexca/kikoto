package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestApplyRemoteFetchSourceDecisionSelectsPerFileSource(t *testing.T) {
	size := int64(42)
	item := remoteWorkSavePlanItem{Path: "audio/track.mp3"}
	options := []remoteFetchSourceOption{
		{SourceID: 1, SourceCode: "one", SourceName: "One", Path: item.Path, SourcePath: "https://one.invalid/track", SizeBytes: &size, Kind: "audio"},
		{SourceID: 2, SourceCode: "two", SourceName: "Two", Path: item.Path, SourcePath: "https://two.invalid/track", SizeBytes: &size, Kind: "audio"},
	}
	if err := applyRemoteFetchSourceDecision(&item, remoteFetchFileDecision{SourceID: 2}, options, remoteSourceForUse{ID: 1}, "RJ01234567"); err != nil {
		t.Fatal(err)
	}
	if item.RemoteSourceID != 2 || item.RemoteSourceCode != "two" || item.SourcePath != "https://two.invalid/track" {
		t.Fatalf("selected item = %+v", item)
	}
	if item.CachePath != "media/two/RJ/012/RJ01234567/audio/track.mp3" {
		t.Fatalf("cache path = %q", item.CachePath)
	}
}

func TestKeepBothAllocatesSafeTarget(t *testing.T) {
	dataRoot := filepath.Join(t.TempDir(), "data")
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot, CacheRoot: filepath.Join(t.TempDir(), "cache")})
	existing := filepath.Join(dataRoot, "source", "RJ01234567", "track.mp3")
	if err := os.MkdirAll(filepath.Dir(existing), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(existing, []byte("local"), 0o644); err != nil {
		t.Fatal(err)
	}
	item := remoteWorkSavePlanItem{
		Path: "track.mp3", TargetPath: "source/RJ01234567/track.mp3", RemoteSourceCode: "remote_two",
		TargetConflict: true, TargetConflictReason: "different size", Action: "conflict",
	}
	seen := map[string]string{item.TargetPath: item.Path}
	if err := server.applyRemoteFetchConflictDecision(&item, remoteFetchFileDecision{Resolution: "keep_both"}, "source/RJ01234567", seen); err != nil {
		t.Fatal(err)
	}
	if item.TargetConflict || item.Action != "" || item.TargetPath != "source/RJ01234567/track (remote_two).mp3" {
		t.Fatalf("resolved item = %+v", item)
	}
}

func TestFinishFetchPresenceKeepsTrackedAndRetiresRemoteStream(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	ctx := context.Background()
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru'), (2, 'local', 'Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ01234567', 'Work')`,
		`INSERT INTO media_item (id, work_id, kind, title) VALUES (1, 1, 'audio', 'Track')`,
		`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability) VALUES (1, 1, 'remote_stream', 'track.mp3', 'available'), (1, 1, 'cache', 'media/remote/RJ/012/RJ01234567/track.mp3', 'available')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if err := server.finishFetchPresence(ctx, 1, []int64{1}, 2, "RJ01234567"); err != nil {
		t.Fatal(err)
	}
	var tracked, remoteStreams, caches int
	if err := db.QueryRow(`SELECT COUNT(*) FROM work_source_presence WHERE work_id = 1 AND file_source_id = 1 AND presence_type = 'tracked' AND availability = 'available'`).Scan(&tracked); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND location_type = 'remote_stream'`).Scan(&remoteStreams); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE media_item_id = 1 AND location_type = 'cache' AND availability = 'available'`).Scan(&caches); err != nil {
		t.Fatal(err)
	}
	if tracked != 1 || remoteStreams != 0 || caches != 1 {
		t.Fatalf("tracked=%d remoteStreams=%d caches=%d", tracked, remoteStreams, caches)
	}
}
