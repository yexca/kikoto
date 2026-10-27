package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

type subscriptionTestEnv struct {
	db      *sqlutil.DB
	server  *Server
	adminID int64
}

func newSubscriptionTestEnv(t *testing.T) subscriptionTestEnv {
	t.Helper()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	return subscriptionTestEnv{db: db, server: server, adminID: insertWorkflowGraphAPIUser(t, db, "subscriber-one")}
}

func (env subscriptionTestEnv) exec(t *testing.T, statements ...string) {
	t.Helper()
	for _, statement := range statements {
		if _, err := env.db.Exec(statement); err != nil {
			t.Fatalf("%v\n%s", err, statement)
		}
	}
}

// addCircle stores a circle with the given catalog codes. A pulled catalog
// records a successful pull at pulledAt.
func (env subscriptionTestEnv) addCircle(t *testing.T, partyID int64, makerID string, codes []string, pulledAt string) {
	t.Helper()
	if _, err := env.db.Exec(`INSERT INTO party (id, display_name) VALUES (?, ?)`, partyID, "Example Circle "+makerID); err != nil {
		t.Fatal(err)
	}
	if _, err := env.db.Exec(`
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
		VALUES (?, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'maker_id', ?, 1)
	`, partyID, makerID); err != nil {
		t.Fatal(err)
	}
	for _, code := range codes {
		env.addCatalogCode(t, partyID, code)
	}
	if pulledAt != "" {
		if _, err := env.db.Exec(`
			INSERT INTO party_catalog_refresh_state (party_id, provider_code, last_success_at) VALUES (?, 'dlsite', ?)
			ON CONFLICT(party_id, provider_code) DO UPDATE SET last_success_at = excluded.last_success_at
		`, partyID, pulledAt); err != nil {
			t.Fatal(err)
		}
	}
}

func (env subscriptionTestEnv) addCatalogCode(t *testing.T, partyID int64, code string) {
	t.Helper()
	if _, err := env.db.Exec(`
		INSERT INTO party_catalog_item (party_id, provider_id, primary_code, catalog_status)
		VALUES (?, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), ?, 'catalog')
	`, partyID, code); err != nil {
		t.Fatal(err)
	}
}

func (env subscriptionTestEnv) request(t *testing.T, userID int64, method, target string, body any, handler func(http.ResponseWriter, *http.Request), pathValues ...string) *httptest.ResponseRecorder {
	t.Helper()
	var reader *strings.Reader
	if body != nil {
		reader = strings.NewReader(mustJSON(body))
	} else {
		reader = strings.NewReader("")
	}
	request := httptest.NewRequest(method, target, reader)
	for index := 0; index+1 < len(pathValues); index += 2 {
		request.SetPathValue(pathValues[index], pathValues[index+1])
	}
	var role string
	if err := env.db.QueryRow("SELECT role FROM user_account WHERE id = ?", userID).Scan(&role); err != nil {
		t.Fatal(err)
	}
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: userID, Role: role, Permissions: account.PermissionsForRole(role)}))
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func recentPull() string {
	return time.Now().UTC().Add(-time.Hour).Format(time.RFC3339)
}

