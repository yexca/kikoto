// Package demorecord makes the sample Record library that Demo shows. Demo
// never reads an operator's folder for Record: its root holds only the
// videos, photos, audio files, and sidecars generated here, so the public
// surface can show nothing personal.
package demorecord

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strings"

	"github.com/yexca/kikoto/backend/internal/record"
)

// LayoutVersion names the sample set. Change it whenever a sample is added,
// removed, or made differently, so a running Demo generates the set again.
const LayoutVersion = "kikoto-demo-record-v1"

// manifestSuffix names the file beside the root that records the layout the
// root holds on its first line and the files generated for it on the lines
// after. It sits outside the root so the Record library lists only the
// samples.
const manifestSuffix = ".layout"

// pendingLayout marks a root this package owns while it is replaced, so a
// start interrupted part way generates the set again.
const pendingLayout = "pending"

func manifestPath(root string) string { return root + manifestSuffix }

// markerName is the record root marker, which a regeneration carries over so
// the catalog keeps its identity.
const markerName = ".kikoto-record"

// ErrForeignRoot means the root holds a file or folder this package did not
// generate. Ensure never removes it, and Demo starts without Record.
var ErrForeignRoot = errors.New("demo record root holds files that were not generated for Demo")

// FFmpegFunc runs ffmpeg with the given arguments.
type FFmpegFunc func(ctx context.Context, args []string) error

type sampleKind int

const (
	sampleVideo sampleKind = iota
	sampleImage
	sampleAudio
	sampleText
)

type sample struct {
	path string
	kind sampleKind
	// source is the lavfi source of a video or image, without its duration.
	source string
	// seconds is a video's or audio file's length.
	seconds int
	// tone is the frequency of the sine wave a video or audio file carries.
	tone int
	// subtitles are the cues of a video's embedded SubRip track.
	subtitles string
	// cover is the sample, earlier in the list, an audio file embeds as its cover art.
	cover string
	// text is a text sample's content.
	text string
}

const harborCues = `WEBVTT

00:00:01.000 --> 00:00:05.000
Sample subtitle: a generated test pattern.

00:00:06.000 --> 00:00:12.000
This sidecar is a WebVTT file beside the video.
`

const marketCues = `1
00:00:01,000 --> 00:00:06,000
Sample subtitle embedded in the video.

2
00:00:07,000 --> 00:00:14,000
Every frame here is generated.
`

const harborInfo = `<?xml version="1.0" encoding="UTF-8"?>
<movie>
  <title>Harbor walk</title>
  <plot>A generated sample video.</plot>
</movie>
`

const tripNotes = "Sample notes. Every file in this demo Record library is generated.\n"

// samples is the generated library in the order it is made. A cover comes
// before the audio file that embeds it.
var samples = []sample{
	{path: "Sample trip/folder.jpg", kind: sampleImage, source: "gradients=size=1280x720:seed=1:nb_colors=3:x0=0:y0=0:x1=1280:y1=720"},
	{path: "Sample trip/backdrop.jpg", kind: sampleImage, source: "gradients=size=1920x1080:seed=2:nb_colors=4"},
	{path: "Sample trip/Day 1/Harbor walk.mp4", kind: sampleVideo, source: "testsrc2=size=640x360:rate=24", seconds: 14, tone: 330},
	{path: "Sample trip/Day 1/Harbor walk.vtt", kind: sampleText, text: harborCues},
	{path: "Sample trip/Day 1/Harbor walk.nfo", kind: sampleText, text: harborInfo},
	{path: "Sample trip/Day 1/Harbor 01.jpg", kind: sampleImage, source: "gradients=size=1600x1200:seed=11:nb_colors=3"},
	{path: "Sample trip/Day 1/Harbor 02.jpg", kind: sampleImage, source: "gradients=size=1200x1600:seed=12:nb_colors=5"},
	{path: "Sample trip/Day 1/Harbor 03.jpg", kind: sampleImage, source: "mandelbrot=size=1600x1200"},
	{path: "Sample trip/Day 2/Night market.mkv", kind: sampleVideo, source: "gradients=size=640x360:rate=24:seed=21:speed=0.03", seconds: 16, tone: 220, subtitles: marketCues},
	{path: "Sample trip/Day 2/Lantern 01.jpg", kind: sampleImage, source: "cellauto=size=1280x960:rule=110"},
	{path: "Sample trip/Day 2/Lantern 02.jpg", kind: sampleImage, source: "gradients=size=1280x960:seed=22:nb_colors=2"},
	{path: "Sample trip/Day 2/notes.txt", kind: sampleText, text: tripNotes},
	{path: "Sample clips/Pattern 01.mp4", kind: sampleVideo, source: "life=size=640x360:rate=12:ratio=0.3:mold=10:death_color=#1f3b57:life_color=#f2c14e", seconds: 10, tone: 440},
	{path: "Sample clips/Pattern 02.mp4", kind: sampleVideo, source: "smptehdbars=size=640x360:rate=24", seconds: 8, tone: 523},
	{path: "Sample audio/cover.jpg", kind: sampleImage, source: "gradients=size=800x800:seed=31:nb_colors=3"},
	{path: "Sample audio/Morning tone.mp3", kind: sampleAudio, seconds: 24, tone: 440, cover: "Sample audio/cover.jpg"},
	{path: "Sample audio/Evening tone.m4a", kind: sampleAudio, seconds: 18, tone: 294},
}

