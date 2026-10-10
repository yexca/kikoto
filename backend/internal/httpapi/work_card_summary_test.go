package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestWorksWithLyricsRequiresKnownEnabledLyricsAvailability(t *testing.T) {
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

	available, err := server.loadWorksWithLyrics(context.Background(), []int64{301})
	if err != nil {
		t.Fatal(err)
	}
	if available[301] {
		t.Fatal("metadata-only edition must not be reported as having lyrics")
	}

	if _, err := db.Exec(`
		INSERT INTO media_item (id, work_id, kind, title, fingerprint)
		VALUES (301, 302, 'audio', 'Track 1', 'audio-301');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (301, 301, 301, 'remote_stream', 'RJ00000001/track.mp3', 'available')
	`); err != nil {
		t.Fatal(err)
	}
	available, err = server.loadWorksWithLyrics(context.Background(), []int64{301})
	if err != nil {
		t.Fatal(err)
	}
	if available[301] {
		t.Fatal("available audio without lyrics must not be reported as having lyrics")
	}

	if _, err := db.Exec(`
		INSERT INTO media_item (id, work_id, kind, title, fingerprint)
		VALUES (302, 302, 'text', 'Track lyrics', 'lyrics-302');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (302, 302, 301, 'remote_stream', 'RJ00000001/track.lrc', 'available')
	`); err != nil {
		t.Fatal(err)
	}
	available, err = server.loadWorksWithLyrics(context.Background(), []int64{301})
	if err != nil {
		t.Fatal(err)
	}
	if !available[301] {
		t.Fatal("available lyrics in a sibling edition must be reported")
	}

	if _, err := db.Exec("UPDATE file_source SET enabled = 0 WHERE id = 301"); err != nil {
		t.Fatal(err)
	}
	available, err = server.loadWorksWithLyrics(context.Background(), []int64{301})
	if err != nil {
		t.Fatal(err)
	}
	if available[301] {
		t.Fatal("disabled source must not make lyrics available")
	}
}

func TestWorksWithLyricsFollowsPlaybackLyricsResolution(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(321, 'RJ00000004', 'Example Work 1'),
			(322, 'RJ00000005', 'Example Work 2');
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (321, 'example_local', 'Example Local', 'local_folder', 1);
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(3211, 321, 'audio', 'Track 1', 'lyrics-status-3211'),
			(3212, 321, 'text', 'readme', 'lyrics-status-3212'),
			(3213, 321, 'text', 'script', 'lyrics-status-3213'),
			(3221, 322, 'audio', 'Track 1', 'lyrics-status-3221'),
			(3222, 322, 'text', 'Track 1 lyrics', 'lyrics-status-3222');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(3211, 3211, 321, 'local', 'Library/RJ00000004/01_track.mp3', 'available'),
			(3212, 3212, 321, 'local', 'Library/RJ00000004/readme.txt', 'available'),
			(3213, 3213, 321, 'local', 'Library/RJ00000004/script.txt', 'available'),
			(3221, 3221, 321, 'local', 'Library/RJ00000005/01_track.mp3', 'available'),
			(3222, 3222, 321, 'local', 'Library/RJ00000005/01_track.mp3.vtt', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	server := NewServer(db, config.Config{})
	load := func() map[int64]bool {
		t.Helper()
		available, err := server.loadWorksWithLyrics(context.Background(), []int64{321, 322})
		if err != nil {
			t.Fatal(err)
		}
		return available
	}

	available := load()
	if available[321] {
		t.Fatal("text files that match no track must not be reported as lyrics")
	}
	if !available[322] {
		t.Fatal("a lyrics file matched to a track by name must be reported")
	}

	if _, err := db.Exec("INSERT INTO media_lyrics_assignment (audio_media_item_id, lyrics_media_item_id) VALUES (3211, 3213)"); err != nil {
		t.Fatal(err)
	}
	if !load()[321] {
		t.Fatal("a library lyrics assignment must be reported")
	}

	if _, err := db.Exec("UPDATE media_file_location SET availability = 'missing' WHERE id = 3213"); err != nil {
		t.Fatal(err)
	}
	if load()[321] {
		t.Fatal("an assignment whose lyrics file is gone must not be reported")
	}
}

func TestWorksWithLyricsUsesOtherEditionsOnlyWithoutOwnTracks(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES
			(331, 'RJ00000006', 'Origin'),
			(332, 'RJ00000007', 'Translation');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (331, 331, 'RJ00000006');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
			(331, 331, 'RJ00000006', 'RJ00000006', 1),
			(332, 331, 'RJ00000007', 'RJ00000006', 0);
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (331, 'example_local', 'Example Local', 'local_folder', 1);
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES
			(3311, 331, 'audio', 'Track 1', 'lyrics-status-3311'),
			(3321, 332, 'audio', 'Track 1', 'lyrics-status-3321'),
			(3322, 332, 'text', 'Track 1 lyrics', 'lyrics-status-3322');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability) VALUES
			(3311, 3311, 331, 'local', 'Library/RJ00000006/01_track.mp3', 'available'),
			(3321, 3321, 331, 'local', 'Library/RJ00000007/01_track.mp3', 'available'),
			(3322, 3322, 331, 'local', 'Library/RJ00000007/01_track.vtt', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	server := NewServer(db, config.Config{})

	available, err := server.loadWorksWithLyrics(context.Background(), []int64{331, 332})
	if err != nil {
		t.Fatal(err)
	}
	if available[331] {
		t.Fatal("an edition with its own tracks must not take the lyrics status of another edition")
	}
	if !available[332] {
		t.Fatal("the edition that holds the matched lyrics must be reported")
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
	if tracked.WorkID != 312 {
		t.Fatalf("tracked family presence owner = %d, want 312", tracked.WorkID)
	}
	flags, err := server.sourceAvailabilityFlags(context.Background(), 311, "RJ00000002")
	if err != nil {
		t.Fatal(err)
	}
	if !flags.HasTracked {
		t.Fatal("family source availability reported hasTracked=false")
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

func TestParseSourcePresenceSummaryKeepsDistinctOwners(t *testing.T) {
	items := parseSourcePresenceSummary(
		"tracked|available|311|example_remote|Example Remote|a||RJ00000002|311," +
			"tracked|available|311|example_remote|Example Remote|b||RJ00000003|312",
	)
	if len(items) != 2 {
		t.Fatalf("parsed presence count = %d, want 2", len(items))
	}
	if items[0].WorkID != 311 || items[1].WorkID != 312 {
		t.Fatalf("parsed presence owners = %d/%d, want 311/312", items[0].WorkID, items[1].WorkID)
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
