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
	// ThumbnailPartialPrefix starts the name of a thumbnail that is still
	// being written, so the cache holding it can reclaim one left behind.
	ThumbnailPartialPrefix = ".record-thumbnail-"
)

var (
	// ErrThumbnailUnavailable means a thumbnail cannot be made for this file
	// revision; the failure is remembered until the file changes.
	ErrThumbnailUnavailable = errors.New("record thumbnail is unavailable")
	// ErrThumbnailBusy means a thumbnail cannot be had now but may be later:
	// too many requests already wait for a slot, or a passing failure, such as
	// a timeout, stopped the last attempt.
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
	err = command.Run()
	if err != nil && ctx.Err() == nil && errors.Is(runContext.Err(), context.DeadlineExceeded) {
		return ErrMediaToolTimedOut
	}
	return err
}

// errThumbnailWork is a failure of the thumbnail's own work file, such as a
// full temporary directory, which says nothing about the source file.
var errThumbnailWork = errors.New("record thumbnail work file failed")

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

// ThumbnailGuard runs before a Thumbnailer changes its cache directory, given
// the bytes it is about to write, and returns the function that ends the
// change. The cache that holds the directory uses it to make room under its
// quota and to keep the directory from being cleared during the change.
type ThumbnailGuard func(ctx context.Context, bytes int64) (release func(), err error)

// ThumbnailOption configures a Thumbnailer.
type ThumbnailOption func(*Thumbnailer)

// WithThumbnailWorkDir makes ffmpeg write into dir before a result is stored;
// the default is the system temporary directory.
func WithThumbnailWorkDir(dir string) ThumbnailOption {
	return func(t *Thumbnailer) { t.workDir = dir }
}

// WithThumbnailGuard coordinates every change to the cache directory.
func WithThumbnailGuard(guard ThumbnailGuard) ThumbnailOption {
	return func(t *Thumbnailer) {
		if guard != nil {
			t.guard = guard
		}
	}
}

// ThumbnailDuration reads the length of a video whose length is not yet known,
// or reports zero.
type ThumbnailDuration func(ctx context.Context, assetID int64) float64

// WithThumbnailDuration reads a video's unknown length before its frame is
// chosen, inside the bounded generation slots.
func WithThumbnailDuration(read ThumbnailDuration) ThumbnailOption {
	return func(t *Thumbnailer) { t.duration = read }
}

// Thumbnailer makes and caches JPEG thumbnails of record videos, images, and
// the cover art embedded in audio files on first request. A video's frame is
// taken a tenth of the way in. Generation
// is bounded to a few ffmpeg processes and a bounded number of waiters, and
// concurrent requests for one revision share a single run. ffmpeg writes
// outside the cache directory; only a finished thumbnail is stored there,
// under the guard, and every read marks the thumbnail as recently used.
type Thumbnailer struct {
	dir      string
	workDir  string
	run      FFmpegFunc
	guard    ThumbnailGuard
	duration ThumbnailDuration
	slots    chan struct{}
	waiting  atomic.Int32
	mu       sync.Mutex
	pending  map[string]*thumbnailCall
}

type thumbnailCall struct {
	done chan struct{}
	err  error
}

// NewThumbnailer caches under dir with at most concurrency ffmpeg runs.
func NewThumbnailer(dir string, run FFmpegFunc, concurrency int, options ...ThumbnailOption) *Thumbnailer {
	if concurrency <= 0 {
		concurrency = 2
	}
	t := &Thumbnailer{
		dir: dir, run: run, slots: make(chan struct{}, concurrency), pending: map[string]*thumbnailCall{},
		guard: func(context.Context, int64) (func(), error) { return func() {}, nil },
	}
	for _, option := range options {
		option(t)
	}
	return t
}

