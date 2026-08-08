package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestAvailableNonOriginEditionRequiresKnownEnabledAvailability(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(301, 'RJ00000000', 'Origin'),
			(302, 'RJ00000001', 'Translation');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (301, 301, 'RJ00000000');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(301, 301, 'RJ00000000', 'RJ00000000', 1),
			(302, 301, 'RJ00000001', 'RJ00000000', 0);
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (301, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1);
	`); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	server := NewServer(db, config.Config{})

	available, err := server.loadAvailableNonOriginEditions(context.Background(), []int64{301})
	if err != nil {
		t.Fatal(err)
	}
	if available[301] {
		t.Fatal("metadata-only non-Origin edition must not be reported as available")
	}

	if _, err := db.Exec(`
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability)
		VALUES (302, 301, 'source', 'available')
	`); err != nil {
		t.Fatal(err)
	}
	available, err = server.loadAvailableNonOriginEditions(context.Background(), []int64{301})
	if err != nil {
		t.Fatal(err)
	}
	if !available[301] {
		t.Fatal("available non-Origin source presence must be reported")
	}

	if _, err := db.Exec("UPDATE file_source SET enabled = 0 WHERE id = 301"); err != nil {
		t.Fatal(err)
	}
	available, err = server.loadAvailableNonOriginEditions(context.Background(), []int64{301})
	if err != nil {
		t.Fatal(err)
	}
	if available[301] {
		t.Fatal("disabled source must not make a non-Origin edition available")
	}
}

func TestTrackedPresenceForkStateUsesWholeLogicalFamily(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(311, 'RJ00000002', 'Origin'),
			(312, 'RJ00000003', 'Translation');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (311, 311, 'RJ00000002');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(311, 311, 'RJ00000002', 'RJ00000002', 1),
			(312, 311, 'RJ00000003', 'RJ00000002', 0);
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (311, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1);
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, remote_code, availability)
		VALUES (312, 311, 'tracked', 'RJ00000003', 'available');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint)
		VALUES (311, 312, 'audio', 'Track 1', 'family-fork-track');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (311, 311, 311, 'remote_stream', 'RJ00000003/track.mp3', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	server := NewServer(db, config.Config{})

	items := server.sourcePresenceForCode(context.Background(), "RJ00000002")
	tracked := trackedPresenceForTest(items, 311)
	if tracked == nil || tracked.Forked == nil || !*tracked.Forked {
		t.Fatalf("tracked family presence = %#v, want forked true", tracked)
	}

	if _, err := db.Exec("UPDATE media_file_location SET availability = 'missing' WHERE id = 311"); err != nil {
		t.Fatal(err)
	}
	items = server.sourcePresenceForCode(context.Background(), "RJ00000002")
	tracked = trackedPresenceForTest(items, 311)
	if tracked == nil || tracked.Forked == nil || *tracked.Forked {
		t.Fatalf("tracked family presence = %#v, want forked false", tracked)
	}
}

func trackedPresenceForTest(items []sourcePresenceItem, sourceID int64) *sourcePresenceItem {
	for index := range items {
		if items[index].Type == "tracked" && items[index].FileSourceID == sourceID {
			return &items[index]
		}
	}
	return nil
}
