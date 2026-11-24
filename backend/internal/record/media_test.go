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
	// A header read may name a picture stream without its dimensions; the
	// video keeps its length.
	header, err := ParseMediaInfo([]byte(`{"streams":[{"codec_type":"video","codec_name":"h264"}],"format":{"duration":"42.5"}}`), "video")
	if err != nil || header.DurationSeconds == nil || *header.DurationSeconds != 42.5 || header.Width != nil {
		t.Fatalf("header-only video info = %+v, err %v", header, err)
	}
	image, err := ParseMediaInfo([]byte(`{"streams":[{"codec_type":"video","codec_name":"mjpeg","width":800,"height":1200}],"format":{"duration":"0.04"}}`), "image")
	if err != nil || image.DurationSeconds != nil || *image.Width != 800 || image.HasAudio != nil {
		t.Fatalf("image info = %+v, err %v", image, err)
	}
	if _, err := ParseMediaInfo([]byte(`{"streams":[{"codec_type":"audio"}],"format":{}}`), "video"); err == nil {
		t.Fatal("a file without a picture was accepted")
	}
	if _, err := ParseMediaInfo([]byte(`{"streams":[{"codec_type":"audio"},{"codec_type":"video","width":500,"height":500,"disposition":{"attached_pic":1}}],"format":{"duration":"3"}}`), "video"); err == nil {
		t.Fatal("a video whose only picture is cover art was accepted")
	}
	if _, err := ParseMediaInfo([]byte(`not json`), "video"); err == nil {
		t.Fatal("malformed probe output was accepted")
	}
}

