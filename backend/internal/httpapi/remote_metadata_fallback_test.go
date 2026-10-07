package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

type remoteFallbackFixture struct {
	db     *sql.DB
	server *Server
	workID int64
	code   string
}

func newRemoteFallbackFixture(t *testing.T, ordinal int, dlsiteFailure error) remoteFallbackFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	server.dlsiteClient = &recoveryMetadataClient{failure: dlsiteFailure}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES
		('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	code := testfixture.WorkCode(testfixture.PrefixRJ, ordinal)
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", code, code)
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := result.LastInsertId()
	return remoteFallbackFixture{db: db, server: server, workID: workID, code: code}
}

func (f remoteFallbackFixture) addSource(t *testing.T, letter string, priority int, apiURL string) int64 {
	t.Helper()
	result, err := f.db.Exec(`INSERT INTO file_source (code, display_name, source_type, priority, enabled, config_json)
		VALUES (?, ?, 'kikoeru_compatible', ?, 1, '{}')`, "example_remote_"+strings.ToLower(letter), "Example Remote "+letter, priority)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	if _, err := f.db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (?, ?, ?)`, id, apiURL, apiURL); err != nil {
		t.Fatal(err)
	}
	return id
}

func (f remoteFallbackFixture) enable(t *testing.T, ids ...int64) {
	t.Helper()
	raw, _ := json.Marshal(remotemetadata.Settings{Enabled: true, SourceIDs: ids})
	if _, err := f.db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`, remotemetadata.SettingKey, string(raw)); err != nil {
		t.Fatal(err)
	}
}

// runJob queues and runs the work's metadata job, returning the job error.
func (f remoteFallbackFixture) runJob(t *testing.T) (int64, error) {
	t.Helper()
	run, err := f.server.enqueueWorkMetadataSyncWithOptions(context.Background(), f.workID, true)
	if err != nil {
		t.Fatal(err)
	}
	return run.RunID, f.server.runNextQueuedWorkflowJob(context.Background())
}

func (f remoteFallbackFixture) providerStatus(t *testing.T, providerCode string) string {
	t.Helper()
	var status string
	err := f.db.QueryRow(`SELECT state.status FROM work_metadata_sync_state AS state
		JOIN metadata_provider AS provider ON provider.id = state.provider_id
		WHERE state.work_id = ? AND provider.code = ? AND state.component = 'metadata'`, f.workID, providerCode).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return ""
	}
	if err != nil {
		t.Fatal(err)
	}
	return status
}

func syntheticPNG(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 1, 1))); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

