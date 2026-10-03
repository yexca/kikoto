package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLocalFFprobeRejectsEmbeddedNetworkPlaylist(t *testing.T) {
	if _, err := exec.LookPath("ffprobe"); err != nil {
		t.Skip("ffprobe is not installed")
	}
	var requests atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		_, _ = w.Write(testWAVBytes())
	}))
	defer remote.Close()
	playlist := filepath.Join(t.TempDir(), "example.m3u8")
	content := fmt.Sprintf("#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n%s/segment.aac\n#EXT-X-ENDLIST\n", remote.URL)
	if err := os.WriteFile(playlist, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
	server := NewServer(nil, config.Config{})
	if _, err := server.runBoundedFFprobe(context.Background(), playlist, "format=duration"); err == nil {
		t.Fatal("network playlist unexpectedly produced a local probe result")
	}
	if requests.Load() != 0 {
		t.Fatalf("FFprobe made %d unchecked network requests", requests.Load())
	}
	local := filepath.Join(t.TempDir(), "example.wav")
	if err := os.WriteFile(local, testWAVBytes(), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := server.runBoundedFFprobe(context.Background(), local, "format=duration"); err != nil {
		t.Fatalf("local audio probe was blocked: %v", err)
	}
}
