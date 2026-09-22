package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func detectFileSourceForTest(t *testing.T, server *Server, body string) (int, fileSourceDetectResult) {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/file-sources/detect", strings.NewReader(body))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	var result fileSourceDetectResult
	if response.Code == http.StatusOK {
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return response.Code, result
}

func TestDetectFileSourceFindsCompatibleAPIFromPastedEndpoint(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/works" {
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{}, Pagination: kikoeru.Pagination{PageSize: 1}})
			return
		}
		http.NotFound(w, r)
	}))
	defer remote.Close()
	server := NewServer(openMigratedTestDB(t), config.Config{})

	status, result := detectFileSourceForTest(t, server, `{"url":"`+remote.URL+`/api/"}`)
	if status != http.StatusOK || !result.Detected || result.APIURL != remote.URL {
		t.Fatalf("status = %d, result = %+v", status, result)
	}
	if result.SourceType != sourceTypeKikoeruCompatible || result.BaseURL != remote.URL {
		t.Fatalf("result = %+v", result)
	}
}

func TestDetectFileSourceRejectsSinglePageApplicationFallbacks(t *testing.T) {
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			_, _ = w.Write([]byte(`{"status":"ok"}`))
			return
		}
		w.Header().Set("Content-Type", "text/html")
		_, _ = w.Write([]byte("<!doctype html><title>app</title>"))
	}))
	defer site.Close()
	server := NewServer(openMigratedTestDB(t), config.Config{})

	status, result := detectFileSourceForTest(t, server, `{"url":"`+site.URL+`"}`)
	if status != http.StatusOK || result.Detected || result.APIURL != "" || len(result.Tried) == 0 {
		t.Fatalf("status = %d, result = %+v", status, result)
	}
}

func TestDetectFileSourceRejectsCredentialsAndNonHTTPAddresses(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	withCredentials := url.URL{Scheme: "https", Host: "example.invalid", User: url.UserPassword("synthetic-user", "synthetic-password")}
	for _, body := range []string{`{"url":"` + withCredentials.String() + `"}`, `{"url":"ftp://example.invalid"}`, `{"url":""}`} {
		if status, _ := detectFileSourceForTest(t, server, body); status != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", body, status)
		}
	}
}

func TestFileSourceDetectCandidatesAreBoundedAndIncludeAPISibling(t *testing.T) {
	input, err := url.Parse("https://www.example.invalid/api/works?page=1")
	if err != nil {
		t.Fatal(err)
	}
	input.RawQuery = ""
	got := fileSourceDetectCandidates(input)
	want := []string{"https://www.example.invalid", "https://api.example.invalid"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	if base := fileSourceDetectBaseURL(mustParseURL(t, "https://api.example.invalid")); base != "https://example.invalid" {
		t.Fatalf("base = %q", base)
	}
	if candidates := fileSourceDetectCandidates(mustParseURL(t, "http://192.0.2.10:8888/kikoeru")); len(candidates) != 2 {
		t.Fatalf("IP literal must not get an api. sibling: %v", candidates)
	}
}

func mustParseURL(t *testing.T, value string) *url.URL {
	t.Helper()
	parsed, err := url.Parse(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
