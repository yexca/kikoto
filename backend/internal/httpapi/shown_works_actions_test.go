package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

// failingFamilySyncer fails the listed codes and syncs the rest as the fake
// family syncer does.
type failingFamilySyncer struct {
	fakeFamilySyncer
	failing map[string]bool
}

func (syncer *failingFamilySyncer) SyncFamily(ctx context.Context, code string) (metasync.DLsiteFamilySyncResult, error) {
	if syncer.failing[code] {
		syncer.calls = append(syncer.calls, code)
		return metasync.DLsiteFamilySyncResult{RequestedCode: code}, errors.New("example upstream failure")
	}
	return syncer.fakeFamilySyncer.SyncFamily(ctx, code)
}

func (env subscriptionTestEnv) shownWorksAction(t *testing.T, userID int64, target string, body any, handler func(http.ResponseWriter, *http.Request), pathValues ...string) (int, shownWorksActionResult) {
	t.Helper()
	response := env.request(t, userID, http.MethodPost, target, body, handler, pathValues...)
	var result shownWorksActionResult
	if response.Code < 300 {
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
	}
	return response.Code, result
}

func (env subscriptionTestEnv) rankingAction(t *testing.T, userID int64, list rankingList, snapshotID int64, handler func(http.ResponseWriter, *http.Request)) (int, shownWorksActionResult) {
	t.Helper()
	id := strconv.FormatInt(list.ID, 10)
	return env.shownWorksAction(t, userID, "/api/rankings/"+id+"/action", map[string]int64{"snapshotId": snapshotID}, handler, "id", id)
}

func (env subscriptionTestEnv) claimShownWorksJob(t *testing.T, workerType string) workflowJobRecord {
	t.Helper()
	job, ok, err := env.server.claimNextQueuedWorkflowJob(context.Background(), "shown-works-test-runner")
	if err != nil || !ok || job.WorkerType != workerType {
		t.Fatalf("claim = %+v %v %v", job, ok, err)
	}
	return job
}

func (env subscriptionTestEnv) runSummary(t *testing.T, runID int64) (string, map[string]any) {
	t.Helper()
	var status, raw string
	if err := env.db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", runID).Scan(&status, &raw); err != nil {
		t.Fatal(err)
	}
	summary := map[string]any{}
	if err := json.Unmarshal([]byte(raw), &summary); err != nil {
		t.Fatal(err)
	}
	return status, summary
}

func (env subscriptionTestEnv) queuedCodes(t *testing.T, runID int64) string {
	t.Helper()
	return env.scalar(t, "SELECT GROUP_CONCAT(value) FROM workflow_run, json_each(workflow_run.input_json, '$.codes') WHERE workflow_run.id = ?", runID).String
}

