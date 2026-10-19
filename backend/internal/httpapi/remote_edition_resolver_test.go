package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

func TestRemoteEditionFallbackRequiresProviderOriginAndParent(t *testing.T) {
	originCode := testfixture.WorkCode("RJ", 0)
	parentCode := testfixture.WorkCode("RJ", 1)
	candidateCode := testfixture.WorkCode("RJ", 2)
	otherCode := testfixture.WorkCode("RJ", 3)
	for _, tc := range []struct {
		name, original, parent, productCode, remoteCode string
		wantFound                                       bool
	}{
		{"verified replacement", originCode, parentCode, candidateCode, candidateCode, true},
		{"different origin", otherCode, parentCode, candidateCode, candidateCode, false},
		{"different parent", originCode, otherCode, candidateCode, candidateCode, false},
		{"different product", originCode, parentCode, otherCode, candidateCode, false},
		{"different remote result", originCode, parentCode, candidateCode, otherCode, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var downloads atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/api/workInfo/" + originCode:
					_ = json.NewEncoder(w).Encode(kikoeru.Work{
						ID: 1, SourceID: originCode, Title: "Example Work",
						OtherLanguageEditions: []kikoeru.OtherLanguageEdition{{SourceID: candidateCode, Language: "CHI_HANS"}},
					})
				case "/api/workInfo/" + candidateCode:
					_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 2, SourceID: tc.remoteCode, Title: "Example Work Chinese"})
				case "/api/tracks/2":
					_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: "track.mp3", MediaDownloadURL: "/media/" + candidateCode + "/track.mp3", Size: int64Pointer(5)}})
				case "/media/" + candidateCode + "/track.mp3":
					w.Header().Set("Content-Type", "audio/mpeg")
					downloads.Add(1)
					_, _ = w.Write([]byte("track"))
				case "/api/works", "/api/search/" + parentCode:
					_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{}})
				default:
					http.NotFound(w, r)
				}
			}))
			defer remote.Close()
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
			provider := &availabilityWatchDLsiteClient{products: map[string]dlsite.Product{
				candidateCode: {
					WorkNo: tc.productCode,
					TranslationInfo: dlsite.TranslationInfo{
						OriginalWorkNo: tc.original, ParentWorkNo: tc.parent, Lang: "CHI_HANS",
					},
				},
			}}
			server.dlsiteClient = provider
			syncer := metasync.NewDLsiteSyncer(db, provider)
			ctx := context.Background()
			if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: originCode, ProductName: "Example Work"}); err != nil {
				t.Fatal(err)
			}
			parentProduct := dlsite.Product{
				WorkNo: parentCode, ProductName: "Example Work Chinese",
				TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: originCode, Lang: "CHI_HANS"},
			}
			parentProduct.Raw, _ = json.Marshal(parentProduct)
			parentID, err := syncer.SyncProductOnly(ctx, parentProduct)
			if err != nil {
				t.Fatal(err)
			}
			// A family may already declare the replacement without binding it to
			// a persisted edition. Verification must promote that existing row.
			metadataReviewExec(t, db, `
				INSERT INTO work_code_alias (logical_work_id, provider_id, primary_code)
				SELECT logical_work_id, provider_id, ? FROM work_edition WHERE work_id = ?
			`, candidateCode, parentID)
			metadataReviewExec(t, db, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible')`)
			metadataReviewExec(t, db, `INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (7, ?, ?)`, remote.URL, remote.URL)
			_, work, err := server.loadRemoteWork(ctx, 7, parentCode, nil)
			if !tc.wantFound {
				if !errors.Is(err, errRemoteWorkNotFound) {
					t.Fatalf("unverified replacement returned %+v, error = %v", work, err)
				}
				var linked int
				if err := db.QueryRow("SELECT COUNT(*) FROM work_code_alias WHERE primary_code = ? AND source_work_id IS NOT NULL", candidateCode).Scan(&linked); err != nil || linked != 0 {
					t.Fatalf("unverified alias count = %d, error = %v", linked, err)
				}
				return
			}
			if err != nil || normalizedRemoteWorkCode(work) != candidateCode {
				t.Fatalf("replacement = %+v, error = %v", work, err)
			}
			if code := server.localCodeForRemoteWork(ctx, candidateCode, work); code != parentCode {
				t.Fatalf("Fetch work code = %q, want %q", code, parentCode)
			}
			source, err := server.loadRemoteSourceForUse(ctx, 7)
			if err != nil {
				t.Fatal(err)
			}
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback() }()
			raw, _ := json.Marshal(work)
			reusedID, err := upsertRemoteWork(ctx, tx, source, work, raw)
			if err != nil || reusedID != parentID {
				t.Fatalf("replacement owner = %d, error = %v; want %d", reusedID, err, parentID)
			}
			if err := tx.Rollback(); err != nil {
				t.Fatal(err)
			}
			var discoveredWorks int
			if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = ?", candidateCode).Scan(&discoveredWorks); err != nil || discoveredWorks != 0 {
				t.Fatalf("discovered work count = %d, error = %v", discoveredWorks, err)
			}
			// Stored aliases resolve without another metadata lookup.
			server.dlsiteClient = nil
			if _, work, err := server.loadRemoteWork(ctx, 7, parentCode, nil); err != nil || normalizedRemoteWorkCode(work) != candidateCode {
				t.Fatalf("stored replacement = %+v, error = %v", work, err)
			}
			if len(provider.requests) != 1 {
				t.Fatalf("metadata requests = %v, want one candidate lookup", provider.requests)
			}
			availability, err := server.checkOneWorkSourceAvailability(ctx, source, parentCode, "manual")
			if err != nil || availability.Status != "available" || availability.EditionCode != parentCode || availability.RemoteCode != candidateCode {
				t.Fatalf("source mapping = %+v, error = %v", availability, err)
			}
			if err := server.recordSourceAvailabilityObservation(ctx, parentCode, []sourceAvailabilitySummary{availability}); err != nil {
				t.Fatal(err)
			}
			cached, err := server.readWorkSourceAvailability(ctx, parentCode)
			if err != nil || len(cached.Sources) != 1 || cached.Sources[0].RemoteCode != candidateCode || cached.Sources[0].EditionCode != parentCode {
				t.Fatalf("cached source mapping = %+v, error = %v", cached, err)
			}
			if _, err := server.buildRemoteWorkSavePlan(withRemoteFetchEdition(ctx, originCode), 7, candidateCode, nil, nil, "", nil); err == nil {
				t.Fatal("Fetch accepted a different selected local edition")
			}
			prep, err := server.prepareRemoteWorkSaveEnqueue(withRemoteFetchEdition(ctx, parentCode), 7, candidateCode, nil, nil, "", "", nil, 0, 0, workflow.JobPriorityUserInitiated)
			if err != nil {
				t.Fatal(err)
			}
			if prep.plan.EditionCode != parentCode || prep.plan.RemoteCode != candidateCode || !strings.Contains(prep.plan.SaveRoot, parentCode) || len(prep.plan.Items) != 1 || !strings.Contains(prep.plan.Items[0].SourcePath, candidateCode) {
				t.Fatalf("Fetch identity mapping = %+v", prep.plan)
			}
			result, err := server.enqueuePreparedRemoteWorkSave(ctx, prep)
			if err != nil || result.WorkID != parentID || result.PrimaryCode != parentCode {
				t.Fatalf("Fetch owner = %+v, error = %v", result, err)
			}
			var payloadJSON string
			if err := db.QueryRow("SELECT payload_json FROM workflow_job WHERE id = ?", result.JobID).Scan(&payloadJSON); err != nil {
				t.Fatal(err)
			}
			var payload remoteWorkFetchJobPayload
			if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
				t.Fatal(err)
			}
			if payload.EditionCode != parentCode || payload.RemoteCode != candidateCode {
				t.Fatalf("Fetch payload = %+v", payload)
			}
			server.invalidateRemoteWorkCache(7)
			metadataReviewExec(t, db, "UPDATE remote_fetch_manifest SET plan_json = '{}' WHERE workflow_run_id = ?", result.RunID)
			if _, err := server.prepareRemoteWorkFetchExecution(ctx, result.RunID, result.JobID, payload); err != nil {
				t.Fatal(err)
			}
			if err := server.runNextQueuedWorkflowJob(ctx); err != nil {
				t.Fatal(err)
			}
			bytes, err := os.ReadFile(filepath.Join(server.cfg.DataRoot, filepath.FromSlash(prep.plan.Items[0].TargetPath)))
			if err != nil || string(bytes) != "track" || downloads.Load() != 1 {
				t.Fatalf("downloaded bytes = %q, downloads = %d, error = %v", bytes, downloads.Load(), err)
			}
			var wrongOwners int
			if err := db.QueryRow("SELECT COUNT(*) FROM media_item WHERE work_id <> ?", parentID).Scan(&wrongOwners); err != nil || wrongOwners != 0 {
				t.Fatalf("media with wrong owner = %d, error = %v", wrongOwners, err)
			}
			if err := db.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = ?", candidateCode).Scan(&discoveredWorks); err != nil || discoveredWorks != 0 {
				t.Fatalf("replacement work count after Fetch = %d, error = %v", discoveredWorks, err)
			}
		})
	}
}

