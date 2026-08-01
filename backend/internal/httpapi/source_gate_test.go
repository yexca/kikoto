package httpapi

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestSourceRequestGateSerializesSameOrigin(t *testing.T) {
	var active int32
	var maximum int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		current := atomic.AddInt32(&active, 1)
		for {
			seen := atomic.LoadInt32(&maximum)
			if current <= seen || atomic.CompareAndSwapInt32(&maximum, seen, current) {
				break
			}
		}
		time.Sleep(25 * time.Millisecond)
		_, _ = io.WriteString(w, "ok")
		atomic.AddInt32(&active, -1)
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	client := server.sourceHTTPClient(0)
	var group sync.WaitGroup
	for index := 0; index < 2; index++ {
		group.Add(1)
		go func() {
			defer group.Done()
			response, err := client.Get(remote.URL)
			if err != nil {
				t.Errorf("request: %v", err)
				return
			}
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}()
	}
	group.Wait()
	if maximum != 1 {
		t.Fatalf("maximum concurrent requests = %d, want 1", maximum)
	}
}

func TestSourceRequestGateOnlyPacesDownloadLane(t *testing.T) {
	var requests int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&requests, 1)
		_, _ = io.WriteString(w, "ok")
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '60'), ('remote_request_delay_random_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})

	interactiveRequest, err := http.NewRequestWithContext(context.Background(), http.MethodGet, remote.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	interactiveResponse, err := server.sourceHTTPClient(250 * time.Millisecond).Do(interactiveRequest)
	if err != nil {
		t.Fatalf("interactive request: %v", err)
	}
	_ = interactiveResponse.Body.Close()

	firstDownload, err := server.sourceDownloadHTTPClient(250 * time.Millisecond).Get(remote.URL)
	if err != nil {
		t.Fatalf("first download request: %v", err)
	}
	_ = firstDownload.Body.Close()

	downloadContext, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	downloadRequest, err := http.NewRequestWithContext(downloadContext, http.MethodGet, remote.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.sourceDownloadHTTPClient(0).Do(downloadRequest); err == nil {
		t.Fatal("download request unexpectedly bypassed pacing")
	}
	if got := atomic.LoadInt32(&requests); got != 2 {
		t.Fatalf("remote requests = %d, want interactive and first download", got)
	}
}