func TestSubscribingToACircleCoversItsSeries(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	env.addCircle(t, 10, "RG00001", []string{"RJ00000001"}, recentPull())
	env.exec(t, `INSERT INTO party_series (party_id, provider_id, title_id, name)
		VALUES (10, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'SRI0000000001', 'Example Series 1')`)

	series := env.request(t, env.adminID, http.MethodPost, "/api/subscriptions", map[string]any{"kind": "series", "circleId": "RG00001", "seriesId": "SRI0000000001"}, env.server.createCreatorSubscription)
	if series.Code != http.StatusCreated {
		t.Fatalf("series subscription = %d %s", series.Code, series.Body.String())
	}
	circle := env.request(t, env.adminID, http.MethodPost, "/api/subscriptions", map[string]any{"kind": "circle", "circleId": "RG00001"}, env.server.createCreatorSubscription)
	if circle.Code != http.StatusConflict || !strings.Contains(circle.Body.String(), "series_will_be_removed") {
		t.Fatalf("circle subscription without confirmation = %d %s", circle.Code, circle.Body.String())
	}
	circle = env.request(t, env.adminID, http.MethodPost, "/api/subscriptions", map[string]any{"kind": "circle", "circleId": "RG00001", "replaceSeries": true}, env.server.createCreatorSubscription)
	if circle.Code != http.StatusCreated {
		t.Fatalf("confirmed circle subscription = %d %s", circle.Code, circle.Body.String())
	}
	var created creatorSubscriptionCreated
	if err := json.Unmarshal(circle.Body.Bytes(), &created); err != nil {
		t.Fatal(err)
	}
	if created.Subscription.Status != "active" || len(created.RemovedSeries) != 1 || created.RemovedSeries[0].SeriesName != "Example Series 1" {
		t.Fatalf("circle subscription = %+v", created)
	}
	series = env.request(t, env.adminID, http.MethodPost, "/api/subscriptions", map[string]any{"kind": "series", "circleId": "RG00001", "seriesId": "SRI0000000001"}, env.server.createCreatorSubscription)
	if series.Code != http.StatusConflict || !strings.Contains(series.Body.String(), "covered_by_circle") {
		t.Fatalf("series of a subscribed circle = %d %s", series.Code, series.Body.String())
	}
	var subscriptions int
	if err := env.db.QueryRow("SELECT COUNT(*) FROM creator_subscription WHERE user_id = ?", env.adminID).Scan(&subscriptions); err != nil {
		t.Fatal(err)
	}
	if subscriptions != 1 {
		t.Fatalf("subscriptions = %d, want only the circle", subscriptions)
	}
}

