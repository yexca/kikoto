package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// Fetch must not persist a viewer's localized browse snapshot, including when
// both the viewer's metadata and directory caches were populated first.
func TestRemoteFetchUsesInstanceLanguagesAfterPersonalBrowse(t *testing.T) {
	code := testfixture.WorkCode("RJ", 0)
	var mu sync.Mutex
	requests := []string{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		language := r.Header.Get("Accept-Language")
		mu.Lock()
		requests = append(requests, language)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/workInfo/" + code:
			title := "Example Work Japanese"
			if strings.HasPrefix(language, "en-US") {
				title = "Example Work English"
			}
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 1, SourceID: code, Title: title})
		case "/api/tracks/1":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: "track.mp3", MediaDownloadURL: "/media/track.mp3", Size: 3}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer upstream.Close()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir(), LocalScanDepth: 2})
	metadataReviewExec(t, db, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible')`)
	metadataReviewExec(t, db, `INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (7, ?, ?)`, upstream.URL, upstream.URL)
	metadataReviewExec(t, db, `INSERT INTO app_setting (key, value_json) VALUES ('dlsite_metadata_languages', '["ja-jp","origin"]')`)
	userID := metadataReviewExec(t, db, `INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-user', 'Example User', 'user')`)
	metadataReviewExec(t, db, `INSERT INTO user_preference (user_id, metadata_languages) VALUES (?, '["en-us","origin"]')`, userID)
	ctx := withMetadataLanguageMemo(context.WithValue(context.Background(), currentUserKey, currentUser{ID: userID, Role: "user"}))
	_, work, _, err := server.loadRemoteWorkTracksCached(ctx, 7, code)
	if err != nil || work.Title != "Example Work English" {
		t.Fatalf("personal browse = %q, error = %v", work.Title, err)
	}
	plan, err := server.buildRemoteWorkSavePlan(ctx, 7, code, nil, nil, "", nil)
	if err != nil || len(plan.Items) != 1 {
		t.Fatalf("Fetch plan = %+v, error = %v", plan, err)
	}
	prep, err := server.prepareRemoteWorkSaveEnqueue(ctx, 7, code, nil, nil, "", "", nil, 0, userID, workflow.JobPriorityUserInitiated)
	if err != nil {
		t.Fatal(err)
	}
	result, err := server.enqueuePreparedRemoteWorkSave(ctx, prep)
	if err != nil {
		t.Fatal(err)
	}
	var title, snapshotTitle string
	if err := db.QueryRow(`SELECT title FROM work WHERE id = ?`, result.WorkID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT json_extract(snapshot_json, '$.title') FROM metadata_snapshot WHERE work_id = ?`, result.WorkID).Scan(&snapshotTitle); err != nil {
		t.Fatal(err)
	}
	if title != "Example Work Japanese" || snapshotTitle != title {
		t.Fatalf("shared work/snapshot titles = %q/%q", title, snapshotTitle)
	}
	_, work, _, err = server.loadRemoteWorkTracksCached(ctx, 7, code)
	if err != nil || work.Title != "Example Work English" {
		t.Fatalf("personal browse after Fetch = %q, error = %v", work.Title, err)
	}
	// Force recovery to reconstruct the plan after the instance cache expires.
	server.invalidateRemoteWorkCache(7)
	metadataReviewExec(t, db, `UPDATE remote_fetch_manifest SET plan_json = '{}' WHERE workflow_run_id = ?`, result.RunID)
	if _, err := server.prepareRemoteWorkFetchExecution(ctx, result.RunID, result.JobID, remoteWorkFetchJobPayload{SourceID: 7, WorkCode: code}); err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	seen := append([]string(nil), requests...)
	mu.Unlock()
	if len(seen) != 6 {
		t.Fatalf("upstream requests = %v, want personal browse, instance plan and instance recovery pairs", seen)
	}
	for index, language := range seen {
		want := "ja-JP"
		if index < 2 {
			want = "en-US, ja-JP;q=0.9"
		}
		if language != want {
			t.Fatalf("request %d language = %q, want %q", index, language, want)
		}
	}
	// Shared writes never rewrite the account's personal preference.
	if got, _ := server.userMetadataLanguages(ctx, userID); !sameMetadataLanguages(got, []string{"en-us", "origin"}) {
		t.Fatalf("personal preference after Fetch = %v", got)
	}
}
