package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestVoiceCatalogDiscoversEveryPageAndConfirmedAliasWithoutCreatingWorks(t *testing.T) {
	var mu sync.Mutex
	requests := []string{}
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		keyword := strings.TrimPrefix(request.URL.Path, "/api/search/")
		page, _ := strconv.Atoi(request.URL.Query().Get("page"))
		mu.Lock()
		requests = append(requests, keyword+":"+strconv.Itoa(page))
		mu.Unlock()

		result := kikoeru.WorksPage{Pagination: kikoeru.Pagination{CurrentPage: page, PageSize: 2}}
		switch keyword {
		case "$va:Example Voice$":
			result.Pagination.TotalCount = 3
			if page == 1 {
				result.Works = []kikoeru.Work{
					{ID: 1, SourceID: "RJ00000001", Title: "Example Work 1"},
					{ID: 2, SourceID: "RJ00000002", Title: "Example Work 2"},
				}
			} else if page == 2 {
				result.Works = []kikoeru.Work{{ID: 3, SourceID: "RJ00000003", Title: "Example Work 3"}}
			}
		case "$va:Confirmed Alias$":
			result.Pagination.TotalCount = 2
			result.Works = []kikoeru.Work{
				{ID: 2, SourceID: "RJ00000002", Title: "Example Work 2"},
				{ID: 3, SourceID: "RJ00000003", Title: "Example Work 3"},
			}
		default:
			http.NotFound(w, request)
			return
		}
		_ = json.NewEncoder(w).Encode(result)
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{query: "INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')"},
		{query: "INSERT INTO person_alias (person_id, alias, source) VALUES (1, 'Confirmed Alias', 'manual')"},
		{query: "INSERT INTO file_source (id, code, display_name, source_type, priority, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 10, 1)"},
		{query: "INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (11, ?, ?)", args: []any{remote.URL, remote.URL}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}

	server := NewServer(db, config.Config{})
	queries, err := server.voiceCatalogQueries(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(queries, "|") != "Example Voice|Confirmed Alias" {
		t.Fatalf("queries = %v, want display name followed by confirmed alias", queries)
	}
	sources, err := server.loadRemoteSourcesForAvailability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	result := server.discoverVoiceCatalogSource(context.Background(), 0, sources[0], queries, server.remoteCatalogProjector(context.Background()))
	if !result.Complete || result.Status.Pages != 3 || result.Status.Matches != 3 || len(result.Candidates) != 3 {
		t.Fatalf("discovery = %+v, want three canonical works across three fetched pages", result)
	}
	if _, err := server.persistVoiceCatalogSource(context.Background(), 1, 1, result); err != nil {
		t.Fatal(err)
	}
	var catalogCount, workCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = 1").Scan(&catalogCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM work").Scan(&workCount); err != nil {
		t.Fatal(err)
	}
	if catalogCount != 3 || workCount != 0 {
		t.Fatalf("catalog count = %d, work count = %d; want catalog-only discoveries", catalogCount, workCount)
	}
	var providerCode string
	if err := db.QueryRow(`
		SELECT provider.code
		FROM voice_catalog_source AS source
		INNER JOIN metadata_provider AS provider ON provider.id = source.provider_id
		LIMIT 1
	`).Scan(&providerCode); err != nil {
		t.Fatal(err)
	}
	if providerCode != "kikoeru_source_example_remote" {
		t.Fatalf("catalog provider = %q, want source-derived metadata provider", providerCode)
	}
	mu.Lock()
	defer mu.Unlock()
	wantRequests := []string{"$va:Example Voice$:1", "$va:Example Voice$:2", "$va:Confirmed Alias$:1"}
	if strings.Join(requests, "|") != strings.Join(wantRequests, "|") {
		t.Fatalf("requests = %v, want %v", requests, wantRequests)
	}
}

