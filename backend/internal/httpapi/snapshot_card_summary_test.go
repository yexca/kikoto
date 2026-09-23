package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// cardSnapshotJSON is a synthetic DLsite envelope that exercises every card
// field: a translated edition, dynamic rating count, and duplicate tags/actors.
func cardSnapshotJSON(code string, originCode string, circle string) string {
	return `{
		"product": {
			"workno": "` + code + `",
			"maker_name": " ` + circle + ` ",
			"maker_id": "rg00000001",
			"release_date": "2024-01-02",
			"series_name": "Example Series",
			"translation_info": {"lang": "ENG"},
			"language_editions": [
				{"workno": "` + originCode + `", "display_order": 1, "label": "Japanese", "lang": "JPN"},
				{"workno": "` + code + `", "display_order": 2, "label": "English", "lang": "ENG"}
			],
			"genres": [{"name": "Example Tag"}, {"name": "Example Tag"}, {"name_base": "Base Tag"}],
			"creaters": {"voice_by": [{"name": "Example Voice"}, {"name": "Example Voice"}, {"name": "Second Voice"}]}
		},
		"dynamic": {"rate_count": 12},
		"_kikoto": {"edition_language": "ENG"}
	}`
}

type snapshotCardFields struct {
	Circle, CircleExternalID, BaseCode, Series string
	EditionCodes                               []string
	ReleaseDate                                *string
	RatingCount                                *int64
	Tags, VoiceActors                          []string
}

func cardFieldsOf(metadata dlsiteSnapshotMetadata) snapshotCardFields {
	fields := snapshotCardFields{
		Circle: metadata.Circle, CircleExternalID: metadata.CircleExternalID, BaseCode: metadata.BaseCode,
		Series: metadata.Series, ReleaseDate: metadata.ReleaseDate, RatingCount: metadata.RatingCount,
		Tags: metadata.Tags, VoiceActors: metadata.VoiceActors,
	}
	for _, edition := range metadata.LanguageEditions {
		fields.EditionCodes = append(fields.EditionCodes, edition.PrimaryCode)
	}
	return fields
}

func TestDLsiteCardSummaryPreservesSnapshotCardFields(t *testing.T) {
	code := testfixture.WorkCode(testfixture.PrefixRJ, 10)
	originCode := testfixture.WorkCode(testfixture.PrefixRJ, 11)
	for name, raw := range map[string]string{
		"translated edition": cardSnapshotJSON(code, originCode, "Example Circle"),
		"sparse product":     `{"workno": "` + code + `"}`,
		"invalid snapshot":   `not json`,
		"empty snapshot":     ``,
	} {
		t.Run(name, func(t *testing.T) {
			summary, err := encodeDLsiteCardSummary(raw)
			if err != nil {
				t.Fatal(err)
			}
			want := cardFieldsOf(parseDLsiteSnapshot(raw))
			// The raw snapshot argument is deliberately wrong: a current summary
			// must be used on its own.
			got := cardFieldsOf(dlsiteCardMetadata(summary, `{"maker_name": "Wrong"}`))
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("summary card fields = %+v, want %+v (summary %s)", got, want, summary)
			}
		})
	}
	if got := dlsiteCardMetadata(`{"v": 0, "circle": "Outdated"}`, cardSnapshotJSON(code, originCode, "Snapshot Circle")); got.Circle != "Snapshot Circle" {
		t.Fatalf("outdated summary circle = %q, want the raw snapshot", got.Circle)
	}
}

type snapshotCardTestWorks struct {
	db       *sql.DB
	server   *Server
	personID int64
}

func newSnapshotCardTestWorks(t *testing.T) snapshotCardTestWorks {
	t.Helper()
	db := openMigratedTestDB(t)
	originCode := testfixture.WorkCode(testfixture.PrefixRJ, 11)
	personResult, err := db.Exec("INSERT INTO person (display_name) VALUES ('Example Voice')")
	if err != nil {
		t.Fatal(err)
	}
	personID, _ := personResult.LastInsertId()
	for index, ordinal := range []int{10, 12} {
		code := testfixture.WorkCode(testfixture.PrefixRJ, ordinal)
		result, err := db.Exec("INSERT INTO work (primary_code, title, age_rating) VALUES (?, ?, 'R18')", code, "Example Work "+code)
		if err != nil {
			t.Fatal(err)
		}
		workID, _ := result.LastInsertId()
		if _, err := db.Exec(`INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
			SELECT ?, id, ?, ? FROM metadata_provider WHERE code = 'dlsite'`,
			workID, code, cardSnapshotJSON(code, originCode, "Example Circle "+string(rune('A'+index)))); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO work_credit (work_id, person_id, role) VALUES (?, ?, 'voice_actor')", workID, personID); err != nil {
			t.Fatal(err)
		}
	}
	return snapshotCardTestWorks{db: db, server: NewServer(db, config.Config{}), personID: personID}
}

