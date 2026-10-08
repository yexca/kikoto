package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/remotemetadata"
)

func TestMetadataSyncSelectedWorksNormalizesAndRejectsUnknownWorks(t *testing.T) {
	f := newRemoteFallbackFixture(t, 70, nil)
	ctx := context.Background()
	options, err := f.server.validateMetadataSyncOptions(ctx, metadataSyncOptions{Scope: "works", WorkCodes: []string{strings.ToLower(f.code), " " + f.code + " "}, Mode: "full"})
	if err != nil || !slices.Equal(options.WorkCodes, []string{f.code}) {
		t.Fatalf("normalized works: %+v, %v", options, err)
	}
	scope, err := f.server.metadataSyncScope(ctx, options)
	if err != nil || !slices.Equal(scope.WorkIDs, []int64{f.workID}) || !scope.RecheckUnavailable {
		t.Fatalf("selected works: %+v, %v", scope, err)
	}
	for _, codes := range [][]string{nil, {"invalid"}, {"RJ00000099"}, make([]string, 101)} {
		if _, err := f.server.validateMetadataSyncOptions(ctx, metadataSyncOptions{Scope: "works", WorkCodes: codes}); err == nil {
			t.Fatalf("accepted invalid work selection: %v", codes)
		}
	}
	var works int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil || works != 1 {
		t.Fatalf("validation materialized works: %d, %v", works, err)
	}
}

type metadataRunBonusClient struct{ recoveryMetadataClient }

func (metadataRunBonusClient) FetchProduct(_ context.Context, code string) (dlsite.Product, error) {
	price := int64(0)
	raw := json.RawMessage(`{"workno":"` + code + `","maker_id":"RG00000","work_name":"【早期購入特典】Example Work","official_price":0,"price":0}`)
	return dlsite.Product{WorkNo: code, ProductName: "【早期購入特典】Example Work", WorkName: "【早期購入特典】Example Work", MakerID: "RG00000", RegularPrice: &price, CurrentPrice: &price, ProductRaw: raw, Raw: json.RawMessage(`{"product":` + string(raw) + `}`)}, nil
}

func TestMetadataRunBonusDetectionUsesRunOption(t *testing.T) {
	for _, enabled := range []bool{true, false} {
		f := newRemoteFallbackFixture(t, 76, nil)
		f.server.dlsiteClient = &metadataRunBonusClient{}
		if _, err := f.db.Exec("INSERT INTO app_setting(key,value_json) VALUES (?,?)", purchaseBonusAutoLinkSetting, mustJSON(!enabled)); err != nil {
			t.Fatal(err)
		}
		if _, err := f.server.enqueueScopedDLsiteMetadataSync(context.Background(), "manual", "manual", 0, metadataSyncOptions{Scope: "works", WorkCodes: []string{f.code}, Mode: "full", PurchaseBonusAutoLink: &enabled}); err != nil {
			t.Fatal(err)
		}
		if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
			t.Fatal(err)
		}
		var detected bool
		if err := f.db.QueryRow("SELECT EXISTS(SELECT 1 FROM work_purchase_bonus WHERE work_id=?)", f.workID).Scan(&detected); err != nil {
			t.Fatal(err)
		}
		if detected != enabled {
			t.Fatalf("bonus detection=%t want run option %t", detected, enabled)
		}
	}
}

func TestBulkRemoteMetadataCancellationRecordsNoProviderOutcome(t *testing.T) {
	f := newRemoteFallbackFixture(t, 77, nil)
	started := make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer remote.Close()
	sourceID := f.addSource(t, "A", 10, remote.URL)
	if _, err := f.server.enqueueScopedDLsiteMetadataSync(context.Background(), "manual", "manual", 0, metadataSyncOptions{Scope: "works", WorkCodes: []string{f.code}, SourceID: sourceID, Mode: "full"}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- f.server.runNextQueuedWorkflowJob(ctx) }()
	select {
	case <-started:
	case <-time.After(10 * time.Second):
		t.Fatal("request did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("cancelled run error=%v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cancelled request did not release the executor")
	}
	var outcomes int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM work_metadata_sync_state WHERE work_id=?", f.workID).Scan(&outcomes); err != nil || outcomes != 0 {
		t.Fatalf("cancelled outcome count=%d err=%v", outcomes, err)
	}
}

