package record

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const (
	thumbnailVersion    = "v1"
	thumbnailMaxBytes   = 2 << 20
	thumbnailTimeout    = 30 * time.Second
	thumbnailBox        = "640"
	thumbnailMaxWaiters = 64
)

var (
	// ErrThumbnailUnavailable means a thumbnail cannot be made for this file
	// revision; the failure is remembered until the file changes.
	ErrThumbnailUnavailable = errors.New("record thumbnail is unavailable")
	// ErrThumbnailBusy means too many requests already wait for a thumbnail slot.
	ErrThumbnailBusy = errors.New("record thumbnail generation is busy")
)

// FFmpegFunc runs ffmpeg with the given arguments.
type FFmpegFunc func(ctx context.Context, args []string) error

// FFmpeg runs the installed ffmpeg with a timeout and discarded output.
func FFmpeg(ctx context.Context, args []string) error {
	binary, err := exec.LookPath("ffmpeg")
	if err != nil {
		return ErrProbeUnavailable
	}
	runContext, cancel := context.WithTimeout(ctx, thumbnailTimeout)
	defer cancel()
	command := exec.CommandContext(runContext, binary, args...)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	return command.Run()
}

// ThumbnailSource identifies the file revision a thumbnail is made from.
type ThumbnailSource struct {
	AssetID         int64
	Kind            string
	SizeBytes       int64
	MtimeNs         int64
	DurationSeconds float64
}

// Revision names the source's revision in thumbnail URLs and cache keys, so a
// changed file gets a new thumbnail.
func (s ThumbnailSource) Revision() string {
	return strconv.FormatInt(s.SizeBytes, 36) + "-" + strconv.FormatInt(s.MtimeNs, 36)
}

// Thumbnailer makes and caches JPEG thumbnails of record videos and images on
// first request. A video's frame is taken a tenth of the way in. Generation
// is bounded to a few ffmpeg processes and a bounded number of waiters, and
// concurrent requests for one revision share a single run.
type Thumbnailer struct {
	dir     string
	run     FFmpegFunc
	slots   chan struct{}
	waiting atomic.Int32
	mu      sync.Mutex
	pending map[string]*thumbnailCall
}

type thumbnailCall struct {
	done chan struct{}
	err  error
}

// NewThumbnailer caches under dir with at most concurrency ffmpeg runs.
func NewThumbnailer(dir string, run FFmpegFunc, concurrency int) *Thumbnailer {
	if concurrency <= 0 {
		concurrency = 2
	}
	return &Thumbnailer{dir: dir, run: run, slots: make(chan struct{}, concurrency), pending: map[string]*thumbnailCall{}}
}

func (t *Thumbnailer) paths(source ThumbnailSource) (dir, prefix, final, failed string) {
	dir = filepath.Join(t.dir, fmt.Sprintf("%02x", source.AssetID%256))
	prefix = fmt.Sprintf("a%d-", source.AssetID)
	key := prefix + source.Revision() + "-" + thumbnailVersion
	return dir, prefix, filepath.Join(dir, key+".jpg"), filepath.Join(dir, key+".failed")
}

// Thumbnail returns the cached thumbnail path for one revision of a record
// video or image at input, making it first when needed.
func (t *Thumbnailer) Thumbnail(ctx context.Context, input string, source ThumbnailSource) (string, error) {
	if source.Kind != "video" && source.Kind != "image" {
		return "", ErrThumbnailUnavailable
	}
	_, _, final, failed := t.paths(source)
	if validThumbnail(final) {
		return final, nil
	}
	if _, err := os.Stat(failed); err == nil {
		return "", ErrThumbnailUnavailable
	}
	if t.waiting.Add(1) > thumbnailMaxWaiters {
		t.waiting.Add(-1)
		return "", ErrThumbnailBusy
	}
	defer t.waiting.Add(-1)

	t.mu.Lock()
	call, running := t.pending[final]
	if !running {
		call = &thumbnailCall{done: make(chan struct{})}
		t.pending[final] = call
	}
	t.mu.Unlock()
	if running {
		select {
		case <-call.done:
			if call.err != nil {
				return "", call.err
			}
			return final, nil
		case <-ctx.Done():
			return "", ctx.Err()
		}
	}
	call.err = t.generate(ctx, input, source)
	t.mu.Lock()
	delete(t.pending, final)
	t.mu.Unlock()
	close(call.done)
	if call.err != nil {
		return "", call.err
	}
	return final, nil
}

func (t *Thumbnailer) generate(ctx context.Context, input string, source ThumbnailSource) error {
	select {
	case t.slots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-t.slots }()

	dir, prefix, final, failed := t.paths(source)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	temporary := final + ".part"
	defer func() { _ = os.Remove(temporary) }()

	seeks := []float64{0}
	if source.Kind == "video" {
		seek := 1.0
		if source.DurationSeconds > 0 {
			seek = source.DurationSeconds / 10
		}
		// A short video may end before the seek; its first frame is the fallback.
		seeks = []float64{seek, 0}
	}
	var lastErr error
	for _, seek := range seeks {
		_ = os.Remove(temporary)
		lastErr = t.run(ctx, thumbnailArgs(input, temporary, source.Kind, seek))
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if lastErr == nil && validThumbnail(temporary) {
			if err := os.Rename(temporary, final); err != nil {
				return err
			}
			removeStaleThumbnails(dir, prefix, final)
			return nil
		}
	}
	if errors.Is(lastErr, ErrProbeUnavailable) {
		// Nothing is remembered when ffmpeg is missing; installing it fixes every file.
		return ErrThumbnailUnavailable
	}
	_ = os.WriteFile(failed, nil, 0o644)
	return ErrThumbnailUnavailable
}

func thumbnailArgs(input, output, kind string, seek float64) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file"}
	if kind == "video" && seek > 0 {
		args = append(args, "-ss", strconv.FormatFloat(seek, 'f', 3, 64))
	}
	scale := "scale=" + thumbnailBox + ":" + thumbnailBox + ":force_original_aspect_ratio=decrease"
	return append(args, "-i", "file:"+input, "-frames:v", "1", "-vf", scale, "-c:v", "mjpeg", "-q:v", "4", "-f", "image2", "-update", "1", "-y", "file:"+output)
}

func validThumbnail(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() == 0 || info.Size() > thumbnailMaxBytes {
		return false
	}
	return ValidateImageFile(path, "image/jpeg") == nil
}

// removeStaleThumbnails deletes the thumbnails and failure markers of an
// asset's earlier revisions.
func removeStaleThumbnails(dir, prefix, keep string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		path := filepath.Join(dir, entry.Name())
		if path != keep && strings.HasPrefix(entry.Name(), prefix) {
			_ = os.Remove(path)
		}
	}
}