func TestRankingMetadataSyncTakesTheShownOrderWhenAsked(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	contributor := env.addUser(t, "ranking-contributor", "contributor")
	now := time.Now().UTC().Truncate(time.Second)
	day := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	week := env.addRankingList(t, rankingProviderDLsite, nil, "week", true)
	env.record(t, day, rankingItems("RJ00000010", "RJ00000011", "RJ00000012", "RJ00000013", "RJ00000014"), now)
	env.record(t, week, rankingItems("RJ00000015"), now)
	if works := env.scalar(t, "SELECT COUNT(*) FROM work"); works.String != "0" {
		t.Fatalf("a pull created %s works", works.String)
	}
	// RJ00000011 was synced an hour ago, RJ00000012 long ago, and DLsite
	// does not list RJ00000013.
	env.exec(t, `INSERT INTO work (id, primary_code, title) VALUES
			(11, 'RJ00000011', 'Example Work 11'), (12, 'RJ00000012', 'Example Work 12'), (13, 'RJ00000013', 'Example Work 13')`,
		`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json, fetched_at)
			SELECT 11, id, 'RJ00000011', '{}', datetime('now', '-1 hour') FROM metadata_provider WHERE code = 'dlsite'`,
		`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json, fetched_at)
			SELECT 12, id, 'RJ00000012', '{}', '2020-01-01 00:00:00' FROM metadata_provider WHERE code = 'dlsite'`,
		`INSERT INTO work_metadata_provider_state (work_id, provider_id, status)
			SELECT 13, id, 'not_found' FROM metadata_provider WHERE code = 'dlsite'`)
	shown := env.rankingPage(t, env.adminID, day, nil).Snapshot.ID
	other := env.rankingPage(t, env.adminID, week, nil).Snapshot.ID

	if code, _ := env.rankingAction(t, contributor, day, shown, env.server.createRankingMetadataSyncRun); code != http.StatusForbidden {
		t.Fatalf("contributor sync = %d", code)
	}
	if code, _ := env.rankingAction(t, env.adminID, day, other, env.server.createRankingMetadataSyncRun); code != http.StatusNotFound {
		t.Fatalf("another list's order = %d", code)
	}
	code, queued := env.rankingAction(t, env.adminID, day, shown, env.server.createRankingMetadataSyncRun)
	if code != http.StatusAccepted || queued.RunID <= 0 || queued.Queued != 3 || queued.Skipped != 2 {
		t.Fatalf("sync = %d %+v", code, queued)
	}
	if code, again := env.rankingAction(t, env.adminID, day, shown, env.server.createRankingMetadataSyncRun); code != http.StatusOK || !again.Existing || again.RunID != queued.RunID {
		t.Fatalf("repeated sync = %d %+v", code, again)
	}

	syncer := &failingFamilySyncer{
		fakeFamilySyncer: fakeFamilySyncer{db: env.db, works: map[string]fakeFamilyWork{
			"RJ00000010": {releaseDate: "2026-10-01", family: "RJ00000010", canonical: true},
		}},
		failing: map[string]bool{"RJ00000014": true},
	}
	job := env.claimShownWorksJob(t, shownWorksMetadataSyncWorkflowCode)
	if err := env.server.runShownWorksMetadataSync(context.Background(), job, syncer); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(syncer.calls, ","); got != "RJ00000010,RJ00000012,RJ00000014" {
		t.Fatalf("synced codes = %s", got)
	}
	status, summary := env.runSummary(t, queued.RunID)
	if status != "partial" || summary["synced"] != float64(2) || summary["failed"] != float64(1) {
		t.Fatalf("run = %s %v", status, summary)
	}

	// The new work shows its metadata, but neither it nor the other works
	// without files count as in the library.
	env.exec(t, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (11, 1, 'local', 'available')`)
	page := env.rankingPage(t, env.adminID, day, nil)
	inLibrary := []string{}
	for _, item := range page.Items {
		if item.Code == "RJ00000010" && (item.Work == nil || item.Work.Title != "Example Work 10") {
			t.Fatalf("synced entry = %+v", item)
		}
		if item.InLibrary {
			inLibrary = append(inLibrary, item.Code)
		}
	}
	if strings.Join(inLibrary, ",") != "RJ00000011" || page.Counts.NotInLibrary != 4 {
		t.Fatalf("in library = %v, not in library = %d", inLibrary, page.Counts.NotInLibrary)
	}

	// Once every entry is fresh or settled, a press queues nothing.
	env.exec(t, `INSERT INTO work (primary_code, title) VALUES ('RJ00000014', 'Example Work 14')`,
		`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
			SELECT work.id, provider.id, work.primary_code, '{}' FROM work, metadata_provider AS provider
			WHERE provider.code = 'dlsite' AND work.primary_code IN ('RJ00000010', 'RJ00000012', 'RJ00000014')`)
	if code, fresh := env.rankingAction(t, env.adminID, day, shown, env.server.createRankingMetadataSyncRun); code != http.StatusOK || fresh.RunID != 0 || fresh.Queued != 0 || fresh.Skipped != 5 {
		t.Fatalf("fresh order = %d %+v", code, fresh)
	}
}

func TestShownWorksSourceCheckAsksOnlyAboutWorksNotKnownAvailable(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case r.URL.Path == "/api/workInfo/RJ00000020", r.URL.Path == "/api/workInfo/RJ00000021":
			code := strings.TrimPrefix(r.URL.Path, "/api/workInfo/")
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 20, SourceID: code, Title: "Example Work " + code[len(code)-2:]})
		case strings.HasPrefix(r.URL.Path, "/api/search/") || r.URL.Path == "/api/works":
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{}, Pagination: kikoeru.Pagination{PageSize: 100, TotalCount: 0}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	env := newSubscriptionTestEnv(t)
	viewer := env.addUser(t, "ranking-viewer", "user")
	contributor := env.addUser(t, "ranking-contributor", "contributor")
	day := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	env.record(t, day, rankingItems("RJ00000020", "RJ00000021", "RJ00000022", "RJ00000023", "RJ00000024"), time.Now().UTC())
	// RJ00000023 has local files and the source was asked about RJ00000024
	// an hour ago, so neither needs a check.
	env.exec(t, `INSERT INTO work (id, primary_code, title) VALUES
			(20, 'RJ00000020', 'Example Work 20'), (23, 'RJ00000023', 'Example Work 23'), (24, 'RJ00000024', 'Example Work 24')`,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (23, 1, 'local', 'available')`)
	shown := env.rankingPage(t, env.adminID, day, nil).Snapshot.ID

	if code, _ := env.rankingAction(t, contributor, day, shown, env.server.createRankingSourceCheckRun); code != http.StatusConflict {
		t.Fatalf("check without a source = %d", code)
	}
	env.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled)
			VALUES (11, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`,
		`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (11, '`+remote.URL+`', '`+remote.URL+`')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability, last_checked_at)
			VALUES (24, 11, 'source', 'missing', datetime('now', '-1 hour'))`)
	if code, _ := env.rankingAction(t, viewer, day, shown, env.server.createRankingSourceCheckRun); code != http.StatusForbidden {
		t.Fatalf("viewer check = %d", code)
	}
	code, queued := env.rankingAction(t, contributor, day, shown, env.server.createRankingSourceCheckRun)
	if code != http.StatusAccepted || queued.Queued != 3 || queued.Skipped != 2 || env.queuedCodes(t, queued.RunID) != "RJ00000020,RJ00000021,RJ00000022" {
		t.Fatalf("check = %d %+v %s", code, queued, env.queuedCodes(t, queued.RunID))
	}
	job := env.claimShownWorksJob(t, shownWorksSourceCheckWorkflowCode)
	if err := env.server.executeShownWorksSourceCheckJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}

	status, summary := env.runSummary(t, queued.RunID)
	if status != "succeeded" || summary["available"] != float64(2) || summary["missing"] != float64(1) {
		t.Fatalf("run = %s %v", status, summary)
	}
	answers := map[string]string{}
	for _, raw := range summary["results"].([]any) {
		result := raw.(map[string]any)
		switch {
		case len(result["available"].([]any)) > 0:
			answers[result["code"].(string)] = "available"
		case len(result["missing"].([]any)) > 0:
			answers[result["code"].(string)] = "missing"
		}
	}
	if answers["RJ00000020"] != "available" || answers["RJ00000021"] != "available" || answers["RJ00000022"] != "missing" {
		t.Fatalf("answers = %v", answers)
	}
	// Only the code with a work keeps a presence; the check creates no work.
	if presence := env.scalar(t, "SELECT GROUP_CONCAT(work_id || ':' || availability) FROM work_source_presence WHERE file_source_id = 11 AND work_id <> 24"); presence.String != "20:available" {
		t.Fatalf("presence = %v", presence)
	}
	if works := env.scalar(t, "SELECT COUNT(*) FROM work"); works.String != "3" {
		t.Fatalf("works after the check = %s", works.String)
	}
	// A work now known to be on a source is not asked about again.
	if code, again := env.rankingAction(t, contributor, day, shown, env.server.createRankingSourceCheckRun); code != http.StatusAccepted || env.queuedCodes(t, again.RunID) != "RJ00000021,RJ00000022" {
		t.Fatalf("second check = %d %+v %s", code, again, env.queuedCodes(t, again.RunID))
	}
}

func TestReleaseFeedActionsTakeTheAccountsShownPage(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	otherID := insertWorkflowGraphAPIUser(t, env.db, "subscriber-two")
	admin := strconv.FormatInt(env.adminID, 10)
	other := strconv.FormatInt(otherID, 10)
	// Six days with a release each: a page of five days leaves the oldest on
	// the second page.
	for day := range 6 {
		env.exec(t, `INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind, created_at)
			VALUES (`+admin+`, 'RJ0000004`+strconv.Itoa(day)+`', 'released', 'circle', datetime('now', '-`+strconv.Itoa(day)+` days'))`)
	}
	env.exec(t, `INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind) VALUES (`+other+`, 'RJ00000049', 'released', 'circle')`)
	feedAction := func(userID int64, body any) (int, shownWorksActionResult) {
		return env.shownWorksAction(t, userID, "/api/subscriptions/feed/metadata-sync", body, env.server.createReleaseFeedMetadataSyncRun)
	}

	// Another account's feed is never read.
	code, first := feedAction(env.adminID, map[string]int{"page": 1, "days": 5})
	if code != http.StatusAccepted || env.queuedCodes(t, first.RunID) != "RJ00000040,RJ00000041,RJ00000042,RJ00000043,RJ00000044" {
		t.Fatalf("first page = %d %+v %s", code, first, env.queuedCodes(t, first.RunID))
	}
	if code, again := feedAction(env.adminID, map[string]int{"page": 1, "days": 5}); code != http.StatusOK || again.RunID != first.RunID {
		t.Fatalf("repeated page = %d %+v", code, again)
	}
	if code, second := feedAction(env.adminID, map[string]int{"page": 2, "days": 5}); code != http.StatusAccepted || env.queuedCodes(t, second.RunID) != "RJ00000045" {
		t.Fatalf("second page = %d %+v", code, second)
	}
	if code, _ := feedAction(env.addUser(t, "feed-contributor", "contributor"), map[string]int{"page": 1}); code != http.StatusForbidden {
		t.Fatalf("contributor sync = %d", code)
	}
	if code, _ := env.shownWorksAction(t, env.adminID, "/api/subscriptions/feed/source-check", map[string]int{"page": 1}, env.server.createReleaseFeedSourceCheckRun); code != http.StatusConflict {
		t.Fatalf("feed check without a source = %d", code)
	}

	demo := subscriptionTestEnv{db: env.db, server: NewServer(env.db, config.Config{Mode: config.ModeDemo}), adminID: env.adminID}
	if code, _ := demo.shownWorksAction(t, env.adminID, "/api/subscriptions/feed/metadata-sync", map[string]int{"page": 1}, demo.server.createReleaseFeedMetadataSyncRun); code != http.StatusForbidden {
		t.Fatalf("demo feed sync = %d", code)
	}
}

func TestRankingAndFeedStateWatchedCodesToWatchAccounts(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	viewer := env.addUser(t, "ranking-viewer", "user")
	day := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	env.record(t, day, rankingItems("RJ00000030", "RJ00000031", "RJ00000032"), time.Now().UTC())
	// RJ00000033 is a translation of RJ00000032; watching it watches the family.
	for code, canonical := range map[string]bool{"RJ00000032": true, "RJ00000033": false} {
		if err := insertFakeFamilyWork(context.Background(), env.db, code, fakeFamilyWork{family: "RJ00000032", canonical: canonical}); err != nil {
			t.Fatal(err)
		}
	}
	if err := env.server.persistAvailabilityWatchTargets(context.Background(), env.adminID, []string{"RJ00000031", "RJ00000033"}, false); err != nil {
		t.Fatal(err)
	}
	env.exec(t, `INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind) VALUES
		(`+strconv.FormatInt(env.adminID, 10)+`, 'RJ00000030', 'released', 'circle'),
		(`+strconv.FormatInt(env.adminID, 10)+`, 'RJ00000031', 'released', 'circle'),
		(`+strconv.FormatInt(viewer, 10)+`, 'RJ00000031', 'released', 'circle')`)

	watched := func(page rankingPage) string {
		codes := []string{}
		for _, item := range page.Items {
			if item.Watched {
				codes = append(codes, item.Code)
			}
		}
		return strings.Join(codes, ",")
	}
	if got := watched(env.rankingPage(t, env.adminID, day, nil)); got != "RJ00000031,RJ00000032" {
		t.Fatalf("watched ranking entries = %q", got)
	}
	if got := watched(env.rankingPage(t, viewer, day, nil)); got != "" {
		t.Fatalf("a viewer sees watched entries %q", got)
	}
	feedWatched := func(userID int64) string {
		response := env.request(t, userID, http.MethodGet, "/api/subscriptions/feed", nil, env.server.listReleaseFeed)
		var feed releaseFeedPage
		if err := json.Unmarshal(response.Body.Bytes(), &feed); err != nil || response.Code != http.StatusOK {
			t.Fatalf("feed = %d %s", response.Code, response.Body.String())
		}
		codes := []string{}
		for _, family := range feed.Families {
			if family.Watched {
				codes = append(codes, family.Fallback.Code)
			}
		}
		return strings.Join(codes, ",")
	}
	if got := feedWatched(env.adminID); got != "RJ00000031" {
		t.Fatalf("watched feed families = %q", got)
	}
	if got := feedWatched(viewer); got != "" {
		t.Fatalf("a viewer sees watched families %q", got)
	}
}
