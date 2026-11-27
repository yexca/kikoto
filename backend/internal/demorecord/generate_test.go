package demorecord

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/record"
)

// fakeFFmpeg writes a few bytes to the output path, the last argument.
func fakeFFmpeg(runs *int) FFmpegFunc {
	return func(_ context.Context, args []string) error {
		*runs++
		return os.WriteFile(args[len(args)-1], []byte("sample"), 0o644)
	}
}

func TestEnsureGeneratesTheSampleSetOnceAndKeepsItsMarker(t *testing.T) {
	root := filepath.Join(t.TempDir(), "demo-record")
	runs := 0
	generated, err := Ensure(context.Background(), root, fakeFFmpeg(&runs))
	if err != nil || !generated {
		t.Fatalf("Ensure() = %v, %v; want a generated set", generated, err)
	}
	for _, path := range SamplePaths() {
		if info, err := os.Stat(filepath.Join(root, filepath.FromSlash(path))); err != nil || info.Size() == 0 {
			t.Fatalf("sample %s missing or empty: %v", path, err)
		}
	}
	// The root holds the samples alone; the manifest sits beside it.
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "Sample ") {
			t.Fatalf("root holds %q beside the samples", entry.Name())
		}
	}

	// A start that finds the set leaves it and runs nothing.
	if err := os.WriteFile(filepath.Join(root, markerName), []byte("marker"), 0o644); err != nil {
		t.Fatal(err)
	}
	before := runs
	if generated, err := Ensure(context.Background(), root, fakeFFmpeg(&runs)); err != nil || generated || runs != before {
		t.Fatalf("second Ensure() = %v, %v with %d runs; want the set kept", generated, err, runs-before)
	}

	// Another layout generates the set again, drops the samples it retired,
	// and keeps the root's identity.
	retired := filepath.Join(root, "Sample old", "Retired.mp4")
	if err := os.MkdirAll(filepath.Dir(retired), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(retired, []byte("sample"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeManifest(root, "older-layout", []string{"Sample old/Retired.mp4"}); err != nil {
		t.Fatal(err)
	}
	if generated, err := Ensure(context.Background(), root, fakeFFmpeg(&runs)); err != nil || !generated {
		t.Fatalf("Ensure() after a layout change = %v, %v", generated, err)
	}
	if _, err := os.Stat(retired); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("retired sample after regeneration: %v", err)
	}
	if marker, err := os.ReadFile(filepath.Join(root, markerName)); err != nil || string(marker) != "marker" {
		t.Fatalf("marker after regeneration = %q, %v", marker, err)
	}

	// A root that lost its manifest is still recognized as Demo's.
	if err := os.Remove(manifestPath(root)); err != nil {
		t.Fatal(err)
	}
	if generated, err := Ensure(context.Background(), root, fakeFFmpeg(&runs)); err != nil || !generated {
		t.Fatalf("Ensure() without a manifest = %v, %v; want the set generated again", generated, err)
	}
}

func TestEnsureNeverServesOrReplacesFilesItDidNotGenerate(t *testing.T) {
	ctx := context.Background()
	runs := 0
	generatedRoot := filepath.Join(t.TempDir(), "demo-record")
	if _, err := Ensure(ctx, generatedRoot, fakeFFmpeg(&runs)); err != nil {
		t.Fatal(err)
	}
	foreignRoot := t.TempDir()
	for _, test := range []struct {
		name, root, personal string
	}{
		{"a folder of its own", foreignRoot, filepath.Join(foreignRoot, "holiday.mp4")},
		// Its manifest is current, yet the root no longer holds only samples.
		{"a file added to the generated set", generatedRoot, filepath.Join(generatedRoot, "Sample trip", "Day 1", "holiday.mp4")},
	} {
		t.Run(test.name, func(t *testing.T) {
			personal := test.personal
			if err := os.WriteFile(personal, []byte("video"), 0o644); err != nil {
				t.Fatal(err)
			}
			before := runs
			if _, err := Ensure(ctx, test.root, fakeFFmpeg(&runs)); !errors.Is(err, ErrForeignRoot) {
				t.Fatalf("Ensure() = %v, want ErrForeignRoot", err)
			}
			if runs != before {
				t.Fatalf("ffmpeg ran %d times over a foreign file", runs-before)
			}
			if _, err := os.Stat(personal); err != nil {
				t.Fatalf("foreign file removed: %v", err)
			}
		})
	}
}

func TestEnsureLeavesNoPartialSetAfterAFailure(t *testing.T) {
	root := filepath.Join(t.TempDir(), "demo-record")
	failure := errors.New("encoder missing")
	_, err := Ensure(context.Background(), root, func(context.Context, []string) error { return failure })
	if !errors.Is(err, failure) {
		t.Fatalf("Ensure() = %v, want the ffmpeg failure", err)
	}
	for _, path := range []string{root, root + ".partial"} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("%s left after a failure: %v", path, err)
		}
	}
}

// The recipes must produce media the Record probe reads, with the cover art
// and subtitles the sample set promises.
func TestSampleRecipesProduceProbedMedia(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("ffmpeg is not installed")
	}
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	root := filepath.Join(t.TempDir(), "demo-record")
	if _, err := Ensure(ctx, root, record.FFmpeg); err != nil {
		t.Fatalf("Ensure() with ffmpeg: %v", err)
	}
	for _, item := range samples {
		if item.kind != sampleVideo && item.kind != sampleAudio {
			continue
		}
		kind := "video"
		if item.kind == sampleAudio {
			kind = "audio"
		}
		output, err := record.FFprobe(ctx, filepath.Join(root, filepath.FromSlash(item.path)))
		if err != nil {
			t.Fatalf("probe %s: %v", item.path, err)
		}
		info, err := record.ParseMediaInfo(output, kind)
		if err != nil {
			t.Fatalf("parse %s: %v", item.path, err)
		}
		if info.DurationSeconds == nil || *info.DurationSeconds < float64(item.seconds)-1 || *info.DurationSeconds > float64(item.seconds)+1 {
			t.Fatalf("%s duration = %v, want about %d seconds", item.path, info.DurationSeconds, item.seconds)
		}
		if item.cover != "" && (info.HasCover == nil || !*info.HasCover) {
			t.Fatalf("%s carries no cover art", item.path)
		}
	}
}
