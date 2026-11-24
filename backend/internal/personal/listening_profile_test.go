package personal

import (
	"context"
	"errors"
	"math"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestListeningYearReportCoversTheCalendarYear(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Date(2026, time.March, 2, 12, 0, 0, 0, time.UTC)
	for _, statement := range []string{
		`INSERT INTO user_listening_day (user_id,work_id,day,listened_seconds,listen_count) VALUES
		 (1,2,'2024-06-01',100,1),(1,1,'2025-03-10',600,1),(1,2,'2025-03-10',1800,2),(1,1,'2025-12-31',300,1),(1,3,'2026-01-01',900,1),(2,3,'2025-05-05',60,1)`,
		`INSERT INTO person (id,display_name) VALUES (1,'Example Voice A'),(2,'Example Voice B')`,
		`INSERT INTO work_credit (work_id,person_id,role) VALUES (1,1,'voice_actor'),(2,2,'voice_actor')`,
	} {
		execFixture(t, s.DB, statement)
	}

	for _, value := range []string{"25", "0999", "20x5", "+025"} {
		if _, err := ParseStatisticsRange(value); !errors.Is(err, ErrInvalid) {
			t.Fatalf("range %q = %v", value, err)
		}
	}
	period, err := ParseStatisticsRange("2025")
	if err != nil {
		t.Fatal(err)
	}
	stats, err := s.StatisticsFor(ctx, 1, period, now)
	if err != nil || stats.ListenedSeconds != 2700 || stats.WorkCount != 2 || stats.ActiveDays != 2 || stats.Today != "2025-12-31" || stats.Granularity != GranularityMonth {
		t.Fatalf("2025 = %+v, %v", stats, err)
	}
	if len(stats.Series) != 12 || stats.Series[0].Period != "2025-01" || stats.Series[2].ListenedSeconds != 2400 || stats.Series[11] != (ListeningPeriod{Period: "2025-12", ListenedSeconds: 300, ListenCount: 1}) {
		t.Fatalf("2025 series = %+v", stats.Series)
	}
	if len(stats.Years) != 3 || stats.Years[0] != "2026" || stats.Years[2] != "2024" || len(stats.TopWorks) != 2 || stats.TopWorks[0].WorkID != 2 {
		t.Fatalf("2025 years and works = %+v, %+v", stats.Years, stats.TopWorks)
	}
	// Work 2 was first heard in 2024, so only work 1 is new in 2025.
	highlights := stats.Highlights
	if highlights == nil || highlights.NewWorkCount != 1 || highlights.BusiestDay == nil || highlights.BusiestDay.Date != "2025-03-10" || highlights.BusiestDay.ListenedSeconds != 2400 || highlights.BusiestDay.TopWork == nil || highlights.BusiestDay.TopWork.WorkID != 2 {
		t.Fatalf("2025 highlights = %+v", highlights)
	}
	if highlights.TopVoice == nil || highlights.TopVoice.ID != 2 || highlights.TopVoice.ListenedSeconds != 1800 || highlights.TopCircle != nil {
		t.Fatalf("2025 leaders = %+v, %+v", highlights.TopVoice, highlights.TopCircle)
	}

	// The current year ends today, and a named range has no highlights.
	stats, err = s.StatisticsFor(ctx, 1, "2026", now)
	if err != nil || stats.ListenedSeconds != 900 || stats.Today != "2026-03-02" || len(stats.Series) != 3 || stats.Highlights == nil || stats.Highlights.NewWorkCount != 1 {
		t.Fatalf("2026 = %+v, %v", stats, err)
	}
	if stats, err = s.StatisticsFor(ctx, 1, RangeLast12Months, now); err != nil || stats.Highlights != nil || len(stats.Years) != 3 {
		t.Fatalf("12m = %+v, %v", stats, err)
	}
	// A year without listening is twelve empty months.
	if stats, err = s.StatisticsFor(ctx, 1, "2031", now); err != nil || stats.ListenedSeconds != 0 || len(stats.Series) != 12 || stats.Highlights == nil || stats.Highlights.BusiestDay != nil {
		t.Fatalf("2031 = %+v, %v", stats, err)
	}

	calendar, err := s.CalendarFor(ctx, 1, "2025", now)
	if err != nil || calendar.From != "2025-01-01" || calendar.To != "2025-12-31" || len(calendar.Days) != 2 || calendar.Days[1].Date != "2025-12-31" {
		t.Fatalf("2025 calendar = %+v, %v", calendar, err)
	}
	breakdown, err := s.BreakdownFor(ctx, 1, "2025", RankTime, now)
	if err != nil || breakdown.ListenedSeconds != 2700 || len(breakdown.Voices) != 2 || breakdown.Voices[1].ListenedSeconds != 900 {
		t.Fatalf("2025 breakdown = %+v, %v", breakdown, err)
	}
}

func TestDatedSessionsCreditEachHourOnce(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	session := func(seconds float64, hours ...SessionHour) SessionInput {
		return SessionInput{SessionID: "synthetic-session-hours", WorkID: 1, ListenedSeconds: seconds, StartedAt: "2026-03-02T22:59:00Z", LastListenedAt: "2026-03-02T23:02:00Z", Days: []SessionDay{{Day: "2026-03-02", ListenedSeconds: seconds, Hours: hours}}}
	}
	record := func(input SessionInput) string {
		t.Helper()
		result, err := s.RecordPlaybackReport(ctx, 1, PlaybackReport{History: []SessionInput{input}})
		if err != nil || len(result.History) != 1 {
			t.Fatalf("report = %+v, %v", result, err)
		}
		return result.History[0].Status
	}
	for name, input := range map[string]SessionInput{
		"more than the day": session(120, SessionHour{Hour: 22, ListenedSeconds: 100}, SessionHour{Hour: 23, ListenedSeconds: 100}),
		"not an hour":       session(120, SessionHour{Hour: 24, ListenedSeconds: 60}),
		"out of order":      session(120, SessionHour{Hour: 23, ListenedSeconds: 60}, SessionHour{Hour: 22, ListenedSeconds: 60}),
	} {
		if status := record(input); status != "invalid" {
			t.Fatalf("%s = %q", name, status)
		}
	}
	// A repeated and a later report credit only what each hour gained.
	for _, input := range []SessionInput{
		session(120, SessionHour{Hour: 22, ListenedSeconds: 60}, SessionHour{Hour: 23, ListenedSeconds: 60}),
		session(120, SessionHour{Hour: 22, ListenedSeconds: 60}, SessionHour{Hour: 23, ListenedSeconds: 60}),
		session(180, SessionHour{Hour: 22, ListenedSeconds: 60}, SessionHour{Hour: 23, ListenedSeconds: 120}),
	} {
		if status := record(input); status != "recorded" {
			t.Fatalf("report = %q", status)
		}
	}
	// A report without hours still counts toward its day.
	if status := record(SessionInput{SessionID: "synthetic-session-plain", WorkID: 2, ListenedSeconds: 30, StartedAt: "2026-03-02T10:00:00Z", LastListenedAt: "2026-03-02T10:00:30Z", Days: []SessionDay{{Day: "2026-03-02", ListenedSeconds: 30}}}); status != "recorded" {
		t.Fatalf("plain report = %q", status)
	}

	now := time.Date(2026, time.March, 3, 12, 0, 0, 0, time.UTC)
	stats, err := s.StatisticsFor(ctx, 1, RangeLast30Days, now)
	if err != nil || stats.ListenedSeconds != 210 || len(stats.Hours) != 24 || stats.Hours[22] != 60 || stats.Hours[23] != 120 || stats.Hours[10] != 0 {
		t.Fatalf("statistics = %+v, %v", stats, err)
	}
	// Another year has no recorded hours.
	if stats, err = s.StatisticsFor(ctx, 1, "2025", now); err != nil || stats.Hours != nil {
		t.Fatalf("2025 hours = %+v, %v", stats.Hours, err)
	}
	if err = s.ClearHistory(ctx, 1); err != nil {
		t.Fatal(err)
	}
	var rows int
	if err = s.DB.QueryRow(`SELECT (SELECT COUNT(*) FROM user_listening_hour)+(SELECT COUNT(*) FROM user_listening_session_hour)`).Scan(&rows); err != nil || rows != 0 {
		t.Fatalf("hours after clear = %d, %v", rows, err)
	}
}

func TestListeningProfilePlacesListeningAgainstTheLibrary(t *testing.T) {
	s := testStore(t)
	ctx := context.Background()
	now := time.Date(2026, time.March, 2, 12, 0, 0, 0, time.UTC)
	for index := 3; index < 5; index++ {
		execFixture(t, s.DB, `INSERT INTO work (id,primary_code,title) VALUES (?,?,'Example Work')`, index+1, testfixture.WorkCode(testfixture.PrefixRJ, index))
	}
	for id := 1; id <= 5; id++ {
		execFixture(t, s.DB, `UPDATE work SET duration_seconds = ?, sales_count = ?, release_date = ?, rating_average = 4 WHERE id = ?`, id*600, id*10, time.Date(2019+id, time.January, 1, 0, 0, 0, 0, time.UTC).Format(time.DateOnly), id)
	}
	for _, statement := range []string{
		`INSERT INTO tag (id,namespace,normalized_name,display_name) VALUES (1,'metadata','example-a','Example Tag A'),(2,'metadata','example-b','Example Tag B')`,
		`INSERT INTO work_tag (work_id,tag_id,source) VALUES (4,1,'dlsite_snapshot'),(5,1,'dlsite_snapshot'),(1,2,'dlsite_snapshot'),(2,2,'dlsite_snapshot'),(3,2,'dlsite_snapshot'),(4,2,'dlsite_snapshot'),(5,2,'dlsite_snapshot')`,
		`INSERT INTO user_listening_day (user_id,work_id,day,listened_seconds,listen_count) VALUES (1,3,'2026-03-01',600,1),(1,4,'2026-03-01',2400,1),(1,5,'2026-03-02',3000,1),(2,1,'2026-03-01',60,1),(2,4,'2026-03-01',60,1)`,
		`INSERT INTO user_work_state (user_id,work_id,listening_status,rating) VALUES (1,3,'listening',3),(1,4,'finished',3),(1,5,'relisten',3),(1,1,'finished',NULL),(1,2,'want_to_listen',NULL)`,
	} {
		execFixture(t, s.DB, statement)
	}
	near := func(left, right float64) bool { return math.Abs(left-right) < 0.0001 }

	profile, err := s.ProfileFor(ctx, 1, RangeLast30Days, now)
	if err != nil || profile.ListenedSeconds != 6000 || profile.WorkCount != 3 || profile.LibraryWorkCount != 5 {
		t.Fatalf("profile = %+v, %v", profile, err)
	}
	// Works 3, 4, and 5 sit at the 50th, 70th, and 90th percentile of five.
	for name, trait := range map[string]*ProfileTrait{"duration": profile.Duration, "release": profile.Release, "popularity": profile.Popularity} {
		if trait == nil || trait.WorkCount != 3 || !near(trait.Position, 0.78) {
			t.Fatalf("%s = %+v", name, trait)
		}
	}
	if !near(profile.Duration.Value, 2640) || !near(profile.Duration.LibraryValue, 1800) || !near(profile.Popularity.Value, 44) || profile.Release.Value < 2023 || profile.Release.Value > 2024 {
		t.Fatalf("trait values = %+v, %+v, %+v", profile.Duration, profile.Popularity, profile.Release)
	}
	// The tag every work carries takes no larger share of listening than of the library.
	if len(profile.Tags) != 1 || profile.Tags[0].ID != 1 || profile.Tags[0].ListenedSeconds != 5400 || profile.Tags[0].LibraryWorkCount != 2 {
		t.Fatalf("tags = %+v", profile.Tags)
	}
	// Marks count the started works listened to in the range; ratings one star below the public's sit a quarter down.
	if profile.Marks != (ProfileMarks{Works: 3, Finished: 2, Relisten: 1}) || profile.Rating == nil || profile.Rating.WorkCount != 3 || !near(profile.Rating.Value, 3) || !near(profile.Rating.LibraryValue, 4) || !near(profile.Rating.Position, 0.25) {
		t.Fatalf("marks and rating = %+v, %+v", profile.Marks, profile.Rating)
	}

	// Two works are too few to place, even where one carries a tag the library rarely does.
	profile, err = s.ProfileFor(ctx, 2, RangeLast30Days, now)
	if err != nil || profile.WorkCount != 2 || profile.Duration != nil || profile.Rating != nil || profile.Marks.Works != 0 || len(profile.Tags) != 0 {
		t.Fatalf("small profile = %+v, %v", profile, err)
	}
	if _, err = s.ProfileFor(ctx, 1, StatisticsRange("7d"), now); !errors.Is(err, ErrInvalid) {
		t.Fatalf("unknown range = %v", err)
	}
}