// DLsite explicitly does not have the work. The first selected source answers
// 404, the second describes the work; each is asked exactly once through
// workInfo, and no catalog page is scanned. The configured loopback origins
// exercise the administrator's private-origin exception.
func TestRemoteFallbackFillsWorkDLsiteReportsNotFound(t *testing.T) {
	f := newRemoteFallbackFixture(t, 20, dlsite.ErrNoProduct)
	var hitsA, hitsB, listHits atomic.Int32
	remoteA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/workInfo/"+f.code {
			hitsA.Add(1)
		} else {
			listHits.Add(1)
		}
		http.NotFound(w, r)
	}))
	defer remoteA.Close()
	cover := syntheticPNG(t)
	var remoteB *httptest.Server
	remoteB = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/workInfo/" + f.code:
			hitsB.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id": 7, "source_id": f.code, "title": "Example Work 20", "release": "2026-05-06",
				"circle": map[string]any{"id": 3, "name": "Example Circle 20"}, "mainCoverUrl": remoteB.URL + "/cover",
				"tags": []any{map[string]any{"id": 9, "name": "Example Tag", "i18n": map[string]any{"en-us": map[string]any{"name": "Example Tag EN"}}}},
			})
		case "/cover":
			w.Header().Set("Content-Type", "image/png")
			_, _ = w.Write(cover)
		default:
			listHits.Add(1)
			http.NotFound(w, r)
		}
	}))
	defer remoteB.Close()
	sourceA := f.addSource(t, "A", 10, remoteA.URL)
	sourceB := f.addSource(t, "B", 20, remoteB.URL)
	f.enable(t, sourceA, sourceB)

	runID, err := f.runJob(t)
	if err != nil {
		t.Fatal(err)
	}
	if hitsA.Load() != 1 || hitsB.Load() != 1 || listHits.Load() != 0 {
		t.Fatalf("requests: A=%d B=%d list=%d", hitsA.Load(), hitsB.Load(), listHits.Load())
	}
	var title, release string
	if err := f.db.QueryRow("SELECT title, release_date FROM work WHERE id = ?", f.workID).Scan(&title, &release); err != nil {
		t.Fatal(err)
	}
	if title != "Example Work 20" || release != "2026-05-06" {
		t.Fatalf("work fields: %q %q", title, release)
	}
	// The earlier source's miss is superseded once B fills the work; the run
	// output keeps both attempts.
	if a, b, d := f.providerStatus(t, "kikoeru_source_example_remote_a"), f.providerStatus(t, "kikoeru_source_example_remote_b"), f.providerStatus(t, "dlsite"); a != "" || b != "succeeded" || d != "unavailable" {
		t.Fatalf("provider states: A=%q B=%q DLsite=%q", a, b, d)
	}
	var summary string
	if err := f.db.QueryRow("SELECT summary_json FROM workflow_run WHERE id = ?", runID).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, `"status":"filled"`) || !strings.Contains(summary, `"outcome":"not_found"`) || strings.Contains(summary, strings.TrimPrefix(remoteB.URL, "http://")) {
		t.Fatalf("run summary: %s", summary)
	}

	detail, err := f.server.loadWorkDetail(context.Background(), 1, f.workID, false)
	if err != nil {
		t.Fatal(err)
	}
	if detail.MetadataSync.Status != workMetadataSyncStatusRemoteFallback || detail.MetadataSync.Source != "Example Remote B" {
		t.Fatalf("sync status: %+v", detail.MetadataSync)
	}
	if choice := detail.TitleChoices[""]; choice.Source != "remote" || choice.SourceName != "Example Remote B" || choice.Language != "" {
		t.Fatalf("title source: %+v", choice)
	}
	fields := map[string]string{}
	for _, item := range detail.MetadataSync.Fields {
		fields[item.Field] = item.Source
	}
	for _, field := range []string{"title", "release_date", "circle", "tags", "cover"} {
		if fields[field] != "Example Remote B" {
			t.Fatalf("field %s source: %v", field, detail.MetadataSync.Fields)
		}
	}
	if len(detail.MetadataView.Variants) != 0 || !strings.Contains(strings.Join(detail.Tags, ","), "Example Tag") || detail.Circle != "Example Circle 20" {
		t.Fatalf("detail presentation: variants=%+v tags=%v circle=%q", detail.MetadataView.Variants, detail.Tags, detail.Circle)
	}
	page, err := metasync.NewIssueStore(f.db).List(context.Background(), metasync.IssueQuery{Page: 1, PageSize: 50})
	if err != nil {
		t.Fatal(err)
	}
	marked := false
	for _, item := range page.Items {
		if item.ProviderCode == "dlsite" && item.WorkID == f.workID {
			marked = item.FallbackSource == "Example Remote B"
		}
	}
	if !marked {
		t.Fatalf("issue list does not name the fallback source: %+v", page.Items)
	}
}

// Timeouts, rate limits and other retryable DLsite failures never contact a
// remote source, and neither does an explicit not-found while the switch is off.
func TestRemoteFallbackRunsOnlyForExplicitNotFoundWhenEnabled(t *testing.T) {
	for _, tc := range []struct {
		name    string
		failure error
		enable  bool
	}{
		{"retryable DLsite failure", errors.New("synthetic upstream failure"), true},
		{"fallback disabled", dlsite.ErrNoProduct, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newRemoteFallbackFixture(t, 21, tc.failure)
			var hits atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				http.Error(w, "unexpected", http.StatusInternalServerError)
			}))
			defer remote.Close()
			source := f.addSource(t, "A", 10, remote.URL)
			if tc.enable {
				f.enable(t, source)
			}
			_, jobErr := f.runJob(t)
			if (jobErr != nil) != (tc.failure != dlsite.ErrNoProduct) {
				t.Fatalf("job error = %v", jobErr)
			}
			if hits.Load() != 0 || f.providerStatus(t, "kikoeru_source_example_remote_a") != "" {
				t.Fatalf("remote source contacted: hits=%d", hits.Load())
			}
		})
	}
}

