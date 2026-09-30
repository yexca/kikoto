package personal

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func testStore(t *testing.T) Store {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "personal.db"))
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = db.Close() })
	if err = storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	execFixture(t, db, `INSERT INTO user_account (id,username,display_name,role) VALUES (1,'synthetic-user','Example User','user'),(2,'synthetic-other','Example Other','user')`)
	for i := 0; i < 3; i++ {
		execFixture(t, db, `INSERT INTO work (id,primary_code,title) VALUES (?,?,?)`, i+1, testfixture.WorkCode(testfixture.PrefixRJ, i), "Example Work")
	}
	return Store{DB: db}
}

func execFixture(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	if _, err := db.Exec(query, args...); err != nil {
		t.Fatal(err)
	}
}

func TestTagsMergeDeduplicatesOwnershipAndUnusedTags(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	execFixture(t, s.DB, `INSERT INTO party (id,display_name) VALUES (1,'Example Circle'),(2,'Example Circle 2'); INSERT INTO person (id,display_name) VALUES (1,'Example Voice'),(2,'Example Voice 2')`)
	for scope, table := range tagScopes {
		t.Run(scope, func(t *testing.T) {
			execFixture(t, s.DB, `INSERT INTO `+table.tags+` (id,user_id,name) VALUES (1,1,'Example One'),(2,1,'Example Two'),(3,2,'Other User'),(4,1,'Unused')`)
			execFixture(t, s.DB, `INSERT INTO `+table.assignments+` (user_id,`+table.entityID+`,`+table.tagID+`) VALUES (1,1,1),(1,1,2),(1,2,1),(2,1,3)`)
			if _, err := s.ChangeTag(ctx, 1, scope, 1, "merge", "", 3); !errors.Is(err, ErrNotFound) {
				t.Fatalf("foreign merge = %v", err)
			}
			if _, err := s.ChangeTag(ctx, 1, scope, 1, "rename", "Example Two", 0); !errors.Is(err, ErrConflict) {
				t.Fatalf("duplicate rename = %v", err)
			}
			if _, err := s.ChangeTag(ctx, 1, scope, 1, "rename", " 睡前 ", 0); err != nil {
				t.Fatal(err)
			}
			tag, err := s.ChangeTag(ctx, 1, scope, 1, "merge", "", 2)
			if err != nil || tag.UsageCount != 2 {
				t.Fatalf("merge = %+v, %v", tag, err)
			}
			page, err := s.Tags(ctx, 1, scope, "", 1, 1)
			if err != nil || page.Total != 2 || len(page.Tags) != 1 {
				t.Fatalf("page = %+v, %v", page, err)
			}
			page, err = s.Tags(ctx, 1, scope, "Unused", 1, 50)
			if err != nil || page.Total != 1 || page.Tags[0].UsageCount != 0 {
				t.Fatalf("unused = %+v, %v", page, err)
			}
			if _, err = s.ChangeTag(ctx, 1, scope, 2, "delete", "", 0); err != nil {
				t.Fatal(err)
			}
			var count int
			if err = s.DB.QueryRow(`SELECT COUNT(*) FROM ` + table.assignments).Scan(&count); err != nil || count != 1 {
				t.Fatalf("assignments after delete = %d, %v", count, err)
			}
		})
	}
}