// SamplePaths lists the generated files relative to the root.
func SamplePaths() []string {
	paths := make([]string, 0, len(samples))
	for _, item := range samples {
		paths = append(paths, item.path)
	}
	return paths
}

// Ensure leaves root holding the sample set of LayoutVersion and reports
// whether it generated the set now. A root that already holds it is left as
// it is, so its files keep their revisions and cached thumbnails. Otherwise
// the set is generated beside root and swapped in, keeping the record marker.
// Ensure refuses a root that holds a file or folder it did not generate,
// whatever its manifest says, and removes nothing from it.
func Ensure(ctx context.Context, root string, run FFmpegFunc) (bool, error) {
	root = filepath.Clean(strings.TrimSpace(root))
	if root == "." || root == "" {
		return false, errors.New("demo record root is not configured")
	}
	layout, listed, err := readManifest(root)
	if err != nil {
		return false, err
	}
	// The current samples are always this package's, so a root that lost its
	// manifest is still recognized. The manifest adds the files of the layout
	// that made the root, which a later layout may have retired.
	owned := SamplePaths()
	for _, item := range listed {
		if !slices.Contains(owned, item) {
			owned = append(owned, item)
		}
	}
	if err := requireOwned(root, owned); err != nil {
		return false, err
	}
	if layout == LayoutVersion && holdsSamples(root) {
		return false, nil
	}
	building := root + ".partial"
	if err := os.RemoveAll(building); err != nil {
		return false, err
	}
	if err := generateSamples(ctx, building, run); err != nil {
		_ = os.RemoveAll(building)
		return false, err
	}
	if marker, err := os.ReadFile(filepath.Join(root, markerName)); err == nil {
		if err := os.WriteFile(filepath.Join(building, markerName), marker, 0o644); err != nil {
			_ = os.RemoveAll(building)
			return false, err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		_ = os.RemoveAll(building)
		return false, err
	}
	// While the root is replaced, its manifest lists what either set holds,
	// so an interrupted start still recognizes every file left in it.
	if err := writeManifest(root, pendingLayout, owned); err != nil {
		_ = os.RemoveAll(building)
		return false, err
	}
	if err := os.RemoveAll(root); err != nil {
		_ = os.RemoveAll(building)
		return false, err
	}
	if err := os.Rename(building, root); err != nil {
		_ = os.RemoveAll(building)
		return false, err
	}
	if err := writeManifest(root, LayoutVersion, SamplePaths()); err != nil {
		return false, err
	}
	return true, nil
}

// readManifest returns the layout a root's manifest names and the files it
// lists, or nothing when the root has no manifest.
func readManifest(root string) (string, []string, error) {
	data, err := os.ReadFile(manifestPath(root))
	if errors.Is(err, os.ErrNotExist) {
		return "", nil, nil
	}
	if err != nil {
		return "", nil, err
	}
	var layout string
	var listed []string
	for index, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		switch {
		case index == 0:
			layout = line
		case line != "":
			listed = append(listed, line)
		}
	}
	return layout, listed, nil
}

func writeManifest(root, layout string, paths []string) error {
	return os.WriteFile(manifestPath(root), []byte(layout+"\n"+strings.Join(paths, "\n")+"\n"), 0o644)
}

// holdsSamples reports whether root holds every sample as a regular file
// that is not empty.
func holdsSamples(root string) bool {
	for _, item := range samples {
		info, err := os.Lstat(filepath.Join(root, filepath.FromSlash(item.path)))
		if err != nil || !info.Mode().IsRegular() || info.Size() == 0 {
			return false
		}
	}
	return true
}

