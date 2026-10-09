package personal

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func reportFixture(t *testing.T) Store {
	t.Helper()
	s := testStore(t)
	execFixture(t, s.DB, `INSERT INTO logical_work (id,canonical_work_id,canonical_code) VALUES (1,1,'RJ00000000'); INSERT INTO work_edition (work_id,logical_work_id,primary_code,is_canonical) VALUES (1,1,'RJ00000000',1),(2,1,'RJ00000001',0); INSERT INTO media_item (id,work_id,kind,title,fingerprint) VALUES (1,2,'audio','Example Track','synthetic-track'); INSERT INTO file_source (id,code,display_name,source_type) VALUES (1,'example_local','Example Local','local'); INSERT INTO media_file_location (id,media_item_id,file_source_id,location_type,path,availability) VALUES (1,1,1,'local','Library/RJ00000001/track.mp3','local')`)
	return s
}

func datedFixture(seconds float64) SessionInput {
	return SessionInput{SessionID: "synthetic-session-a", WorkID: 2, ListenedSeconds: seconds, StartedAt: "2026-01-01T23:59:50Z", LastListenedAt: "2026-01-02T00:01:00Z", Days: []SessionDay{{Day: "2026-01-01", ListenedSeconds: 10}, {Day: "2026-01-02", ListenedSeconds: seconds - 10}}}
}
func progressFixture(order int64, position float64) ProgressInput {
	location := int64(1)
	return ProgressInput{ReportID: "synthetic-progress-a", Order: order, MediaItemID: 1, LocationID: &location, PositionSeconds: position}
}

func TestPlaybackReportsOrderBackwardSeeksAndAttributeOfflineUTC(t *testing.T) {
	s := reportFixture(t)
	ctx := context.Background()
	for _, tc := range []struct {
		order             int64
		position, seconds float64
		status            string
	}{{1000, 120, 30, "recorded"}, {2000, 20, 45, "recorded"}, {1000, 120, 30, "stale"}, {2000, 20, 45, "stale"}} {
		result, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{progressFixture(tc.order, tc.position)}, History: []SessionInput{datedFixture(tc.seconds)}})
		if err != nil || result.Progress[0].Status != tc.status {
			t.Fatalf("batch = %+v, %v", result, err)
		}
	}
	var work int64
	var position float64
	if err := s.DB.QueryRow(`SELECT work_id,position_seconds FROM user_work_playback_cursor WHERE user_id=1`).Scan(&work, &position); err != nil || work != 1 || position != 20 {
		t.Fatalf("canonical cursor = %d/%v: %v", work, position, err)
	}
	stats, err := s.StatisticsFor(ctx, 1, RangeAll, time.Date(2026, 1, 2, 0, 2, 0, 0, time.UTC))
	if err != nil || stats.ListenedSeconds != 45 || stats.ListenCount != 1 || len(stats.Daily) != 2 || stats.Daily[0].Date != "2026-01-01" || stats.Daily[0].ListenedSeconds != 10 || stats.Daily[1].ListenedSeconds != 35 {
		t.Fatalf("UTC stats = %+v: %v", stats, err)
	}
	page, err := s.History(ctx, 1, "", 1, 30)
	if err != nil || page.Items[0].LastPlayedAt != "2026-01-02 00:01:00" {
		t.Fatalf("occurrence history = %+v: %v", page, err)
	}
	if _, err = s.RecordPlaybackReport(ctx, 2, PlaybackReport{History: []SessionInput{datedFixture(30)}}); err != nil {
		t.Fatal(err)
	}
	other, err := s.Statistics(ctx, 2)
	if err != nil || other.ListenedSeconds != 30 {
		t.Fatalf("other account = %+v %v", other, err)
	}
}

func TestPlaybackReportHistoryRejectionDoesNotStopProgressAndUnexpectedFailureRollsBack(t *testing.T) {
	s := reportFixture(t)
	ctx := context.Background()
	if err := s.ClearHistory(ctx, 1); err != nil {
		t.Fatal(err)
	}
	result, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{progressFixture(1000, 20)}, History: []SessionInput{datedFixture(30)}})
	if err != nil || result.Generation != 1 || result.Progress[0].Status != "recorded" || result.History[0].Status != "history_cleared" {
		t.Fatalf("partial acknowledgement = %+v %v", result, err)
	}
	var count int
	if err = s.DB.QueryRow(`SELECT COUNT(*) FROM user_listening_session`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("history returned: %d %v", count, err)
	}
	execFixture(t, s.DB, `CREATE TRIGGER synthetic_failure BEFORE INSERT ON user_listening_session BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`)
	history := datedFixture(30)
	history.Generation = 1
	if _, err = s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{progressFixture(2000, 50)}, History: []SessionInput{history}}); err == nil {
		t.Fatal("unexpected persistence failure accepted")
	}
	var position float64
	if err = s.DB.QueryRow(`SELECT position_seconds FROM user_work_playback_cursor WHERE user_id=1`).Scan(&position); err != nil || position != 20 {
		t.Fatalf("failed transaction cursor = %v %v", position, err)
	}
}