func TestVoiceCatalogFailedSourcePreservesRowsAndCompleteSourceMarksMissing(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	source := remoteSourceForUse{ID: 11, Code: "example_remote", DisplayName: "Example Remote", Enabled: true, SourceType: sourceTypeKikoeruCompatible}
	initial := voiceCatalogSourceResult{
		Source:   source,
		Complete: true,
		Candidates: []voiceCatalogCandidate{{
			CanonicalCode: "RJ00000004",
			RemoteCode:    "RJ00000004",
			Projection:    remoteCatalogWorkProjection{RemoteID: "4", RemoteCode: "RJ00000004", Title: "Example Work 4", Tags: []string{}, VoiceActors: []string{}},
			RawJSON:       "{}",
		}},
	}
	if _, err := server.persistVoiceCatalogSource(context.Background(), 1, 1, initial); err != nil {
		t.Fatal(err)
	}
	if _, err := server.persistVoiceCatalogSource(context.Background(), 1, 2, voiceCatalogSourceResult{Source: source}); err != nil {
		t.Fatal(err)
	}
	var availability string
	if err := db.QueryRow("SELECT availability FROM voice_catalog_source").Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "available" {
		t.Fatalf("availability after failed refresh = %q, want preserved available observation", availability)
	}
	if _, err := server.persistVoiceCatalogSource(context.Background(), 1, 3, voiceCatalogSourceResult{Source: source, Complete: true}); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT availability FROM voice_catalog_source").Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "not_found" {
		t.Fatalf("availability after complete empty refresh = %q, want not_found", availability)
	}
	if _, err := db.Exec("UPDATE file_source SET enabled = 0 WHERE id = 11"); err != nil {
		t.Fatal(err)
	}
	matches, err := server.loadVoiceCatalogMatches(context.Background(), 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(matches) != 1 || matches[0].Status != "disabled" || len(matches[0].Works) != 1 || matches[0].Works[0].Availability != "disabled" {
		t.Fatalf("disabled source projection = %+v, want visible catalog row without an available action target", matches)
	}
}

func TestVoiceCatalogCanonicalizesMetadataOnlyWorkAlias(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`
		INSERT INTO person (id, display_name) VALUES (1, 'Example Voice');
		INSERT INTO work (id, primary_code, title) VALUES (10, 'RJ00000010', 'Canonical Work');
		INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (10, 10, 'RJ00000010');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical)
		VALUES (10, 10, 'RJ00000010', 'RJ00000010', 1);
		INSERT INTO work_code_alias (logical_work_id, provider_id, primary_code, relationship_kind)
		VALUES (10, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'RJ00000011', 'provider_declared');
		INSERT INTO file_source (id, code, display_name, source_type, enabled)
		VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1);
	`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	projector := server.remoteCatalogProjector(context.Background())
	origin, ok, err := server.voiceCatalogCandidate(context.Background(), 11, kikoeru.Work{ID: 10, SourceID: "RJ00000010", Title: "Canonical Work"}, projector)
	if err != nil || !ok {
		t.Fatalf("origin candidate = %+v, %t, %v", origin, ok, err)
	}
	alias, ok, err := server.voiceCatalogCandidate(context.Background(), 11, kikoeru.Work{ID: 11, SourceID: "RJ00000011", Title: "Alias Work"}, projector)
	if err != nil || !ok {
		t.Fatalf("alias candidate = %+v, %t, %v", alias, ok, err)
	}
	if alias.CanonicalCode != "RJ00000010" || alias.WorkID != 10 {
		t.Fatalf("alias candidate = %+v, want canonical work identity", alias)
	}
	result := voiceCatalogSourceResult{
		Source:     remoteSourceForUse{ID: 11, Code: "example_remote", DisplayName: "Example Remote", Enabled: true, SourceType: sourceTypeKikoeruCompatible},
		Candidates: []voiceCatalogCandidate{origin, alias},
		Complete:   true,
	}
	if _, err := server.persistVoiceCatalogSource(context.Background(), 1, 1, result); err != nil {
		t.Fatal(err)
	}
	var itemCount, observationCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = 1").Scan(&itemCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM voice_catalog_source").Scan(&observationCount); err != nil {
		t.Fatal(err)
	}
	if itemCount != 1 || observationCount != 2 {
		t.Fatalf("catalog items = %d, source observations = %d; want one identity with both remote codes", itemCount, observationCount)
	}
}