func TestSubscriptionTakesItsBaselineFromTheFirstPullAfterSubscribing(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	env.addCircle(t, 10, "RG00001", []string{"RJ00000001"}, "")
	response := env.request(t, env.adminID, http.MethodPost, "/api/subscriptions", map[string]any{"kind": "circle", "circleId": "RG00001"}, env.server.createCreatorSubscription)
	if response.Code != http.StatusCreated || !strings.Contains(response.Body.String(), `"status":"pending"`) {
		t.Fatalf("subscription to an unpulled circle = %d %s", response.Code, response.Body.String())
	}
	// The first pull lists the whole catalog; none of it is new.
	env.addCatalogCode(t, 10, "RJ00000002")
	env.exec(t, `INSERT INTO party_catalog_refresh_state (party_id, provider_code, last_success_at) VALUES (10, 'dlsite', '2999-01-01T00:00:00Z')`)
	if err := env.server.activateCreatorSubscriptions(context.Background()); err != nil {
		t.Fatal(err)
	}
	var activated bool
	var seen int
	if err := env.db.QueryRow("SELECT activated_at IS NOT NULL FROM creator_subscription WHERE user_id = ?", env.adminID).Scan(&activated); err != nil {
		t.Fatal(err)
	}
	if err := env.db.QueryRow("SELECT COUNT(*) FROM party_release_seen WHERE party_id = 10").Scan(&seen); err != nil {
		t.Fatal(err)
	}
	if !activated || seen != 2 {
		t.Fatalf("activation = %v, baseline codes = %d", activated, seen)
	}
	candidates, err := env.server.creatorReleaseCandidates(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(candidates) != 0 {
		t.Fatalf("baseline candidates = %+v", candidates)
	}
}

// fakeFamilySyncer stores the works a test declares, as a DLsite family sync
// would, without a request.
type fakeFamilySyncer struct {
	db          *sqlutil.DB
	works       map[string]fakeFamilyWork
	unavailable map[string]bool
	calls       []string
}

type fakeFamilyWork struct {
	releaseDate string
	family      string
	canonical   bool
}

func (syncer *fakeFamilySyncer) SyncFamily(ctx context.Context, code string) (metasync.DLsiteFamilySyncResult, error) {
	syncer.calls = append(syncer.calls, code)
	if syncer.unavailable[code] {
		return metasync.DLsiteFamilySyncResult{RequestedCode: code, RequestedUnavailable: true}, nil
	}
	work, ok := syncer.works[code]
	if !ok {
		return metasync.DLsiteFamilySyncResult{RequestedCode: code}, nil
	}
	if err := insertFakeFamilyWork(ctx, syncer.db, code, work); err != nil {
		return metasync.DLsiteFamilySyncResult{}, err
	}
	return metasync.DLsiteFamilySyncResult{RequestedCode: code, SyncedCodes: []string{code}}, nil
}

func insertFakeFamilyWork(ctx context.Context, db *sqlutil.DB, code string, work fakeFamilyWork) error {
	result, err := db.ExecContext(ctx, `INSERT INTO work (primary_code, title, release_date) VALUES (?, ?, ?)`, code, "Example Work "+code[len(code)-2:], work.releaseDate)
	if err != nil {
		return err
	}
	workID, err := result.LastInsertId()
	if err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO logical_work (canonical_code) VALUES (?) ON CONFLICT(canonical_code) DO NOTHING`, work.family); err != nil {
		return err
	}
	if work.canonical {
		if _, err := db.ExecContext(ctx, `UPDATE logical_work SET canonical_work_id = ? WHERE canonical_code = ?`, workID, work.family); err != nil {
			return err
		}
	}
	_, err = db.ExecContext(ctx, `
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, is_canonical)
		VALUES (?, (SELECT id FROM logical_work WHERE canonical_code = ?), ?, ?)
	`, workID, work.family, code, work.canonical)
	return err
}

func TestNewCatalogWorksReachSubscribersFeedsOnce(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	otherID := insertWorkflowGraphAPIUser(t, env.db, "subscriber-two")
	env.addCircle(t, 10, "RG00001", []string{"RJ00000001"}, recentPull())
	env.exec(t, `INSERT INTO party_series (id, party_id, provider_id, title_id, name)
		VALUES (30, 10, (SELECT id FROM metadata_provider WHERE code = 'dlsite'), 'SRI0000000001', 'Example Series 1')`)
	for _, request := range []struct {
		userID int64
		body   map[string]any
	}{
		{env.adminID, map[string]any{"kind": "circle", "circleId": "RG00001"}},
		{otherID, map[string]any{"kind": "series", "circleId": "RG00001", "seriesId": "SRI0000000001"}},
	} {
		if response := env.request(t, request.userID, http.MethodPost, "/api/subscriptions", request.body, env.server.createCreatorSubscription); response.Code != http.StatusCreated {
			t.Fatalf("subscribe = %d %s", response.Code, response.Body.String())
		}
	}
	today := time.Now().UTC().Format("2006-01-02")
	// RJ00000002 is new and in the series, RJ00000003 is new outside it,
	// RJ00000004 surfaced late but was released long ago, RJ00000005 is a new
	// translation of a family released long ago, and RJ00000006 is no longer
	// listed by DLsite.
	for _, code := range []string{"RJ00000002", "RJ00000003", "RJ00000004", "RJ00000005", "RJ00000006"} {
		env.addCatalogCode(t, 10, code)
	}
	env.exec(t, `INSERT INTO party_series_work (series_id, primary_code) VALUES (30, 'RJ00000002')`)
	if err := insertFakeFamilyWork(context.Background(), env.db, "RJ00000007", fakeFamilyWork{releaseDate: "2020-01-01", family: "RJ00000007", canonical: true}); err != nil {
		t.Fatal(err)
	}
	syncer := &fakeFamilySyncer{db: env.db, unavailable: map[string]bool{"RJ00000006": true}, works: map[string]fakeFamilyWork{
		"RJ00000002": {releaseDate: today, family: "RJ00000002", canonical: true},
		"RJ00000003": {releaseDate: today, family: "RJ00000003", canonical: true},
		"RJ00000004": {releaseDate: "2020-01-01", family: "RJ00000004", canonical: true},
		"RJ00000005": {releaseDate: today, family: "RJ00000007", canonical: false},
	}}
	execution := &creatorSubscriptionExecution{result: creatorSubscriptionRunResult{Failures: []string{}}, feed: map[int64][]string{}}
	if err := env.server.processCreatorReleaseCandidates(context.Background(), 0, syncer, execution); err != nil {
		t.Fatal(err)
	}
	feed := func(userID int64) map[string]string {
		rows, err := env.db.Query("SELECT primary_code, event_type FROM user_release_feed_item WHERE user_id = ? ORDER BY primary_code", userID)
		if err != nil {
			t.Fatal(err)
		}
		defer func() { _ = rows.Close() }()
		items := map[string]string{}
		for rows.Next() {
			var code, eventType string
			if err := rows.Scan(&code, &eventType); err != nil {
				t.Fatal(err)
			}
			items[code] = eventType
		}
		return items
	}
	circleFeed, seriesFeed := feed(env.adminID), feed(otherID)
	if len(circleFeed) != 3 || circleFeed["RJ00000002"] != "released" || circleFeed["RJ00000003"] != "released" || circleFeed["RJ00000005"] != "edition" {
		t.Fatalf("circle subscriber feed = %v", circleFeed)
	}
	if len(seriesFeed) != 1 || seriesFeed["RJ00000002"] != "released" {
		t.Fatalf("series subscriber feed = %v", seriesFeed)
	}
	var unseen int
	if err := env.db.QueryRow(`
		SELECT COUNT(*) FROM party_catalog_item AS item
		WHERE item.party_id = 10 AND NOT EXISTS (
			SELECT 1 FROM party_release_seen AS seen WHERE seen.party_id = 10 AND seen.primary_code = item.primary_code
		)
	`).Scan(&unseen); err != nil {
		t.Fatal(err)
	}
	if unseen != 0 {
		t.Fatalf("unseen codes after processing = %d", unseen)
	}
	// A second run finds nothing new and makes no request.
	syncer.calls = nil
	if err := env.server.processCreatorReleaseCandidates(context.Background(), 0, syncer, execution); err != nil {
		t.Fatal(err)
	}
	if len(syncer.calls) != 0 {
		t.Fatalf("second run synced %v", syncer.calls)
	}
}

func TestReleaseFeedGroupsFamiliesAndTracksUnread(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	ctx := context.Background()
	for _, work := range []struct {
		code      string
		canonical bool
	}{{"RJ00000001", true}, {"RJ00000002", false}} {
		if err := insertFakeFamilyWork(ctx, env.db, work.code, fakeFamilyWork{releaseDate: "2026-10-01", family: "RJ00000001", canonical: work.canonical}); err != nil {
			t.Fatal(err)
		}
	}
	env.exec(t,
		`INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind, created_at) VALUES (1, 'RJ00000001', 'released', 'circle', '2026-10-01 00:00:00')`,
		`INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind, created_at) VALUES (1, 'RJ00000002', 'edition', 'circle', '2026-10-03 00:00:00')`,
		`INSERT INTO user_release_feed_item (user_id, primary_code, event_type, subject_kind, created_at) VALUES (1, 'RJ00000003', 'available', 'watch', '2026-10-02 00:00:00')`,
		`INSERT INTO user_release_feed_state (user_id, seen_at) VALUES (1, '2026-10-02 12:00:00')`,
	)
	if env.adminID != 1 {
		t.Fatalf("fixture expects the first account, got %d", env.adminID)
	}
	page, err := env.server.loadReleaseFeed(ctx, env.adminID, 1, 10, time.UTC)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || page.TotalDays != 2 || page.UnreadCount != 1 || len(page.Families) != 2 {
		t.Fatalf("feed page = total %d days %d unread %d families %d", page.Total, page.TotalDays, page.UnreadCount, len(page.Families))
	}
	if page.Families[0].Day != "2026-10-03" || page.Families[1].Day != "2026-10-02" {
		t.Fatalf("family days = %q %q", page.Families[0].Day, page.Families[1].Day)
	}
	family := page.Families[0]
	if !family.Unread || len(family.Events) != 2 || family.Events[0].Type != "edition" || family.Work == nil || family.Work.PrimaryCode != "RJ00000001" {
		t.Fatalf("newest family = %+v", family)
	}
	if page.Families[1].Unread || page.Families[1].Work != nil || page.Families[1].Fallback.Code != "RJ00000003" {
		t.Fatalf("catalog-only family = %+v", page.Families[1])
	}
	if response := env.request(t, env.adminID, http.MethodPost, "/api/subscriptions/feed/seen", nil, env.server.markReleaseFeedSeen); response.Code != http.StatusOK {
		t.Fatalf("mark seen = %d", response.Code)
	}
	count, err := env.server.releaseFeedUnreadCount(ctx, env.adminID)
	if err != nil || count != 0 {
		t.Fatalf("unread after opening the feed = %d %v", count, err)
	}
}

func TestReleaseFeedPagesCountOnlyDaysWithEntriesInTheAccountZone(t *testing.T) {
	tokyo, err := time.LoadLocation("Asia/Tokyo")
	if err != nil {
		t.Fatal(err)
	}
	families := []releaseFeedFamily{
		{Key: "a", LatestAt: "2026-10-14 01:00:00"},
		// 23:30 UTC is the next morning in Tokyo, the same day as the entry above.
		{Key: "b", LatestAt: "2026-10-13 23:30:00"},
		{Key: "c", LatestAt: "2026-10-13 09:00:00"},
		// A week without entries takes no page space.
		{Key: "d", LatestAt: "2026-10-05 09:00:00"},
		{Key: "e", LatestAt: "2026-10-04 09:00:00"},
	}
	keys := func(page []releaseFeedFamily) (out []string) {
		for _, family := range page {
			out = append(out, family.Key+"@"+family.Day)
		}
		return out
	}
	first, total := pageReleaseFeedDays(families, 1, 2, tokyo)
	if total != 4 || !slices.Equal(keys(first), []string{"a@2026-10-14", "b@2026-10-14", "c@2026-10-13"}) {
		t.Fatalf("first page = %v of %d days", keys(first), total)
	}
	second, _ := pageReleaseFeedDays(families, 2, 2, tokyo)
	if !slices.Equal(keys(second), []string{"d@2026-10-05", "e@2026-10-04"}) {
		t.Fatalf("second page = %v", keys(second))
	}
	if beyond, _ := pageReleaseFeedDays(families, 3, 2, tokyo); len(beyond) != 0 {
		t.Fatalf("page past the end = %v", keys(beyond))
	}
	utc, total := pageReleaseFeedDays(families, 1, 2, time.UTC)
	if total != 4 || !slices.Equal(keys(utc), []string{"a@2026-10-14", "b@2026-10-13", "c@2026-10-13"}) {
		t.Fatalf("UTC page = %v of %d days", keys(utc), total)
	}
}

func TestNewlyAvailableWatchTargetsReachEveryWorkflowAccountsFeed(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	listener := env.adminID
	env.exec(t, `INSERT INTO user_account (username, display_name, role) VALUES ('listener-only', 'listener-only', 'user')`)
	env.exec(t, `INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES (900, 'availability_watch', 'Availability Watch', 'running', 'manual')`)
	tx, err := env.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if err := createAvailabilityWatchNotifications(context.Background(), tx, 900, []string{"RJ00000001"}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	rows, err := env.db.Query("SELECT user_id, event_type FROM user_release_feed_item ORDER BY user_id")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	recipients := []int64{}
	for rows.Next() {
		var userID int64
		var eventType string
		if err := rows.Scan(&userID, &eventType); err != nil {
			t.Fatal(err)
		}
		if eventType != "available" {
			t.Fatalf("event type = %s", eventType)
		}
		recipients = append(recipients, userID)
	}
	if len(recipients) != 1 || recipients[0] != listener {
		t.Fatalf("available feed recipients = %v, want only the workflow account", recipients)
	}
}

func TestSubscriptionScheduleIsOnlyConfiguredOnTheSubscriptionsPage(t *testing.T) {
	env := newSubscriptionTestEnv(t)
	if err := env.server.ensureCreatorSubscriptionSchedule(context.Background()); err != nil {
		t.Fatal(err)
	}
	schedule, err := env.server.loadCreatorSubscriptionSchedule(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if schedule.triggerID == 0 || !schedule.Enabled || schedule.IntervalHours != 24 || schedule.NextRunAt == nil {
		t.Fatalf("default schedule = %+v", schedule)
	}
	update := env.request(t, env.adminID, http.MethodPut, "/api/subscriptions/schedule", map[string]any{"intervalHours": 6, "availabilityWatch": false}, env.server.updateCreatorSubscriptionSchedule)
	if update.Code != http.StatusOK || !strings.Contains(update.Body.String(), `"intervalHours":6`) {
		t.Fatalf("schedule update = %d %s", update.Code, update.Body.String())
	}
	deleted := env.request(t, env.adminID, http.MethodDelete, "/api/workflow-triggers/x", nil, env.server.deleteWorkflowTrigger, "id", jsonNumber(schedule.triggerID))
	if deleted.Code != http.StatusConflict {
		t.Fatalf("generic delete of the subscription schedule = %d %s", deleted.Code, deleted.Body.String())
	}
	listener := insertWorkflowGraphAPIUser(t, env.db, "listener")
	env.exec(t, "UPDATE user_account SET role = 'user' WHERE username = 'listener'")
	forbidden := env.request(t, listener, http.MethodPut, "/api/subscriptions/schedule", map[string]any{"intervalHours": 2}, env.server.updateCreatorSubscriptionSchedule)
	if forbidden.Code != http.StatusForbidden {
		t.Fatalf("listener schedule update = %d", forbidden.Code)
	}
}