func TestListeningHistoryIsDurableIdempotentAndAccountScoped(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	for _, seconds := range []float64{15, 30, 30, 10, 45} {
		if err := s.RecordSession(ctx, 1, SessionInput{SessionID: "synthetic-session", WorkID: 1, ListenedSeconds: seconds}); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.RecordSession(ctx, 1, SessionInput{SessionID: "synthetic-session", WorkID: 2, ListenedSeconds: 60}); !errors.Is(err, ErrConflict) {
		t.Fatalf("session reused for other work = %v", err)
	}
	if err := s.RecordSession(ctx, 2, SessionInput{SessionID: "synthetic-session", WorkID: 2, ListenedSeconds: 25}); err != nil {
		t.Fatal(err)
	}
	// Recommendation retention must not affect listening statistics.
	execFixture(t, s.DB, `UPDATE user_listening_session SET created_at='2020-01-01 00:00:00',updated_at='2020-01-01 00:00:00' WHERE user_id=1; DELETE FROM recommendation_event`)
	stats, err := s.Statistics(ctx, 1)
	if err != nil || stats.ListenedSeconds != 45 || stats.ListenCount != 1 || stats.WorkCount != 1 || len(stats.Daily) != 1 || stats.Daily[0].ListenedSeconds != 45 {
		t.Fatalf("stats = %+v, %v", stats, err)
	}
	page, err := s.History(ctx, 1, "RJ00000000", 1, 30)
	if err != nil || page.Total != 1 || page.Items[0].LastPlayedAt != "2020-01-01 00:00:00" {
		t.Fatalf("history = %+v, %v", page, err)
	}
	if err = s.ClearHistory(ctx, 1); err != nil {
		t.Fatal(err)
	}
	// A request already in flight during Clear must not bring the old totals back.
	for _, id := range []string{"synthetic-session", "synthetic-unseen-session"} {
		if err = s.RecordSession(ctx, 1, SessionInput{SessionID: id, WorkID: 1, ListenedSeconds: 60}); !errors.Is(err, ErrHistoryCleared) {
			t.Fatalf("pre-clear session accepted: %v", err)
		}
	}
	stats, err = s.Statistics(ctx, 1)
	if err != nil || stats.WorkCount != 0 {
		t.Fatalf("cleared = %+v, %v", stats, err)
	}
	generation, err := s.ListeningGeneration(ctx, 1)
	if err != nil || generation != 1 {
		t.Fatalf("new generation = %d, %v", generation, err)
	}
	if err = s.RecordSession(ctx, 1, SessionInput{Generation: generation, SessionID: "synthetic-new-session", WorkID: 1, ListenedSeconds: 10}); err != nil {
		t.Fatal(err)
	}
	stats, err = s.Statistics(ctx, 1)
	if err != nil || stats.ListenedSeconds != 10 || stats.ListenCount != 1 {
		t.Fatalf("continued listening = %+v, %v", stats, err)
	}
	stats, err = s.Statistics(ctx, 2)
	if err != nil || stats.ListenedSeconds != 25 {
		t.Fatalf("other account = %+v, %v", stats, err)
	}
}

func TestPersonalDataRoundTripConflictPolicyAndPortableProgress(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	execFixture(t, s.DB, `INSERT INTO media_item (id,work_id,kind,title,track_no,fingerprint) VALUES (1,1,'audio','Example Track',1,'local:synthetic-private-path');
	 INSERT INTO user_work_state (user_id,work_id,listening_status,rating,note) VALUES (1,1,'listening',4,'Example note');
	 INSERT INTO user_work_playback_cursor (user_id,work_id,media_item_id,position_seconds,duration_seconds,last_played_at) VALUES (1,1,1,120,600,'2026-01-01 00:00:00');
	 INSERT INTO user_tag (id,user_id,name,color) VALUES (1,1,'Example Tag',''),(2,1,'Unused','');
	 INSERT INTO user_work_tag (user_id,work_id,user_tag_id) VALUES (1,1,1);
	 INSERT INTO favorite_list (id,user_id,name,kind) VALUES (1,1,'Example Playlist','user'),(2,1,'','marked'),(3,1,'example playlist','user');
	 INSERT INTO favorite_list_item (list_id,work_id,sort_order,note) VALUES (1,1,7,'Example list note');`)
	// Existing personal text may exceed UI-sized names and descriptions. The
	// transfer's file budget applies without silently truncating those values.
	longName, longNote := strings.Repeat("Example ", 15)+"List", strings.Repeat("Example note. ", 1000)
	execFixture(t, s.DB, `UPDATE favorite_list SET name=?,description=? WHERE id=3`, longName, longNote)
	execFixture(t, s.DB, `INSERT INTO favorite_list (id,user_id,name,kind) VALUES (4,1,'example playlist','user')`)
	execFixture(t, s.DB, `UPDATE user_work_state SET note=? WHERE user_id=1 AND work_id=1`, longNote)
	// Non-ASCII case variants are distinct in the existing SQLite tag store.
	execFixture(t, s.DB, `INSERT INTO user_tag (user_id,name) VALUES (1,'Example Ä'),(1,'Example ä')`)
	if err := s.RecordSession(ctx, 1, SessionInput{SessionID: "synthetic-session", WorkID: 1, ListenedSeconds: 30}); err != nil {
		t.Fatal(err)
	}
	data, err := s.Export(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "synthetic-private-path") || strings.Contains(string(data), "sessionId") || strings.Contains(string(data), "userId") {
		t.Fatalf("nonportable data in export: %s", data)
	}
	b, err := ParseImport(ImportRequest{Format: "kikoto", Data: data, Conflict: "keep"})
	if err != nil || len(b.Playlists) != 3 || len(b.Tags) != 4 || b.Works[0].Note != longNote {
		t.Fatalf("parse = %+v, %v", b, err)
	}
	preview, err := s.PreviewImport(ctx, 2, b)
	if err != nil || preview.MatchedWorks != 1 || preview.Conflicts != 0 || preview.UnmatchedProgress != 0 {
		t.Fatalf("preview = %+v, %v", preview, err)
	}
	result, err := s.Import(ctx, 2, b, false)
	if err != nil || result.ImportedWorks != 1 || result.Playlists != 3 {
		t.Fatalf("import = %+v, %v", result, err)
	}
	tags, err := s.Tags(ctx, 2, "work", "", 1, 50)
	if err != nil || tags.Total != 4 {
		t.Fatalf("restored tag definitions = %+v, %v", tags, err)
	}
	var pos float64
	if err = s.DB.QueryRow(`SELECT position_seconds FROM user_work_playback_cursor WHERE user_id=2`).Scan(&pos); err != nil || pos != 120 {
		t.Fatalf("progress = %v, %v", pos, err)
	}
	execFixture(t, s.DB, `UPDATE user_work_state SET listening_status='finished' WHERE user_id=2`)
	result, err = s.Import(ctx, 2, b, false)
	if err != nil || result.SkippedWorks != 1 {
		t.Fatalf("keep existing = %+v, %v", result, err)
	}
	for range 2 {
		if _, err = s.Import(ctx, 2, b, true); err != nil {
			t.Fatal(err)
		}
	}
	stats, err := s.Statistics(ctx, 2)
	if err != nil || stats.ListenedSeconds != 30 || stats.ListenCount != 1 || stats.ActiveDays != 0 {
		t.Fatalf("imported stats = %+v, %v", stats, err)
	}
	var status string
	var favorite bool
	if err = s.DB.QueryRow(`SELECT listening_status,favorite FROM user_work_state WHERE user_id=2 AND work_id=1`).Scan(&status, &favorite); err != nil || status != "listening" || !favorite {
		t.Fatalf("restored status = %s, favorite=%v, %v", status, favorite, err)
	}
}

func TestImportSkipsUnknownWorksAndAmbiguousMediaWithoutMaterializing(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	b := Backup{Format: "kikoto-user-data", Version: 1, Works: []BackupWork{
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 0), ListeningStatus: "finished", Progress: &BackupProgress{MediaWorkCode: testfixture.WorkCode(testfixture.PrefixRJ, 0), MediaTitle: "Example Track", PositionSeconds: 5}},
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 99), ListeningStatus: "paused"},
	}}
	execFixture(t, s.DB, `INSERT INTO media_item (work_id,kind,title) VALUES (1,'audio','Example Track'),(1,'audio','Example Track')`)
	preview, err := s.PreviewImport(ctx, 1, b)
	if err != nil || preview.MatchedWorks != 1 || preview.UnmatchedProgress != 1 || len(preview.MissingCodes) != 1 {
		t.Fatalf("preview = %+v, %v", preview, err)
	}
	result, err := s.Import(ctx, 1, b, false)
	if err != nil || result.ImportedWorks != 1 || result.SkippedWorks != 1 || result.SkippedProgress != 1 {
		t.Fatalf("import = %+v, %v", result, err)
	}
	var works, progress int
	if err = s.DB.QueryRow(`SELECT COUNT(*) FROM work`).Scan(&works); err != nil {
		t.Fatal(err)
	}
	if err = s.DB.QueryRow(`SELECT COUNT(*) FROM user_work_playback_cursor`).Scan(&progress); err != nil {
		t.Fatal(err)
	}
	if works != 3 || progress != 0 {
		t.Fatalf("created works/progress = %d/%d", works, progress)
	}
}

