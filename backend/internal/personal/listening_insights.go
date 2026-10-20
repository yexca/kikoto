package personal

import (
	"context"
	"sort"
	"time"
)

// calendarWeeks is the number of whole weeks before the current one a
// listening calendar covers.
const calendarWeeks = 52

const breakdownLimit = 10

// Calendar is the dated listening of the weeks ending with the current one,
// or of one calendar year.
type Calendar struct {
	// From is the Monday the calendar starts on and To is today; a year's
	// calendar runs from its first day through its last, or through today.
	From string `json:"from"`
	To   string `json:"to"`
	// TimeZone names the zone whose calendar the days follow.
	TimeZone string `json:"timeZone"`
	// Days is sparse and oldest first; a day without listening is absent.
	Days []ListeningDay `json:"days"`
}

// CalendarFor reports dated listening per day, read in now's own time zone:
// the days of the year a range names, or else from the Monday 52 weeks before
// the current week through now's calendar day. Imported totals have no dates
// and never appear.
func (s Store) CalendarFor(ctx context.Context, user int64, period StatisticsRange, now time.Time) (Calendar, error) {
	today := calendarDay(now)
	monday := today.AddDate(0, 0, -((int(today.Weekday()) + 6) % 7))
	from, to := monday.AddDate(0, 0, -7*calendarWeeks), today
	if _, ok := period.Year(); ok {
		window, err := rangeWindow(period, today)
		if err != nil {
			return Calendar{}, err
		}
		from, to = window.from, window.to
	}
	result := Calendar{From: from.Format(time.DateOnly), To: to.Format(time.DateOnly), TimeZone: now.Location().String()}
	var err error
	result.Days, err = s.listeningDays(ctx, user, from, to)
	return result, err
}

// BreakdownRank orders a breakdown's entries.
type BreakdownRank string

const (
	// RankTime orders by listening time, then by plays.
	RankTime BreakdownRank = "time"
	// RankPreference orders by how far an entry's share of listening time
	// exceeds its share of the library's works, and keeps only entries where
	// it does.
	RankPreference BreakdownRank = "preference"
)

// ParseBreakdownRank accepts the public rank names; an empty value ranks by time.
func ParseBreakdownRank(value string) (BreakdownRank, error) {
	switch BreakdownRank(value) {
	case "":
		return RankTime, nil
	case RankTime, RankPreference:
		return BreakdownRank(value), nil
	default:
		return "", ErrInvalid
	}
}

// BreakdownEntry is the listening of every work that carries one tag, credits
// one voice, or belongs to one circle.
type BreakdownEntry struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
	// ExternalID is a circle's provider id, or empty when it has none.
	ExternalID string `json:"externalId,omitempty"`
	// RouteKey addresses a voice's detail page; the server sets it.
	RouteKey        string  `json:"routeKey,omitempty"`
	ListenedSeconds float64 `json:"listenedSeconds"`
	ListenCount     int64   `json:"listenCount"`
	WorkCount       int     `json:"workCount"`
	// LibraryWorkCount is how many of the library's works the entry covers; it
	// is reported for the preference ranking only.
	LibraryWorkCount int `json:"libraryWorkCount,omitempty"`
}

// Breakdown ranks one range's listening by shared tag, voice, and circle. A
// work counts in full toward each of its tags and voices, so the entries of a
// dimension do not add up to ListenedSeconds.
type Breakdown struct {
	Range           StatisticsRange `json:"range"`
	Rank            BreakdownRank   `json:"rank"`
	ListenedSeconds float64         `json:"listenedSeconds"`
	// LibraryWorkCount is the number of works the library lists; it is reported
	// for the preference ranking only.
	LibraryWorkCount int              `json:"libraryWorkCount,omitempty"`
	Tags             []BreakdownEntry `json:"tags"`
	Voices           []BreakdownEntry `json:"voices"`
	Circles          []BreakdownEntry `json:"circles"`
}

// libraryWorkCTE is the works the library lists: every work except a
// non-canonical edition of a family.
const libraryWorkCTE = `WITH library AS (SELECT work.id work_id FROM work WHERE NOT EXISTS (
 SELECT 1 FROM work_edition edition JOIN logical_work logical ON logical.id = edition.logical_work_id
 WHERE edition.work_id = work.id AND edition.is_canonical = 0 AND logical.canonical_work_id IS NOT NULL AND logical.canonical_work_id <> work.id)) `

// A dimension's listened entities: one row per work and entity, named
// entity_id, name, external_id, listened_seconds, and listen_count. The same
// relations count an entity's works in the library.
var breakdownDimensions = []struct {
	listened string
	library  string
}{
	{
		// A work can hold one shared tag from several sources.
		listened: `SELECT DISTINCT l.work_id,t.id entity_id,t.display_name name,'' external_id,l.listened_seconds,l.listen_count
 FROM listened l JOIN work_tag r ON r.work_id = l.work_id JOIN tag t ON t.id = r.tag_id WHERE t.namespace IN ('dlsite','metadata') AND TRIM(t.display_name) <> ''`,
		library: `SELECT r.tag_id,COUNT(DISTINCT r.work_id) FROM work_tag r JOIN library ON library.work_id = r.work_id JOIN tag t ON t.id = r.tag_id WHERE t.namespace IN ('dlsite','metadata') GROUP BY r.tag_id`,
	},
	{
		listened: `SELECT l.work_id,p.id entity_id,p.display_name name,'' external_id,l.listened_seconds,l.listen_count
 FROM listened l JOIN work_credit c ON c.work_id = l.work_id AND c.role = 'voice_actor' JOIN person p ON p.id = c.person_id`,
		library: `SELECT c.person_id,COUNT(*) FROM work_credit c JOIN library ON library.work_id = c.work_id WHERE c.role = 'voice_actor' GROUP BY c.person_id`,
	},
	{
		listened: `SELECT l.work_id,c.party_id entity_id,c.display_name name,c.external_id,l.listened_seconds,l.listen_count
 FROM listened l JOIN work_primary_circle c ON c.work_id = l.work_id`,
		library: `SELECT c.party_id,COUNT(*) FROM work_primary_circle c JOIN library ON library.work_id = c.work_id GROUP BY c.party_id`,
	},
}

