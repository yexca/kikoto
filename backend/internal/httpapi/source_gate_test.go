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
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	client := server.sourceHTTPClient(source, 0)
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
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}

	interactiveRequest, err := http.NewRequestWithContext(context.Background(), http.MethodGet, remote.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	interactiveResponse, err := server.sourceHTTPClient(source, 250*time.Millisecond).Do(interactiveRequest)
	if err != nil {
		t.Fatalf("interactive request: %v", err)
	}
	_ = interactiveResponse.Body.Close()

	firstDownload, err := server.sourceDownloadHTTPClient(source, 250*time.Millisecond).Get(remote.URL)
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
	if _, err := server.sourceDownloadHTTPClient(source, 0).Do(downloadRequest); err == nil {
		t.Fatal("download request unexpectedly bypassed pacing")
	}
	if got := atomic.LoadInt32(&requests); got != 2 {
		t.Fatalf("remote requests = %d, want interactive and first download", got)
	}
}

func TestSourceRequestCancellationReleasesLane(t *testing.T) {
	firstStarted := make(chan struct{})
	var requests int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		if atomic.AddInt32(&requests, 1) == 1 {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			close(firstStarted)
			<-request.Context().Done()
			return
		}
		_, _ = io.WriteString(w, "second")
	}))
	defer remote.Close()

	server := NewServer(openMigratedTestDB(t), config.Config{})
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	firstContext, cancelFirst := context.WithCancel(context.Background())
	firstRequest, err := http.NewRequestWithContext(firstContext, http.MethodGet, remote.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	firstResponse, err := server.sourceHTTPClient(source, time.Second).Do(firstRequest)
	if err != nil {
		t.Fatalf("first request: %v", err)
	}
	<-firstStarted
	cancelFirst()

	secondResponse, err := server.sourceHTTPClient(source, time.Second).Get(remote.URL)
	if err != nil {
		_ = firstResponse.Body.Close()
		t.Fatalf("second request remained blocked after cancellation: %v", err)
	}
	body, err := io.ReadAll(secondResponse.Body)
	_ = secondResponse.Body.Close()
	_ = firstResponse.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "second" {
		t.Fatalf("second response = %q", body)
	}
}

func TestSourceClientRejectsURLOutsideConfiguredOrigins(t *testing.T) {
	var reached atomic.Bool
	other := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		reached.Store(true)
	}))
	defer other.Close()
	configured := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "configured")
	}))
	defer configured.Close()

	server := NewServer(openMigratedTestDB(t), config.Config{})
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: configured.URL}}
	if _, err := server.sourceHTTPClient(source, time.Second).Get(other.URL); err == nil {
		t.Fatal("source client reached an origin outside its configured boundary")
	}
	if reached.Load() {
		t.Fatal("request reached the unconfigured origin")
	}
	server.sourceGate.mu.Lock()
	defer server.sourceGate.mu.Unlock()
	if len(server.sourceGate.lanes) != 0 || len(server.sourceGate.origins) != 0 {
		t.Fatal("rejected URL allocated persistent source-gate state")
	}
}

func TestSourceResourceKeyDoesNotRetainInvalidEndpointDetails(t *testing.T) {
	value := sourceResourceKey("https://synthetic-user:synthetic-password@example.invalid/api")
	if value != "remote:invalid" {
		t.Fatalf("resource key = %q, want sanitized invalid marker", value)
	}
}