func TestKikoeruStatusesAndStrictImportValidation(t *testing.T) {
	// Explicit zero-prefixed literals exercise the catalog's supported widths.
	for _, code := range []string{"RJ00000", "RJ000000", "RJ0000000", "RJ00000000"} {
		data, _ := json.Marshal([]map[string]any{{"source_id": strings.ToLower(code), "progress": "listened"}})
		b, err := ParseImport(ImportRequest{Format: "kikoeru", Data: data})
		if err != nil || b.Works[0].PrimaryCode != code {
			t.Fatalf("catalog code width %s = %+v, %v", code, b, err)
		}
	}
	for source, want := range map[string]string{"marked": "want_to_listen", "listening": "listening", "listened": "finished", "replay": "relisten", "postponed": "paused", "": "none"} {
		data, _ := json.Marshal([]map[string]any{{"source_id": testfixture.WorkCode(testfixture.PrefixRJ, 0), "progress": source, "rating": 4.7, "userRating": 4}})
		b, err := ParseImport(ImportRequest{Format: "kikoeru", Data: data})
		if err != nil || b.Works[0].ListeningStatus != want || *b.Works[0].Rating != 4 {
			t.Fatalf("%s = %+v, %v", source, b, err)
		}
	}
	for _, raw := range []string{
		`{"format":"kikoto-user-data","version":2,"works":[]}`,
		`{"format":"kikoto-user-data","version":1,"credentials":"synthetic-token"}`,
		`{"format":"kikoto-user-data","version":1,"works":[{"primaryCode":"RJ00000000","listeningStatus":"invalid"}]}`,
		`{"format":"kikoto-user-data","version":1} {}`,
	} {
		if _, err := ParseImport(ImportRequest{Format: "kikoto", Data: json.RawMessage(raw)}); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid input accepted: %s, %v", raw, err)
		}
	}
}

