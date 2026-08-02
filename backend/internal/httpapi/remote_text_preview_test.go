package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestGetRemoteSourceWorkTextServesAllowlistedTreeFile(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamRequests++
		if r.URL.Path != "/media/01.lrc" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		_, _ = w.Write([]byte("[00:01.00]Synthetic lyric\n"))
	}))
	defer upstream.Close()

	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/01.lrc")
	response := httptest.NewRecorder()
	request := remoteTextPreviewRequest("01.lrc")
	server.getRemoteSourceWorkText(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("remote text status = %d, body = %s", response.Code, response.Body.String())
	}
	if contentType := response.Header().Get("Content-Type"); contentType != "text/plain; charset=utf-8" {
		t.Fatalf("remote text content type = %q", contentType)
	}
	if response.Body.String() != "[00:01.00]Synthetic lyric\n" || upstreamRequests != 1 {
		t.Fatalf("remote text body/requests = %q/%d", response.Body.String(), upstreamRequests)
	}
}

func TestGetRemoteSourceWorkTextRejectsFilesOutsideTree(t *testing.T) {
	upstreamRequests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		upstreamRequests++
		_, _ = w.Write([]byte("not reachable"))
	}))
	defer upstream.Close()

	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/01.lrc")
	response := httptest.NewRecorder()
	server.getRemoteSourceWorkText(response, remoteTextPreviewRequest("other.lrc"))

	if response.Code != http.StatusNotFound || upstreamRequests != 0 {
		t.Fatalf("outside-tree status/requests = %d/%d, body = %s", response.Code, upstreamRequests, response.Body.String())
	}
}

func TestGetRemoteSourceWorkTextRejectsUnconfiguredHost(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("not reachable"))
	}))
	defer upstream.Close()

	server := newRemoteTextPreviewServer(t, upstream.URL, "https://media.invalid/01.lrc")
	response := httptest.NewRecorder()
	server.getRemoteSourceWorkText(response, remoteTextPreviewRequest("01.lrc"))

	if response.Code != http.StatusBadGateway || !strings.Contains(response.Body.String(), "remote text URL is not allowed") {
		t.Fatalf("unconfigured-host response = %d %s", response.Code, response.Body.String())
	}
}

func newRemoteTextPreviewServer(t *testing.T, endpoint string, textURL string) *Server {
	t.Helper()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	source := remoteSourceForUse{
		ID:          7,
		Code:        "remote_fixture",
		DisplayName: "Remote fixture",
		SourceType:  sourceTypeKikoeruCompatible,
		Enabled:     true,
		Endpoint: fileSourceEndpoint{
			APIURL:  endpoint,
			BaseURL: endpoint,
		},
	}
	work := kikoeru.Work{ID: 71, SourceID: "RJ00000000", Title: "Synthetic work"}
	tracks := []kikoeru.Track{{Type: "text", Title: "01.lrc", MediaStreamURL: textURL}}
	key := remoteWorkCacheKey(source.ID, work.SourceID)
	expiresAt := time.Now().Add(time.Minute)
	server.remoteWorkCache[key] = remoteWorkSnapshot{Source: source, Work: work, ExpiresAt: expiresAt}
	server.remoteWorkTracksCache[key] = remoteWorkTracksSnapshot{Source: source, Work: work, Tracks: tracks, ExpiresAt: expiresAt}
	return server
}

func remoteTextPreviewRequest(path string) *http.Request {
	request := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works/RJ00000000/text?path="+path, nil)
	request.SetPathValue("id", "7")
	request.SetPathValue("code", "RJ00000000")
	return request
}