func TestRemoteEditionFallbackStopsBeforeRequestsInDemoOrAfterCancellation(t *testing.T) {
	source := remoteSourceForUse{Enabled: true, SourceType: "kikoeru_compatible"}
	server := &Server{cfg: config.Config{Mode: config.ModeDemo}}
	if _, err := server.resolveRemoteEditionFallback(context.Background(), source, nil, testfixture.WorkCode("RJ", 0)); !errors.Is(err, errRemoteWorkNotFound) {
		t.Fatalf("Demo fallback error = %v", err)
	}
	if stored, err := server.persistDLsiteReplacementAlias(context.Background(), "", "", dlsite.Product{}); err != nil || stored {
		t.Fatalf("Demo alias write = %v, error = %v", stored, err)
	}
	server.cfg.Mode = ""
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := server.resolveRemoteEditionFallback(ctx, source, nil, testfixture.WorkCode("RJ", 0)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled fallback error = %v", err)
	}
}

func TestRemotePersistenceVerifiesSelectedUnknownCodeBeforeInsert(t *testing.T) {
	original, local, candidate := testfixture.WorkCode("RJ", 0), testfixture.WorkCode("RJ", 1), testfixture.WorkCode("RJ", 2)
	for _, related := range []bool{true, false} {
		t.Run(map[bool]string{true: "verified parent", false: "same language only"}[related], func(t *testing.T) {
			db := openMigratedTestDB(t)
			server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
			product := dlsite.Product{WorkNo: candidate, ProductName: "Example Work Chinese", TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original, Lang: "CHI_HANS"}}
			if related {
				product.TranslationInfo.ParentWorkNo = local
			}
			provider := &availabilityWatchDLsiteClient{products: map[string]dlsite.Product{candidate: product}}
			server.dlsiteClient = provider
			syncer := metasync.NewDLsiteSyncer(db, provider)
			ctx := context.Background()
			if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: original, ProductName: "Example Work"}); err != nil {
				t.Fatal(err)
			}
			localProduct := dlsite.Product{WorkNo: local, ProductName: product.ProductName, TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original, Lang: "CHI_HANS"}}
			localProduct.Raw, _ = json.Marshal(localProduct)
			localID, err := syncer.SyncProductOnly(ctx, localProduct)
			if err != nil {
				t.Fatal(err)
			}
			work := kikoeru.Work{ID: 2, SourceID: candidate, Title: product.ProductName}
			if err := server.verifyRemoteWorkIdentity(ctx, work); err != nil {
				t.Fatal(err)
			}
			if len(provider.requests) != 1 || provider.requests[0] != candidate {
				t.Fatalf("provider requests = %v", provider.requests)
			}
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback() }()
			raw, _ := json.Marshal(work)
			id, err := upsertRemoteWork(ctx, tx, remoteSourceForUse{Code: "example_remote_a", DisplayName: "Example Remote A"}, work, raw)
			if err != nil || (id == localID) != related {
				t.Fatalf("persisted owner = %d, local = %d, related = %v, error = %v", id, localID, related, err)
			}
			var created int
			if err := tx.QueryRow("SELECT COUNT(*) FROM work WHERE primary_code = ?", candidate).Scan(&created); err != nil || (created == 0) != related {
				t.Fatalf("replacement work count = %d, error = %v", created, err)
			}
		})
	}
}

