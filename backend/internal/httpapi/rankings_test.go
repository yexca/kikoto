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

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func rankingItems(codes ...string) rankingPull {
	pull := rankingPull{}
	for _, code := range codes {
		pull.Items = append(pull.Items, rankingPulledItem{Code: code, Title: "Example Work " + code[len(code)-2:], Maker: "Example Circle"})
	}
	return pull
}

func (env subscriptionTestEnv) addRankingList(t *testing.T, provider string, sourceID any, period string, enabled bool) rankingList {
	t.Helper()
	result, err := env.db.Exec(`INSERT INTO ranking_list (provider, file_source_id, period, enabled) VALUES (?, ?, ?, ?)`, provider, sourceID, period, enabled)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	list, err := env.server.loadRankingList(context.Background(), env.adminID, id)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func (env subscriptionTestEnv) addUser(t *testing.T, username, role string) int64 {
	t.Helper()
	result, err := env.db.Exec(`INSERT INTO user_account (username, display_name, role) VALUES (?, ?, ?)`, username, username, role)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	return id
}

func (env subscriptionTestEnv) record(t *testing.T, list rankingList, pull rankingPull, at time.Time) rankingListOutcome {
	t.Helper()
	outcome, err := env.server.recordRankingPull(context.Background(), list, 0, pull, at)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func (env subscriptionTestEnv) rankingPage(t *testing.T, userID int64, list rankingList, compare string) rankingPage {
	t.Helper()
	target := "/api/rankings/" + strconv.FormatInt(list.ID, 10)
	if compare != "" {
		target += "?compare=" + compare
	}
	response := env.request(t, userID, http.MethodGet, target, nil, env.server.getRanking, "id", strconv.FormatInt(list.ID, 10))
	if response.Code != http.StatusOK {
		t.Fatalf("ranking page = %d %s", response.Code, response.Body.String())
	}
	var page rankingPage
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	return page
}

func rankingChangeKinds(page rankingPage) string {
	kinds := []string{}
	for _, item := range page.Items {
		kinds = append(kinds, item.Code[len(item.Code)-2:]+":"+item.Change.Kind)
	}
	return strings.Join(kinds, " ")
}

func TestRankingPullsRecordSnapshotsOnlyWhenTheOrderChanges(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	now := time.Now().UTC().Truncate(time.Second)

	first := env.record(t, list, rankingItems("RJ00000001", "RJ00000002", "RJ00000003"), now.Add(-4*time.Hour))
	if !first.Changed || first.New != 3 {
		t.Fatalf("first pull = %+v", first)
	}
	same := env.record(t, list, rankingItems("RJ00000001", "RJ00000002", "RJ00000003"), now.Add(-3*time.Hour))
	if same.Changed || same.New != 0 {
		t.Fatalf("identical pull = %+v", same)
	}
	moved := env.record(t, list, rankingItems("RJ00000002", "RJ00000004", "RJ00000001"), now.Add(-2*time.Hour))
	if !moved.Changed || moved.New != 1 || moved.Dropped != 1 || moved.Reentered != 0 {
		t.Fatalf("changed pull = %+v", moved)
	}
	back := env.record(t, list, rankingItems("RJ00000003", "RJ00000002", "RJ00000001"), now.Add(-time.Hour))
	if back.New != 0 || back.Reentered != 1 || back.Dropped != 1 {
		t.Fatalf("re-entry pull = %+v", back)
	}

	var snapshots int
	if err := env.db.QueryRow("SELECT COUNT(*) FROM ranking_snapshot WHERE ranking_list_id = ?", list.ID).Scan(&snapshots); err != nil {
		t.Fatal(err)
	}
	if snapshots != 3 {
		t.Fatalf("snapshots = %d, want 3 (the identical pull adds none)", snapshots)
	}
	var streak, firstSeen string
	var best, appearances int
	if err := env.db.QueryRow(`
		SELECT streak_started_at, first_seen_at, best_rank, appearances FROM ranking_entry WHERE ranking_list_id = ? AND primary_code = 'RJ00000003'
	`, list.ID).Scan(&streak, &firstSeen, &best, &appearances); err != nil {
		t.Fatal(err)
	}
	if streak != formatWorkflowTimestamp(now.Add(-time.Hour)) || firstSeen != formatWorkflowTimestamp(now.Add(-4*time.Hour)) || best != 1 || appearances != 2 {
		t.Fatalf("re-entered entry streak=%s first=%s best=%d appearances=%d", streak, firstSeen, best, appearances)
	}
	var lastPulled string
	if err := env.db.QueryRow("SELECT last_pulled_at FROM ranking_list WHERE id = ?", list.ID).Scan(&lastPulled); err != nil {
		t.Fatal(err)
	}
	if lastPulled != formatWorkflowTimestamp(now.Add(-time.Hour)) {
		t.Fatalf("last pulled = %s", lastPulled)
	}
	var works int
	if err := env.db.QueryRow("SELECT COUNT(*) FROM work").Scan(&works); err != nil {
		t.Fatal(err)
	}
	if works != 0 {
		t.Fatalf("ranking pulls created %d works", works)
	}
}

func TestRankingPageComparesWithSeenPreviousOrPickedSnapshot(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.addRankingList(t, rankingProviderDLsite, nil, "week", true)
	now := time.Now().UTC().Truncate(time.Second)
	env.record(t, list, rankingItems("RJ00000001", "RJ00000002", "RJ00000003"), now.Add(-3*time.Hour))
	env.record(t, list, rankingItems("RJ00000002", "RJ00000001", "RJ00000004"), now.Add(-2*time.Hour))
	env.record(t, list, rankingItems("RJ00000003", "RJ00000002", "RJ00000005"), now.Add(-time.Hour))
	env.exec(t, `INSERT INTO work (primary_code, title) VALUES ('RJ00000002', 'Example Work 2')`)

	firstVisit := env.rankingPage(t, env.adminID, list, "")
	if firstVisit.Baseline == nil || firstVisit.Baseline.Kind != "previous" {
		t.Fatalf("first visit baseline = %+v", firstVisit.Baseline)
	}
	if got, want := rankingChangeKinds(firstVisit), "03:reentered 02:down 05:new"; got != want {
		t.Fatalf("changes against previous = %q, want %q", got, want)
	}
	if len(firstVisit.Dropped) != 2 || firstVisit.Dropped[0].Code != "RJ00000001" || firstVisit.Dropped[0].PreviousRank != 2 || firstVisit.Dropped[1].Code != "RJ00000004" {
		t.Fatalf("dropped = %+v", firstVisit.Dropped)
	}
	if firstVisit.Counts.NotInLibrary != 2 || firstVisit.Items[1].Work == nil || firstVisit.Items[0].Work != nil {
		t.Fatalf("library state counts=%+v items=%+v", firstVisit.Counts, firstVisit.Items)
	}
	if firstVisit.Items[0].Fallback.Title != "Example Work 03" || firstVisit.Items[0].Fallback.Circle != "Example Circle" {
		t.Fatalf("text card = %+v", firstVisit.Items[0].Fallback)
	}

	oldest := firstVisit.Snapshots[len(firstVisit.Snapshots)-1]
	seen := env.request(t, env.adminID, http.MethodPost, "/api/rankings/x/seen", map[string]int64{"snapshotId": oldest.ID}, env.server.markRankingSeen, "id", strconv.FormatInt(list.ID, 10))
	if seen.Code != http.StatusOK {
		t.Fatalf("seen = %d %s", seen.Code, seen.Body.String())
	}
	sinceVisit := env.rankingPage(t, env.adminID, list, "seen")
	if sinceVisit.Baseline == nil || sinceVisit.Baseline.Kind != "seen" || sinceVisit.Baseline.ID != oldest.ID {
		t.Fatalf("seen baseline = %+v", sinceVisit.Baseline)
	}
	if got, want := rankingChangeKinds(sinceVisit), "03:up 02:same 05:new"; got != want {
		t.Fatalf("changes since the visit = %q, want %q", got, want)
	}
	if sinceVisit.Items[0].Change.From == nil || *sinceVisit.Items[0].Change.From != 3 || sinceVisit.Items[0].Change.Delta != 2 {
		t.Fatalf("moved item = %+v", sinceVisit.Items[0].Change)
	}

	picked := env.rankingPage(t, env.adminID, list, strconv.FormatInt(oldest.ID, 10))
	if picked.Baseline == nil || picked.Baseline.Kind != "snapshot" {
		t.Fatalf("picked baseline = %+v", picked.Baseline)
	}
	invalid := env.request(t, env.adminID, http.MethodGet, "/api/rankings/x?compare=999999", nil, env.server.getRanking, "id", strconv.FormatInt(list.ID, 10))
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("unknown snapshot = %d", invalid.Code)
	}

	// A displayed snapshot older than the stored one leaves the state alone.
	latest := firstVisit.Snapshots[0]
	env.request(t, env.adminID, http.MethodPost, "/api/rankings/x/seen", map[string]int64{"snapshotId": latest.ID}, env.server.markRankingSeen, "id", strconv.FormatInt(list.ID, 10))
	env.request(t, env.adminID, http.MethodPost, "/api/rankings/x/seen", map[string]int64{"snapshotId": oldest.ID}, env.server.markRankingSeen, "id", strconv.FormatInt(list.ID, 10))
	var stored int64
	if err := env.db.QueryRow("SELECT seen_snapshot_id FROM user_ranking_state WHERE user_id = ? AND ranking_list_id = ?", env.adminID, list.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != latest.ID {
		t.Fatalf("seen snapshot = %d, want %d", stored, latest.ID)
	}
	lists, err := env.server.loadRankingLists(context.Background(), env.adminID, "")
	if err != nil || len(lists) != 1 || lists[0].Unseen {
		t.Fatalf("lists after seeing the latest = %+v %v", lists, err)
	}
}

type fakeRankingPuller struct {
	pulls map[int64]rankingPull
	errs  map[int64]error
}

func (puller fakeRankingPuller) pull(_ context.Context, list rankingList) (rankingPull, error) {
	if err := puller.errs[list.ID]; err != nil {
		return rankingPull{}, err
	}
	return puller.pulls[list.ID], nil
}

func TestRankingRefreshRecordsEachListAndKeepsFailuresApart(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	if _, err := env.server.enqueueRankingRefresh(context.Background(), workflowRunTrigger{Type: "manual"}, env.adminID, nil); !errors.Is(err, errRankingNothingToPull) {
		t.Fatalf("refresh without lists = %v", err)
	}
	env.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (7, 'remote_example', 'Example Remote', 'kikoeru_compatible', 0)`)
	day := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	remote := env.addRankingList(t, rankingProviderRemote, 7, "", true)
	env.addRankingList(t, rankingProviderDLsite, nil, "month", false)

	queued, err := env.server.enqueueRankingRefresh(context.Background(), workflowRunTrigger{Type: "manual"}, env.adminID, nil)
	if err != nil {
		t.Fatal(err)
	}
	again, err := env.server.enqueueRankingRefresh(context.Background(), workflowRunTrigger{Type: "manual"}, env.adminID, nil)
	if !errors.Is(err, errRankingRunActive) || again.RunID != queued.RunID {
		t.Fatalf("second refresh = %+v %v", again, err)
	}
	job, ok, err := env.server.claimNextQueuedWorkflowJob(context.Background(), "ranking-test-runner")
	if err != nil || !ok {
		t.Fatalf("claim = %+v %v %v", job, ok, err)
	}
	puller := fakeRankingPuller{
		pulls: map[int64]rankingPull{day.ID: rankingItems("RJ00000010", "RJ00000011")},
		errs:  map[int64]error{remote.ID: errRankingSourceUnavailable},
	}
	if err := env.server.executeRankingRefreshJobWith(context.Background(), job, puller); err != nil {
		t.Fatal(err)
	}
	var status, summary string
	if err := env.db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "partial" || strings.Count(summary, `"listId"`) != 2 {
		t.Fatalf("run = %s %s", status, summary)
	}
	statuses := map[int64]string{}
	rows, err := env.db.Query("SELECT id, last_status FROM ranking_list")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		var listStatus string
		if err := rows.Scan(&id, &listStatus); err != nil {
			t.Fatal(err)
		}
		statuses[id] = listStatus
	}
	_ = rows.Close()
	if statuses[day.ID] != "succeeded" || statuses[remote.ID] != "source_unavailable" || len(statuses) != 3 || statuses[day.ID+2] != "" {
		t.Fatalf("list statuses = %+v", statuses)
	}
}

func TestRemoteRankingPullSkipsCodelessWorksAndProxiesCovers(t *testing.T) {
	remoteServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/recommender/popular" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{
			{ID: 21, SourceID: "RJ00000020", Title: "Example Popular 20", ThumbnailCoverURL: "http://192.0.2.10/covers/20.jpg", Circle: &kikoeru.Circle{Name: "Example Circle"}},
			{ID: 22, Title: "Example without a code"},
			{ID: 23, SourceID: "RJ00000021", Title: "Example Popular 21"},
		}})
	}))
	defer remoteServer.Close()
	env := newSubscriptionTestEnv(t)
	env.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (8, 'remote_example', 'Example Remote', 'kikoeru_compatible', 1)`)
	if _, err := env.db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (8, ?, ?)`, remoteServer.URL, remoteServer.URL); err != nil {
		t.Fatal(err)
	}
	list := env.addRankingList(t, rankingProviderRemote, 8, "", true)
	pull, err := serverRankingPuller{server: env.server}.pull(context.Background(), list)
	if err != nil {
		t.Fatal(err)
	}
	if len(pull.Items) != 2 || pull.SkippedWithoutCode != 1 || pull.Items[0].Maker != "Example Circle" || pull.Items[0].RemoteWorkID != 21 {
		t.Fatalf("pull = %+v", pull)
	}
	env.record(t, list, pull, time.Now().UTC())
	page := env.rankingPage(t, env.adminID, list, "")
	cover := page.Items[0].Fallback.CoverURL
	if !strings.HasPrefix(cover, "/api/remote-sources/8/images/") || strings.Contains(cover, "192.0.2.10") {
		t.Fatalf("cover = %q", cover)
	}

	env.exec(t, `UPDATE file_source SET enabled = 0 WHERE id = 8`)
	if _, err := (serverRankingPuller{server: env.server}).pull(context.Background(), list); !errors.Is(err, errRankingSourceUnavailable) {
		t.Fatalf("disabled source pull = %v", err)
	}
	if page := env.rankingPage(t, env.adminID, list, ""); len(page.Items) != 2 {
		t.Fatalf("the last snapshot of a disabled source = %+v", page.Items)
	}
}

func TestRankingConfigurationNeedsMetadataSync(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	contributor := env.addUser(t, "ranking-contributor", "contributor")
	viewer := env.addUser(t, "ranking-viewer", "user")

	if response := env.request(t, contributor, http.MethodPost, "/api/rankings", map[string]any{"provider": "dlsite", "period": "day"}, env.server.createRanking); response.Code != http.StatusForbidden {
		t.Fatalf("contributor create = %d", response.Code)
	}
	invalid := env.request(t, env.adminID, http.MethodPost, "/api/rankings", map[string]any{"provider": "dlsite", "period": "year"}, env.server.createRanking)
	if invalid.Code != http.StatusBadRequest {
		t.Fatalf("annual list = %d", invalid.Code)
	}
	created := env.request(t, env.adminID, http.MethodPost, "/api/rankings", map[string]any{"provider": "dlsite", "period": "day", "releaseWindow": "30d"}, env.server.createRanking)
	if created.Code != http.StatusCreated {
		t.Fatalf("create = %d %s", created.Code, created.Body.String())
	}
	var body struct {
		List  rankingList `json:"list"`
		RunID int64       `json:"runId"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.RunID <= 0 || body.List.Depth != rankingDefaultDepth {
		t.Fatalf("created = %+v", body)
	}
	duplicate := env.request(t, env.adminID, http.MethodPost, "/api/rankings", map[string]any{"provider": "dlsite", "period": "day", "releaseWindow": "30d"}, env.server.createRanking)
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate = %d", duplicate.Code)
	}
	id := strconv.FormatInt(body.List.ID, 10)
	if response := env.request(t, env.adminID, http.MethodPatch, "/api/rankings/"+id, map[string]any{"enabled": false}, env.server.updateRanking, "id", id); response.Code != http.StatusOK {
		t.Fatalf("disable = %d %s", response.Code, response.Body.String())
	}

	var overview rankingOverview
	listed := env.request(t, viewer, http.MethodGet, "/api/rankings", nil, env.server.listRankings)
	if err := json.Unmarshal(listed.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	if len(overview.Lists) != 0 || overview.Schedule.IntervalHours != rankingDefaultIntervalHours {
		t.Fatalf("viewer overview = %+v", overview)
	}
	if response := env.request(t, viewer, http.MethodGet, "/api/rankings/"+id, nil, env.server.getRanking, "id", id); response.Code != http.StatusNotFound {
		t.Fatalf("viewer disabled list = %d", response.Code)
	}
	if response := env.request(t, viewer, http.MethodPut, "/api/rankings/schedule", map[string]any{"enabled": false}, env.server.updateRankingSchedule); response.Code != http.StatusForbidden {
		t.Fatalf("viewer schedule = %d", response.Code)
	}
	if response := env.request(t, env.adminID, http.MethodDelete, "/api/rankings/"+id, nil, env.server.deleteRanking, "id", id); response.Code != http.StatusOK {
		t.Fatalf("delete = %d", response.Code)
	}
}

func TestRankingScheduleIsEnsuredAndEditedOnlyHere(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	if err := env.server.ensureRankingSchedule(context.Background()); err != nil {
		t.Fatal(err)
	}
	schedule, err := env.server.loadRankingSchedule(context.Background())
	if err != nil || schedule.triggerID == 0 || !schedule.Enabled || schedule.IntervalHours != 24 || schedule.NextRunAt == nil {
		t.Fatalf("ensured schedule = %+v %v", schedule, err)
	}
	updated := env.request(t, env.adminID, http.MethodPut, "/api/rankings/schedule", map[string]any{"intervalHours": 12}, env.server.updateRankingSchedule)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"intervalHours":12`) {
		t.Fatalf("update = %d %s", updated.Code, updated.Body.String())
	}
	if response := env.request(t, env.adminID, http.MethodPut, "/api/rankings/schedule", map[string]any{"intervalHours": 200}, env.server.updateRankingSchedule); response.Code != http.StatusBadRequest {
		t.Fatalf("out of range interval = %d", response.Code)
	}
	// Dispatch without an enabled list records success and creates no run.
	status, _, err := env.server.executeRankingSystemTrigger(context.Background(), workflowTriggerRecord{ID: schedule.triggerID}, "schedule", "scheduled_interval")
	if err != nil || status != "succeeded" {
		t.Fatalf("empty dispatch = %s %v", status, err)
	}
	var runs int
	if err := env.db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", rankingWorkflowCode).Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if runs != 0 {
		t.Fatalf("runs = %d", runs)
	}
}

func TestOldRankingSnapshotCleanupKeepsTheNewestTwo(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	for _, age := range []string{"-200 days", "-150 days", "-120 days", "-100 days", "-1 day"} {
		env.exec(t, `INSERT INTO ranking_snapshot (ranking_list_id, pulled_at, item_count, content_hash) VALUES (`+strconv.FormatInt(list.ID, 10)+`, datetime('now', '`+age+`'), 0, '`+age+`')`)
	}
	stale := env.addRankingList(t, rankingProviderDLsite, nil, "week", true)
	for _, age := range []string{"-300 days", "-200 days"} {
		env.exec(t, `INSERT INTO ranking_snapshot (ranking_list_id, pulled_at, item_count, content_hash) VALUES (`+strconv.FormatInt(stale.ID, 10)+`, datetime('now', '`+age+`'), 0, '`+age+`')`)
	}
	result, err := env.db.Exec(databaseCleanupDeleteQueries[databaseCleanupTaskOldRankings])
	if err != nil {
		t.Fatal(err)
	}
	if removed, _ := result.RowsAffected(); removed != 3 {
		t.Fatalf("removed = %d, want 3", removed)
	}
	var kept []string
	rows, err := env.db.Query("SELECT content_hash FROM ranking_snapshot ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var hash string
		if err := rows.Scan(&hash); err != nil {
			t.Fatal(err)
		}
		kept = append(kept, hash)
	}
	_ = rows.Close()
	if got, want := strings.Join(kept, ","), "-100 days,-1 day,-300 days,-200 days"; got != want {
		t.Fatalf("kept = %s, want %s", got, want)
	}
}
