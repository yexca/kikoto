package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestServeBrowserCompatibleAudioWithCachesAndRangesWMA(t *testing.T) {
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	sourcePath := filepath.Join(dataRoot, "track.wma")
	if err := os.WriteFile(sourcePath, []byte("synthetic-wma-source"), 0o600); err != nil {
		t.Fatal(err)
	}
	transcodeCalls := 0
	transcode := func(_ context.Context, _ string, targetPath string) error {
		transcodeCalls++
		return os.WriteFile(targetPath, []byte("ID3synthetic-mp3-payload"), 0o600)
	}

	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/media/41/stream", nil)
	if handled := serveBrowserCompatibleAudioWith(response, request, cacheRoot, 41, sourcePath, transcode); !handled {
		t.Fatal("WMA request was not handled")
	}
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "audio/mpeg" {
		t.Fatalf("WMA response = %d %q, want 200 audio/mpeg", response.Code, response.Header().Get("Content-Type"))
	}
	if response.Body.String() != "ID3synthetic-mp3-payload" || transcodeCalls != 1 {
		t.Fatalf("WMA body/calls = %q/%d", response.Body.String(), transcodeCalls)
	}

	rangeResponse := httptest.NewRecorder()
	rangeRequest := httptest.NewRequest(http.MethodGet, "/api/media/41/stream", nil)
	rangeRequest.Header.Set("Range", "bytes=3-11")
	serveBrowserCompatibleAudioWith(rangeResponse, rangeRequest, cacheRoot, 41, sourcePath, transcode)
	if rangeResponse.Code != http.StatusPartialContent || rangeResponse.Body.String() != "synthetic" {
		t.Fatalf("WMA range response = %d %q", rangeResponse.Code, rangeResponse.Body.String())
	}
	if !strings.HasPrefix(rangeResponse.Header().Get("Content-Range"), "bytes 3-11/") || transcodeCalls != 1 {
		t.Fatalf("WMA range header/calls = %q/%d", rangeResponse.Header().Get("Content-Range"), transcodeCalls)
	}

	if err := os.WriteFile(sourcePath, []byte("changed-synthetic-wma-source"), 0o600); err != nil {
		t.Fatal(err)
	}
	changedResponse := httptest.NewRecorder()
	changedRequest := httptest.NewRequest(http.MethodGet, "/api/media/41/stream", nil)
	serveBrowserCompatibleAudioWith(changedResponse, changedRequest, cacheRoot, 41, sourcePath, transcode)
	if changedResponse.Code != http.StatusOK || transcodeCalls != 2 {
		t.Fatalf("changed WMA response/calls = %d/%d", changedResponse.Code, transcodeCalls)
	}
	assets, err := filepath.Glob(filepath.Join(cacheRoot, "playback-transcode", "41", "*.mp3"))
	if err != nil || len(assets) != 1 {
		t.Fatalf("cached WMA assets = %v, err = %v", assets, err)
	}
}

func TestServeBrowserCompatibleAudioWithSkipsSupportedAudio(t *testing.T) {
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/media/41/stream", nil)
	handled := serveBrowserCompatibleAudioWith(response, request, t.TempDir(), 41, "track.mp3", func(context.Context, string, string) error {
		t.Fatal("transcoder should not be called for MP3")
		return nil
	})
	if handled {
		t.Fatal("MP3 request should use the ordinary stream path")
	}
}

func TestServeBrowserCompatibleAudioWithReportsTranscodeFailure(t *testing.T) {
	sourcePath := filepath.Join(t.TempDir(), "track.wma")
	if err := os.WriteFile(sourcePath, []byte("synthetic-wma-source"), 0o600); err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/media/41/stream", nil)
	serveBrowserCompatibleAudioWith(response, request, t.TempDir(), 41, sourcePath, func(context.Context, string, string) error {
		return errors.New("synthetic transcode failure")
	})
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), `"code":"media_transcode_unavailable"`) {
		t.Fatalf("WMA failure response = %d %s", response.Code, response.Body.String())
	}
}
