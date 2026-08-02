package httpapi

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const wmaPlaybackTranscodeTimeout = 10 * time.Minute

type audioTranscodeFunc func(context.Context, string, string) error

var wmaPlaybackLocks sync.Map

func (s *Server) serveBrowserCompatibleAudio(w http.ResponseWriter, r *http.Request, locationID int64, sourcePath string) bool {
	return serveBrowserCompatibleAudioWith(w, r, s.cfg.CacheRoot, locationID, sourcePath, transcodeWMAWithFFmpeg)
}

func serveBrowserCompatibleAudioWith(
	w http.ResponseWriter,
	r *http.Request,
	cacheRoot string,
	locationID int64,
	sourcePath string,
	transcode audioTranscodeFunc,
) bool {
	if !strings.EqualFold(filepath.Ext(sourcePath), ".wma") {
		return false
	}
	assetPath, err := ensureWMAPlaybackAsset(r.Context(), cacheRoot, locationID, sourcePath, transcode)
	if err != nil {
		slog.Warn("prepare WMA compatibility stream", "location_id", locationID, "error", err)
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "WMA playback preparation failed", true)
		return true
	}
	file, err := os.Open(assetPath)
	if err != nil {
		slog.Warn("open WMA compatibility stream", "location_id", locationID, "error", err)
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "WMA playback preparation failed", true)
		return true
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() <= 0 {
		writeAPIError(w, http.StatusServiceUnavailable, "media_transcode_unavailable", "WMA playback preparation failed", true)
		return true
	}
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("Content-Type", "audio/mpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, strconv.FormatInt(locationID, 10)+".mp3", info.ModTime(), file)
	return true
}

func ensureWMAPlaybackAsset(
	ctx context.Context,
	cacheRoot string,
	locationID int64,
	sourcePath string,
	transcode audioTranscodeFunc,
) (string, error) {
	if locationID <= 0 || strings.TrimSpace(cacheRoot) == "" || transcode == nil {
		return "", fmt.Errorf("invalid WMA compatibility request")
	}
	cacheDir, err := safeCachePath(cacheRoot, filepath.ToSlash(filepath.Join("playback-transcode", strconv.FormatInt(locationID, 10))))
	if err != nil {
		return "", err
	}
	lockValue, _ := wmaPlaybackLocks.LoadOrStore(cacheDir, &sync.Mutex{})
	lock := lockValue.(*sync.Mutex)
	lock.Lock()
	defer lock.Unlock()

	sourceInfo, err := os.Stat(sourcePath)
	if err != nil {
		return "", err
	}
	if !sourceInfo.Mode().IsRegular() || sourceInfo.Size() <= 0 {
		return "", fmt.Errorf("WMA source is not a regular file")
	}
	fingerprint := wmaPlaybackFingerprint(sourcePath, sourceInfo)
	assetPath := filepath.Join(cacheDir, fingerprint+".mp3")
	if validPlaybackTranscode(assetPath) {
		return assetPath, nil
	}
	if err := os.MkdirAll(cacheDir, 0o750); err != nil {
		return "", err
	}
	temporary, err := os.CreateTemp(cacheDir, ".wma-transcode-*.mp3")
	if err != nil {
		return "", err
	}
	temporaryPath := temporary.Name()
	if err := temporary.Close(); err != nil {
		_ = os.Remove(temporaryPath)
		return "", err
	}
	defer func() { _ = os.Remove(temporaryPath) }()
	if err := transcode(ctx, sourcePath, temporaryPath); err != nil {
		return "", err
	}
	if !validPlaybackTranscode(temporaryPath) {
		return "", fmt.Errorf("WMA transcoder produced no playable output")
	}
	if err := os.Rename(temporaryPath, assetPath); err != nil {
		if !validPlaybackTranscode(assetPath) {
			return "", err
		}
	} else {
		temporaryPath = ""
	}
	cleanupStaleWMAPlaybackAssets(cacheDir, filepath.Base(assetPath))
	return assetPath, nil
}

func wmaPlaybackFingerprint(sourcePath string, info os.FileInfo) string {
	value := strings.Join([]string{
		filepath.Clean(sourcePath),
		strconv.FormatInt(info.Size(), 10),
		strconv.FormatInt(info.ModTime().UnixNano(), 10),
	}, "\x00")
	sum := sha256.Sum256([]byte(value))
	return fmt.Sprintf("%x", sum[:12])
}

func validPlaybackTranscode(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

func cleanupStaleWMAPlaybackAssets(cacheDir string, currentName string) {
	entries, err := os.ReadDir(cacheDir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || name == currentName || !isWMAPlaybackAssetName(name) {
			continue
		}
		_ = os.Remove(filepath.Join(cacheDir, name))
	}
}

func isWMAPlaybackAssetName(name string) bool {
	if len(name) != 28 || !strings.HasSuffix(name, ".mp3") {
		return false
	}
	for _, char := range name[:24] {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func transcodeWMAWithFFmpeg(ctx context.Context, sourcePath string, targetPath string) error {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		return fmt.Errorf("ffmpeg is unavailable")
	}
	transcodeContext, cancel := context.WithTimeout(ctx, wmaPlaybackTranscodeTimeout)
	defer cancel()
	command := exec.CommandContext(
		transcodeContext,
		ffmpegPath,
		"-y",
		"-nostdin",
		"-hide_banner",
		"-loglevel", "error",
		"-i", sourcePath,
		"-map", "0:a:0",
		"-vn",
		"-sn",
		"-dn",
		"-c:a", "libmp3lame",
		"-q:a", "4",
		"-f", "mp3",
		targetPath,
	)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Run(); err != nil {
		if errors.Is(transcodeContext.Err(), context.DeadlineExceeded) {
			return fmt.Errorf("WMA transcoding timed out")
		}
		return fmt.Errorf("ffmpeg could not transcode WMA: %w", err)
	}
	return nil
}