func TestPlaybackReportRejectsInvalidDatesAndInconsistentCumulativeBuckets(t *testing.T) {
	s := reportFixture(t)
	ctx := context.Background()
	first := datedFixture(30)
	if err := s.RecordSession(ctx, 1, first); err != nil {
		t.Fatal(err)
	}
	inconsistent := datedFixture(45)
	inconsistent.Days[0].ListenedSeconds = 5
	inconsistent.Days[1].ListenedSeconds = 40
	invalid := datedFixture(45)
	invalid.Days[0].Day = "2026-02-30"
	for _, tc := range []struct {
		input  SessionInput
		status string
	}{{inconsistent, "conflict"}, {invalid, "invalid"}} {
		result, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{History: []SessionInput{tc.input}})
		if err != nil || result.History[0].Status != tc.status {
			t.Fatalf("invalid report = %+v %v", result, err)
		}
	}
	stats, err := s.Statistics(ctx, 1)
	if err != nil || stats.ListenedSeconds != 30 {
		t.Fatalf("rejected input changed totals: %+v %v", stats, err)
	}
	if err = s.ClearHistory(ctx, 1); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = s.DB.QueryRow(`SELECT COUNT(*) FROM user_listening_session_day`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("clear left per-session dates: %d %v", count, err)
	}
}

func TestPlaybackReportUsesCanonicalEditionWhenLogicalPointerIsAbsent(t *testing.T) {
	s := reportFixture(t)
	execFixture(t, s.DB, `UPDATE logical_work SET canonical_work_id=NULL`)
	result, err := s.RecordPlaybackReport(context.Background(), 1, PlaybackReport{Progress: []ProgressInput{progressFixture(1000, 20)}})
	if err != nil || result.Progress[0].Cursor == nil || result.Progress[0].Cursor.WorkID != 1 || result.Progress[0].Cursor.MediaWorkID != 2 {
		t.Fatalf("canonical edition fallback = %+v %v", result, err)
	}
	if identity := result.Progress[0].Identity; identity == nil || identity.WorkID != 1 || !reflect.DeepEqual(identity.EditionWorkIDs, []int64{1, 2}) {
		t.Fatalf("canonical identity fallback = %+v", identity)
	}
}

func TestPlaybackReportIdentifiesRecordedAndStaleFamiliesWithoutReturningStaleCursors(t *testing.T) {
	s := reportFixture(t)
	execFixture(t, s.DB, `INSERT INTO work_edition (work_id,logical_work_id,primary_code,is_canonical) VALUES (3,1,?,0)`, testfixture.WorkCode(testfixture.PrefixRJ, 2))
	execFixture(t, s.DB, `INSERT INTO work (id,primary_code,title) VALUES (4,?,'Example Work 4')`, testfixture.WorkCode(testfixture.PrefixRJ, 3))
	execFixture(t, s.DB, `INSERT INTO media_item (id,work_id,kind,title,fingerprint) VALUES (4,4,'audio','Example Track 4','synthetic-track-4')`)
	ctx := context.Background()
	b := progressFixture(3000, 80)
	b.ReportID, b.MediaItemID, b.LocationID = "synthetic-progress-b", 4, nil
	if _, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{b}}); err != nil {
		t.Fatal(err)
	}
	b.Order, b.PositionSeconds = 2000, 20
	a := progressFixture(1000, 120)
	result, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{a, b}})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Progress) != 2 || result.Progress[0].ReportID != a.ReportID || result.Progress[1].ReportID != b.ReportID {
		t.Fatalf("report association = %+v", result)
	}
	first, second := result.Progress[0], result.Progress[1]
	if first.Status != "recorded" || first.Cursor == nil || first.Identity == nil || first.Identity.WorkID != 1 || !reflect.DeepEqual(first.Identity.EditionWorkIDs, []int64{1, 2, 3}) {
		t.Fatalf("recorded family = %+v", first)
	}
	if second.Status != "stale" || second.Cursor != nil || second.Identity == nil || second.Identity.WorkID != 4 || !reflect.DeepEqual(second.Identity.EditionWorkIDs, []int64{4}) {
		t.Fatalf("unrelated stale family = %+v", second)
	}
	// A replay retains identity, even though no new cursor was written. The
	// family includes the as-yet unplayed third edition, never unrelated works.
	result, err = s.RecordPlaybackReport(ctx, 1, PlaybackReport{Progress: []ProgressInput{a}})
	if err != nil || result.Progress[0].Status != "stale" || result.Progress[0].Cursor != nil || !reflect.DeepEqual(result.Progress[0].Identity, first.Identity) {
		t.Fatalf("stale edition identity = %+v %v", result, err)
	}
}