func TestBulkRemoteMetadataRetryKeepsOptionsAndSanitizesErrors(t *testing.T) {
	f := newRemoteFallbackFixture(t, 78, nil)
	if _, err := f.db.Exec("INSERT INTO app_setting(key,value_json) VALUES ('remote_rate_limit_backoff_seconds','0')"); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if hits.Add(1) == 1 {
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte("synthetic upstream diagnostic"))
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"source_id": f.code, "title": "Example Work 78"})
	}))
	defer remote.Close()
	sourceID := f.addSource(t, "A", 10, remote.URL)
	run, err := f.server.enqueueScopedDLsiteMetadataSync(context.Background(), "manual", "manual", 0, metadataSyncOptions{Scope: "works", WorkCodes: []string{f.code}, SourceID: sourceID, Mode: "full"})
	if err != nil {
		t.Fatal(err)
	}
	var original string
	if err := f.db.QueryRow("SELECT payload_json FROM workflow_job WHERE id=?", run.JobID).Scan(&original); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	var status, payload, summary string
	var retries int
	if err := f.db.QueryRow("SELECT job.status,job.retry_count,job.payload_json,run.summary_json FROM workflow_job job JOIN workflow_run run ON run.id=job.workflow_run_id WHERE job.id=?", run.JobID).Scan(&status, &retries, &payload, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "queued" || retries != 1 || payload != original || strings.Contains(summary, remote.URL) || strings.Contains(summary, "synthetic upstream diagnostic") {
		t.Fatalf("retry state=%s retries=%d payload=%s summary=%s", status, retries, payload, summary)
	}
	if _, err := f.db.Exec("UPDATE workflow_job SET available_at=CURRENT_TIMESTAMP WHERE id=?", run.JobID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id=?", run.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" || hits.Load() != 2 {
		t.Fatalf("retry result=%s hits=%d", status, hits.Load())
	}
}

func TestMetadataRunOptionsDeduplicationTriggerAndRetry(t *testing.T) {
	f := newRemoteFallbackFixture(t, 71, nil)
	sourceID := f.addSource(t, "A", 10, "https://source.example.invalid")
	autoLink := false
	options := metadataSyncOptions{Scope: "works", WorkCodes: []string{f.code}, Mode: "full", PurchaseBonusAutoLink: &autoLink, RemoteMetadataFallback: remoteMetadataFallbackSettings{Enabled: true, SourceIDs: []int64{sourceID}}}
	ctx := context.Background()
	first, err := f.server.enqueueScopedDLsiteMetadataSync(ctx, "manual", "manual", 0, options)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.server.enqueueScopedDLsiteMetadataSync(ctx, "manual", "manual", 0, options)
	if err != nil || again.RunID != first.RunID || !again.Deduplicated {
		t.Fatalf("identical options did not coalesce: %+v %v", again, err)
	}
	other := options
	other.RemoteMetadataFallback = remoteMetadataFallbackSettings{}
	different, err := f.server.enqueueScopedDLsiteMetadataSync(ctx, "manual", "manual", 0, other)
	if err != nil || different.RunID == first.RunID {
		t.Fatalf("fallback choices coalesced: %+v %v", different, err)
	}
	other.SourceID = sourceID
	remote, err := f.server.enqueueScopedDLsiteMetadataSync(ctx, "manual", "manual", 0, other)
	if err != nil || remote.RunID == different.RunID {
		t.Fatalf("different providers coalesced: %+v %v", remote, err)
	}
	if _, err := f.db.Exec("UPDATE workflow_run SET status='failed' WHERE id=?", first.RunID); err != nil {
		t.Fatal(err)
	}
	retried, err := f.server.dispatchWorkflowRetry(ctx, currentUser{ID: 1, Permissions: []string{"metadata:sync"}}, workflowRunRecord{WorkflowCode: "metadata_sync"}, first.RunID)
	if err != nil {
		t.Fatal(err)
	}
	var originalJSON, retryJSON string
	if err := f.db.QueryRow("SELECT input_json FROM workflow_run WHERE id=?", first.RunID).Scan(&originalJSON); err != nil {
		t.Fatal(err)
	}
	if err := f.db.QueryRow("SELECT input_json FROM workflow_run WHERE id=?", retried.NewRunID).Scan(&retryJSON); err != nil {
		t.Fatal(err)
	}
	if originalJSON != retryJSON {
		t.Fatalf("retry changed options: %s => %s", originalJSON, retryJSON)
	}
	_, _, err = f.server.executeMetadataSystemTrigger(ctx, workflowTriggerRecord{ConfigJSON: originalJSON}, "schedule", "test")
	if err != nil {
		t.Fatal(err)
	}
	var settings int
	if err := f.db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key IN (?,?)", remotemetadata.SettingKey, purchaseBonusAutoLinkSetting).Scan(&settings); err != nil || settings != 0 {
		t.Fatalf("run choices mutated instance settings: %d %v", settings, err)
	}
}

