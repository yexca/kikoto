package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestRemoteAcceptLanguageEndsWithSourceFallback(t *testing.T) {
	for _, check := range []struct {
		name       string
		priorities []string
		fallback   string
		want       string
	}{
		{"preferred then fallback", []string{"zh-cn", "origin"}, "ja-JP", "zh-CN, ja-JP;q=0.9"},
		{"origin asks only the fallback", []string{"origin"}, "ja-JP", "ja-JP"},
		{"fallback already preferred", []string{"ja-jp", "origin"}, "ja-JP", "ja-JP"},
		{"custom fallback tag", []string{"en-us", "zh-cn", "origin"}, "zh-Hant", "en-US, zh-CN;q=0.9, zh-Hant;q=0.8"},
		{"missing fallback uses the default", []string{"ko-kr"}, "", "ko-KR, ja-JP;q=0.9"},
	} {
		if got := remoteAcceptLanguage(remoteSourceLanguageList(check.priorities, check.fallback)); got != check.want {
			t.Fatalf("%s: Accept-Language = %q, want %q", check.name, got, check.want)
		}
	}
}

// A viewer's live request asks in that viewer's language first and the
// source fallback last; a viewer without a preference, anonymous browsing and
// requests whose results are stored for everyone ask in the fallback alone.
func TestRemoteSourceRequestsUseViewerOrFallbackLanguages(t *testing.T) {
	var mu sync.Mutex
	seen := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Get("Accept-Language"))
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"works":[],"pagination":{}}`))
	}))
	defer upstream.Close()
	server := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	userID := metadataReviewExec(t, server.db, "INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-remote-viewer', 'Example viewer', 'user')")
	metadataReviewExec(t, server.db, `INSERT INTO user_preference (user_id, metadata_languages) VALUES (?, '["zh-cn","origin"]')`, userID)
	viewerCtx := context.WithValue(context.Background(), currentUserKey, currentUser{ID: userID, Role: "user"})
	plainUserID := metadataReviewExec(t, server.db, "INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-remote-plain', 'Example plain viewer', 'user')")
	plainCtx := context.WithValue(context.Background(), currentUserKey, currentUser{ID: plainUserID, Role: "user"})
	source, err := server.loadRemoteSourceForUse(context.Background(), 7)
	if err != nil {
		t.Fatal(err)
	}
	// A non-default fallback shows that requests without a preference send
	// the fallback alone rather than a Japanese original language.
	custom := source
	custom.Config.RequestLanguage = "en-US"

	clients := []struct {
		name   string
		client *kikoeru.Client
		want   string
	}{
		{"viewer browse", server.kikoeruClientForSource(viewerCtx, source), "zh-CN, ja-JP;q=0.9"},
		{"anonymous browse", server.kikoeruClientForSource(context.Background(), source), "ja-JP"},
		{"crawl", server.kikoeruCrawlClientForSource(viewerCtx, source), "ja-JP"},
		{"metadata fallback", server.remoteMetadataClient(viewerCtx, source), "ja-JP"},
		{"viewer browse, custom fallback", server.kikoeruClientForSource(viewerCtx, custom), "zh-CN, en-US;q=0.9"},
		{"viewer without preference, custom fallback", server.kikoeruClientForSource(plainCtx, custom), "en-US"},
		{"anonymous browse, custom fallback", server.kikoeruClientForSource(context.Background(), custom), "en-US"},
		{"crawl, custom fallback", server.kikoeruCrawlClientForSource(viewerCtx, custom), "en-US"},
		{"metadata fallback, custom fallback", server.remoteMetadataClient(viewerCtx, custom), "en-US"},
	}
	for _, check := range clients {
		mu.Lock()
		seen = seen[:0]
		mu.Unlock()
		if _, err := check.client.ListWorks(context.Background(), 1, 10, ""); err != nil {
			t.Fatalf("%s: %v", check.name, err)
		}
		mu.Lock()
		got := append([]string(nil), seen...)
		mu.Unlock()
		if len(got) == 0 || got[0] != check.want {
			t.Fatalf("%s: Accept-Language = %v, want %q", check.name, got, check.want)
		}
	}

	// Cached remote works never cross viewers with different languages.
	if server.remoteWorkCacheKey(viewerCtx, 7, "RJ00000001") == server.remoteWorkCacheKey(context.Background(), 7, "RJ00000001") {
		t.Fatal("remote work cache key ignores the viewer language")
	}
}

func TestRemoteWorkDefaultsToFirstPreferredLanguageItDescribes(t *testing.T) {
	work := kikoeru.Work{ID: 1, SourceID: "RJ00000001", Title: "Example remote", Tags: []kikoeru.Tag{
		{Name: "Example tag", I18n: map[string]kikoeru.LocalizedTag{"ja-jp": {Name: "例のタグ"}, "en-us": {Name: "Example tag"}}},
	}}
	if got := remoteWorkMetadataPresentation(work, []string{"zh-cn", "en-us", "ja-jp"}).DefaultVariantKey; got != "en-us" {
		t.Fatalf("default = %q, want en-us", got)
	}
	if got := remoteWorkMetadataPresentation(work, []string{"ko-kr", "ja-jp"}).DefaultVariantKey; got != "ja-jp" {
		t.Fatalf("default = %q, want the ja-jp fallback", got)
	}
	// A fallback the work does not describe is still the last resort.
	if got := remoteWorkMetadataPresentation(work, []string{"ko-kr", "zh-tw"}).DefaultVariantKey; got != "zh-tw" {
		t.Fatalf("default = %q, want the zh-tw fallback", got)
	}
}
