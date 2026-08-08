package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestPrepareRemoteFetchUsesPersistedMetadata(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000003', 'Cached work')")
	if err != nil {
		t.Fatal(err)
	}
	workID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	logical, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ00000003')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalID, err := logical.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, metadata_language, edition_label, is_canonical, translation_kind)
		VALUES (?, ?, ?, 'RJ00000003', 'ja-jp', 'Japanese', 1, 'origin')
	`, workID, logicalID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (?, ?, 'RJ00000003', '{"_kikoto":{"response_language":"ja-jp"}}')
	`, workID, providerID); err != nil {
		t.Fatal(err)
	}

	var before int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&before); err != nil {
		t.Fatal(err)
	}
	if err := server.ensureRemoteFetchMetadata(context.Background(), "RJ00000003"); err != nil {
		t.Fatal(err)
	}
	preparation := server.prepareRemoteFetch(context.Background(), "RJ00000003")
	var after int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&after); err != nil {
		t.Fatal(err)
	}

	if preparation.MetadataStatus != "complete" || preparation.CanonicalCode != "RJ00000003" || len(preparation.Editions) != 1 {
		t.Fatalf("preparation = %+v", preparation)
	}
	if after != before {
		t.Fatalf("metadata snapshots changed from %d to %d during Fetch preparation", before, after)
	}
}

func TestRemoteFetchMetadataReadyRejectsLocalizedOriginSnapshot(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000000', '中文标题')")
	if err != nil {
		t.Fatal(err)
	}
	workID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	logical, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ00000000')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalID, err := logical.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, metadata_language, edition_label, is_canonical, translation_kind)
		VALUES (?, ?, ?, 'RJ00000000', 'ja-jp', 'Japanese', 1, 'origin')
	`, workID, logicalID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (?, ?, 'RJ00000000', '{"_kikoto":{"response_language":"zh-cn"}}')
	`, workID, providerID); err != nil {
		t.Fatal(err)
	}

	ready, err := server.remoteFetchMetadataReady(context.Background(), "RJ00000000")
	if err != nil {
		t.Fatal(err)
	}
	if ready {
		t.Fatal("localized Origin snapshot was treated as complete Fetch metadata")
	}
}

func TestRemoteFetchMetadataReadyRejectsRemoteOnlyWorkShell(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ00000001', 'Remote shell')"); err != nil {
		t.Fatal(err)
	}
	ready, err := server.remoteFetchMetadataReady(context.Background(), "RJ00000001")
	if err != nil {
		t.Fatal(err)
	}
	if ready {
		t.Fatal("remote-only work shell was treated as complete Fetch metadata")
	}
}

func TestRemoteWorkTrackCacheReusesSnapshot(t *testing.T) {
	server := NewServer(nil, config.Config{})
	key := "7:RJ00000002"
	server.remoteWorkCache[key] = remoteWorkSnapshot{
		Source:    remoteSourceForUse{ID: 7, Code: "cached"},
		Work:      kikoeru.Work{ID: 95, SourceID: "RJ00000002"},
		ExpiresAt: time.Now().Add(time.Minute),
	}
	server.remoteWorkTracksCache[key] = remoteWorkTracksSnapshot{
		Source:    remoteSourceForUse{ID: 7, Code: "cached"},
		Work:      kikoeru.Work{ID: 95, SourceID: "RJ00000002"},
		Tracks:    []kikoeru.Track{{Type: "audio", Title: "Cached track"}},
		ExpiresAt: time.Now().Add(time.Minute),
	}

	source, work, tracks, err := server.loadRemoteWorkTracksCached(context.Background(), 7, "rj00000002")
	if err != nil {
		t.Fatal(err)
	}
	if source.ID != 7 || work.ID != 95 || len(tracks) != 1 || tracks[0].Title != "Cached track" {
		t.Fatalf("cached snapshot = source %+v work %+v tracks %+v", source, work, tracks)
	}
}

func TestInvalidateRemoteWorkCacheRemovesOnlySelectedSource(t *testing.T) {
	server := NewServer(nil, config.Config{})
	server.remoteWorkCache["7:RJ00000002"] = remoteWorkSnapshot{}
	server.remoteWorkCache["7:RJ00000003"] = remoteWorkSnapshot{}
	server.remoteWorkCache["8:RJ00000002"] = remoteWorkSnapshot{}
	server.remoteWorkTracksCache["7:RJ00000002"] = remoteWorkTracksSnapshot{}
	server.remoteWorkTracksCache["7:RJ00000003"] = remoteWorkTracksSnapshot{}
	server.remoteWorkTracksCache["8:RJ00000002"] = remoteWorkTracksSnapshot{}

	server.invalidateRemoteWorkCache(7)

	if len(server.remoteWorkCache) != 1 || len(server.remoteWorkTracksCache) != 1 {
		t.Fatalf("cache sizes = metadata %d, tracks %d, want 1", len(server.remoteWorkCache), len(server.remoteWorkTracksCache))
	}
	if _, ok := server.remoteWorkCache["8:RJ00000002"]; !ok {
		t.Fatal("cache entry for another source was removed")
	}
}