func TestVoiceCatalogReadIsSideEffectFreeAndRefreshEnqueueIsIdempotent(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec("INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/voices/1/remote-matches?refresh=true", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("GET status = %d, body = %s", response.Code, response.Body.String())
	}
	var runCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", voiceCatalogRefreshWorkflow).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 0 {
		t.Fatalf("GET created %d workflow runs, want none", runCount)
	}

	first, err := server.ensureVoiceCatalogRefresh(context.Background(), 1, false)
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.ensureVoiceCatalogRefresh(context.Background(), 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if first.RunID == 0 || second.RunID != first.RunID {
		t.Fatalf("refresh runs = %d then %d, want one reused run", first.RunID, second.RunID)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", voiceCatalogRefreshWorkflow).Scan(&runCount); err != nil {
		t.Fatal(err)
	}
	if runCount != 1 {
		t.Fatalf("refresh created %d workflow runs, want one", runCount)
	}
}

func TestVoiceCatalogTransientFailureUsesBoundedWorkflowRetry(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "temporary failure", http.StatusServiceUnavailable)
	}))
	defer remote.Close()
	db := openMigratedTestDB(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{query: "INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')"},
		{query: "INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)"},
		{query: "INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (11, ?, ?)", args: []any{remote.URL, remote.URL}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	refresh, err := server.ensureVoiceCatalogRefresh(context.Background(), 1, false)
	if err != nil {
		t.Fatal(err)
	}
	if err := server.runNextQueuedWorkflowJob(context.Background(), "voice-catalog-test"); err != nil {
		t.Fatal(err)
	}
	var status string
	var retryCount, maxRetries int
	if err := db.QueryRow(`
		SELECT status, retry_count, max_retries
		FROM workflow_job
		WHERE workflow_run_id = ? AND worker_type = ?
	`, refresh.RunID, voiceCatalogRefreshWorker).Scan(&status, &retryCount, &maxRetries); err != nil {
		t.Fatal(err)
	}
	if status != "queued" || retryCount != 1 || maxRetries != 3 {
		t.Fatalf("retry job status = %q, retries = %d/%d; want one bounded retry", status, retryCount, maxRetries)
	}
}

func TestVoiceCatalogWorkerDoesNotOverwriteManualCancellation(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec("INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	refresh, err := server.ensureVoiceCatalogRefresh(context.Background(), 1, false)
	if err != nil {
		t.Fatal(err)
	}
	job, claimed, err := server.claimNextQueuedWorkflowJob(context.Background(), "voice-catalog-test")
	if err != nil || !claimed {
		t.Fatalf("claim = %t, %v", claimed, err)
	}
	if _, err := db.Exec("UPDATE workflow_run SET status = 'cancelled' WHERE id = ?", refresh.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec("UPDATE workflow_job SET status = 'cancelled' WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if err := server.executeVoiceCatalogRefreshJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	var runStatus, refreshStatus string
	if err := db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", refresh.RunID).Scan(&runStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT last_status FROM voice_catalog_refresh_state WHERE person_id = 1").Scan(&refreshStatus); err != nil {
		t.Fatal(err)
	}
	if runStatus != "cancelled" || refreshStatus != "cancelled" {
		t.Fatalf("run status = %q, catalog status = %q; want cancellation preserved", runStatus, refreshStatus)
	}
}

func TestVoiceCatalogContributesToSummaryAndLatestWorkWithoutCredit(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO person (id, display_name) VALUES (1, 'Example Voice')",
		"INSERT INTO metadata_provider (id, code, display_name) VALUES (11, 'kikoeru_source_example_remote', 'Example Remote')",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)",
		"INSERT INTO voice_catalog_item (id, person_id, primary_code, title, release_date, cover_url) VALUES (21, 1, 'RJ00000006', 'Example Work 6', '2026-06-01', 'https://example.invalid/cover.jpg')",
		"INSERT INTO voice_catalog_source (catalog_item_id, provider_id, remote_code, availability) VALUES (21, 11, 'RJ00000006', 'available')",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	summaries, err := (&Server{db: db}).loadVoiceSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(summaries) != 1 {
		t.Fatalf("summaries = %+v, want catalog-only voice actor", summaries)
	}
	item := summaries[0]
	if item.KnownWorks != 1 || item.RemoteWorks != 1 || item.PlayableWorks != 1 || item.LocalWorks != 0 {
		t.Fatalf("summary = %+v, want one remote catalog work", item)
	}
	if item.LatestWork == nil || item.LatestWork.PrimaryCode != "RJ00000006" || item.LatestWork.CoverURL != "https://example.invalid/cover.jpg" {
		t.Fatalf("latest work = %+v, want persisted catalog projection and cover", item.LatestWork)
	}
	demoSummaries, err := (&Server{db: db, cfg: config.Config{Mode: config.ModeDemo}}).loadVoiceSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(demoSummaries) != 0 {
		t.Fatalf("Demo summaries = %+v, want catalog-only private rows filtered", demoSummaries)
	}
}

func TestVoiceMergeAndUndoPreserveCatalogOwnership(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, statement := range []string{
		"INSERT INTO person (id, display_name) VALUES (1, 'Target Voice'), (2, 'Source Voice')",
		"INSERT INTO metadata_provider (id, code, display_name) VALUES (11, 'kikoeru_source_example_remote', 'Example Remote')",
		"INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)",
		"INSERT INTO voice_catalog_item (id, person_id, primary_code, title) VALUES (21, 1, 'RJ00000007', 'Target Work'), (22, 2, 'RJ00000008', 'Source Work'), (23, 1, 'RJ00000009', 'Shared Target Work'), (24, 2, 'RJ00000009', 'Shared Source Work')",
		"INSERT INTO voice_catalog_source (catalog_item_id, provider_id, remote_code, availability) VALUES (21, 11, 'RJ00000007', 'available'), (22, 11, 'RJ00000008', 'available'), (23, 11, 'RJ00000009', 'available'), (24, 11, 'RJ00000012', 'available')",
		"INSERT INTO voice_catalog_refresh_state (person_id, generation, query_json, last_status, complete, catalog_works) VALUES (1, 1, '[\"Target Voice\"]', 'succeeded', 1, 2), (2, 2, '[\"Source Voice\"]', 'partial', 0, 2)",
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	merged, err := server.mergeVoicePeople(context.Background(), 1, 2)
	if err != nil {
		t.Fatal(err)
	}
	mergeID, ok := merged["mergeId"].(int64)
	if !ok || mergeID <= 0 {
		t.Fatalf("merge result = %+v, want merge id", merged)
	}
	var targetCatalogCount, sourcePersonCount int
	var targetStatus string
	if err := db.QueryRow("SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = 1").Scan(&targetCatalogCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM person WHERE id = 2").Scan(&sourcePersonCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT last_status FROM voice_catalog_refresh_state WHERE person_id = 1").Scan(&targetStatus); err != nil {
		t.Fatal(err)
	}
	var sharedObservationCount int
	if err := db.QueryRow(`
		SELECT COUNT(*)
		FROM voice_catalog_source AS source
		INNER JOIN voice_catalog_item AS item ON item.id = source.catalog_item_id
		WHERE item.person_id = 1 AND item.primary_code = 'RJ00000009'
	`).Scan(&sharedObservationCount); err != nil {
		t.Fatal(err)
	}
	if targetCatalogCount != 3 || sourcePersonCount != 0 || targetStatus != "stale" || sharedObservationCount != 2 {
		t.Fatalf("merged catalog count = %d, source people = %d, status = %q", targetCatalogCount, sourcePersonCount, targetStatus)
	}
	if _, err := server.undoVoiceMerge(context.Background(), 1, mergeID); err != nil {
		t.Fatal(err)
	}
	var targetCode, sourceCode, sourceStatus string
	if err := db.QueryRow("SELECT primary_code FROM voice_catalog_item WHERE person_id = 1 ORDER BY primary_code LIMIT 1").Scan(&targetCode); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT primary_code FROM voice_catalog_item WHERE person_id = 2 ORDER BY primary_code LIMIT 1").Scan(&sourceCode); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT last_status FROM voice_catalog_refresh_state WHERE person_id = 1").Scan(&targetStatus); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT last_status FROM voice_catalog_refresh_state WHERE person_id = 2").Scan(&sourceStatus); err != nil {
		t.Fatal(err)
	}
	var restoredTargetCount, restoredSourceCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = 1").Scan(&restoredTargetCount); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = 2").Scan(&restoredSourceCount); err != nil {
		t.Fatal(err)
	}
	if targetCode != "RJ00000007" || sourceCode != "RJ00000008" || targetStatus != "succeeded" || sourceStatus != "partial" || restoredTargetCount != 2 || restoredSourceCount != 2 {
		t.Fatalf("undo restored target %q/%q and source %q/%q", targetCode, targetStatus, sourceCode, sourceStatus)
	}
}