// A cached catalog description of the same code is reused without a request.
func TestRemoteFallbackReusesCachedCatalogJSON(t *testing.T) {
	f := newRemoteFallbackFixture(t, 22, dlsite.ErrNoProduct)
	var hits atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.Error(w, "unexpected", http.StatusInternalServerError)
	}))
	defer remote.Close()
	source := f.addSource(t, "A", 10, remote.URL)
	f.enable(t, source)
	if _, err := f.db.Exec(`INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')`); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('kikoeru_source_example_remote_a', 'Example Remote A')`); err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(map[string]any{"id": 5, "source_id": f.code, "title": "Example Work 22"})
	if _, err := f.db.Exec(`INSERT INTO voice_catalog_item (id, person_id, primary_code) VALUES (1, 1, ?)`, f.code); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO voice_catalog_source (catalog_item_id, provider_id, remote_code, availability, raw_json)
		SELECT 1, id, ?, 'available', ? FROM metadata_provider WHERE code = 'kikoeru_source_example_remote_a'`, f.code, string(raw)); err != nil {
		t.Fatal(err)
	}
	result, err := f.server.runRemoteMetadataFallback(context.Background(), f.workID, f.code)
	if err != nil {
		t.Fatal(err)
	}
	var title string
	if err := f.db.QueryRow("SELECT title FROM work WHERE id = ?", f.workID).Scan(&title); err != nil {
		t.Fatal(err)
	}
	if hits.Load() != 0 || result.Status != remoteFallbackFilled || len(result.Attempts) != 1 || !result.Attempts[0].Cached || title != "Example Work 22" {
		t.Fatalf("cached reuse: hits=%d result=%+v title=%q", hits.Load(), result, title)
	}
}

// The lookup stays on the configured origin: a redirect elsewhere is refused
// before the target is contacted, a same-origin redirect is followed, an
// oversized body is rejected whole, and a cover on an unconfigured private
// origin is never fetched.
func TestRemoteFallbackRequestBoundary(t *testing.T) {
	var outsideHits atomic.Int32
	outside := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		outsideHits.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"source_id": testfixture.WorkCode(testfixture.PrefixRJ, 23), "title": "Example Outside"})
	}))
	defer outside.Close()
	for _, tc := range []struct {
		name    string
		handler func(code string) http.HandlerFunc
		filled  bool
	}{
		{"cross-origin redirect", func(code string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				http.Redirect(w, r, outside.URL+"/api/workInfo/"+code, http.StatusFound)
			}
		}, false},
		{"same-origin redirect with private cover", func(code string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/api/workInfo/"+code {
					http.Redirect(w, r, "/v2/workInfo/"+code, http.StatusFound)
					return
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"source_id": code, "title": "Example Work 23", "mainCoverUrl": outside.URL + "/cover"})
			}
		}, true},
		{"oversized response", func(code string) http.HandlerFunc {
			return func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewEncoder(w).Encode(map[string]any{"source_id": code, "title": "Example Work 23", "padding": strings.Repeat("x", remotemetadata.MaxResponseBytes)})
			}
		}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, explicit := range []bool{false, true} {
				t.Run(strconv.FormatBool(explicit), func(t *testing.T) {
					outsideHits.Store(0)
					f := newRemoteFallbackFixture(t, 23, dlsite.ErrNoProduct)
					remote := httptest.NewServer(tc.handler(f.code))
					defer remote.Close()
					sourceID := f.addSource(t, "A", 10, remote.URL)
					var filled bool
					if explicit {
						if _, err := f.server.enqueueWorkMetadataSyncForSource(context.Background(), f.workID, false, sourceID); err != nil {
							t.Fatal(err)
						}
						_ = f.server.runNextQueuedWorkflowJob(context.Background())
						var status string
						if err := f.db.QueryRow("SELECT status FROM workflow_run ORDER BY id DESC LIMIT 1").Scan(&status); err != nil {
							t.Fatal(err)
						}
						filled = status == "succeeded"
					} else {
						f.enable(t, sourceID)
						result, err := f.server.runRemoteMetadataFallback(context.Background(), f.workID, f.code)
						if err != nil {
							t.Fatal(err)
						}
						filled = result.Status == remoteFallbackFilled
					}
					var snapshots int
					if err := f.db.QueryRow(`SELECT COUNT(*) FROM metadata_snapshot WHERE work_id = ?`, f.workID).Scan(&snapshots); err != nil {
						t.Fatal(err)
					}
					if outsideHits.Load() != 0 {
						t.Fatalf("unconfigured origin contacted %d times", outsideHits.Load())
					}
					if tc.filled != filled || tc.filled != (snapshots == 1) {
						t.Fatalf("filled=%t snapshots=%d", filled, snapshots)
					}
					if !tc.filled && f.providerStatus(t, "kikoeru_source_example_remote_a") != "failed" {
						t.Fatalf("boundary failure was not recorded as failed")
					}
				})
			}
		})
	}
}

