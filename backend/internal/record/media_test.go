package record

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

const videoProbeJSON = `{"streams":[{"codec_type":"video","codec_name":"h264","width":1280,"height":720},{"codec_type":"audio","codec_name":"aac"}],"format":{"duration":"18.040000"}}`

func scannedStore(t *testing.T, files map[string]string, options ...Option) (*Store, *sqlutil.DB, string) {
	t.Helper()
	root := t.TempDir()
	for name, content := range files {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	db := storagetest.Open(t)
	store := NewStore(db, root, options...)
	if _, err := store.InitializeRoot(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	return store, db, root
}

func assetID(t *testing.T, db *sqlutil.DB, name string) int64 {
	t.Helper()
	var id int64
	if err := db.QueryRow(`SELECT id FROM record_asset WHERE name=?`, name).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func probeState(t *testing.T, db *sqlutil.DB, name string) (string, *float64, *int) {
	t.Helper()
	var state string
	var duration *float64
	var width *int
	if err := db.QueryRow(`SELECT probe_state, duration_seconds, width FROM record_asset WHERE name=?`, name).Scan(&state, &duration, &width); err != nil {
		t.Fatal(err)
	}
	return state, duration, width
}

func TestParseMediaInfo(t *testing.T) {
	info, err := ParseMediaInfo([]byte(videoProbeJSON), "video")
	if err != nil || info.DurationSeconds == nil || *info.DurationSeconds != 18.04 || *info.Width != 1280 || *info.Height != 720 || info.VideoCodec != "h264" || info.AudioCodec != "aac" || !*info.HasAudio {
		t.Fatalf("video info = %+v, err %v", info, err)
	}
	image, err := ParseMediaInfo([]byte(`{"streams":[{"codec_type":"video","codec_name":"mjpeg","width":800,"height":1200}],"format":{"duration":"0.04"}}`), "image")
	if err != nil || image.DurationSeconds != nil || *image.Width != 800 || image.HasAudio != nil {
		t.Fatalf("image info = %+v, err %v", image, err)
	}
	if _, err := ParseMediaInfo([]byte(`{"streams":[{"codec_type":"audio"}],"format":{}}`), "video"); err == nil {
		t.Fatal("a file without a picture was accepted")
	}
	if _, err := ParseMediaInfo([]byte(`not json`), "video"); err == nil {
		t.Fatal("malformed probe output was accepted")
	}
}

func TestScanProbesChangedFilesOnlyAndKeepsUnreadableOnesFailed(t *testing.T) {
	var calls atomic.Int32
	probe := func(_ context.Context, path string) ([]byte, error) {
		calls.Add(1)
		if strings.HasSuffix(path, "broken.mp4") {
			return nil, errors.New("invalid data")
		}
		return []byte(videoProbeJSON), nil
	}
	store, db, root := scannedStore(t, map[string]string{
		"trip/day1.mp4":   "video",
		"trip/broken.mp4": "corrupt",
		"trip/notes.nfo":  "metadata",
	}, WithProber(probe))

	if state, duration, width := probeState(t, db, "day1.mp4"); state != "ready" || duration == nil || *duration != 18.04 || width == nil || *width != 1280 {
		t.Fatalf("day1 = %s %v %v", state, duration, width)
	}
	if state, _, _ := probeState(t, db, "broken.mp4"); state != "failed" {
		t.Fatalf("broken probe state = %s", state)
	}
	if calls.Load() != 2 {
		t.Fatalf("probe calls = %d, want 2 (metadata is never probed)", calls.Load())
	}

	result, err := store.Scan(context.Background())
	if err != nil || result.Probe == nil || result.Probe.Probed != 0 || result.Probe.Remaining != 0 {
		t.Fatalf("unchanged rescan = %+v, %v", result.Probe, err)
	}
	if calls.Load() != 2 {
		t.Fatalf("an unchanged file was probed again: %d calls", calls.Load())
	}

	changed := filepath.Join(root, "trip", "day1.mp4")
	if err := os.WriteFile(changed, []byte("a longer video"), 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(changed, later, later); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 3 {
		t.Fatalf("a changed file was not probed again: %d calls", calls.Load())
	}
}

func TestProbeStopsOnCancelAndLeavesAssetsPending(t *testing.T) {
	store, db, _ := scannedStore(t, map[string]string{"a.mp4": "a", "b.mp4": "b"})
	ctx, cancel := context.WithCancel(context.Background())
	probe := func(ctx context.Context, _ string) ([]byte, error) {
		cancel()
		<-ctx.Done()
		return nil, ctx.Err()
	}
	if _, err := store.ProbePending(ctx, probe, 10, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled probe err = %v", err)
	}
	for _, name := range []string{"a.mp4", "b.mp4"} {
		if state, _, _ := probeState(t, db, name); state != "pending" {
			t.Fatalf("%s after cancel = %s", name, state)
		}
	}
}

func TestProbeWithoutFFprobeLeavesAssetsPending(t *testing.T) {
	store, db, _ := scannedStore(t, map[string]string{"a.mp4": "a"})
	result, err := store.ProbePending(context.Background(), func(context.Context, string) ([]byte, error) {
		return nil, ErrProbeUnavailable
	}, 10, 2)
	if err != nil || !result.Unavailable || result.Remaining != 1 {
		t.Fatalf("result = %+v, err %v", result, err)
	}
	if state, _, _ := probeState(t, db, "a.mp4"); state != "pending" {
		t.Fatalf("state = %s", state)
	}
}

func TestTreeCarriesProgressAndContinueListsUnfinishedVideos(t *testing.T) {
	store, db, _ := scannedStore(t, map[string]string{
		"trip/started.mp4":  "a",
		"trip/finished.mp4": "b",
		"trip/barely.mp4":   "c",
		"trip/recent.mp4":   "d",
		"trip/photo.jpg":    "e",
	})
	if _, err := db.Exec(`INSERT INTO user_account(id,username,role,enabled) VALUES (7,'viewer','user',1),(8,'other','user',1)`); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	duration := 120.0
	save := func(user int64, name string, position float64, completed bool) {
		t.Helper()
		if _, err := store.SaveProgress(ctx, user, assetID(t, db, name), Progress{PositionSeconds: position, DurationSeconds: &duration, Completed: completed}); err != nil {
			t.Fatal(err)
		}
	}
	save(7, "started.mp4", 40, false)
	save(7, "finished.mp4", 120, true)
	save(7, "barely.mp4", 2, false)
	save(7, "recent.mp4", 60, false)
	save(8, "started.mp4", 90, false)
	if _, err := db.Exec(`UPDATE record_asset_progress SET last_played_at='2026-01-01 00:00:00' WHERE asset_id=?`, assetID(t, db, "started.mp4")); err != nil {
		t.Fatal(err)
	}

	rootPage, err := store.ListTree(ctx, 0, 0, TreePageMax, 7)
	folders := rootPage.Folders
	if err != nil || len(folders) != 1 {
		t.Fatalf("root = %d folders, err %v", len(folders), err)
	}
	folderPage, err := store.ListTree(ctx, folders[0].ID, 0, TreePageMax, 7)
	assets := folderPage.Assets
	if err != nil {
		t.Fatal(err)
	}
	progress := map[string]*Progress{}
	for _, asset := range assets {
		progress[asset.Name] = asset.Progress
	}
	if progress["started.mp4"] == nil || progress["started.mp4"].PositionSeconds != 40 || progress["photo.jpg"] != nil {
		t.Fatalf("tree progress = %+v", progress)
	}

	continueList, err := store.ContinueWatching(ctx, 7, 10)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, asset := range continueList {
		names = append(names, asset.Name)
	}
	if strings.Join(names, ",") != "recent.mp4,started.mp4" {
		t.Fatalf("continue = %v", names)
	}
	if limited, _ := store.ContinueWatching(ctx, 7, 1); len(limited) != 1 {
		t.Fatalf("limited continue = %d", len(limited))
	}
}

func TestSubtitleToWebVTT(t *testing.T) {
	srt := "\xef\xbb\xbf1\r\n00:00:01,500 --> 00:00:03,000\r\nHello\r\n\r\n2\r\n0:00:04,2 --> 0:00:05,000 X:10\r\nTwo\r\nlines\r\n"
	got, err := SubtitleToWebVTT("Day 1.srt", []byte(srt))
	want := "WEBVTT\n\n00:00:01.500 --> 00:00:03.000\nHello\n\n00:00:04.200 --> 00:00:05.000\nTwo\nlines\n"
	if err != nil || string(got) != want {
		t.Fatalf("srt = %q, err %v", got, err)
	}
	if got, err := SubtitleToWebVTT("a.vtt", []byte("WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nHi\r\n")); err != nil || !strings.HasPrefix(string(got), "WEBVTT\n\n") {
		t.Fatalf("vtt = %q, err %v", got, err)
	}
	for name, data := range map[string][]byte{
		"no-header.vtt": []byte("00:01.000 --> 00:02.000\nHi\n"),
		"latin1.srt":    {0x31, 0x0a, 0xe9, 0xff},
		"styled.ass":    []byte("[Script Info]"),
		"large.vtt":     []byte("WEBVTT\n" + strings.Repeat("x", SubtitleMaxBytes)),
	} {
		if _, err := SubtitleToWebVTT(name, data); !errors.Is(err, ErrSubtitleUnsupported) {
			t.Fatalf("%s err = %v", name, err)
		}
	}
}

// fakeFFmpeg writes a minimal JPEG to the output argument, or garbage.
func fakeFFmpeg(calls *atomic.Int32, output []byte, fail func(args []string) bool) FFmpegFunc {
	return func(_ context.Context, args []string) error {
		calls.Add(1)
		if fail != nil && fail(args) {
			return errors.New("ffmpeg failed")
		}
		target := strings.TrimPrefix(args[len(args)-1], "file:")
		return os.WriteFile(target, output, 0o644)
	}
}

var tinyJPEG = []byte{0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 'J', 'F', 'I', 'F', 0xff, 0xd9}

func TestThumbnailerCachesPerRevisionAndRemembersFailures(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(input, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	thumbs := NewThumbnailer(dir, fakeFFmpeg(&calls, tinyJPEG, nil), 1)
	source := ThumbnailSource{AssetID: 300, Kind: "video", SizeBytes: 5, MtimeNs: 1, DurationSeconds: 60}
	ctx := context.Background()
	thumbnail := func(source ThumbnailSource) (string, error) {
		file, err := thumbs.Thumbnail(ctx, input, source)
		if err != nil {
			return "", err
		}
		_ = file.Close()
		return file.Name(), nil
	}
	first, err := thumbnail(source)
	if err != nil || ValidateImageFile(first, "image/jpeg") != nil || !strings.HasPrefix(first, dir) {
		t.Fatalf("first thumbnail = %q, %v", first, err)
	}
	if again, err := thumbnail(source); err != nil || again != first || calls.Load() != 1 {
		t.Fatalf("cached thumbnail = %q, %v, calls %d", again, err, calls.Load())
	}

	changed := source
	changed.MtimeNs = 2
	second, err := thumbnail(changed)
	if err != nil || second == first || calls.Load() != 2 {
		t.Fatalf("changed revision = %q, %v, calls %d", second, err, calls.Load())
	}
	if _, err := os.Stat(first); !os.IsNotExist(err) {
		t.Fatalf("stale revision kept: %v", err)
	}

	var badCalls atomic.Int32
	broken := NewThumbnailer(t.TempDir(), fakeFFmpeg(&badCalls, []byte("not a jpeg"), nil), 1)
	for range 2 {
		if _, err := broken.Thumbnail(ctx, input, source); !errors.Is(err, ErrThumbnailUnavailable) {
			t.Fatalf("invalid output err = %v", err)
		}
	}
	// One request tries the seek and the first frame; the second reads the failure marker.
	if badCalls.Load() != 2 {
		t.Fatalf("failed thumbnail runs = %d", badCalls.Load())
	}
}

func TestThumbnailerFallsBackToFirstFrameAndRejectsOtherKinds(t *testing.T) {
	input := filepath.Join(t.TempDir(), "short.mp4")
	if err := os.WriteFile(input, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	seekFails := func(args []string) bool {
		for _, arg := range args {
			if arg == "-ss" {
				return true
			}
		}
		return false
	}
	thumbs := NewThumbnailer(t.TempDir(), fakeFFmpeg(&calls, tinyJPEG, seekFails), 1)
	file, err := thumbs.Thumbnail(context.Background(), input, ThumbnailSource{AssetID: 1, Kind: "video", SizeBytes: 5, MtimeNs: 1})
	if err != nil || calls.Load() != 2 {
		t.Fatalf("fallback err = %v, calls %d", err, calls.Load())
	}
	_ = file.Close()
	if _, err := thumbs.Thumbnail(context.Background(), input, ThumbnailSource{AssetID: 2, Kind: "subtitle"}); !errors.Is(err, ErrThumbnailUnavailable) {
		t.Fatalf("subtitle thumbnail err = %v", err)
	}
}

func TestThumbnailerTakesAnAudioFilesCoverArt(t *testing.T) {
	input := filepath.Join(t.TempDir(), "talk.mp3")
	if err := os.WriteFile(input, []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	var seen []string
	run := func(_ context.Context, args []string) error {
		seen = args
		return os.WriteFile(strings.TrimPrefix(args[len(args)-1], "file:"), tinyJPEG, 0o600)
	}
	thumbs := NewThumbnailer(t.TempDir(), run, 1)
	file, err := thumbs.Thumbnail(context.Background(), input, ThumbnailSource{AssetID: 3, Kind: "audio", SizeBytes: 5, MtimeNs: 1})
	if err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	joined := strings.Join(seen, " ")
	if !strings.Contains(joined, "-map 0:v:0") || strings.Contains(joined, "-ss") {
		t.Fatalf("audio cover args = %v", seen)
	}
}

func TestAudioFilesAreIndexedAndProbedForTheirLengthAndCover(t *testing.T) {
	probe := func(_ context.Context, path string) ([]byte, error) {
		if strings.HasSuffix(path, "Episode 2.flac") {
			return []byte(`{"streams":[{"codec_type":"audio","codec_name":"flac"}],"format":{"duration":"60"}}`), nil
		}
		// Cover art reads as a video stream marked as an attached picture; the file stays audio.
		return []byte(`{"streams":[{"codec_type":"audio","codec_name":"mp3"},{"codec_type":"video","codec_name":"mjpeg","width":500,"height":500,"disposition":{"attached_pic":1}}],"format":{"duration":"7167.168"}}`), nil
	}
	store, db, _ := scannedStore(t, map[string]string{"talk/Episode 1.mp3": "audio", "talk/Episode 2.flac": "audio", "talk/notes.txt": "text"}, WithProber(probe))
	var kind, mime string
	if err := db.QueryRow(`SELECT kind, mime_type FROM record_asset WHERE name='Episode 1.mp3'`).Scan(&kind, &mime); err != nil || kind != "audio" || mime != "audio/mpeg" {
		t.Fatalf("mp3 = %s %s, %v", kind, mime, err)
	}
	state, duration, width := probeState(t, db, "Episode 1.mp3")
	if state != "ready" || duration == nil || *duration != 7167.168 || width != nil {
		t.Fatalf("mp3 probe = %s %v %v", state, duration, width)
	}
	if state, _, _ := probeState(t, db, "notes.txt"); state != "pending" {
		t.Fatalf("text probe state = %s", state)
	}
	covers := map[string]bool{}
	for _, name := range []string{"Episode 1.mp3", "Episode 2.flac"} {
		var id int64
		if err := db.QueryRow(`SELECT id FROM record_asset WHERE name=?`, name).Scan(&id); err != nil {
			t.Fatal(err)
		}
		asset, err := store.Asset(context.Background(), id)
		if err != nil {
			t.Fatal(err)
		}
		covers[name] = asset.HasCover
	}
	if !covers["Episode 1.mp3"] || covers["Episode 2.flac"] {
		t.Fatalf("covers = %v", covers)
	}
	video, err := ParseMediaInfo([]byte(videoProbeJSON), "video")
	if err != nil || video.HasCover != nil {
		t.Fatalf("video cover flag = %v, %v", video.HasCover, err)
	}
	if _, err := ParseMediaInfo([]byte(`{"streams":[{"codec_type":"video","width":1,"height":1}],"format":{"duration":"3"}}`), "audio"); err == nil {
		t.Fatal("an audio file without sound was accepted")
	}
}