func TestBulkMetadataFallbackUsesRecordedChoicesAndOnlyExplicitNotFound(t *testing.T) {
	for _, failure := range []error{dlsite.ErrNoProduct, errors.New("synthetic temporary provider failure"), context.DeadlineExceeded} {
		t.Run(failure.Error(), func(t *testing.T) {
			f := newRemoteFallbackFixture(t, 72, failure)
			if _, err := f.db.Exec("INSERT INTO app_setting(key,value_json) VALUES ('remote_rate_limit_backoff_seconds','0')"); err != nil {
				t.Fatal(err)
			}
			var hits atomic.Int32
			remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				if r.URL.Path != "/api/workInfo/"+f.code {
					t.Errorf("unexpected catalog request: %s", r.URL.Path)
				}
				_ = json.NewEncoder(w).Encode(map[string]any{"source_id": f.code, "title": "Example Work 72"})
			}))
			defer remote.Close()
			sourceID := f.addSource(t, "A", 10, remote.URL)
			options := metadataSyncOptions{Scope: "works", WorkCodes: []string{f.code}, Mode: "full", RemoteMetadataFallback: remoteMetadataFallbackSettings{Enabled: true, SourceIDs: []int64{sourceID}}}
			run, err := f.server.enqueueScopedDLsiteMetadataSync(context.Background(), "manual", "manual", 0, options)
			if err != nil {
				t.Fatal(err)
			}
			// An unrelated global policy edited after enqueue cannot change this run.
			if _, err := f.db.Exec("INSERT INTO app_setting(key,value_json) VALUES (?,?)", remotemetadata.SettingKey, `{"enabled":false,"sourceIds":[]}`); err != nil {
				t.Fatal(err)
			}
			if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil && !errors.Is(failure, context.DeadlineExceeded) {
				t.Fatal(err)
			}
			want := int32(0)
			if errors.Is(failure, dlsite.ErrNoProduct) {
				want = 1
			}
			if hits.Load() != want {
				t.Fatalf("fallback hits=%d want=%d", hits.Load(), want)
			}
			var global, input string
			if err := f.db.QueryRow("SELECT value_json FROM app_setting WHERE key=?", remotemetadata.SettingKey).Scan(&global); err != nil {
				t.Fatal(err)
			}
			if err := f.db.QueryRow("SELECT input_json FROM workflow_run WHERE id=?", run.RunID).Scan(&input); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(input, `"enabled":true`) || global != `{"enabled":false,"sourceIds":[]}` {
				t.Fatalf("execution changed recorded options: %s %s", input, global)
			}
		})
	}
}

func TestBulkRemoteMetadataRefreshUsesSelectedProviderAndPreservesLibraryScope(t *testing.T) {
	f := newRemoteFallbackFixture(t, 73, nil)
	if _, err := f.db.Exec("INSERT INTO work(primary_code,title) VALUES ('RJ00000074','Example Work 74'),('RJ00000075','Example Work 75')"); err != nil {
		t.Fatal(err)
	}
	var hits atomic.Int32
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		code := strings.TrimPrefix(r.URL.Path, "/api/workInfo/")
		if code != f.code && code != "RJ00000074" {
			t.Errorf("out of scope request: %s", r.URL.Path)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"source_id": code, "title": "Example refreshed title"})
	}))
	defer remote.Close()
	sourceID := f.addSource(t, "A", 10, remote.URL)
	// A DLsite snapshot must not suppress missing metadata from the chosen source.
	if _, err := f.db.Exec(`INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT ?,id,?,'{}' FROM metadata_provider WHERE code='dlsite'`, f.workID, f.code); err != nil {
		t.Fatal(err)
	}
	options := metadataSyncOptions{Scope: "works", WorkCodes: []string{f.code, "RJ00000074"}, SourceID: sourceID}
	for _, mode := range []string{"missing", "missing", "full"} {
		options.Mode = mode
		if _, err := f.server.enqueueScopedDLsiteMetadataSync(context.Background(), "manual", "manual", 0, options); err != nil {
			t.Fatal(err)
		}
		if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if hits.Load() != 4 {
		t.Fatalf("provider missing/full hits=%d want=4", hits.Load())
	}
	var works, presence, locations int
	var title string
	if err := f.db.QueryRow(`SELECT (SELECT COUNT(*) FROM work),(SELECT COUNT(*) FROM work_source_presence),(SELECT COUNT(*) FROM media_file_location),(SELECT title FROM work WHERE primary_code='RJ00000075')`).Scan(&works, &presence, &locations, &title); err != nil {
		t.Fatal(err)
	}
	if works != 3 || presence != 0 || locations != 0 || title != "Example Work 75" {
		t.Fatalf("scope changed: works=%d presence=%d locations=%d title=%s", works, presence, locations, title)
	}
	options.Mode = "full"
	if _, err := f.server.enqueueScopedDLsiteMetadataSync(context.Background(), "manual", "manual", 0, options); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.Exec("UPDATE file_source SET enabled=0 WHERE id=?", sourceID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err == nil || hits.Load() != 4 {
		t.Fatalf("queued run did not revalidate capability: %v hits=%d", err, hits.Load())
	}
}
