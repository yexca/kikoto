package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLocalAndRemoteMediaKindsRecognizeVideo(t *testing.T) {
	for _, path := range []string{"movie.mp4", "movie.m4v", "movie.webm", "movie.mkv", "movie.mov", "movie.avi"} {
		if kind := localFileKind(path); kind != "video" {
			t.Fatalf("localFileKind(%q) = %q, want video", path, kind)
		}
		if kind := mediaKindFromPath(path); kind != "video" {
			t.Fatalf("mediaKindFromPath(%q) = %q, want video", path, kind)
		}
	}
	if kind := remoteTrackKindForPath("video", "stream.bin"); kind != "video" {
		t.Fatalf("remote video kind = %q", kind)
	}
	if kind := remoteTrackKindForPath("file", "bonus/movie.mp4"); kind != "video" {
		t.Fatalf("remote extension kind = %q", kind)
	}
}

func TestLocalAndRemoteMediaKindsRecognizeWMAAudio(t *testing.T) {
	if got := localFileKind("track.wma"); got != "audio" {
		t.Fatalf("localFileKind(track.wma) = %q, want audio", got)
	}
	if got := mediaKindFromPath("track.WMA"); got != "audio" {
		t.Fatalf("mediaKindFromPath(track.WMA) = %q, want audio", got)
	}
	if got := remoteTrackKindForPath("file", "disc/track.wma"); got != "audio" {
		t.Fatalf("remote WMA kind = %q, want audio", got)
	}
}

func TestLoadWorkMediaDerivesKindForPreviouslyIndexedWMA(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (701, 'RJ00000000', 'WMA fixture');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (702, 'fixture-local', 'Fixture local', 'local_folder');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (703, 701, 'file', '1', 'wma-1');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability, duration_seconds)
		VALUES (704, 703, 702, 'local', 'RJ00000000/1.wma', 'available', 847);
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	items, err := server.loadWorkMediaItems(context.Background(), 0, 701)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].Kind != "audio" || items[0].DurationSeconds == nil || *items[0].DurationSeconds != 847 {
		t.Fatalf("derived WMA item = %+v, want audio with duration", items)
	}
}

func TestLoadWorkMediaDerivesStreamURLForAvailableCacheLocation(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (711, 'RJ00000000', 'Cache fixture');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (712, 'fixture-remote', 'Fixture remote', 'kikoeru_compatible');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (713, 711, 'audio', '1', 'cache-1');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, stream_url, availability)
		VALUES (714, 713, 712, 'cache', 'media/fixture-remote/RJ/RJ00000000/1.mp3', '', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	items, err := server.loadWorkMediaItems(context.Background(), 0, 711)
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || len(items[0].Locations) != 1 {
		t.Fatalf("cache media items = %+v", items)
	}
	if got := items[0].Locations[0].StreamURL; got != "/api/media/714/stream" {
		t.Fatalf("cache stream URL = %q, want /api/media/714/stream", got)
	}
}

func TestParseMediaProbeOutputFindsDurationAndAudioStream(t *testing.T) {
	duration, hasAudio, ok := parseMediaProbeOutput([]byte(`{
		"streams":[{"codec_type":"video"},{"codec_type":"audio"}],
		"format":{"duration":"61.6"}
	}`))
	if !ok || !hasAudio || duration != 62 {
		t.Fatalf("probe result = duration %d, hasAudio %t, ok %t", duration, hasAudio, ok)
	}

	duration, hasAudio, ok = parseMediaProbeOutput([]byte(`{
		"streams":[{"codec_type":"video"}],
		"format":{"duration":"12.1"}
	}`))
	if !ok || hasAudio || duration != 12 {
		t.Fatalf("silent probe result = duration %d, hasAudio %t, ok %t", duration, hasAudio, ok)
	}
}