// A scan only walks: it records the scan as finished and counts the videos
// and audio files left to probe, and the probe pass reads them. Images and
// other files are never probed, and an unchanged file is probed once.
func TestScanLeavesProbingToTheProbePass(t *testing.T) {
	var calls atomic.Int32
	probe := func(_ context.Context, path string) ([]byte, error) {
		calls.Add(1)
		if strings.HasSuffix(path, "broken.mp4") {
			return nil, errors.New("invalid data")
		}
		return []byte(videoProbeJSON), nil
	}
	root := t.TempDir()
	for name, content := range map[string]string{
		"trip/day1.mp4": "video", "trip/broken.mp4": "corrupt", "trip/photo.jpg": "image", "trip/notes.nfo": "metadata",
	} {
		path := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	db := storagetest.Open(t)
	store := NewStore(db, root, WithProber(probe))
	if _, err := store.InitializeRoot(context.Background(), false); err != nil {
		t.Fatal(err)
	}
	scan, err := store.Scan(context.Background())
	if err != nil || scan.PendingProbes != 2 || calls.Load() != 0 {
		t.Fatalf("scan = %+v, %v; probe calls %d", scan, err, calls.Load())
	}
	if root, err := store.Root(context.Background()); err != nil || root.LastScannedAt == "" {
		t.Fatalf("a scan was not recorded as finished before probing: %+v, %v", root, err)
	}

	result, err := store.ProbePending(context.Background(), ProbeOptions{})
	if err != nil || result.Probed != 1 || result.Failed != 1 || result.Remaining != 0 {
		t.Fatalf("probe pass = %+v, %v", result, err)
	}
	if state, duration, width := probeState(t, db, "day1.mp4"); state != "ready" || duration == nil || *duration != 18.04 || width == nil || *width != 1280 {
		t.Fatalf("day1 = %s %v %v", state, duration, width)
	}
	if state, _, _ := probeState(t, db, "broken.mp4"); state != "failed" {
		t.Fatalf("broken probe state = %s", state)
	}
	if state, _, _ := probeState(t, db, "photo.jpg"); state != "pending" {
		t.Fatalf("an image was probed: %s", state)
	}
	if calls.Load() != 2 {
		t.Fatalf("probe calls = %d, want 2 (images and metadata are never probed)", calls.Load())
	}

	if scan, err := store.Scan(context.Background()); err != nil || scan.PendingProbes != 0 {
		t.Fatalf("unchanged rescan = %+v, %v", scan, err)
	}
	changed := filepath.Join(root, "trip", "day1.mp4")
	if err := os.WriteFile(changed, []byte("a longer video"), 0o600); err != nil {
		t.Fatal(err)
	}
	later := time.Now().Add(time.Hour)
	if err := os.Chtimes(changed, later, later); err != nil {
		t.Fatal(err)
	}
	if scan, err := store.Scan(context.Background()); err != nil || scan.PendingProbes != 1 {
		t.Fatalf("rescan after a change = %+v, %v", scan, err)
	}
	if _, err := store.ProbePending(context.Background(), ProbeOptions{}); err != nil || calls.Load() != 3 {
		t.Fatalf("a changed file was not probed again: %d calls, %v", calls.Load(), err)
	}
}

// A probe pass stops at a safe point when Between asks it to, keeping what it
// finished, and a later pass continues with the rest.
func TestProbePassStopsBetweenGroupsAndResumes(t *testing.T) {
	store, db, _ := scannedStore(t, map[string]string{"a.mp4": "a", "b.mp4": "b", "c.mp4": "c"}, WithProber(func(context.Context, string) ([]byte, error) {
		return []byte(videoProbeJSON), nil
	}))
	stop := errors.New("yield")
	result, err := store.ProbePending(context.Background(), ProbeOptions{Concurrency: 1, Between: func(ProbeResult) error { return stop }})
	if !errors.Is(err, stop) || result.Probed != 1 {
		t.Fatalf("stopped pass = %+v, %v", result, err)
	}
	if state, _, _ := probeState(t, db, "a.mp4"); state != "ready" {
		t.Fatalf("first file after the stop = %s", state)
	}
	if state, _, _ := probeState(t, db, "c.mp4"); state != "pending" {
		t.Fatalf("last file after the stop = %s", state)
	}
	result, err = store.ProbePending(context.Background(), ProbeOptions{Concurrency: 2})
	if err != nil || result.Probed != 2 || result.Remaining != 0 {
		t.Fatalf("resumed pass = %+v, %v", result, err)
	}
}

// A probe result for a revision the scan has since replaced is not kept.
func TestProbeOfAChangedFileIsNotKept(t *testing.T) {
	var store *Store
	var root string
	store, db, root := scannedStore(t, map[string]string{"a.mp4": "a"}, WithProber(func(context.Context, string) ([]byte, error) {
		later := time.Now().Add(time.Hour)
		path := filepath.Join(root, "a.mp4")
		if err := os.WriteFile(path, []byte("rewritten while probing"), 0o600); err != nil {
			t.Error(err)
		}
		if err := os.Chtimes(path, later, later); err != nil {
			t.Error(err)
		}
		if _, err := store.Scan(context.Background()); err != nil {
			t.Error(err)
		}
		return []byte(videoProbeJSON), nil
	}))
	if _, err := store.ProbePending(context.Background(), ProbeOptions{Concurrency: 1, Between: func(ProbeResult) error { return errors.New("stop") }}); err == nil {
		t.Fatal("the pass did not stop")
	}
	if state, duration, _ := probeState(t, db, "a.mp4"); state != "pending" || duration != nil {
		t.Fatalf("a probe of the earlier revision was kept: %s %v", state, duration)
	}
}

// A cancel keeps the probes of its group that had finished, leaves the file
// it interrupted and the files after it pending, and reports what remains.
func TestProbeStopsOnCancelAndLeavesAssetsPending(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	store, db, _ := scannedStore(t, map[string]string{"a.mp4": "a", "b.mp4": "b", "c.mp4": "c"}, WithProber(func(ctx context.Context, path string) ([]byte, error) {
		if filepath.Base(path) == "a.mp4" {
			return []byte(videoProbeJSON), nil
		}
		cancel()
		<-ctx.Done()
		return nil, ctx.Err()
	}))
	result, err := store.ProbePending(ctx, ProbeOptions{Concurrency: 2})
	if !errors.Is(err, context.Canceled) || result.Probed != 1 || result.Remaining != 2 {
		t.Fatalf("cancelled probe = %+v, %v", result, err)
	}
	if state, duration, _ := probeState(t, db, "a.mp4"); state != "ready" || duration == nil {
		t.Fatalf("a probe finished before the cancel was not kept: %s %v", state, duration)
	}
	for _, name := range []string{"b.mp4", "c.mp4"} {
		if state, _, _ := probeState(t, db, name); state != "pending" {
			t.Fatalf("%s after cancel = %s", name, state)
		}
	}
}

func TestProbeWithoutFFprobeLeavesAssetsPending(t *testing.T) {
	store, db, _ := scannedStore(t, map[string]string{"a.mp4": "a"}, WithProber(func(context.Context, string) ([]byte, error) {
		return nil, ErrProbeUnavailable
	}))
	result, err := store.ProbePending(context.Background(), ProbeOptions{Concurrency: 2})
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

	rootView, err := store.FolderView(ctx, 0, SectionPageMax, 7)
	folders := sectionOf(t, rootView, SectionFolders).Folders
	if err != nil || len(folders) != 1 {
		t.Fatalf("root = %d folders, err %v", len(folders), err)
	}
	folderView, err := store.FolderView(ctx, folders[0].ID, SectionPageMax, 7)
	if err != nil {
		t.Fatal(err)
	}
	assets := append(sectionOf(t, folderView, SectionVideos).Assets, sectionOf(t, folderView, SectionPhotos).Assets...)
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

// A video whose length the probe pass has not read yet has it read when its
// thumbnail is made, so the frame is still taken a tenth of the way in.
func TestThumbnailerReadsAnUnknownVideoLength(t *testing.T) {
	input := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(input, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	var seek string
	var reads atomic.Int32
	thumbs := NewThumbnailer(t.TempDir(), func(_ context.Context, args []string) error {
		for index, arg := range args {
			if arg == "-ss" {
				seek = args[index+1]
			}
		}
		return os.WriteFile(strings.TrimPrefix(args[len(args)-1], "file:"), tinyJPEG, 0o644)
	}, 1, WithThumbnailProbe(func(_ context.Context, assetID int64) ThumbnailDetails {
		reads.Add(1)
		return ThumbnailDetails{Read: true, DurationSeconds: 300}
	}))
	file, err := thumbs.Thumbnail(context.Background(), input, ThumbnailSource{AssetID: 7, Kind: "video", SizeBytes: 5, MtimeNs: 1})
	if err != nil || seek != "30.000" || reads.Load() != 1 {
		t.Fatalf("thumbnail err = %v, seek %q, reads %d", err, seek, reads.Load())
	}
	_ = file.Close()
	if file, err := thumbs.Thumbnail(context.Background(), input, ThumbnailSource{AssetID: 8, Kind: "video", SizeBytes: 5, MtimeNs: 1, DurationSeconds: 50}); err != nil || seek != "5.000" || reads.Load() != 1 {
		t.Fatalf("known length err = %v, seek %q, reads %d", err, seek, reads.Load())
	} else {
		_ = file.Close()
	}
}

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

// An audio file whose details are unread has them read first; one without
// cover art has no thumbnail and runs no ffmpeg, and one whose read could not
// finish is tried with ffmpeg.
func TestThumbnailerReadsWhetherAnUnreadAudioFileHasCoverArt(t *testing.T) {
	input := filepath.Join(t.TempDir(), "talk.mp3")
	if err := os.WriteFile(input, []byte("audio"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	details := map[int64]ThumbnailDetails{1: {Read: true}, 2: {Read: true, HasCover: true}, 3: {}}
	thumbs := NewThumbnailer(t.TempDir(), fakeFFmpeg(&calls, tinyJPEG, nil), 1, WithThumbnailProbe(func(_ context.Context, assetID int64) ThumbnailDetails {
		return details[assetID]
	}))
	source := func(id int64) ThumbnailSource {
		return ThumbnailSource{AssetID: id, Kind: "audio", SizeBytes: 5, MtimeNs: 1, CoverUnknown: true}
	}
	if _, err := thumbs.Thumbnail(context.Background(), input, source(1)); !errors.Is(err, ErrThumbnailUnavailable) || calls.Load() != 0 {
		t.Fatalf("audio without cover = %v, ffmpeg calls %d", err, calls.Load())
	}
	for _, id := range []int64{2, 3} {
		file, err := thumbs.Thumbnail(context.Background(), input, source(id))
		if err != nil {
			t.Fatalf("audio %d thumbnail = %v", id, err)
		}
		_ = file.Close()
	}
	if calls.Load() != 2 {
		t.Fatalf("ffmpeg calls = %d, want 2", calls.Load())
	}
}

// A pass over a root that is not online, such as another disk mounted at its
// path, is refused before any file is read, so its files stay pending; a pass
// limited to some files reads only those.
func TestProbePassesWaitForTheRootAndKeepToTheirFiles(t *testing.T) {
	var calls atomic.Int32
	store, db, root := scannedStore(t, map[string]string{"a.mp4": "a", "b.mp4": "b"}, WithProber(func(context.Context, string) ([]byte, error) {
		calls.Add(1)
		return []byte(videoProbeJSON), nil
	}))
	ctx := context.Background()
	result, err := store.ProbeAssets(ctx, []int64{assetID(t, db, "a.mp4")}, ProbeOptions{})
	if err != nil || result.Probed != 1 || result.Remaining != 1 || calls.Load() != 1 {
		t.Fatalf("limited pass = %+v, %v; probe calls %d", result, err, calls.Load())
	}
	if state, _, _ := probeState(t, db, "b.mp4"); state != "pending" {
		t.Fatalf("a file the pass did not name = %s", state)
	}
	if err := writeMarker(root, "00000000000000000000000000000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.ProbePending(ctx, ProbeOptions{}); !errors.Is(err, ErrRootOffline) || calls.Load() != 1 {
		t.Fatalf("pass on another disk = %v; probe calls %d", err, calls.Load())
	}
	if state, _, _ := probeState(t, db, "b.mp4"); state != "pending" {
		t.Fatalf("a file on another disk = %s", state)
	}
	// A thumbnail that opens the file first reads nothing from the other disk either.
	if asset, err := store.ProbeIfPending(ctx, assetID(t, db, "b.mp4")); err != nil || !asset.ProbePending || calls.Load() != 1 {
		t.Fatalf("opened file on another disk = %+v, %v; probe calls %d", asset, err, calls.Load())
	}
	if state, _, _ := probeState(t, db, "b.mp4"); state != "pending" {
		t.Fatalf("an opened file on another disk = %s", state)
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
	if _, err := store.ProbePending(context.Background(), ProbeOptions{}); err != nil {
		t.Fatal(err)
	}
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

// A probe that times out, as on a disk spinning up, leaves the file pending
// for a later pass instead of failing it for good, and the pass that timed out
// does not try it again.
func TestProbeTimeoutLeavesTheFilePending(t *testing.T) {
	var calls atomic.Int32
	store, db, _ := scannedStore(t, map[string]string{"a.mp4": "a"}, WithProber(func(context.Context, string) ([]byte, error) {
		calls.Add(1)
		return nil, ErrMediaToolTimedOut
	}))
	result, err := store.ProbePending(context.Background(), ProbeOptions{Concurrency: 1})
	if err != nil || result.TimedOut != 1 || result.Failed != 0 || result.Remaining != 1 || calls.Load() != 1 {
		t.Fatalf("result = %+v, err %v, calls %d", result, err, calls.Load())
	}
	if len(result.TimedOutIDs) != 1 {
		t.Fatalf("timed-out ids = %v", result.TimedOutIDs)
	}
	if state, _, _ := probeState(t, db, "a.mp4"); state != "pending" {
		t.Fatalf("state after a timeout = %s", state)
	}
	// A resumed pass that skips it leaves it alone.
	if result, err := store.ProbePending(context.Background(), ProbeOptions{Skip: result.TimedOutIDs}); err != nil || calls.Load() != 1 || result.Remaining != 1 {
		t.Fatalf("resumed pass = %+v, %v, calls %d", result, err, calls.Load())
	}
}

// Opening a file before the probe pass reaches it reads it once; playback's
// own read of the file is kept only for the revision it describes.
func TestFilesAreProbedWhenOpenedBeforeThePass(t *testing.T) {
	var calls atomic.Int32
	store, db, _ := scannedStore(t, map[string]string{"a.mp4": "a", "b.mp4": "b"}, WithProber(func(context.Context, string) ([]byte, error) {
		calls.Add(1)
		return []byte(videoProbeJSON), nil
	}))
	id := assetID(t, db, "a.mp4")
	asset, err := store.ProbeIfPending(context.Background(), id)
	if err != nil || asset.DurationSeconds == nil || *asset.DurationSeconds != 18.04 || calls.Load() != 1 {
		t.Fatalf("opened asset = %+v, %v, calls %d", asset, err, calls.Load())
	}
	if _, err := store.ProbeIfPending(context.Background(), id); err != nil || calls.Load() != 1 {
		t.Fatalf("a probed file was read again: %d calls, %v", calls.Load(), err)
	}

	other := assetID(t, db, "b.mp4")
	var size, mtime int64
	if err := db.QueryRow(`SELECT size_bytes, mtime_ns FROM record_asset WHERE id=?`, other).Scan(&size, &mtime); err != nil {
		t.Fatal(err)
	}
	if err := store.RecordProbe(context.Background(), other, size+1, mtime, []byte(videoProbeJSON)); err != nil {
		t.Fatal(err)
	}
	if state, _, _ := probeState(t, db, "b.mp4"); state != "pending" {
		t.Fatalf("a read of another revision was kept: %s", state)
	}
	if err := store.RecordProbe(context.Background(), other, size, mtime, []byte(videoProbeJSON)); err != nil {
		t.Fatal(err)
	}
	if state, duration, _ := probeState(t, db, "b.mp4"); state != "ready" || duration == nil || *duration != 18.04 {
		t.Fatalf("playback's read = %s %v", state, duration)
	}
}

// A thumbnail that timed out is not remembered as failed: the request is busy,
// and a later one renders it.
func TestThumbnailTimeoutIsTriedAgain(t *testing.T) {
	input := filepath.Join(t.TempDir(), "clip.mp4")
	if err := os.WriteFile(input, []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	var calls atomic.Int32
	timedOut := true
	thumbs := NewThumbnailer(t.TempDir(), func(ctx context.Context, args []string) error {
		if timedOut {
			calls.Add(1)
			return ErrMediaToolTimedOut
		}
		return fakeFFmpeg(&calls, tinyJPEG, nil)(ctx, args)
	}, 1)
	source := ThumbnailSource{AssetID: 301, Kind: "image", SizeBytes: 5, MtimeNs: 1}
	if _, err := thumbs.Thumbnail(context.Background(), input, source); !errors.Is(err, ErrThumbnailBusy) {
		t.Fatalf("timed out thumbnail err = %v, want ErrThumbnailBusy", err)
	}
	timedOut = false
	file, err := thumbs.Thumbnail(context.Background(), input, source)
	if err != nil {
		t.Fatalf("thumbnail after the timeout = %v", err)
	}
	_ = file.Close()
}
