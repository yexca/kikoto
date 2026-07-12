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
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999996', 'Cached work')")
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
	logical, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ09999996')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalID, err := logical.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, metadata_language, edition_label, is_canonical, translation_kind)
		VALUES (?, ?, ?, 'RJ09999996', 'ja-jp', 'Japanese', 1, 'origin')
	`, workID, logicalID, providerID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (?, ?, 'RJ09999996', '{}')
	`, workID, providerID); err != nil {
		t.Fatal(err)
	}

	var before int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&before); err != nil {
		t.Fatal(err)
	}
	preparation := server.prepareRemoteFetch(context.Background(), "RJ09999996")
	var after int
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&after); err != nil {
		t.Fatal(err)
	}

	if preparation.MetadataStatus != "complete" || preparation.CanonicalCode != "RJ09999996" || len(preparation.Editions) != 1 {
		t.Fatalf("preparation = %+v", preparation)
	}
	if after != before {
		t.Fatalf("metadata snapshots changed from %d to %d during Fetch preparation", before, after)
	}
}

func TestRemoteWorkTrackCacheReusesSnapshot(t *testing.T) {
	server := NewServer(nil, config.Config{})
	key := "7:RJ09999995"
	server.remoteWorkCache[key] = remoteWorkTracksSnapshot{
		Source:    remoteSourceForUse{ID: 7, Code: "cached"},
		Work:      kikoeru.Work{ID: 95, SourceID: "RJ09999995"},
		Tracks:    []kikoeru.Track{{Type: "audio", Title: "Cached track"}},
		ExpiresAt: time.Now().Add(time.Minute),
	}

	source, work, tracks, err := server.loadRemoteWorkTracksCached(context.Background(), 7, "rj09999995")
	if err != nil {
		t.Fatal(err)
	}
	if source.ID != 7 || work.ID != 95 || len(tracks) != 1 || tracks[0].Title != "Cached track" {
		t.Fatalf("cached snapshot = source %+v work %+v tracks %+v", source, work, tracks)
	}
}
