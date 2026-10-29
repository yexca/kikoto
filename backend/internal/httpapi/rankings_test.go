package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func rankingItems(codes ...string) rankingPull {
	pull := rankingPull{}
	for _, code := range codes {
		pull.Items = append(pull.Items, rankingPulledItem{Code: code, Title: "Example Work " + code[len(code)-2:], Maker: "Example Circle"})
	}
	return pull
}

func (env subscriptionTestEnv) insertRankingList(t *testing.T, statement string, args ...any) rankingList {
	t.Helper()
	result, err := env.db.Exec(statement, args...)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	var provider, period string
	if err := env.db.QueryRow(`SELECT provider, period FROM ranking_list WHERE id = ?`, id).Scan(&provider, &period); err != nil {
		t.Fatal(err)
	}
	tx, err := env.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := ensureRankingVariants(context.Background(), tx, id, provider, period); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	return env.rankingList(t, id)
}

func (env subscriptionTestEnv) addRankingList(t *testing.T, provider string, sourceID any, period string, enabled bool) rankingList {
	t.Helper()
	return env.insertRankingList(t, `INSERT INTO ranking_list (provider, file_source_id, period, enabled) VALUES (?, ?, ?, ?)`, provider, sourceID, period, enabled)
}

func (env subscriptionTestEnv) addAnnualRankingList(t *testing.T, year int, autoRefresh bool) rankingList {
	t.Helper()
	return env.insertRankingList(t, `INSERT INTO ranking_list (provider, period, year, depth, auto_refresh, refresh_interval_minutes)
		VALUES ('dlsite', 'year', ?, 50, ?, 10080)`, year, autoRefresh)
}