func (t *Thumbnailer) paths(source ThumbnailSource) (dir, prefix, final, failed string) {
	dir = filepath.Join(t.dir, fmt.Sprintf("%02x", source.AssetID%256))
	prefix = thumbnailAssetPrefix(source.AssetID)
	key := prefix + source.Revision() + "-" + thumbnailVersion
	return dir, prefix, filepath.Join(dir, key+".jpg"), filepath.Join(dir, key+".failed")
}

func thumbnailAssetPrefix(assetID int64) string {
	return fmt.Sprintf("a%d-", assetID)
}

// thumbnailAssetID reads the asset of a thumbnail or failure marker name.
func thumbnailAssetID(name string) (int64, bool) {
	rest, ok := strings.CutPrefix(name, "a")
	if !ok {
		return 0, false
	}
	digits, _, ok := strings.Cut(rest, "-")
	if !ok {
		return 0, false
	}
	id, err := strconv.ParseInt(digits, 10, 64)
	return id, err == nil && id > 0
}

// Thumbnail opens the cached thumbnail of one revision of a record video,
// image, or audio file at input, making it first when needed.
func (t *Thumbnailer) Thumbnail(ctx context.Context, input string, source ThumbnailSource) (*os.File, error) {
	if source.Kind != "video" && source.Kind != "image" && source.Kind != "audio" {
		return nil, ErrThumbnailUnavailable
	}
	_, _, final, failed := t.paths(source)
	if file := openThumbnail(final); file != nil {
		return file, nil
	}
	if _, err := os.Stat(failed); err == nil {
		return nil, ErrThumbnailUnavailable
	}
	if t.waiting.Add(1) > thumbnailMaxWaiters {
		t.waiting.Add(-1)
		return nil, ErrThumbnailBusy
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
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	} else {
		call.err = t.generate(ctx, input, source)
		t.mu.Lock()
		delete(t.pending, final)
		t.mu.Unlock()
		close(call.done)
	}
	if call.err != nil {
		return nil, call.err
	}
	if file := openThumbnail(final); file != nil {
		return file, nil
	}
	// The cache evicted or cleared the thumbnail as it was stored.
	return nil, ErrThumbnailBusy
}

// openThumbnail opens a valid cached thumbnail and marks it as recently used,
// so eviction removes the thumbnails nobody has viewed for longest first.
func openThumbnail(path string) *os.File {
	if !validThumbnail(path) {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		return nil
	}
	now := time.Now()
	_ = os.Chtimes(path, now, now)
	return file
}

func (t *Thumbnailer) generate(ctx context.Context, input string, source ThumbnailSource) error {
	select {
	case t.slots <- struct{}{}:
	case <-ctx.Done():
		return ctx.Err()
	}
	defer func() { <-t.slots }()

	dir, prefix, final, failed := t.paths(source)
	if source.Kind == "video" && source.DurationSeconds <= 0 && t.duration != nil {
		source.DurationSeconds = t.duration(ctx, source.AssetID)
	}
	content, err := t.render(ctx, input, source)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err == nil {
		return t.store(ctx, dir, prefix, final, content)
	}
	if errors.Is(err, ErrProbeUnavailable) {
		// Nothing is remembered when ffmpeg is missing; installing it fixes every file.
		return ErrThumbnailUnavailable
	}
	if errors.Is(err, ErrMediaToolTimedOut) || errors.Is(err, errThumbnailWork) {
		// A slow disk or a full work directory passes; a later request tries again.
		return ErrThumbnailBusy
	}
	_ = t.store(ctx, dir, prefix, failed, nil)
	return ErrThumbnailUnavailable
}