// requireOwned refuses a root that is not a folder or that holds anything
// Record would list besides the owned files and the folders that lead to
// them. Names Record never lists, such as its marker and trash, and links,
// which its scan skips, do not count.
func requireOwned(root string, owned []string) error {
	info, err := os.Lstat(root)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return ErrForeignRoot
	}
	files := make(map[string]bool, len(owned))
	folders := map[string]bool{}
	for _, item := range owned {
		files[item] = true
		for dir := path.Dir(item); dir != "." && dir != "/"; dir = path.Dir(dir) {
			folders[dir] = true
		}
	}
	return filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if current == root {
			return nil
		}
		if record.IgnoredName(entry.Name()) || entry.Type()&fs.ModeSymlink != 0 {
			if entry.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		switch {
		case entry.IsDir() && folders[relative]:
			return nil
		case entry.Type().IsRegular() && files[relative]:
			return nil
		default:
			return ErrForeignRoot
		}
	})
}

func generateSamples(ctx context.Context, dir string, run FFmpegFunc) error {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	work := filepath.Join(dir, ".work")
	if err := os.MkdirAll(work, 0o755); err != nil {
		return err
	}
	for _, item := range samples {
		if err := ctx.Err(); err != nil {
			return err
		}
		target := filepath.Join(dir, filepath.FromSlash(item.path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if item.kind == sampleText {
			if err := os.WriteFile(target, []byte(item.text), 0o644); err != nil {
				return err
			}
			continue
		}
		args, err := sampleArgs(item, dir, work, target)
		if err != nil {
			return err
		}
		if err := run(ctx, args); err != nil {
			return fmt.Errorf("generate %s: %w", item.path, err)
		}
		info, err := os.Stat(target)
		if err != nil {
			return fmt.Errorf("generate %s: %w", item.path, err)
		}
		if info.Size() == 0 {
			return fmt.Errorf("generate %s: empty output", item.path)
		}
	}
	return os.RemoveAll(work)
}

// sampleArgs builds one bounded ffmpeg run. Every input is finite and the
// output is cut with -t as well, so no run can grow without end.
func sampleArgs(item sample, dir, work, target string) ([]string, error) {
	base := []string{"-hide_banner", "-nostdin", "-loglevel", "error", "-y"}
	switch item.kind {
	case sampleImage:
		return append(base, "-f", "lavfi", "-i", item.source, "-frames:v", "1", "-q:v", "4", target), nil
	case sampleVideo:
		duration := fmt.Sprint(item.seconds)
		args := append(base,
			"-f", "lavfi", "-t", duration, "-i", item.source,
			"-f", "lavfi", "-t", duration, "-i", fmt.Sprintf("sine=frequency=%d:sample_rate=44100", item.tone),
		)
		maps := []string{"-map", "0:v", "-map", "1:a"}
		if item.subtitles != "" {
			cues := filepath.Join(work, filepath.Base(target)+".srt")
			if err := os.WriteFile(cues, []byte(item.subtitles), 0o644); err != nil {
				return nil, err
			}
			args = append(args, "-i", cues)
			maps = append(maps, "-map", "2:s", "-c:s", "srt", "-metadata:s:s:0", "language=eng")
		}
		args = append(args, maps...)
		args = append(args,
			"-t", duration,
			"-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p",
			"-c:a", "aac", "-b:a", "64k",
		)
		if strings.EqualFold(filepath.Ext(target), ".mp4") {
			args = append(args, "-movflags", "+faststart")
		}
		return append(args, target), nil
	case sampleAudio:
		duration := fmt.Sprint(item.seconds)
		args := append(base, "-f", "lavfi", "-t", duration, "-i", fmt.Sprintf("sine=frequency=%d:sample_rate=44100", item.tone))
		if item.cover != "" {
			args = append(args, "-i", filepath.Join(dir, filepath.FromSlash(item.cover)),
				"-map", "0:a", "-map", "1:v", "-c:v", "mjpeg", "-disposition:v", "attached_pic")
		}
		args = append(args, "-t", duration)
		switch strings.ToLower(filepath.Ext(target)) {
		case ".mp3":
			args = append(args, "-c:a", "libmp3lame", "-b:a", "96k", "-id3v2_version", "3")
		default:
			args = append(args, "-c:a", "aac", "-b:a", "96k")
		}
		return append(args, target), nil
	default:
		return nil, fmt.Errorf("sample %s has no ffmpeg recipe", item.path)
	}
}