// BreakdownFor ranks the range ending on now's calendar day with the same scope as
// StatisticsFor: a bounded range counts only dated listening, and all time
// also includes imported per-work totals.
func (s Store) BreakdownFor(ctx context.Context, user int64, period StatisticsRange, rank BreakdownRank, now time.Time) (Breakdown, error) {
	today := calendarDay(now)
	result := Breakdown{Range: period, Rank: rank, Tags: []BreakdownEntry{}, Voices: []BreakdownEntry{}, Circles: []BreakdownEntry{}}
	if rank != RankTime && rank != RankPreference {
		return result, ErrInvalid
	}
	window, err := rangeWindow(period, today)
	if err != nil {
		return result, err
	}
	listened, args := listenedWorks(user, window)
	if err := s.DB.QueryRowContext(ctx, listened+`SELECT COALESCE(SUM(listened_seconds),0) FROM listened`, args...).Scan(&result.ListenedSeconds); err != nil {
		return result, err
	}
	if rank == RankPreference {
		if err := s.DB.QueryRowContext(ctx, libraryWorkCTE+`SELECT COUNT(*) FROM library`).Scan(&result.LibraryWorkCount); err != nil {
			return result, err
		}
	}
	for index, target := range []*[]BreakdownEntry{&result.Tags, &result.Voices, &result.Circles} {
		dimension := breakdownDimensions[index]
		entries, err := s.breakdownEntries(ctx, listened+`, entity AS (`+dimension.listened+`)
 SELECT entity_id,MAX(name),MAX(external_id),SUM(listened_seconds),SUM(listen_count),COUNT(*) FROM entity GROUP BY entity_id`, args)
		if err != nil {
			return result, err
		}
		if rank == RankPreference {
			if entries, err = s.rankByPreference(ctx, entries, dimension.library, result.ListenedSeconds, result.LibraryWorkCount); err != nil {
				return result, err
			}
		} else {
			sort.Slice(entries, func(i, j int) bool { return listenedMore(entries[i], entries[j]) })
		}
		*target = entries[:min(len(entries), breakdownLimit)]
	}
	return result, nil
}

// listenedWorks is a CTE named listened that holds a window's listening per
// canonical work, with the scope of StatisticsFor, and the arguments it binds.
func listenedWorks(user int64, window reportWindow) (string, []any) {
	if !window.bounded {
		return reportHistoryCTE + `, listened AS (SELECT work_id,listened_seconds,listen_count FROM history) `, []any{user, user}
	}
	return `WITH listened AS (SELECT work_id,SUM(listened_seconds) listened_seconds,SUM(listen_count) listen_count FROM ` + reportDays + ` WHERE day >= ? AND day <= ? GROUP BY work_id) `, []any{user, window.from.Format(time.DateOnly), window.to.Format(time.DateOnly)}
}

func listenedMore(left, right BreakdownEntry) bool {
	if left.ListenedSeconds != right.ListenedSeconds {
		return left.ListenedSeconds > right.ListenedSeconds
	}
	if left.ListenCount != right.ListenCount {
		return left.ListenCount > right.ListenCount
	}
	return left.ID < right.ID
}

// rankByPreference keeps the entries whose share of listening time exceeds
// their share of the library's works, largest excess first. A tag that most
// of the library carries therefore ranks below one the account seeks out.
func (s Store) rankByPreference(ctx context.Context, entries []BreakdownEntry, libraryQuery string, listenedSeconds float64, libraryWorks int) ([]BreakdownEntry, error) {
	preferred := []BreakdownEntry{}
	if listenedSeconds <= 0 || libraryWorks <= 0 {
		return preferred, nil
	}
	rows, err := s.DB.QueryContext(ctx, libraryWorkCTE+libraryQuery)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	counts := map[int64]int{}
	for rows.Next() {
		var id int64
		var count int
		if err = rows.Scan(&id, &count); err != nil {
			return nil, err
		}
		counts[id] = count
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	excess := func(entry BreakdownEntry) float64 {
		return entry.ListenedSeconds/listenedSeconds - float64(entry.LibraryWorkCount)/float64(libraryWorks)
	}
	for _, entry := range entries {
		entry.LibraryWorkCount = counts[entry.ID]
		if excess(entry) > 0 {
			preferred = append(preferred, entry)
		}
	}
	sort.Slice(preferred, func(i, j int) bool {
		if left, right := excess(preferred[i]), excess(preferred[j]); left != right {
			return left > right
		}
		return listenedMore(preferred[i], preferred[j])
	})
	return preferred, nil
}

func (s Store) breakdownEntries(ctx context.Context, query string, args []any) ([]BreakdownEntry, error) {
	rows, err := s.DB.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	entries := []BreakdownEntry{}
	for rows.Next() {
		var entry BreakdownEntry
		if err = rows.Scan(&entry.ID, &entry.Name, &entry.ExternalID, &entry.ListenedSeconds, &entry.ListenCount, &entry.WorkCount); err != nil {
			return nil, err
		}
		entries = append(entries, entry)
	}
	return entries, rows.Err()
}