func (env subscriptionTestEnv) rankingList(t *testing.T, id int64) rankingList {
	t.Helper()
	list, err := env.server.loadRankingList(context.Background(), env.adminID, id)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func (env subscriptionTestEnv) rankingVariant(t *testing.T, list rankingList, releaseWindow, sort string) rankingVariant {
	t.Helper()
	variant, ok := env.rankingList(t, list.ID).variant(releaseWindow, sort)
	if !ok {
		t.Fatalf("list %d has no %q/%q order", list.ID, releaseWindow, sort)
	}
	return variant
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

func (env subscriptionTestEnv) recordVariant(t *testing.T, variant rankingVariant, pull rankingPull, at time.Time) rankingListOutcome {
	t.Helper()
	outcome, err := env.server.recordRankingPull(context.Background(), variant, 0, pull, at)
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

// record stores a pull of a list's default order and schedules the list as a
// pull whose every order succeeded would.
func (env subscriptionTestEnv) record(t *testing.T, list rankingList, pull rankingPull, at time.Time) rankingListOutcome {
	t.Helper()
	outcome := env.recordVariant(t, env.rankingVariant(t, list, "", ""), pull, at)
	final, err := env.server.recordRankingListPull(context.Background(), env.rankingList(t, list.ID), "succeeded", "", at)
	if err != nil {
		t.Fatal(err)
	}
	outcome.Final = final
	return outcome
}

func (env subscriptionTestEnv) rankingPage(t *testing.T, userID int64, list rankingList, query url.Values) rankingPage {
	t.Helper()
	target := "/api/rankings/" + strconv.FormatInt(list.ID, 10)
	if len(query) > 0 {
		target += "?" + query.Encode()
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

func (env subscriptionTestEnv) rankingTimeline(t *testing.T, list rankingList, query string) rankingTimeline {
	t.Helper()
	response := env.request(t, env.adminID, http.MethodGet, "/api/rankings/x/snapshots?"+query, nil, env.server.listRankingSnapshots, "id", strconv.FormatInt(list.ID, 10))
	var timeline rankingTimeline
	if err := json.Unmarshal(response.Body.Bytes(), &timeline); err != nil || response.Code != http.StatusOK {
		t.Fatalf("timeline %s = %d %s", query, response.Code, response.Body.String())
	}
	return timeline
}

func (env subscriptionTestEnv) markSeen(t *testing.T, list rankingList, snapshotID int64) int {
	t.Helper()
	return env.request(t, env.adminID, http.MethodPost, "/api/rankings/x/seen", map[string]int64{"snapshotId": snapshotID}, env.server.markRankingSeen, "id", strconv.FormatInt(list.ID, 10)).Code
}

func (env subscriptionTestEnv) scalar(t *testing.T, query string, args ...any) sql.NullString {
	t.Helper()
	var value sql.NullString
	if err := env.db.QueryRow(query, args...).Scan(&value); err != nil {
		t.Fatalf("%v\n%s", err, query)
	}
	return value
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
	variant := env.rankingVariant(t, list, "", "")
	now := time.Now().UTC().Truncate(time.Second)

	first := env.recordVariant(t, variant, rankingItems("RJ00000001", "RJ00000002", "RJ00000003"), now.Add(-4*time.Hour))
	if !first.Changed || first.New != 3 {
		t.Fatalf("first pull = %+v", first)
	}
	same := env.recordVariant(t, variant, rankingItems("RJ00000001", "RJ00000002", "RJ00000003"), now.Add(-3*time.Hour))
	if same.Changed || same.New != 0 {
		t.Fatalf("identical pull = %+v", same)
	}
	// An unchanged order moves the snapshot's confirmation instead of adding one.
	if confirmed := env.scalar(t, "SELECT confirmed_until FROM ranking_snapshot WHERE ranking_variant_id = ?", variant.ID); confirmed.String != formatWorkflowTimestamp(now.Add(-3*time.Hour)) {
		t.Fatalf("confirmed until = %v", confirmed)
	}
	moved := env.recordVariant(t, variant, rankingItems("RJ00000002", "RJ00000004", "RJ00000001"), now.Add(-2*time.Hour))
	if !moved.Changed || moved.New != 1 || moved.Dropped != 1 || moved.Reentered != 0 {
		t.Fatalf("changed pull = %+v", moved)
	}
	back := env.recordVariant(t, variant, rankingItems("RJ00000003", "RJ00000002", "RJ00000001"), now.Add(-time.Hour))
	if back.New != 0 || back.Reentered != 1 || back.Dropped != 1 {
		t.Fatalf("re-entry pull = %+v", back)
	}

	if snapshots := env.scalar(t, "SELECT COUNT(*) FROM ranking_snapshot WHERE ranking_variant_id = ?", variant.ID); snapshots.String != "3" {
		t.Fatalf("snapshots = %s, want 3 (the identical pull adds none)", snapshots.String)
	}
	var streak, firstSeen string
	var best, appearances int
	if err := env.db.QueryRow(`
		SELECT streak_started_at, first_seen_at, best_rank, appearances FROM ranking_entry WHERE ranking_variant_id = ? AND primary_code = 'RJ00000003'
	`, variant.ID).Scan(&streak, &firstSeen, &best, &appearances); err != nil {
		t.Fatal(err)
	}
	if streak != formatWorkflowTimestamp(now.Add(-time.Hour)) || firstSeen != formatWorkflowTimestamp(now.Add(-4*time.Hour)) || best != 1 || appearances != 2 {
		t.Fatalf("re-entered entry streak=%s first=%s best=%d appearances=%d", streak, firstSeen, best, appearances)
	}
	if lastPulled := env.scalar(t, "SELECT last_pulled_at FROM ranking_variant WHERE id = ?", variant.ID); lastPulled.String != formatWorkflowTimestamp(now.Add(-time.Hour)) {
		t.Fatalf("last pulled = %v", lastPulled)
	}
	if works := env.scalar(t, "SELECT COUNT(*) FROM work"); works.String != "0" {
		t.Fatalf("ranking pulls created %s works", works.String)
	}
}

func TestRankingPageComparesWithSeenPreviousOrPickedSnapshot(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.addRankingList(t, rankingProviderDLsite, nil, "week", true)
	variant := env.rankingVariant(t, list, "", "")
	now := time.Now().UTC().Truncate(time.Second)
	env.recordVariant(t, variant, rankingItems("RJ00000001", "RJ00000002", "RJ00000003"), now.Add(-3*time.Hour))
	env.recordVariant(t, variant, rankingItems("RJ00000002", "RJ00000001", "RJ00000004"), now.Add(-2*time.Hour))
	env.recordVariant(t, variant, rankingItems("RJ00000003", "RJ00000002", "RJ00000005"), now.Add(-time.Hour))
	env.exec(t, `INSERT INTO work (id, primary_code, title) VALUES (2, 'RJ00000002', 'Example Work 2')`,
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES (2, 1, 'local', 'available')`)

	firstVisit := env.rankingPage(t, env.adminID, list, nil)
	if firstVisit.Variant.ID != variant.ID || firstVisit.Baseline == nil || firstVisit.Baseline.Kind != "previous" || firstVisit.At != nil || firstVisit.Coverage != nil {
		t.Fatalf("first visit variant %+v baseline = %+v, at %v", firstVisit.Variant, firstVisit.Baseline, firstVisit.At)
	}
	if got, want := rankingChangeKinds(firstVisit), "03:reentered 02:down 05:new"; got != want {
		t.Fatalf("changes against previous = %q, want %q", got, want)
	}
	if len(firstVisit.Dropped) != 2 || firstVisit.Dropped[0].Code != "RJ00000001" || firstVisit.Dropped[0].PreviousRank != 2 || firstVisit.Dropped[1].Code != "RJ00000004" {
		t.Fatalf("dropped = %+v", firstVisit.Dropped)
	}
	if firstVisit.Counts.NotInLibrary != 2 || firstVisit.Items[1].Work == nil || !firstVisit.Items[1].InLibrary || firstVisit.Items[0].Work != nil {
		t.Fatalf("library state counts=%+v items=%+v", firstVisit.Counts, firstVisit.Items)
	}
	if firstVisit.Items[0].Fallback.Title != "Example Work 03" || firstVisit.Items[0].Fallback.Circle != "Example Circle" {
		t.Fatalf("text card = %+v", firstVisit.Items[0].Fallback)
	}
	if firstVisit.NextSnapshot != nil || firstVisit.PreviousSnapshot == nil {
		t.Fatalf("latest neighbors = previous %+v next %+v", firstVisit.PreviousSnapshot, firstVisit.NextSnapshot)
	}

	oldestID, _ := strconv.ParseInt(env.scalar(t, "SELECT MIN(id) FROM ranking_snapshot WHERE ranking_variant_id = ?", variant.ID).String, 10, 64)
	if code := env.markSeen(t, list, oldestID); code != http.StatusOK {
		t.Fatalf("seen = %d", code)
	}
	sinceVisit := env.rankingPage(t, env.adminID, list, url.Values{"compare": {"seen"}})
	if sinceVisit.Baseline == nil || sinceVisit.Baseline.Kind != "seen" || sinceVisit.Baseline.ID != oldestID {
		t.Fatalf("seen baseline = %+v", sinceVisit.Baseline)
	}
	if got, want := rankingChangeKinds(sinceVisit), "03:up 02:same 05:new"; got != want {
		t.Fatalf("changes since the visit = %q, want %q", got, want)
	}
	if sinceVisit.Items[0].Change.From == nil || *sinceVisit.Items[0].Change.From != 3 || sinceVisit.Items[0].Change.Delta != 2 {
		t.Fatalf("moved item = %+v", sinceVisit.Items[0].Change)
	}

	picked := env.rankingPage(t, env.adminID, list, url.Values{"compare": {strconv.FormatInt(oldestID, 10)}})
	if picked.Baseline == nil || picked.Baseline.Kind != "snapshot" || picked.Baseline.ID != oldestID {
		t.Fatalf("picked baseline = %+v", picked.Baseline)
	}
	for _, compare := range []string{"999999", "yesterday"} {
		invalid := env.request(t, env.adminID, http.MethodGet, "/api/rankings/x?compare="+compare, nil, env.server.getRanking, "id", strconv.FormatInt(list.ID, 10))
		if invalid.Code != http.StatusBadRequest {
			t.Fatalf("compare %s = %d", compare, invalid.Code)
		}
	}

	// A displayed snapshot older than the stored one leaves the state alone.
	env.markSeen(t, list, firstVisit.Snapshot.ID)
	env.markSeen(t, list, oldestID)
	if stored := env.scalar(t, "SELECT seen_snapshot_id FROM user_ranking_state WHERE user_id = ? AND ranking_variant_id = ?", env.adminID, variant.ID); stored.String != strconv.FormatInt(firstVisit.Snapshot.ID, 10) {
		t.Fatalf("seen snapshot = %v, want %d", stored, firstVisit.Snapshot.ID)
	}
	if seen, _ := env.rankingList(t, list.ID).variant("", ""); seen.Unseen {
		t.Fatalf("variant after seeing the latest = %+v", seen)
	}
}

func TestRankingOrdersKeepTheirOwnHistoryAndSeenState(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.addRankingList(t, rankingProviderDLsite, nil, "week", true)
	annual := env.addAnnualRankingList(t, 2025, false)
	if len(list.Variants) != 4 || len(annual.Variants) != 2 {
		t.Fatalf("orders = week %+v annual %+v", list.Variants, annual.Variants)
	}
	popular := env.rankingVariant(t, list, "", "")
	sales := env.rankingVariant(t, list, "", rankingSortSales)
	newBySales := env.rankingVariant(t, list, rankingReleaseWindow, rankingSortSales)
	now := time.Now().UTC().Truncate(time.Second)
	env.recordVariant(t, popular, rankingItems("RJ00000001", "RJ00000002"), now.Add(-3*time.Hour))
	env.recordVariant(t, popular, rankingItems("RJ00000002", "RJ00000001"), now.Add(-2*time.Hour))
	env.recordVariant(t, sales, rankingItems("RJ00000003", "RJ00000001"), now.Add(-time.Hour))

	salesPage := env.rankingPage(t, env.adminID, list, url.Values{"sort": {"sale"}})
	if salesPage.Variant.ID != sales.ID || salesPage.Snapshot == nil || salesPage.PreviousSnapshot != nil || salesPage.Baseline != nil {
		t.Fatalf("sales page = variant %+v snapshot %+v previous %+v baseline %+v", salesPage.Variant, salesPage.Snapshot, salesPage.PreviousSnapshot, salesPage.Baseline)
	}
	// Statistics belong to the order: the sales order first held RJ00000001 an
	// hour ago, though the popularity order held it before.
	if got := rankingChangeKinds(salesPage); got != "03:same 01:same" || salesPage.Items[1].FirstSeenAt != formatWorkflowTimestamp(now.Add(-time.Hour)) {
		t.Fatalf("sales items = %q first seen %s", got, salesPage.Items[1].FirstSeenAt)
	}
	popularPage := env.rankingPage(t, env.adminID, list, nil)
	if popularPage.Variant.ID != popular.ID || rankingChangeKinds(popularPage) != "02:up 01:down" {
		t.Fatalf("popularity page = variant %+v changes %q", popularPage.Variant, rankingChangeKinds(popularPage))
	}
	empty := env.rankingPage(t, env.adminID, list, url.Values{"release": {"30d"}, "sort": {"sale"}})
	if empty.Variant.ID != newBySales.ID || empty.Snapshot != nil || len(empty.Items) != 0 {
		t.Fatalf("unpulled order = %+v", empty)
	}
	for _, attempt := range []struct {
		list  rankingList
		query string
	}{{list, "sort=price"}, {list, "release=7d"}, {annual, "release=30d"}} {
		target := "/api/rankings/x?" + attempt.query
		if response := env.request(t, env.adminID, http.MethodGet, target, nil, env.server.getRanking, "id", strconv.FormatInt(attempt.list.ID, 10)); response.Code != http.StatusBadRequest {
			t.Fatalf("page %s of list %d = %d", attempt.query, attempt.list.ID, response.Code)
		}
		if response := env.request(t, env.adminID, http.MethodGet, "/api/rankings/x/snapshots?"+attempt.query, nil, env.server.listRankingSnapshots, "id", strconv.FormatInt(attempt.list.ID, 10)); response.Code != http.StatusBadRequest {
			t.Fatalf("timeline %s of list %d = %d", attempt.query, attempt.list.ID, response.Code)
		}
	}
	if timeline := env.rankingTimeline(t, list, "sort=sale"); len(timeline.Snapshots) != 1 || timeline.Snapshots[0].ID != salesPage.Snapshot.ID {
		t.Fatalf("sales timeline = %+v", timeline)
	}
	if timeline := env.rankingTimeline(t, list, ""); len(timeline.Snapshots) != 2 {
		t.Fatalf("popularity timeline = %+v", timeline)
	}

	// Seeing one order leaves the others unread, and a snapshot of another
	// list's order is refused.
	if code := env.markSeen(t, list, popularPage.Snapshot.ID); code != http.StatusOK {
		t.Fatalf("seen popularity = %d", code)
	}
	if code := env.markSeen(t, annual, salesPage.Snapshot.ID); code != http.StatusNotFound {
		t.Fatalf("seen through another list = %d", code)
	}
	reloaded := env.rankingList(t, list.ID)
	seenPopular, _ := reloaded.variant("", "")
	unseenSales, _ := reloaded.variant("", rankingSortSales)
	if seenPopular.Unseen || !unseenSales.Unseen {
		t.Fatalf("seen state = popularity %+v sales %+v", seenPopular, unseenSales)
	}
	if code := env.markSeen(t, list, salesPage.Snapshot.ID); code != http.StatusOK {
		t.Fatalf("seen sales = %d", code)
	}
	if states := env.scalar(t, "SELECT COUNT(*) FROM user_ranking_state WHERE user_id = ?", env.adminID); states.String != "2" {
		t.Fatalf("seen states = %s", states.String)
	}
}

func TestRankingHistoryReadsTheOrderInEffectAtATime(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	variant := env.rankingVariant(t, list, "", "")
	base := time.Date(2026, time.October, 20, 0, 0, 0, 0, time.UTC)
	env.recordVariant(t, variant, rankingItems("RJ00000001", "RJ00000002"), base)
	env.recordVariant(t, variant, rankingItems("RJ00000001", "RJ00000002"), base.Add(2*time.Hour))
	env.recordVariant(t, variant, rankingItems("RJ00000002", "RJ00000003"), base.Add(10*time.Hour))
	ids := []int64{}
	rows, err := env.db.Query("SELECT id FROM ranking_snapshot WHERE ranking_variant_id = ? ORDER BY pulled_at", variant.ID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id int64
		_ = rows.Scan(&id)
		ids = append(ids, id)
	}
	_ = rows.Close()
	at := func(value time.Time) url.Values { return url.Values{"at": {value.Format(time.RFC3339)}} }

	confirmed := env.rankingPage(t, env.adminID, list, at(base.Add(time.Hour)))
	if confirmed.Snapshot == nil || confirmed.Snapshot.ID != ids[0] || confirmed.Coverage == nil || confirmed.Coverage.State != "confirmed" {
		t.Fatalf("confirmed time = snapshot %+v coverage %+v", confirmed.Snapshot, confirmed.Coverage)
	}
	if confirmed.Baseline != nil || confirmed.NextSnapshot == nil || confirmed.NextSnapshot.ID != ids[1] || confirmed.PreviousSnapshot != nil {
		t.Fatalf("first snapshot neighbors = baseline %+v previous %+v next %+v", confirmed.Baseline, confirmed.PreviousSnapshot, confirmed.NextSnapshot)
	}
	// Between the last confirmation at +2h and the next pull at +10h no pull ran.
	gap := env.rankingPage(t, env.adminID, list, at(base.Add(5*time.Hour)))
	if gap.Snapshot.ID != ids[0] || gap.Coverage.State != "unpulled" || gap.Coverage.ConfirmedUntil == nil || *gap.Coverage.ConfirmedUntil != formatWorkflowTimestamp(base.Add(2*time.Hour)) {
		t.Fatalf("gap = snapshot %+v coverage %+v", gap.Snapshot, gap.Coverage)
	}
	// A history page compares with the order before it by default.
	later := env.rankingPage(t, env.adminID, list, at(base.Add(10*time.Hour)))
	if later.Snapshot.ID != ids[1] || later.Baseline == nil || later.Baseline.Kind != "previous" || later.Baseline.ID != ids[0] {
		t.Fatalf("later = snapshot %+v baseline %+v", later.Snapshot, later.Baseline)
	}
	if got, want := rankingChangeKinds(later), "02:up 03:new"; got != want {
		t.Fatalf("history changes = %q, want %q", got, want)
	}
	byTime := env.rankingPage(t, env.adminID, list, url.Values{"at": {base.Add(10 * time.Hour).Format(time.RFC3339)}, "compare": {base.Add(30 * time.Minute).Format(time.RFC3339)}})
	if byTime.Baseline == nil || byTime.Baseline.Kind != "snapshot" || byTime.Baseline.ID != ids[0] {
		t.Fatalf("compare by time = %+v", byTime.Baseline)
	}
	before := env.rankingPage(t, env.adminID, list, at(base.Add(-time.Hour)))
	if before.Snapshot != nil || before.Coverage.State != "before" || before.NextSnapshot == nil || before.NextSnapshot.ID != ids[0] || len(before.Items) != 0 {
		t.Fatalf("before the history = %+v", before)
	}
	if invalid := env.request(t, env.adminID, http.MethodGet, "/api/rankings/x?at=soon", nil, env.server.getRanking, "id", strconv.FormatInt(list.ID, 10)); invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid time = %d", invalid.Code)
	}

	page := env.rankingTimeline(t, list, "limit=1&from="+url.QueryEscape(base.Format(time.RFC3339)))
	if len(page.Snapshots) != 1 || page.Snapshots[0].ID != ids[0] || page.NextAfterID == nil || page.FirstPulledAt == nil {
		t.Fatalf("timeline page = %+v", page)
	}
	if rest := env.rankingTimeline(t, list, "afterId="+strconv.FormatInt(*page.NextAfterID, 10)); len(rest.Snapshots) != 1 || rest.Snapshots[0].ID != ids[1] || rest.NextAfterID != nil {
		t.Fatalf("next timeline page = %+v", rest)
	}
	if day := env.rankingTimeline(t, list, "from="+url.QueryEscape(base.Add(time.Hour).Format(time.RFC3339))+"&to="+url.QueryEscape(base.Add(9*time.Hour).Format(time.RFC3339))); len(day.Snapshots) != 0 {
		t.Fatalf("empty range = %+v", day)
	}
}

type fakeRankingPuller struct {
	// pulls are by list, and errs by list or by variant.
	pulls       map[int64]rankingPull
	errs        map[int64]error
	variantErrs map[int64]error
	seen        []string
}

func (puller *fakeRankingPuller) pull(_ context.Context, list rankingList, variant rankingVariant) (rankingPull, error) {
	puller.seen = append(puller.seen, fmt.Sprintf("%d:%s/%s", list.ID, variant.ReleaseWindow, variant.Sort))
	if err := puller.errs[list.ID]; err != nil {
		return rankingPull{}, err
	}
	if err := puller.variantErrs[variant.ID]; err != nil {
		return rankingPull{}, err
	}
	return puller.pulls[list.ID], nil
}

// runRankingPull queues a DLsite pull, claims it, and runs it at a time.
func (env subscriptionTestEnv) runRankingPull(t *testing.T, puller rankingPuller, now time.Time) int64 {
	t.Helper()
	ctx := context.Background()
	queued, err := env.server.enqueueRankingPull(ctx, rankingPullTarget{Provider: rankingProviderDLsite}, workflowRunTrigger{Type: "manual"}, env.adminID)
	if err != nil {
		t.Fatal(err)
	}
	job, ok, err := env.server.claimNextQueuedWorkflowJob(ctx, "ranking-test-runner")
	if err != nil || !ok || job.WorkerType != rankingPullWorkerType {
		t.Fatalf("claim = %+v %v %v", job, ok, err)
	}
	if err := env.server.executeRankingPullJobWith(ctx, job, puller, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	return queued.RunID
}

func TestRankingPullRunTakesTheListsDueWhenItStarts(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	if err := env.server.ensureRankingDispatchers(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := env.server.requestRankingPulls(ctx, nil, env.adminID, "manual_run"); !errors.Is(err, errRankingNothingToPull) {
		t.Fatalf("refresh without lists = %v", err)
	}
	now := time.Now().UTC().Truncate(time.Second)
	past, soon := formatWorkflowTimestamp(now.Add(-time.Minute)), formatWorkflowTimestamp(now.Add(time.Hour))
	due := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	waiting := env.addRankingList(t, rankingProviderDLsite, nil, "week", true)
	requested := env.addRankingList(t, rankingProviderDLsite, nil, "month", true)
	off := env.addRankingList(t, rankingProviderDLsite, nil, "total", false)
	env.exec(t,
		`UPDATE ranking_list SET refresh_interval_minutes = 30, next_pull_at = '`+past+`' WHERE id = `+strconv.FormatInt(due.ID, 10),
		`UPDATE ranking_list SET refresh_interval_minutes = 360, next_pull_at = '`+soon+`' WHERE id = `+strconv.FormatInt(waiting.ID, 10),
		`UPDATE ranking_list SET auto_refresh = 0, next_pull_at = NULL, pull_requested_at = '`+past+`' WHERE id = `+strconv.FormatInt(requested.ID, 10),
		`UPDATE ranking_list SET next_pull_at = '`+past+`' WHERE id = `+strconv.FormatInt(off.ID, 10),
	)
	queued, err := env.server.enqueueRankingPull(ctx, rankingPullTarget{Provider: rankingProviderDLsite}, workflowRunTrigger{Type: "schedule"}, 0)
	if err != nil {
		t.Fatal(err)
	}
	again, err := env.server.enqueueRankingPull(ctx, rankingPullTarget{Provider: rankingProviderDLsite}, workflowRunTrigger{Type: "manual"}, env.adminID)
	if !errors.Is(err, errRankingRunActive) || again.RunID != queued.RunID {
		t.Fatalf("second pull = %+v %v", again, err)
	}
	// The waiting list becomes due while the run waits for the provider.
	env.exec(t, `UPDATE ranking_list SET next_pull_at = '`+past+`' WHERE id = `+strconv.FormatInt(waiting.ID, 10))
	job, ok, err := env.server.claimNextQueuedWorkflowJob(ctx, "ranking-test-runner")
	if err != nil || !ok || job.WorkerType != rankingPullWorkerType {
		t.Fatalf("claim = %+v %v %v", job, ok, err)
	}
	failingOrder := env.rankingVariant(t, requested, rankingReleaseWindow, "")
	puller := &fakeRankingPuller{
		pulls:       map[int64]rankingPull{due.ID: rankingItems("RJ00000010", "RJ00000011"), requested.ID: rankingItems("RJ00000012")},
		errs:        map[int64]error{waiting.ID: errors.New("example provider failure")},
		variantErrs: map[int64]error{failingOrder.ID: errors.New("example order failure")},
	}
	if err := env.server.executeRankingPullJobWith(ctx, job, puller, func() time.Time { return now }); err != nil {
		t.Fatal(err)
	}
	// Each list is pulled in every one of its orders.
	if got := len(puller.seen); got != 12 {
		t.Fatalf("pulled orders = %v, want the four orders of the due, newly due, and requested lists", puller.seen)
	}
	if status := env.scalar(t, "SELECT status FROM workflow_run WHERE id = ?", queued.RunID); status.String != "partial" {
		t.Fatalf("run status = %v", status)
	}
	type schedule struct {
		next, requested sql.NullString
		failures        int
		status          string
	}
	read := func(id int64) schedule {
		var value schedule
		if err := env.db.QueryRow("SELECT next_pull_at, pull_requested_at, failure_count, last_status FROM ranking_list WHERE id = ?", id).Scan(&value.next, &value.requested, &value.failures, &value.status); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if got := read(due.ID); got.next.String != formatWorkflowTimestamp(now.Add(30*time.Minute)) || got.failures != 0 || got.status != "succeeded" {
		t.Fatalf("due list = %+v", got)
	}
	if got := read(waiting.ID); got.next.String != formatWorkflowTimestamp(now.Add(time.Hour)) || got.failures != 1 || got.status != "failed" {
		t.Fatalf("failed list = %+v", got)
	}
	if got := read(requested.ID); got.next.Valid || got.requested.Valid || got.failures != 1 || got.status != "partial" {
		t.Fatalf("partly failed list = %+v", got)
	}
	if got := read(off.ID); got.status != "" || got.next.String != past {
		t.Fatalf("switched-off list = %+v", got)
	}
	// One failed order keeps its last snapshot; the other orders are recorded.
	statuses := env.scalar(t, `SELECT group_concat(release_window || '/' || sort || '=' || last_status, ',') FROM (
		SELECT * FROM ranking_variant WHERE ranking_list_id = ? ORDER BY sort, release_window)`, requested.ID)
	if statuses.String != "/=succeeded,30d/=failed,/sale=succeeded,30d/sale=succeeded" {
		t.Fatalf("order statuses = %s", statuses.String)
	}
	if snapshots := env.scalar(t, `SELECT COUNT(*) FROM ranking_snapshot AS snapshot
		INNER JOIN ranking_variant AS variant ON variant.id = snapshot.ranking_variant_id WHERE variant.ranking_list_id = ?`, requested.ID); snapshots.String != "3" {
		t.Fatalf("snapshots of the partly failed list = %s", snapshots.String)
	}
	// The dispatcher's next run is the earliest due list.
	next := env.scalar(t, `SELECT trigger.next_run_at FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = ?`, dlsiteRankingWorkflowCode)
	if next.String != formatWorkflowTimestamp(now.Add(30*time.Minute)) {
		t.Fatalf("dispatcher next run = %v", next)
	}
}

type fakeDLsiteRankings struct {
	options []dlsite.RankingOptions
}

func (rankings *fakeDLsiteRankings) FetchVoiceRanking(_ context.Context, options dlsite.RankingOptions) (dlsite.RankingResult, error) {
	rankings.options = append(rankings.options, options)
	result := dlsite.RankingResult{}
	for number := 50; number < 62; number++ {
		result.Items = append(result.Items, dlsite.RankingItem{Code: fmt.Sprintf("RJ%08d", number), Title: "Example Ranked Work", Maker: "Example Circle"})
	}
	return result, nil
}

func TestDLsiteRankingPullAsksForEachOrder(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	day := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	env.exec(t, `UPDATE ranking_list SET depth = 10 WHERE id = `+strconv.FormatInt(day.ID, 10))
	day = env.rankingList(t, day.ID)
	annual := env.addAnnualRankingList(t, 2025, false)
	total := env.addRankingList(t, rankingProviderDLsite, nil, "total", true)
	if len(total.Variants) != 2 {
		t.Fatalf("all-time orders = %+v", total.Variants)
	}
	rankings := &fakeDLsiteRankings{}
	puller := serverRankingPuller{server: env.server, dlsite: rankings}
	for _, list := range []rankingList{day, annual, total} {
		for _, variant := range list.Variants {
			pull, err := puller.pull(context.Background(), list, variant)
			if err != nil {
				t.Fatal(err)
			}
			if len(pull.Items) != min(list.Depth, 12) || pull.Items[0].Code != "RJ00000050" {
				t.Fatalf("pull of %d = %+v", list.ID, pull.Items)
			}
		}
	}
	got := []string{}
	for _, options := range rankings.options {
		got = append(got, fmt.Sprintf("%s:%d:%s/%s", options.Period, options.Year, options.ReleaseWindow, options.Sort))
	}
	want := "day:0:/,day:0:30d/,day:0:/sale,day:0:30d/sale,year:2025:/,year:2025:/sale,total:0:/,total:0:/sale"
	if strings.Join(got, ",") != want {
		t.Fatalf("requested orders = %s, want %s", strings.Join(got, ","), want)
	}
}

func TestRankingListsFollowTheFixedChipOrder(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	env.exec(t, `INSERT INTO file_source (id, code, display_name, source_type, enabled, priority) VALUES
		(8, 'remote_a', 'Example Remote A', 'kikoeru_compatible', 1, 20),
		(9, 'remote_b', 'Example Remote B', 'kikoeru_compatible', 1, 10)`)
	env.addRankingList(t, rankingProviderDLsite, nil, "total", true)
	env.addRankingList(t, rankingProviderRemote, 8, "", true)
	env.addAnnualRankingList(t, 2025, false)
	env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	env.addRankingList(t, rankingProviderRemote, 9, "", true)
	env.addAnnualRankingList(t, 2026, true)
	env.addRankingList(t, rankingProviderDLsite, nil, "month", true)
	env.addRankingList(t, rankingProviderDLsite, nil, "week", true)
	lists, err := env.server.loadRankingLists(context.Background(), env.adminID, "")
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, list := range lists {
		switch {
		case list.Provider == rankingProviderRemote:
			got = append(got, list.SourceName)
		case list.Period == "year":
			got = append(got, strconv.Itoa(list.Year))
		default:
			got = append(got, list.Period)
		}
	}
	want := "day,week,month,2026,2025,total,Example Remote B,Example Remote A"
	if strings.Join(got, ",") != want {
		t.Fatalf("order = %s, want %s", strings.Join(got, ","), want)
	}
}

func TestRankingRetriesBackOffWithinTheListInterval(t *testing.T) {
	now := time.Date(2026, time.October, 20, 0, 0, 0, 0, time.UTC)
	week := rankingList{Period: "week", AutoRefresh: true, RefreshIntervalMinutes: 6 * 60}
	for failures, want := range map[int]time.Duration{1: time.Hour, 2: 2 * time.Hour, 9: 6 * time.Hour} {
		if got := rankingRetryPullAt(week, failures, now); got == nil || !got.Equal(now.Add(want)) {
			t.Errorf("after %d failures retry = %v, want %v", failures, got, now.Add(want))
		}
	}
	quick := rankingList{Period: "day", AutoRefresh: true, RefreshIntervalMinutes: 20}
	if got := rankingRetryPullAt(quick, 1, now); !got.Equal(now.Add(20 * time.Minute)) {
		t.Errorf("a 20-minute list retries after %v", got)
	}
	if got := rankingRetryPullAt(rankingList{Period: "day", RefreshIntervalMinutes: 60}, 1, now); got != nil {
		t.Errorf("a list without automatic pulls retries at %v", got)
	}
	// An annual list without automatic pulls waits for its final pull, and
	// retries a failed final pull.
	annual := rankingList{Period: "year", Year: 2026, RefreshIntervalMinutes: 7 * 24 * 60}
	if got := rankingRetryPullAt(annual, 1, now); !got.Equal(rankingFinalPullAt(2026)) {
		t.Errorf("annual retry before the final pull = %v", got)
	}
	afterYear := time.Date(2027, time.January, 5, 0, 0, 0, 0, time.UTC)
	if got := rankingRetryPullAt(annual, 2, afterYear); !got.Equal(afterYear.Add(2 * time.Hour)) {
		t.Errorf("final pull retry = %v", got)
	}
}

func TestRankingDispatchQueuesOneRunPerProviderAndSource(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	env.exec(t,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES
			(8, 'remote_a', 'Example Remote A', 'kikoeru_compatible', 1),
			(9, 'remote_b', 'Example Remote B', 'kikoeru_compatible_number178', 1),
			(10, 'remote_c', 'Example Remote C', 'kikoeru_compatible', 0)`,
		`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES
			(8, 'https://a.example.invalid', 'https://a.example.invalid/api'),
			(9, 'https://b.example.invalid', 'https://b.example.invalid/api'),
			(10, 'https://c.example.invalid', 'https://c.example.invalid/api')`,
	)
	past := formatWorkflowTimestamp(time.Now().UTC().Add(-time.Minute))
	for _, list := range []rankingList{
		env.addRankingList(t, rankingProviderDLsite, nil, "day", true),
		env.addRankingList(t, rankingProviderDLsite, nil, "week", true),
		env.addRankingList(t, rankingProviderRemote, 8, "", true),
		env.addRankingList(t, rankingProviderRemote, 9, "", true),
		env.addRankingList(t, rankingProviderRemote, 10, "", true),
	} {
		env.exec(t, `UPDATE ranking_list SET next_pull_at = '`+past+`' WHERE id = `+strconv.FormatInt(list.ID, 10))
	}
	if err := env.server.ensureRankingDispatchers(ctx); err != nil {
		t.Fatal(err)
	}
	dispatchers := map[string]workflowTriggerRecord{}
	for _, code := range rankingWorkflowCodes {
		id, _ := strconv.ParseInt(env.scalar(t, `SELECT trigger.id FROM workflow_trigger AS trigger
			INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
			WHERE definition.code = ? AND trigger.trigger_type = 'schedule'`, code).String, 10, 64)
		trigger, err := env.server.loadWorkflowTrigger(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if trigger.NextRunAt == nil || *trigger.NextRunAt > formatWorkflowTimestamp(time.Now().UTC()) {
			t.Fatalf("%s dispatcher is not due: %v", code, trigger.NextRunAt)
		}
		definition, err := env.server.loadWorkflowDefinition(ctx, trigger.WorkflowDefinitionID)
		if err != nil {
			t.Fatal(err)
		}
		if err := env.server.dispatchRankingTrigger(ctx, definition, trigger); err != nil {
			t.Fatal(err)
		}
		dispatchers[code] = trigger
	}
	rows, err := env.db.Query(`SELECT run.workflow_code, COALESCE(json_extract(run.input_json, '$.source_id'), 0), job.resource_key, run.trigger_id
		FROM workflow_run AS run INNER JOIN workflow_job AS job ON job.workflow_run_id = run.id ORDER BY run.id`)
	if err != nil {
		t.Fatal(err)
	}
	runs := []string{}
	for rows.Next() {
		var code, resourceKey string
		var sourceID, triggerID int64
		if err := rows.Scan(&code, &sourceID, &resourceKey, &triggerID); err != nil {
			t.Fatal(err)
		}
		if triggerID != dispatchers[code].ID {
			t.Fatalf("run of %s has trigger %d", code, triggerID)
		}
		runs = append(runs, code+":"+strconv.FormatInt(sourceID, 10)+":"+resourceKey)
	}
	_ = rows.Close()
	want := []string{
		dlsiteRankingWorkflowCode + ":0:metadata:provider",
		remoteRankingWorkflowCode + ":8:" + sourceResourceKey("https://a.example.invalid/api"),
		remoteRankingWorkflowCode + ":9:" + sourceResourceKey("https://b.example.invalid/api"),
	}
	if strings.Join(runs, ",") != strings.Join(want, ",") {
		t.Fatalf("runs = %v, want %v", runs, want)
	}
	// While each target's run is active, the dispatchers wait for a later due list.
	for code := range dispatchers {
		if next := env.scalar(t, "SELECT next_run_at FROM workflow_trigger WHERE id = ?", dispatchers[code].ID); next.Valid {
			t.Fatalf("%s dispatcher next run while its runs are active = %v", code, next)
		}
	}
	// A manual refresh while a target's run is queued joins that run.
	results, err := env.server.requestRankingPulls(ctx, nil, env.adminID, "manual_run")
	if err != nil || len(results) != 3 {
		t.Fatalf("manual refresh = %+v %v", results, err)
	}
	if count := env.scalar(t, "SELECT COUNT(*) FROM workflow_run"); count.String != "3" {
		t.Fatalf("runs after the manual refresh = %s", count.String)
	}
	// The dispatchers are scheduled here, not on the Workflows page.
	id := strconv.FormatInt(dispatchers[dlsiteRankingWorkflowCode].ID, 10)
	if response := env.request(t, env.adminID, http.MethodDelete, "/api/workflow-triggers/"+id, nil, env.server.deleteWorkflowTrigger, "id", id); response.Code != http.StatusConflict {
		t.Fatalf("delete dispatcher = %d", response.Code)
	}
	update := map[string]any{"workflowDefinitionId": dispatchers[dlsiteRankingWorkflowCode].WorkflowDefinitionID, "triggerType": "schedule", "displayName": "Paused", "enabled": false, "scheduleJson": "{}", "configJson": "{}"}
	if response := env.request(t, env.adminID, http.MethodPut, "/api/workflow-triggers/"+id, update, env.server.updateWorkflowTrigger, "id", id); response.Code != http.StatusConflict {
		t.Fatalf("pause dispatcher = %d %s", response.Code, response.Body.String())
	}
}

func TestAnnualRankingFinalizesWhenEveryOrderHasTheFinalPull(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	list := env.addAnnualRankingList(t, 2026, true)
	env.exec(t, `UPDATE ranking_list SET follow_current_year = 1, pull_requested_at = '2027-01-01 00:00:00' WHERE id = `+strconv.FormatInt(list.ID, 10))
	sales := env.rankingVariant(t, list, "", rankingSortSales)
	puller := &fakeRankingPuller{pulls: map[int64]rankingPull{list.ID: rankingItems("RJ00000020", "RJ00000021")}}

	// 23:00 on 2 January in Japan: the year is still being settled, so the
	// next pull is the final one on 3 January rather than a week later.
	env.runRankingPull(t, puller, time.Date(2027, time.January, 2, 14, 0, 0, 0, time.UTC))
	if pulled := env.rankingList(t, list.ID); pulled.FinalAt != nil || pulled.NextPullAt == nil || *pulled.NextPullAt != "2027-01-02 15:00:00" {
		t.Fatalf("list before 3 January = %+v, want the final pull at midnight in Japan", pulled)
	}
	// A final pull with one order failing leaves the year open and retries.
	finalPull := time.Date(2027, time.January, 2, 15, 0, 0, 0, time.UTC)
	puller.variantErrs = map[int64]error{sales.ID: errors.New("example provider failure")}
	env.runRankingPull(t, puller, finalPull)
	if partial := env.rankingList(t, list.ID); partial.FinalAt != nil || partial.LastStatus != "partial" || partial.NextPullAt == nil || *partial.NextPullAt != "2027-01-02 16:00:00" {
		t.Fatalf("partly failed final pull = %+v", partial)
	}
	puller.variantErrs = nil
	runID := env.runRankingPull(t, puller, finalPull.Add(time.Hour))
	finished := env.rankingList(t, list.ID)
	if finished.FinalAt == nil || finished.NextPullAt != nil {
		t.Fatalf("finalized list = %+v", finished)
	}
	for _, variant := range finished.Variants {
		if variant.LastStatus != "succeeded" || variant.LastPulledAt == nil || *variant.LastPulledAt < formatWorkflowTimestamp(finalPull) {
			t.Fatalf("order without the final pull = %+v", variant)
		}
	}
	var summary rankingRunResult
	if err := json.Unmarshal([]byte(env.scalar(t, "SELECT summary_json FROM workflow_run WHERE id = ?", runID).String), &summary); err != nil {
		t.Fatal(err)
	}
	if len(summary.Lists) != 2 || !summary.Lists[0].Final || !summary.Lists[1].Final || summary.Status != "succeeded" {
		t.Fatalf("final run = %+v", summary)
	}
	var depth, interval, orders int
	var autoRefresh, follow bool
	var requested sql.NullString
	if err := env.db.QueryRow(`SELECT depth, auto_refresh, refresh_interval_minutes, follow_current_year, pull_requested_at,
		(SELECT COUNT(*) FROM ranking_variant WHERE ranking_list_id = ranking_list.id)
		FROM ranking_list WHERE period = 'year' AND year = 2027`).Scan(&depth, &autoRefresh, &interval, &follow, &requested, &orders); err != nil {
		t.Fatal(err)
	}
	if depth != 50 || !autoRefresh || interval != 10080 || !follow || !requested.Valid || orders != 2 {
		t.Fatalf("followed year = depth %d auto %v interval %d follow %v requested %v orders %d", depth, autoRefresh, interval, follow, requested, orders)
	}
	autoRefresh = true
	if _, err := applyRankingListUpdate(finished, rankingListUpdate{AutoRefresh: &autoRefresh}, time.Now()); err == nil {
		t.Fatal("a finalized list accepted a schedule")
	}

	// A past year is pulled once and finalized at once.
	past := env.addAnnualRankingList(t, 2020, false)
	if outcome := env.record(t, past, rankingItems("RJ00000030"), time.Now().UTC()); !outcome.Final {
		t.Fatalf("past year pull = %+v", outcome)
	}
	// Re-pulling a finalized list with the same order adds no snapshot.
	env.record(t, past, rankingItems("RJ00000030"), time.Now().UTC())
	if count := env.scalar(t, "SELECT COUNT(*) FROM ranking_snapshot WHERE ranking_variant_id = ?", env.rankingVariant(t, past, "", "").ID); count.String != "1" {
		t.Fatalf("finalized snapshots = %s", count.String)
	}
}

func TestAnnualRankingYearsFollowJapanTime(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	newYearInJapan := time.Date(2026, time.December, 31, 15, 30, 0, 0, time.UTC)
	current, err := env.server.normalizeRankingListRequest(context.Background(), rankingListRequest{Provider: rankingProviderDLsite, Period: "year", Year: 2027}, newYearInJapan)
	if err != nil || !*current.AutoRefresh || current.RefreshIntervalMinutes != 7*24*60 {
		t.Fatalf("current year = %+v %v", current, err)
	}
	previous, err := env.server.normalizeRankingListRequest(context.Background(), rankingListRequest{Provider: rankingProviderDLsite, Period: "year", Year: 2026}, newYearInJapan)
	if err != nil || *previous.AutoRefresh || previous.FollowCurrentYear || !current.FollowCurrentYear {
		t.Fatalf("a past year is scheduled or continues: %+v %v", previous, err)
	}
	if _, err := env.server.normalizeRankingListRequest(context.Background(), rankingListRequest{Provider: rankingProviderDLsite, Period: "year", Year: 2028}, newYearInJapan); err == nil {
		t.Fatal("a future year was accepted")
	}
	if got := rankingFinalPullAt(2026); !got.Equal(time.Date(2027, time.January, 3, 0, 0, 0, 0, time.FixedZone("JST", 9*60*60))) {
		t.Fatalf("final pull = %v", got)
	}
}

func TestPastAnnualRankingFinalizesWithoutAddingTheYearInProgress(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	now := time.Now().UTC()
	request, err := env.server.normalizeRankingListRequest(ctx, rankingListRequest{Provider: rankingProviderDLsite, Period: "year", Year: 2020}, now)
	if err != nil {
		t.Fatal(err)
	}
	id, err := env.server.insertRankingList(ctx, request, now)
	if err != nil {
		t.Fatal(err)
	}
	past := env.rankingList(t, id)
	follow := true
	if _, err := applyRankingListUpdate(past, rankingListUpdate{FollowCurrentYear: &follow}, now); err == nil {
		t.Fatal("a past year accepted following the current year")
	}
	if outcome := env.record(t, past, rankingItems("RJ00000030"), now); !outcome.Final {
		t.Fatalf("past year pull = %+v", outcome)
	}
	if count := env.scalar(t, "SELECT COUNT(*) FROM ranking_list WHERE period = 'year' AND year <> 2020"); count.String != "0" {
		t.Fatalf("a finalized past year added %s lists", count.String)
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
	if len(list.Variants) != 1 {
		t.Fatalf("remote orders = %+v", list.Variants)
	}
	pull, err := serverRankingPuller{server: env.server}.pull(context.Background(), list, list.Variants[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(pull.Items) != 2 || pull.SkippedWithoutCode != 1 || pull.Items[0].Maker != "Example Circle" || pull.Items[0].RemoteWorkID != 21 {
		t.Fatalf("pull = %+v", pull)
	}
	env.record(t, list, pull, time.Now().UTC())
	page := env.rankingPage(t, env.adminID, list, nil)
	cover := page.Items[0].Fallback.CoverURL
	if !strings.HasPrefix(cover, "/api/remote-sources/8/images/") || strings.Contains(cover, "192.0.2.10") {
		t.Fatalf("cover = %q", cover)
	}

	env.exec(t, `UPDATE file_source SET enabled = 0 WHERE id = 8`)
	if _, err := (serverRankingPuller{server: env.server}).pull(context.Background(), list, list.Variants[0]); !errors.Is(err, errRankingSourceUnavailable) {
		t.Fatalf("disabled source pull = %v", err)
	}
	if page := env.rankingPage(t, env.adminID, list, nil); len(page.Items) != 2 || page.List.SourceAvailable {
		t.Fatalf("the last snapshot of a disabled source = %+v available %v", page.Items, page.List.SourceAvailable)
	}
}

func TestRankingConfigurationNeedsMetadataSync(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	if err := env.server.ensureRankingDispatchers(context.Background()); err != nil {
		t.Fatal(err)
	}
	contributor := env.addUser(t, "ranking-contributor", "contributor")
	viewer := env.addUser(t, "ranking-viewer", "user")

	for _, attempt := range []struct {
		method, target string
		handler        func(http.ResponseWriter, *http.Request)
	}{
		{http.MethodPost, "/api/rankings", env.server.createRanking},
		{http.MethodPost, "/api/rankings/refresh", env.server.runRankingRefresh},
		{http.MethodPut, "/api/rankings/retention", env.server.updateRankingRetention},
	} {
		if response := env.request(t, contributor, attempt.method, attempt.target, map[string]any{"provider": "dlsite", "period": "day"}, attempt.handler); response.Code != http.StatusForbidden {
			t.Fatalf("contributor %s %s = %d", attempt.method, attempt.target, response.Code)
		}
	}
	for _, invalid := range []map[string]any{
		{"provider": "dlsite", "period": "day", "refreshIntervalMinutes": 10},
		{"provider": "dlsite", "period": "total", "refreshIntervalMinutes": 600},
		{"provider": "dlsite", "period": "quarter"},
	} {
		if response := env.request(t, env.adminID, http.MethodPost, "/api/rankings", invalid, env.server.createRanking); response.Code != http.StatusBadRequest {
			t.Fatalf("create %v = %d", invalid, response.Code)
		}
	}
	type createdBody struct {
		List  rankingList `json:"list"`
		RunID int64       `json:"runId"`
	}
	create := func(request map[string]any) createdBody {
		t.Helper()
		response := env.request(t, env.adminID, http.MethodPost, "/api/rankings", request, env.server.createRanking)
		if response.Code != http.StatusCreated {
			t.Fatalf("create %v = %d %s", request, response.Code, response.Body.String())
		}
		var body createdBody
		if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return body
	}
	body := create(map[string]any{"provider": "dlsite", "period": "day"})
	if body.RunID <= 0 || body.List.Depth != rankingDefaultDepth || body.List.RefreshIntervalMinutes != 60 || !body.List.AutoRefresh || !body.List.PullRequested || len(body.List.Variants) != 4 {
		t.Fatalf("created = %+v", body)
	}
	if run := env.scalar(t, "SELECT workflow_code FROM workflow_run WHERE id = ?", body.RunID); run.String != dlsiteRankingWorkflowCode {
		t.Fatalf("first pull run = %v", run)
	}
	if allTime := create(map[string]any{"provider": "dlsite", "period": "total"}); allTime.List.RefreshIntervalMinutes != 7*24*60 || len(allTime.List.Variants) != 2 {
		t.Fatalf("all-time list = %+v", allTime.List)
	}
	duplicate := env.request(t, env.adminID, http.MethodPost, "/api/rankings", map[string]any{"provider": "dlsite", "period": "day"}, env.server.createRanking)
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate = %d", duplicate.Code)
	}
	id := strconv.FormatInt(body.List.ID, 10)
	if response := env.request(t, env.adminID, http.MethodPatch, "/api/rankings/"+id, map[string]any{"refreshIntervalMinutes": 2 * 24 * 60}, env.server.updateRanking, "id", id); response.Code != http.StatusBadRequest {
		t.Fatalf("interval above the 24-hour range = %d", response.Code)
	}
	updated := env.request(t, env.adminID, http.MethodPatch, "/api/rankings/"+id, map[string]any{"refreshIntervalMinutes": 20, "depth": 50}, env.server.updateRanking, "id", id)
	if updated.Code != http.StatusOK || !strings.Contains(updated.Body.String(), `"refreshIntervalMinutes":20`) {
		t.Fatalf("update = %d %s", updated.Code, updated.Body.String())
	}
	if response := env.request(t, contributor, http.MethodPatch, "/api/rankings/"+id, map[string]any{"enabled": false}, env.server.updateRanking, "id", id); response.Code != http.StatusForbidden {
		t.Fatalf("contributor update = %d", response.Code)
	}
	if response := env.request(t, env.adminID, http.MethodPatch, "/api/rankings/"+id, map[string]any{"enabled": false}, env.server.updateRanking, "id", id); response.Code != http.StatusOK {
		t.Fatalf("disable = %d %s", response.Code, response.Body.String())
	}
	env.exec(t, `UPDATE ranking_list SET enabled = 0`)

	var overview rankingOverview
	listed := env.request(t, viewer, http.MethodGet, "/api/rankings", nil, env.server.listRankings)
	if err := json.Unmarshal(listed.Body.Bytes(), &overview); err != nil {
		t.Fatal(err)
	}
	if len(overview.Lists) != 0 || len(overview.Workflows) != 2 || overview.Retention.FullDays != 30 || overview.Retention.DailyDays != 365 || overview.CurrentYear < 2026 {
		t.Fatalf("viewer overview = %+v", overview)
	}
	if response := env.request(t, viewer, http.MethodGet, "/api/rankings/"+id, nil, env.server.getRanking, "id", id); response.Code != http.StatusNotFound {
		t.Fatalf("viewer disabled list = %d", response.Code)
	}
	if response := env.request(t, env.adminID, http.MethodPut, "/api/rankings/retention", map[string]any{"fullDays": 30, "dailyDays": 7}, env.server.updateRankingRetention); response.Code != http.StatusBadRequest {
		t.Fatalf("daily retention shorter than the full one = %d", response.Code)
	}
	if response := env.request(t, env.adminID, http.MethodPut, "/api/rankings/retention", map[string]any{"fullDays": 14, "dailyDays": 0}, env.server.updateRankingRetention); response.Code != http.StatusOK {
		t.Fatalf("keep daily forever = %d %s", response.Code, response.Body.String())
	}
	if retention := env.server.rankingRetentionSettings(context.Background()); retention != (rankingRetention{FullDays: 14, DailyDays: 0}) {
		t.Fatalf("retention = %+v", retention)
	}
	if response := env.request(t, env.adminID, http.MethodDelete, "/api/rankings/"+id, nil, env.server.deleteRanking, "id", id); response.Code != http.StatusOK {
		t.Fatalf("delete = %d", response.Code)
	}
	if orders := env.scalar(t, "SELECT COUNT(*) FROM ranking_variant WHERE ranking_list_id = ?", body.List.ID); orders.String != "0" {
		t.Fatalf("orders of a deleted list = %s", orders.String)
	}
}

func TestRankingRetentionKeepsDaysAndProtectedSnapshots(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	now := time.Date(2026, time.October, 25, 3, 0, 0, 0, time.UTC)
	trackedList := env.addRankingList(t, rankingProviderDLsite, nil, "day", true)
	finishedList := env.addAnnualRankingList(t, 2020, false)
	env.exec(t, `UPDATE ranking_list SET final_at = '2021-01-03 00:00:00' WHERE id = `+strconv.FormatInt(finishedList.ID, 10))
	tracked := env.rankingVariant(t, trackedList, "", "")
	trackedSales := env.rankingVariant(t, trackedList, "", rankingSortSales)
	finished := env.rankingVariant(t, finishedList, "", "")
	snapshot := func(variant rankingVariant, hash, pulledAt string, codes ...string) {
		t.Helper()
		result, err := env.db.Exec(`INSERT INTO ranking_snapshot (ranking_variant_id, pulled_at, confirmed_until, item_count, content_hash) VALUES (?, ?, ?, ?, ?)`,
			variant.ID, pulledAt, pulledAt, len(codes), hash)
		if err != nil {
			t.Fatal(err)
		}
		id, _ := result.LastInsertId()
		for index, code := range codes {
			env.exec(t, `INSERT INTO ranking_snapshot_item (snapshot_id, rank, primary_code) VALUES (`+strconv.FormatInt(id, 10)+`, `+strconv.Itoa(index+1)+`, '`+code+`')`)
			env.exec(t, `INSERT INTO ranking_entry (ranking_variant_id, primary_code, first_seen_at, streak_started_at, last_seen_at, best_rank)
				VALUES (`+strconv.FormatInt(variant.ID, 10)+`, '`+code+`', '`+pulledAt+`', '`+pulledAt+`', '`+pulledAt+`', 1) ON CONFLICT DO NOTHING`)
		}
	}
	// One order replaced beyond the daily retention, one still in effect a
	// year ago, then three pulls on one day in Japan whose last is at 23:00
	// there, and the next day at 01:00 there, both on one UTC day. The sales
	// order's only snapshot is old but still its latest.
	snapshot(tracked, "beyond-daily", "2023-01-01 00:00:00", "RJ00000040")
	snapshot(trackedSales, "other-order", "2023-01-02 00:00:00", "RJ00000049")
	snapshot(tracked, "in-effect-a-year-ago", "2023-01-05 00:00:00", "RJ00000041")
	snapshot(tracked, "morning", "2026-06-01 01:00:00", "RJ00000042")
	snapshot(tracked, "seen", "2026-06-01 05:00:00", "RJ00000043")
	snapshot(tracked, "day-end", "2026-06-01 14:00:00", "RJ00000044")
	snapshot(tracked, "next-day", "2026-06-01 16:00:00", "RJ00000045")
	snapshot(tracked, "recent", "2026-10-20 00:00:00", "RJ00000046")
	snapshot(tracked, "latest", "2026-10-24 00:00:00", "RJ00000046")
	snapshot(finished, "final-a", "2021-01-02 00:00:00", "RJ00000047")
	snapshot(finished, "final-b", "2021-01-02 01:00:00", "RJ00000048")
	viewer := env.addUser(t, "ranking-history-viewer", "user")
	env.exec(t, `INSERT INTO user_ranking_state (user_id, ranking_variant_id, seen_snapshot_id)
		SELECT `+strconv.FormatInt(viewer, 10)+`, ranking_variant_id, id FROM ranking_snapshot WHERE content_hash = 'seen'`)

	kept := func() string {
		t.Helper()
		rows, err := env.db.Query("SELECT content_hash FROM ranking_snapshot ORDER BY pulled_at, id")
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		hashes := []string{}
		for rows.Next() {
			var hash string
			_ = rows.Scan(&hash)
			hashes = append(hashes, hash)
		}
		return strings.Join(hashes, ",")
	}
	if count, err := env.server.countOldRankingSnapshots(context.Background(), now); err != nil || count != 2 {
		t.Fatalf("removable = %d %v", count, err)
	}
	removed, err := env.server.cleanupOldRankingSnapshots(context.Background(), now)
	if err != nil || removed != 2 {
		t.Fatalf("removed = %d %v", removed, err)
	}
	if got, want := kept(), "final-a,final-b,other-order,in-effect-a-year-ago,seen,day-end,next-day,recent,latest"; got != want {
		t.Fatalf("kept = %s, want %s", got, want)
	}
	entries := env.scalar(t, "SELECT group_concat(primary_code, ',') FROM (SELECT primary_code FROM ranking_entry ORDER BY primary_code)")
	if entries.String != "RJ00000041,RJ00000043,RJ00000044,RJ00000045,RJ00000046,RJ00000047,RJ00000048,RJ00000049" {
		t.Fatalf("entries = %s", entries.String)
	}

	// Keeping daily history forever keeps the last order of every day.
	env.exec(t, `INSERT INTO ranking_snapshot (ranking_variant_id, pulled_at, confirmed_until, item_count, content_hash)
		VALUES (`+strconv.FormatInt(tracked.ID, 10)+`, '2022-01-01 00:00:00', '2022-01-01 00:00:00', 0, 'old-day-end')`)
	env.exec(t, `INSERT INTO app_setting (key, value_json) VALUES ('`+rankingDailyRetentionKey+`', '0')`)
	if _, err := env.server.cleanupOldRankingSnapshots(context.Background(), now); err != nil {
		t.Fatal(err)
	}
	if got := kept(); !strings.HasPrefix(got, "final-a,final-b,old-day-end,") {
		t.Fatalf("forever kept = %s", got)
	}
}

func TestDemoRankingsShowHistoryAndRefuseChanges(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeDemo})
	env := subscriptionTestEnv{db: db, server: server, adminID: insertWorkflowGraphAPIUser(t, db, "demo-ranking-admin")}

	var overview rankingOverview
	if response := env.request(t, env.adminID, http.MethodGet, "/api/rankings", nil, server.listRankings); json.Unmarshal(response.Body.Bytes(), &overview) != nil || !overview.Demo || len(overview.Lists) != 5 {
		t.Fatalf("demo overview = %+v", overview)
	}
	if day := overview.Lists[0]; len(day.Variants) != 4 || !day.Variants[0].Unseen || day.Variants[1].Unseen {
		t.Fatalf("demo day orders = %+v", day.Variants)
	}
	latest := env.rankingPage(t, env.adminID, rankingList{ID: 1}, nil)
	if !latest.Demo || latest.Snapshot == nil || latest.PreviousSnapshot == nil || latest.Baseline == nil || latest.Baseline.Kind != "seen" || latest.Counts.New == 0 {
		t.Fatalf("demo latest = %+v", latest)
	}
	history := env.rankingPage(t, env.adminID, rankingList{ID: 1}, url.Values{"at": {"2026-10-13T12:00:00Z"}})
	if history.Snapshot == nil || history.Snapshot.ID != latest.PreviousSnapshot.ID || history.Coverage == nil || history.Coverage.State != "confirmed" || history.NextSnapshot == nil {
		t.Fatalf("demo history = %+v", history)
	}
	sales := env.rankingPage(t, env.adminID, rankingList{ID: 1}, url.Values{"release": {"30d"}, "sort": {"sale"}})
	if sales.Variant.ReleaseWindow != "30d" || sales.Variant.Sort != "sale" || sales.Snapshot == nil || sales.Snapshot.ID == latest.Snapshot.ID || sales.Items[0].Code == latest.Items[0].Code {
		t.Fatalf("demo order = variant %+v snapshot %+v", sales.Variant, sales.Snapshot)
	}
	if response := env.request(t, env.adminID, http.MethodGet, "/api/rankings/3?release=30d", nil, server.getRanking, "id", "3"); response.Code != http.StatusBadRequest {
		t.Fatalf("demo annual new releases = %d", response.Code)
	}
	if snapshots := env.rankingTimeline(t, rankingList{ID: 1}, "sort=sale"); len(snapshots.Snapshots) != 3 || !snapshots.Demo {
		t.Fatalf("demo timeline = %+v", snapshots)
	}
	for _, attempt := range []struct {
		method, target string
		handler        func(http.ResponseWriter, *http.Request)
	}{
		{http.MethodPost, "/api/rankings", server.createRanking},
		{http.MethodPatch, "/api/rankings/1", server.updateRanking},
		{http.MethodDelete, "/api/rankings/1", server.deleteRanking},
		{http.MethodPost, "/api/rankings/refresh", server.runRankingRefresh},
		{http.MethodPut, "/api/rankings/retention", server.updateRankingRetention},
		{http.MethodPost, "/api/rankings/1/metadata-sync", server.createRankingMetadataSyncRun},
		{http.MethodPost, "/api/rankings/1/source-check", server.createRankingSourceCheckRun},
	} {
		if response := env.request(t, env.adminID, attempt.method, attempt.target, map[string]any{}, attempt.handler, "id", "1"); response.Code != http.StatusForbidden {
			t.Fatalf("demo %s %s = %d", attempt.method, attempt.target, response.Code)
		}
	}
}
