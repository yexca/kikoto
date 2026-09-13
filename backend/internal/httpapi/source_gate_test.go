package httpapi

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/outbound"
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

func TestSourceQueuedCancellationAndPlaybackIsolation(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/stream" {
			w.WriteHeader(http.StatusOK)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
			return
		}
		_, _ = io.WriteString(w, "metadata")
	}))
	defer remote.Close()
	s := NewServer(nil, config.Config{})
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	first, err := s.sourceHTTPClient(source, 0).Get(remote.URL + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = first.Body.Close() }()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, remote.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		response, err := s.sourceHTTPClient(source, 0).Do(request)
		if response != nil {
			_ = response.Body.Close()
		}
		done <- err
	}()
	parsed, _ := url.Parse(remote.URL)
	lane := s.sourceGate.lane(canonicalSourceOrigin(parsed), sourceRequestInteractive)
	deadline := time.After(time.Second)
	for len(lane.waiters) == 0 {
		select {
		case <-deadline:
			t.Fatal("request did not enter queue")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("queued cancellation error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("queued request ignored cancellation")
	}
	_ = first.Body.Close()
	playback, err := s.sourcePlaybackHTTPClient(source, 0).Get(remote.URL + "/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = playback.Body.Close() }()
	metadata, err := s.sourceHTTPClient(source, time.Second).Get(remote.URL)
	if err != nil {
		t.Fatalf("playback blocked metadata: %v", err)
	}
	defer func() { _ = metadata.Body.Close() }()
	content, err := io.ReadAll(metadata.Body)
	if err != nil || string(content) != "metadata" {
		t.Fatalf("metadata=%q error=%v", content, err)
	}
}

func TestSourceClientsReuseConnectionsAndInvalidateChangedPolicy(t *testing.T) {
	var connections atomic.Int32
	remote := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok") }))
	remote.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	remote.Start()
	defer remote.Close()
	s := NewServer(nil, config.Config{})
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", Endpoint: fileSourceEndpoint{APIURL: remote.URL}}
	for index := 0; index < 3; index++ {
		response, err := s.sourceHTTPClient(source, time.Second).Get(remote.URL)
		if err != nil {
			t.Fatal(err)
		}
		_, err = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
	}
	if connections.Load() != 1 {
		t.Fatalf("connections=%d, want one reused connection", connections.Load())
	}
	source.Endpoint.APIURL = "https://source.example.invalid"
	source.Endpoint.RestrictOutboundHosts = true
	response, err := s.sourceHTTPClient(source, time.Second).Get(remote.URL)
	if response != nil {
		_ = response.Body.Close()
	}
	if !errors.Is(err, outbound.ErrPolicyViolation) {
		t.Fatalf("changed policy retained the old private origin: %v", err)
	}
	if connections.Load() != 1 {
		t.Fatal("rejected origin opened a connection")
	}
}

func TestSourceRequestQueueRejectsOverflowAndDrainsOnCancellation(t *testing.T) {
	lane := newSourceRequestGate().lane("https://source.example.invalid", sourceRequestInteractive)
	release, err := lane.acquire(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	defer release()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, sourceRequestQueueSize)
	for index := 0; index < sourceRequestQueueSize; index++ {
		go func() {
			release, err := lane.acquire(ctx)
			if release != nil {
				release()
			}
			done <- err
		}()
	}
	deadline := time.After(time.Second)
	for len(lane.waiters) != sourceRequestQueueSize {
		select {
		case <-deadline:
			t.Fatal("requests did not enter queue")
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if _, err := lane.acquire(ctx); !errors.Is(err, errSourceRequestQueueFull) {
		t.Fatalf("overflow error=%v", err)
	}
	cancel()
	for index := 0; index < sourceRequestQueueSize; index++ {
		select {
		case err := <-done:
			if !errors.Is(err, context.Canceled) {
				t.Fatalf("queued cancellation=%v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("cancelled queue did not drain")
		}
	}
}

func TestSourceRequestGatePacesCrawlAndDownloadLanes(t *testing.T) {
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

	firstCrawl, err := server.sourceCrawlHTTPClient(source, 250*time.Millisecond).Get(remote.URL)
	if err != nil {
		t.Fatalf("first crawl request: %v", err)
	}
	_ = firstCrawl.Body.Close()

	crawlContext, cancelCrawl := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancelCrawl()
	crawlRequest, err := http.NewRequestWithContext(crawlContext, http.MethodGet, remote.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.sourceCrawlHTTPClient(source, 0).Do(crawlRequest); err == nil {
		t.Fatal("crawl request unexpectedly bypassed pacing")
	}

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
	if got := atomic.LoadInt32(&requests); got != 3 {
		t.Fatalf("remote requests = %d, want interactive, first crawl, and first download", got)
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
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: configured.URL, RestrictOutboundHosts: true}}
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

func TestSourcePolicyCompatibilityAllowsNewPublicOrigin(t *testing.T) {
	source := remoteSourceForUse{Endpoint: fileSourceEndpoint{APIURL: "https://api.source.example.invalid"}}
	policy, err := sourceOutboundPolicy(source)
	if err != nil {
		t.Fatal(err)
	}
	mediaURL, err := url.Parse("https://media.storage.example.invalid/RJ00000000/track.mp3")
	if err != nil {
		t.Fatal(err)
	}
	if err := policy.ValidateURL(mediaURL); err != nil {
		t.Fatalf("compatibility source rejected a new public origin: %v", err)
	}
}

func TestSourceResourceKeyDoesNotRetainInvalidEndpointDetails(t *testing.T) {
	value := sourceResourceKey("https://synthetic-user:synthetic-password@example.invalid/api")
	if value != "remote:invalid" {
		t.Fatalf("resource key = %q, want sanitized invalid marker", value)
	}
}