func (fixture snapshotCardTestWorks) listBody(t *testing.T) string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/works?page=1&pageSize=10&sort=recent&direction=desc", nil)
	recorder := httptest.NewRecorder()
	fixture.server.listWorks(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list works status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	return recorder.Body.String()
}

func (fixture snapshotCardTestWorks) voiceBody(t *testing.T) string {
	t.Helper()
	works, err := fixture.server.loadVoiceKnownWorks(context.Background(), 0, fixture.personID)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(works)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func (fixture snapshotCardTestWorks) rawRows(t *testing.T) []library.RawWork {
	t.Helper()
	page, err := fixture.server.libraryStore.ListPage(context.Background(), library.ListOptions{Page: 1, PageSize: 10, Sort: "recent", Direction: "desc"})
	if err != nil {
		t.Fatal(err)
	}
	if len(page.Works) != 2 {
		t.Fatalf("raw rows = %d, want 2", len(page.Works))
	}
	return page.Works
}

func TestLibraryAndVoiceCardsMatchWithAndWithoutSnapshotCardSummary(t *testing.T) {
	fixture := newSnapshotCardTestWorks(t)
	for _, row := range fixture.rawRows(t) {
		if row.CardSummary != "" || row.Snapshot == "" {
			t.Fatalf("unsummarized row = summary %q, snapshot %d bytes; want raw snapshot fallback", row.CardSummary, len(row.Snapshot))
		}
	}
	fallbackList := fixture.listBody(t)
	fallbackVoice := fixture.voiceBody(t)
	var listed struct {
		Works []libraryWorkSummary `json:"works"`
	}
	if err := json.Unmarshal([]byte(fallbackList), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Works) != 2 || listed.Works[0].Circle == "" || listed.Works[0].RatingCount == nil ||
		len(listed.Works[0].Tags) == 0 || len(listed.Works[0].VoiceActors) == 0 || listed.Works[0].Series == "" {
		t.Fatalf("fallback list lacks card metadata: %s", fallbackList)
	}

	written, err := fixture.server.backfillSnapshotCardSummaries(context.Background(), 200)
	if err != nil || written != 2 {
		t.Fatalf("backfill = %d, %v; want 2 summaries", written, err)
	}
	for _, row := range fixture.rawRows(t) {
		if row.CardSummary == "" || row.Snapshot != "" {
			t.Fatalf("summarized row = summary %q, snapshot %d bytes; want summary only", row.CardSummary, len(row.Snapshot))
		}
	}
	if got := fixture.listBody(t); got != fallbackList {
		t.Fatalf("summarized list differs from fallback\n got: %s\nwant: %s", got, fallbackList)
	}
	if got := fixture.voiceBody(t); got != fallbackVoice {
		t.Fatalf("summarized voice works differ from fallback\n got: %s\nwant: %s", got, fallbackVoice)
	}
}

func TestSnapshotCardSummaryIsInvalidatedWhenSnapshotContentChanges(t *testing.T) {
	fixture := newSnapshotCardTestWorks(t)
	if _, err := fixture.server.backfillSnapshotCardSummaries(context.Background(), 200); err != nil {
		t.Fatal(err)
	}
	var snapshotID int64
	if err := fixture.db.QueryRow("SELECT MIN(id) FROM metadata_snapshot").Scan(&snapshotID); err != nil {
		t.Fatal(err)
	}
	counts := func() (summaries int, queued int) {
		t.Helper()
		if err := fixture.db.QueryRow(`SELECT
			(SELECT COUNT(*) FROM metadata_snapshot_card_summary WHERE snapshot_id = ?),
			(SELECT COUNT(*) FROM metadata_snapshot_card_summary_dirty WHERE snapshot_id = ?)`, snapshotID, snapshotID).Scan(&summaries, &queued); err != nil {
			t.Fatal(err)
		}
		return summaries, queued
	}

	if _, err := fixture.db.Exec("UPDATE metadata_snapshot SET fetched_at = '2030-01-01 00:00:00', snapshot_json = snapshot_json WHERE id = ?", snapshotID); err != nil {
		t.Fatal(err)
	}
	if summaries, queued := counts(); summaries != 1 || queued != 0 {
		t.Fatalf("after unchanged rewrite: summaries %d, queued %d; want 1, 0", summaries, queued)
	}

	code := testfixture.WorkCode(testfixture.PrefixRJ, 10)
	changed := cardSnapshotJSON(code, testfixture.WorkCode(testfixture.PrefixRJ, 11), "Changed Circle")
	if _, err := fixture.db.Exec("UPDATE metadata_snapshot SET snapshot_json = ? WHERE id = ?", changed, snapshotID); err != nil {
		t.Fatal(err)
	}
	if summaries, queued := counts(); summaries != 0 || queued != 1 {
		t.Fatalf("after content change: summaries %d, queued %d; want 0, 1", summaries, queued)
	}
	if written, err := fixture.server.backfillSnapshotCardSummaries(context.Background(), 200); err != nil || written != 1 {
		t.Fatalf("backfill after change = %d, %v; want 1", written, err)
	}
	var summary string
	if err := fixture.db.QueryRow("SELECT summary_json FROM metadata_snapshot_card_summary WHERE snapshot_id = ?", snapshotID).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if got := dlsiteCardMetadata(summary, "").Circle; got != "Changed Circle" {
		t.Fatalf("rebuilt summary circle = %q, want Changed Circle", got)
	}

	if _, err := fixture.db.Exec("DELETE FROM metadata_snapshot WHERE id = ?", snapshotID); err != nil {
		t.Fatal(err)
	}
	if summaries, queued := counts(); summaries != 0 || queued != 0 {
		t.Fatalf("after snapshot delete: summaries %d, queued %d; want 0, 0", summaries, queued)
	}
}

func TestBackfillSnapshotCardSummariesIsBoundedAndRewritesOutdatedVersions(t *testing.T) {
	fixture := newSnapshotCardTestWorks(t)
	ctx := context.Background()
	queued := func() int {
		t.Helper()
		var count int
		if err := fixture.db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot_card_summary_dirty").Scan(&count); err != nil {
			t.Fatal(err)
		}
		return count
	}
	if written, err := fixture.server.backfillSnapshotCardSummaries(ctx, 1); err != nil || written != 1 || queued() != 1 {
		t.Fatalf("first bounded pass = %d, %v, %d queued; want 1 written and 1 queued", written, err, queued())
	}
	if written, err := fixture.server.backfillSnapshotCardSummaries(ctx, 1); err != nil || written != 1 || queued() != 0 {
		t.Fatalf("second bounded pass = %d, %v, %d queued; want 1 written and none queued", written, err, queued())
	}
	if written, err := fixture.server.backfillSnapshotCardSummaries(ctx, 1); err != nil || written != 0 {
		t.Fatalf("drained pass = %d, %v; want 0", written, err)
	}

	if _, err := fixture.db.Exec("UPDATE metadata_snapshot_card_summary SET version = ? WHERE snapshot_id = (SELECT MIN(snapshot_id) FROM metadata_snapshot_card_summary)", library.SnapshotCardSummaryVersion-1); err != nil {
		t.Fatal(err)
	}
	rows := fixture.rawRows(t)
	outdatedRows := 0
	for _, row := range rows {
		if row.CardSummary == "" && row.Snapshot != "" {
			outdatedRows++
		}
	}
	if outdatedRows != 1 {
		t.Fatalf("rows reading the raw snapshot for an outdated summary = %d, want 1", outdatedRows)
	}
	if written, err := fixture.server.backfillSnapshotCardSummaries(ctx, 200); err != nil || written != 1 {
		t.Fatalf("outdated-version pass = %d, %v; want 1", written, err)
	}
	var outdated int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot_card_summary WHERE version <> ?", library.SnapshotCardSummaryVersion).Scan(&outdated); err != nil {
		t.Fatal(err)
	}
	if outdated != 0 || queued() != 0 {
		t.Fatalf("after rewrite: %d outdated summaries, %d queued; want none", outdated, queued())
	}
}