// render runs ffmpeg into a work file and returns the validated JPEG.
func (t *Thumbnailer) render(ctx context.Context, input string, source ThumbnailSource) ([]byte, error) {
	if t.workDir != "" {
		if err := os.MkdirAll(t.workDir, 0o755); err != nil {
			return nil, fmt.Errorf("%w: %w", errThumbnailWork, err)
		}
	}
	work, err := os.CreateTemp(t.workDir, ThumbnailPartialPrefix+"*.jpg")
	if err != nil {
		return nil, fmt.Errorf("%w: %w", errThumbnailWork, err)
	}
	temporary := work.Name()
	_ = work.Close()
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
	lastErr := ErrThumbnailUnavailable
	for _, seek := range seeks {
		_ = os.Truncate(temporary, 0)
		lastErr = t.run(ctx, thumbnailArgs(input, temporary, source.Kind, seek))
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		if lastErr == nil && validThumbnail(temporary) {
			return os.ReadFile(temporary)
		}
	}
	if lastErr == nil {
		lastErr = ErrThumbnailUnavailable
	}
	return nil, lastErr
}

// store writes content, or an empty failure marker, as target under the
// guard and removes the asset's earlier revisions.
func (t *Thumbnailer) store(ctx context.Context, dir, prefix, target string, content []byte) error {
	release, err := t.guard(ctx, int64(len(content)))
	if err != nil {
		return err
	}
	defer release()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	partial, err := os.CreateTemp(dir, ThumbnailPartialPrefix+"*.part")
	if err != nil {
		return err
	}
	partialPath := partial.Name()
	defer func() { _ = os.Remove(partialPath) }()
	_, writeErr := partial.Write(content)
	if err := errors.Join(writeErr, partial.Close()); err != nil {
		return err
	}
	if err := os.Rename(partialPath, target); err != nil {
		return err
	}
	removeStaleThumbnails(dir, prefix, target)
	return nil
}

// Prune removes the cached thumbnails and failure markers of every asset keep
// rejects and reports how many files it removed.
func (t *Thumbnailer) Prune(ctx context.Context, keep func(assetID int64) bool) (int, error) {
	release, err := t.guard(ctx, 0)
	if err != nil {
		return 0, err
	}
	defer release()
	buckets, err := os.ReadDir(t.dir)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	removed := 0
	for _, bucket := range buckets {
		if err := ctx.Err(); err != nil {
			return removed, err
		}
		if !bucket.IsDir() {
			continue
		}
		bucketDir := filepath.Join(t.dir, bucket.Name())
		entries, err := os.ReadDir(bucketDir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			id, ok := thumbnailAssetID(entry.Name())
			if !ok || !entry.Type().IsRegular() || keep(id) {
				continue
			}
			if err := os.Remove(filepath.Join(bucketDir, entry.Name())); err == nil {
				removed++
			}
		}
		// Only an empty bucket is removed.
		_ = os.Remove(bucketDir)
	}
	return removed, nil
}

// Remove deletes every cached thumbnail and failure marker of one asset.
func (t *Thumbnailer) Remove(ctx context.Context, assetID int64) error {
	release, err := t.guard(ctx, 0)
	if err != nil {
		return err
	}
	defer release()
	dir, prefix, _, _ := t.paths(ThumbnailSource{AssetID: assetID})
	removeStaleThumbnails(dir, prefix, "")
	// Only an empty bucket is removed.
	_ = os.Remove(dir)
	return nil
}

func thumbnailArgs(input, output, kind string, seek float64) []string {
	args := []string{"-nostdin", "-hide_banner", "-loglevel", "error", "-protocol_whitelist", "file"}
	if kind == "video" && seek > 0 {
		args = append(args, "-ss", strconv.FormatFloat(seek, 'f', 3, 64))
	}
	if kind == "audio" {
		// An audio file's picture is its attached cover art.
		args = append(args, "-i", "file:"+input, "-map", "0:v:0")
	} else {
		args = append(args, "-i", "file:"+input)
	}
	scale := "scale=" + thumbnailBox + ":" + thumbnailBox + ":force_original_aspect_ratio=decrease"
	return append(args, "-frames:v", "1", "-vf", scale, "-c:v", "mjpeg", "-q:v", "4", "-f", "image2", "-update", "1", "-y", "file:"+output)
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