func TestReplacementAliasWaitsForAnotherWriter(t *testing.T) {
	original, parent, candidate := testfixture.WorkCode("RJ", 0), testfixture.WorkCode("RJ", 1), testfixture.WorkCode("RJ", 2)
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	product := dlsite.Product{WorkNo: candidate, ProductName: "Example Work Chinese", TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original, ParentWorkNo: parent, Lang: "CHI_HANS"}}
	syncer := metasync.NewDLsiteSyncer(db, &availabilityWatchDLsiteClient{products: map[string]dlsite.Product{candidate: product}})
	ctx := context.Background()
	if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: original, ProductName: "Example Work"}); err != nil {
		t.Fatal(err)
	}
	parentProduct := dlsite.Product{WorkNo: parent, ProductName: product.ProductName, TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: original, Lang: "CHI_HANS"}}
	parentProduct.Raw, _ = json.Marshal(parentProduct)
	if _, err := syncer.SyncProductOnly(ctx, parentProduct); err != nil {
		t.Fatal(err)
	}
	// Another connection holds the write lock for a moment, and this one does
	// not wait for a lock by itself.
	var path string
	if err := db.QueryRow("SELECT file FROM pragma_database_list WHERE name = 'main'").Scan(&path); err != nil {
		t.Fatal(err)
	}
	writer, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = writer.Close() }()
	holder, err := writer.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("PRAGMA busy_timeout = 0"); err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		defer close(released)
		time.Sleep(10 * time.Millisecond)
		_ = holder.Rollback()
	}()
	stored, err := server.persistDLsiteReplacementAlias(ctx, parent, candidate, product)
	<-released
	if err != nil || !stored {
		t.Fatalf("replacement alias while another writer held the lock = %v, %v; want it stored once the lock is free", stored, err)
	}
}