func TestImportRollsBackEveryChangeWhenPlaylistWriteFails(t *testing.T) {
	s := testStore(t)
	execFixture(t, s.DB, `CREATE TRIGGER fail_import_list BEFORE INSERT ON favorite_list BEGIN SELECT RAISE(ABORT,'synthetic failure'); END`)
	b := Backup{Works: []BackupWork{{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 0), ListeningStatus: "finished"}}, Tags: []BackupTag{{Scope: "work", Name: "Example Tag"}}, Playlists: []BackupPlaylist{{Name: "Example List"}}}
	if _, err := s.Import(context.Background(), 1, b, false); err == nil {
		t.Fatal("expected import failure")
	}
	var count int
	if err := s.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM user_tag)+(SELECT COUNT(*) FROM user_work_state)`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial writes = %d, %v", count, err)
	}
}

func TestImportBoundsTotalTagAssignments(t *testing.T) {
	b := Backup{}
	for i := range 11 {
		work := BackupWork{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, i), ListeningStatus: "none"}
		for j := range maxTransferTags {
			work.Tags = append(work.Tags, fmt.Sprintf("Example tag %d", j))
		}
		b.Works = append(b.Works, work)
	}
	if err := validateBackup(&b); !errors.Is(err, ErrLimit) {
		t.Fatalf("excess tag assignments = %v", err)
	}
}

func TestListeningStatisticsRangesFillSeriesAndScopeTotals(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Date(2026, time.March, 2, 18, 0, 0, 0, time.FixedZone("synthetic", -5*3600)) // 23:00 UTC
	execFixture(t, s.DB, `INSERT INTO user_listening_day (user_id,work_id,day,listened_seconds,listen_count) VALUES
	 (1,1,'2026-03-02',600,2),(1,2,'2026-02-10',1800,1),(1,1,'2025-06-15',3600,3),(1,3,'2023-01-05',7200,1),(2,1,'2025-12-20',60,1)`)
	execFixture(t, s.DB, `INSERT INTO user_listening_import (user_id,work_id,listened_seconds,listen_count) VALUES (1,3,100,1)`)

	stats, err := s.StatisticsFor(ctx, 1, RangeLast30Days, now)
	if err != nil || stats.Granularity != GranularityDay || len(stats.Series) != 30 || stats.Series[0].Period != "2026-02-01" || stats.Series[29].Period != "2026-03-02" {
		t.Fatalf("30d series = %+v, %v", stats, err)
	}
	if stats.ListenedSeconds != 2400 || stats.ListenCount != 3 || stats.WorkCount != 2 || stats.ActiveDays != 2 || stats.Series[29].ListenedSeconds != 600 || stats.Series[1].ListenedSeconds != 0 {
		t.Fatalf("30d totals = %+v", stats)
	}
	if len(stats.TopWorks) != 2 || stats.TopWorks[0].WorkID != 2 || stats.TopWorks[1].WorkID != 1 {
		t.Fatalf("30d top works = %+v", stats.TopWorks)
	}

	stats, err = s.StatisticsFor(ctx, 1, RangeLast12Months, now)
	if err != nil || stats.Granularity != GranularityMonth || len(stats.Series) != 12 || stats.Series[0].Period != "2025-04" || stats.Series[11].Period != "2026-03" {
		t.Fatalf("12m series = %+v, %v", stats, err)
	}
	if stats.ListenedSeconds != 6000 || stats.Series[2].ListenedSeconds != 3600 || stats.TopWorks[0].WorkID != 1 || stats.TopWorks[0].ListenedSeconds != 4200 {
		t.Fatalf("12m totals = %+v", stats)
	}

	// All time spans more than three years, so it is charted by year, and its
	// totals include imported history that has no dates.
	stats, err = s.StatisticsFor(ctx, 1, RangeAll, now)
	if err != nil || stats.Granularity != GranularityYear || len(stats.Series) != 4 || stats.Series[0].Period != "2023" || stats.Series[0].ListenedSeconds != 7200 {
		t.Fatalf("all series = %+v, %v", stats, err)
	}
	if stats.ListenedSeconds != 100 || stats.ActiveDays != 4 || len(stats.TopWorks) != 1 || stats.TopWorks[0].WorkID != 3 {
		t.Fatalf("all totals = %+v", stats)
	}
	stats, err = s.StatisticsFor(ctx, 2, RangeAll, now)
	if err != nil || stats.Granularity != GranularityMonth || len(stats.Series) != 4 || stats.Series[0].Period != "2025-12" {
		t.Fatalf("short all-time series = %+v, %v", stats, err)
	}

	if _, err = ParseStatisticsRange("7d"); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown range = %v", err)
	}
	if period, err := ParseStatisticsRange(""); err != nil || period != RangeAll {
		t.Fatalf("default range = %q, %v", period, err)
	}
}