// Cancellation releases a lookup that the source never answers and records no
// outcome for it.
func TestRemoteFallbackCancellation(t *testing.T) {
	for _, explicit := range []bool{false, true} {
		t.Run(strconv.FormatBool(explicit), func(t *testing.T) {
			f := newRemoteFallbackFixture(t, 24, dlsite.ErrNoProduct)
			started := make(chan struct{})
			release := make(chan struct{})
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				close(started)
				select {
				case <-r.Context().Done():
				case <-release:
				}
			}))
			defer remote.Close()
			defer close(release)
			sourceID := f.addSource(t, "A", 10, remote.URL)
			if explicit {
				if _, err := f.server.enqueueWorkMetadataSyncForSource(context.Background(), f.workID, false, sourceID); err != nil {
					t.Fatal(err)
				}
			} else {
				f.enable(t, sourceID)
			}
			ctx, cancel := context.WithCancel(context.Background())
			done := make(chan error, 1)
			go func() {
				if explicit {
					done <- f.server.runNextQueuedWorkflowJob(ctx)
				} else {
					_, err := f.server.runRemoteMetadataFallback(ctx, f.workID, f.code)
					done <- err
				}
			}()
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				cancel()
				t.Fatal("metadata lookup did not start")
			}
			cancel()
			select {
			case err := <-done:
				if !errors.Is(err, context.Canceled) {
					t.Fatalf("cancelled lookup returned %v", err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("cancelled lookup did not return")
			}
			if status := f.providerStatus(t, "kikoeru_source_example_remote_a"); status != "" {
				t.Fatalf("cancelled lookup recorded %q", status)
			}
		})
	}
}

func TestRemoteMetadataFallbackSettingsValidateAndRequeue(t *testing.T) {
	f := newRemoteFallbackFixture(t, 25, dlsite.ErrNoProduct)
	capable := f.addSource(t, "A", 10, "https://source.example.invalid/a")
	disabledCapability := f.addSource(t, "B", 20, "https://source.example.invalid/b")
	if _, err := f.db.Exec(`UPDATE file_source SET config_json = '{"capabilities":[]}' WHERE id = ?`, disabledCapability); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec(`INSERT INTO metadata_provider (code, display_name) VALUES ('kikoeru_source_example_remote_a', 'Example Remote A');
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		SELECT ?, id, ?, '{}' FROM metadata_provider WHERE code = 'kikoeru_source_example_remote_a';
		DELETE FROM work_metadata_tag_dirty;`, f.workID, f.code); err != nil {
		t.Fatal(err)
	}
	patch := func(body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPatch, "/api/settings", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"sources:write"}}))
		response := httptest.NewRecorder()
		f.server.updateSettings(response, request)
		return response
	}
	for _, body := range []string{
		`{"remoteMetadataFallback":{"enabled":true,"sourceIds":[` + strconv.FormatInt(disabledCapability, 10) + `]}}`,
		`{"remoteMetadataFallback":{"enabled":true,"sourceIds":[` + strconv.FormatInt(capable, 10) + `,` + strconv.FormatInt(capable, 10) + `]}}`,
		`{"remoteMetadataFallback":{"enabled":true,"sourceIds":[999]}}`,
	} {
		if response := patch(body); response.Code != http.StatusBadRequest {
			t.Fatalf("invalid settings accepted: %s -> %d %s", body, response.Code, response.Body)
		}
	}
	response := patch(`{"remoteMetadataFallback":{"enabled":true,"sourceIds":[` + strconv.FormatInt(capable, 10) + `]}}`)
	var settings appSettingsResponse
	if err := json.Unmarshal(response.Body.Bytes(), &settings); err != nil || response.Code != http.StatusOK ||
		!settings.RemoteMetadataFallback.Enabled || len(settings.RemoteMetadataFallback.SourceIDs) != 1 {
		t.Fatalf("settings: %d %s %v", response.Code, response.Body, err)
	}
	var queued int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM work_metadata_tag_dirty WHERE work_id = ?", f.workID).Scan(&queued); err != nil || queued != 1 {
		t.Fatalf("remote work was not queued: %d %v", queued, err)
	}
	if _, err := f.db.Exec(`INSERT INTO metadata_sync_attempt (id) VALUES (900);
		INSERT INTO work_metadata_sync_state (work_id, provider_id, component, attempt_id, status, failure_count)
		SELECT ?, id, 'metadata', 900, 'failed', 1 FROM metadata_provider WHERE code = 'kikoeru_source_example_remote_a'`, f.workID); err != nil {
		t.Fatal(err)
	}
	if response := patch(`{"remoteMetadataFallback":{"enabled":false,"sourceIds":[` + strconv.FormatInt(capable, 10) + `]}}`); response.Code != http.StatusOK {
		t.Fatalf("disable: %d %s", response.Code, response.Body)
	}
	if status := f.providerStatus(t, "kikoeru_source_example_remote_a"); status != "" {
		t.Fatalf("retired source issue kept: %q", status)
	}
}