type unreachableDLsiteClient struct{ requests atomic.Int32 }

func (c *unreachableDLsiteClient) FetchProduct(context.Context, string) (dlsite.Product, error) {
	c.requests.Add(1)
	return dlsite.Product{}, errors.New("dial tcp: connection refused")
}

func (*unreachableDLsiteClient) DownloadCover(context.Context, dlsite.Product, string) (string, error) {
	return "", nil
}

// A deployment that reaches its remote source but not DLsite keeps working:
// unverified identity leaves the remote work its own code, DLsite failures do
// not mark the source unavailable, and one failure pauses further lookups.
func TestRemoteRequestsProceedWhenDLsiteCannotVerifyIdentity(t *testing.T) {
	originCode, localCode := testfixture.WorkCode("RJ", 0), testfixture.WorkCode("RJ", 1)
	remoteCode, candidateCode := testfixture.WorkCode("RJ", 2), testfixture.WorkCode("RJ", 3)
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/workInfo/" + originCode:
			_ = json.NewEncoder(w).Encode(kikoeru.Work{
				ID: 1, SourceID: originCode, Title: "Example Work",
				OtherLanguageEditions: []kikoeru.OtherLanguageEdition{{SourceID: candidateCode, Language: "CHI_HANT"}},
			})
		case "/api/workInfo/" + remoteCode:
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 2, SourceID: remoteCode, Title: "Example Remote Work"})
		case "/api/tracks/2":
			_ = json.NewEncoder(w).Encode([]kikoeru.Track{{Type: "audio", Title: "track.mp3", MediaDownloadURL: "/media/track.mp3", Size: int64Pointer(5)}})
		case "/api/works", "/api/search/" + localCode:
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	provider := &unreachableDLsiteClient{}
	server.dlsiteClient = provider
	syncer := metasync.NewDLsiteSyncer(db, &availabilityWatchDLsiteClient{})
	ctx := context.Background()
	if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: originCode, ProductName: "Example Work"}); err != nil {
		t.Fatal(err)
	}
	if _, err := syncer.SyncProductOnly(ctx, dlsite.Product{WorkNo: localCode, ProductName: "Example Work Chinese", TranslationInfo: dlsite.TranslationInfo{OriginalWorkNo: originCode, Lang: "CHI_HANS"}}); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, db, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible')`)
	metadataReviewExec(t, db, `INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (7, ?, ?)`, remote.URL, remote.URL)

	plan, err := server.buildRemoteWorkSavePlan(ctx, 7, remoteCode, nil, nil, "", nil)
	if err != nil || plan.EditionCode != remoteCode || !strings.Contains(plan.SaveRoot, remoteCode) {
		t.Fatalf("Fetch plan = %+v, error = %v", plan, err)
	}
	prepared, err := server.prepareRemoteWorkTrack(ctx, 7, remoteCode)
	if err != nil || prepared.WorkCode != remoteCode {
		t.Fatalf("Track = %+v, error = %v", prepared, err)
	}
	source, err := server.loadRemoteSourceForUse(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	availability, err := server.checkOneWorkSourceAvailability(ctx, source, localCode, "source_poll")
	if err != nil || availability.Status != "not_found" {
		t.Fatalf("local edition availability = %+v, error = %v", availability, err)
	}
	var health string
	if err := db.QueryRow("SELECT COALESCE(health_status, '') FROM file_source_endpoint WHERE file_source_id = 7").Scan(&health); err != nil || health != "healthy" {
		t.Fatalf("source health = %q, error = %v", health, err)
	}
	if requests := provider.requests.Load(); requests != 1 {
		t.Fatalf("DLsite requests = %d, want one before the failure pause", requests)
	}
	var aliases int
	if err := db.QueryRow("SELECT COUNT(*) FROM work_code_alias WHERE relationship_kind = 'provider_reissued'").Scan(&aliases); err != nil || aliases != 0 {
		t.Fatalf("unverified aliases = %d, error = %v", aliases, err)
	}
}
