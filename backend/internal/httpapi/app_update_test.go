package httpapi

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

type updateRoundTripper func(*http.Request) (*http.Response, error)

func (fn updateRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return fn(request)
}

func TestHighestStableTagIgnoresPreReleasesAndNonVersionTags(t *testing.T) {
	got := highestStableTag([]githubTag{{Name: "v0.4.1"}, {Name: "v0.5.0-rc.1"}, {Name: "main"}, {Name: "v0.10.0"}})
	if got != "v0.10.0" {
		t.Fatalf("highestStableTag() = %q, want v0.10.0", got)
	}
}

func TestAppUpdateEndpointsBuildReleaseURL(t *testing.T) {
	endpoints := appUpdateEndpoints{releasesURL: "https://example.test/releases"}
	if got := endpoints.releaseURL("v0.5.0"); got != "https://example.test/releases/tag/v0.5.0" {
		t.Fatalf("releaseURL() = %q", got)
	}
	if got := endpoints.releaseURL(" "); got != "" {
		t.Fatalf("empty releaseURL() = %q", got)
	}
}

func TestAppUpdateCachesSuccessfulGitHubResult(t *testing.T) {
	var calls atomic.Int32
	server := NewServer(nil, config.Config{})
	server.updateHTTPClient = &http.Client{Transport: updateRoundTripper(func(request *http.Request) (*http.Response, error) {
		calls.Add(1)
		if request.URL.String() != server.appUpdateEndpoints.tagsURL {
			t.Fatalf("URL = %q, want %q", request.URL.String(), server.appUpdateEndpoints.tagsURL)
		}
		return &http.Response{StatusCode: http.StatusOK, Header: make(http.Header), Body: io.NopCloser(strings.NewReader(`[{"name":"v99.0.0"}]`))}, nil
	})}
	for range 2 {
		response := httptest.NewRecorder()
		server.getAppUpdate(response, httptest.NewRequest(http.MethodGet, "/api/app-update", nil))
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, want %d", response.Code, http.StatusOK)
		}
	}
	if calls.Load() != 1 {
		t.Fatalf("GitHub calls = %d, want 1", calls.Load())
	}
}

func TestAppUpdateSanitizesUpstreamFailure(t *testing.T) {
	server := NewServer(nil, config.Config{})
	server.updateHTTPClient = &http.Client{Transport: updateRoundTripper(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusTooManyRequests, Header: make(http.Header), Body: io.NopCloser(strings.NewReader("private upstream detail"))}, nil
	})}
	response := httptest.NewRecorder()
	server.getAppUpdate(response, httptest.NewRequest(http.MethodGet, "/api/app-update", nil))
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusServiceUnavailable)
	}
	if strings.Contains(response.Body.String(), "private upstream detail") {
		t.Fatalf("response leaks upstream detail: %s", response.Body.String())
	}
}