func TestVoiceCatalogSearchKeywordRemovesQuerySyntax(t *testing.T) {
	if keyword := voiceCatalogSearchKeyword(" Example$ Voice\n$tag:private$ "); keyword != "$va:Example Voice tag:private$" {
		t.Fatalf("keyword = %q, want sanitized voice-only query", keyword)
	}
}

func TestVoiceCatalogRefreshReasonRetriesOnlyIncompleteCatalog(t *testing.T) {
	now := time.Now().UTC()
	incomplete := voiceCatalogRefreshState{
		exists: true, LastStatus: "partial", Complete: false,
		LastAttemptAt: now.Add(-voiceCatalogRetryDelay - time.Minute).Format(time.RFC3339),
		LastSuccessAt: now.Add(-time.Hour).Format(time.RFC3339), Queries: []string{"Example Voice"},
	}
	if reason, due := voiceCatalogRefreshReason(incomplete, []string{"Example Voice"}, false, now); !due || reason != "previous refresh did not complete" {
		t.Fatalf("incomplete refresh reason = %q, due = %t", reason, due)
	}
	metadataPartial := incomplete
	metadataPartial.Complete = true
	if reason, due := voiceCatalogRefreshReason(metadataPartial, []string{"Example Voice"}, false, now); due || reason != "catalog is fresh" {
		t.Fatalf("complete catalog with metadata failure reason = %q, due = %t", reason, due)
	}
}

func TestVoiceCatalogDiscoveryHonorsCancellation(t *testing.T) {
	started := make(chan struct{})
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		close(started)
		<-request.Context().Done()
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	for _, statement := range []struct {
		query string
		args  []any
	}{
		{query: "INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)"},
		{query: "INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (11, ?, ?)", args: []any{remote.URL, remote.URL}},
	} {
		if _, err := db.Exec(statement.query, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	server := NewServer(db, config.Config{})
	sources, err := server.loadRemoteSourcesForAvailability(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan voiceCatalogSourceResult, 1)
	go func() {
		result <- server.discoverVoiceCatalogSource(ctx, 0, sources[0], []string{"Example Voice"}, server.remoteCatalogProjector(ctx))
	}()
	select {
	case <-started:
		cancel()
	case <-time.After(2 * time.Second):
		t.Fatal("remote catalog request did not start")
	}
	select {
	case discovery := <-result:
		if discovery.Complete || discovery.Status.Status != "error" {
			t.Fatalf("cancelled discovery = %+v, want incomplete error status", discovery)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("remote catalog discovery did not stop after cancellation")
	}
}
