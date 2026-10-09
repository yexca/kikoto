package personal

import (
	"context"
	"database/sql"
	"time"
)

// StatisticsRange selects the period a listening report covers.
type StatisticsRange string

const (
	RangeLast30Days   StatisticsRange = "30d"
	RangeLast12Months StatisticsRange = "12m"
	RangeAll          StatisticsRange = "all"
)

// Granularity is the length of one series period.
type Granularity string

const (
	GranularityDay   Granularity = "day"
	GranularityMonth Granularity = "month"
	GranularityYear  Granularity = "year"
)

// allTimeMonthlyLimit is the longest all-time span still charted by month;
// longer histories are charted by year so the chart stays readable.
const allTimeMonthlyLimit = 36

const topWorkLimit = 10

// ParseStatisticsRange accepts the public range names. An empty value is the
// all-time report that clients without a range expect.
func ParseStatisticsRange(value string) (StatisticsRange, error) {
	switch StatisticsRange(value) {
	case "":
		return RangeAll, nil
	case RangeLast30Days, RangeLast12Months, RangeAll:
		return StatisticsRange(value), nil
	default:
		return "", ErrInvalid
	}
}

type ListeningDay struct {
	Date            string  `json:"date"`
	ListenedSeconds float64 `json:"listenedSeconds"`
	ListenCount     int64   `json:"listenCount"`
}

// ListeningPeriod is one series bucket: a UTC day (2006-01-02), month
// (2006-01), or year (2006).
type ListeningPeriod struct {
	Period          string  `json:"period"`
	ListenedSeconds float64 `json:"listenedSeconds"`
	ListenCount     int64   `json:"listenCount"`
}

type Statistics struct {
	Range           StatisticsRange `json:"range"`
	ListenedSeconds float64         `json:"listenedSeconds"`
	ListenCount     int64           `json:"listenCount"`
	WorkCount       int             `json:"workCount"`
	ActiveDays      int             `json:"activeDays"`
	Granularity     Granularity     `json:"granularity"`
	// Series covers the whole range oldest first; periods without listening are zero.
	Series []ListeningPeriod `json:"series"`
	// Daily is the sparse last 30 UTC days for clients that do not read Series.
	Daily    []ListeningDay `json:"daily"`
	TopWorks []HistoryItem  `json:"topWorks"`
}

// Statistics is the all-time listening report.
func (s Store) Statistics(ctx context.Context, user int64) (Statistics, error) {
	return s.StatisticsFor(ctx, user, RangeAll, time.Now())
}

// StatisticsFor reports one range ending at now (UTC). A bounded range counts
// only dated listening; all time also includes imported per-work totals,
// which have no dates and therefore never appear in the series.
func (s Store) StatisticsFor(ctx context.Context, user int64, period StatisticsRange, now time.Time) (Statistics, error) {
	now = now.UTC()
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	result := Statistics{Range: period, Series: []ListeningPeriod{}, Daily: []ListeningDay{}, TopWorks: []HistoryItem{}}
	var from time.Time
	switch period {
	case RangeLast30Days:
		from = today.AddDate(0, 0, -29)
		result.Granularity = GranularityDay
	case RangeLast12Months:
		from = time.Date(today.Year(), today.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -11, 0)
		result.Granularity = GranularityMonth
	case RangeAll:
		first, err := s.firstListeningDay(ctx, user, today)
		if err != nil {
			return result, err
		}
		from = time.Date(first.Year(), first.Month(), 1, 0, 0, 0, 0, time.UTC)
		result.Granularity = GranularityMonth
		if monthsBetween(from, today) >= allTimeMonthlyLimit {
			from = time.Date(first.Year(), time.January, 1, 0, 0, 0, 0, time.UTC)
			result.Granularity = GranularityYear
		}
	default:
		return result, ErrInvalid
	}

	var err error
	if period == RangeAll {
		err = s.DB.QueryRowContext(ctx, historyCTE+`SELECT COALESCE(SUM(listened_seconds),0),COALESCE(SUM(listen_count),0),COUNT(*) FROM history`, user, user).Scan(&result.ListenedSeconds, &result.ListenCount, &result.WorkCount)
		if err == nil {
			err = s.DB.QueryRowContext(ctx, `SELECT COUNT(DISTINCT day) FROM user_listening_day WHERE user_id = ?`, user).Scan(&result.ActiveDays)
		}
	} else {
		err = s.DB.QueryRowContext(ctx, `SELECT COALESCE(SUM(listened_seconds),0),COALESCE(SUM(listen_count),0),COUNT(DISTINCT work_id),COUNT(DISTINCT day) FROM user_listening_day WHERE user_id = ? AND day >= ?`, user, from.Format(time.DateOnly)).Scan(&result.ListenedSeconds, &result.ListenCount, &result.WorkCount, &result.ActiveDays)
	}
	if err != nil {
		return result, err
	}
	if result.Series, err = s.listeningSeries(ctx, user, result.Granularity, from, today); err != nil {
		return result, err
	}
	if result.Daily, err = s.recentListeningDays(ctx, user, today.AddDate(0, 0, -29)); err != nil {
		return result, err
	}
	result.TopWorks, err = s.topWorks(ctx, user, period, from)
	return result, err
}

func (s Store) firstListeningDay(ctx context.Context, user int64, today time.Time) (time.Time, error) {
	var first sql.NullString
	if err := s.DB.QueryRowContext(ctx, `SELECT MIN(day) FROM user_listening_day WHERE user_id = ?`, user).Scan(&first); err != nil {
		return today, err
	}
	if !first.Valid {
		return today, nil
	}
	day, err := time.Parse(time.DateOnly, first.String)
	if err != nil || day.After(today) {
		return today, nil
	}
	return day, nil
}

func monthsBetween(from, to time.Time) int {
	return (to.Year()-from.Year())*12 + int(to.Month()) - int(from.Month())
}

func periodKey(granularity Granularity, day time.Time) string {
	switch granularity {
	case GranularityYear:
		return day.Format("2006")
	case GranularityMonth:
		return day.Format("2006-01")
	default:
		return day.Format(time.DateOnly)
	}
}

func nextPeriod(granularity Granularity, day time.Time) time.Time {
	switch granularity {
	case GranularityYear:
		return day.AddDate(1, 0, 0)
	case GranularityMonth:
		return day.AddDate(0, 1, 0)
	default:
		return day.AddDate(0, 0, 1)
	}
}

// listeningSeries sums dated listening into every period from from through
// today, so a period without listening is an explicit zero.
func (s Store) listeningSeries(ctx context.Context, user int64, granularity Granularity, from, today time.Time) ([]ListeningPeriod, error) {
	length := map[Granularity]int{GranularityDay: 10, GranularityMonth: 7, GranularityYear: 4}[granularity]
	rows, err := s.DB.QueryContext(ctx, `SELECT substr(day,1,?) period,SUM(listened_seconds),SUM(listen_count) FROM user_listening_day WHERE user_id = ? AND day >= ? AND day <= ? GROUP BY period`, length, user, from.Format(time.DateOnly), today.Format(time.DateOnly))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	totals := map[string]ListeningPeriod{}
	for rows.Next() {
		var item ListeningPeriod
		if err = rows.Scan(&item.Period, &item.ListenedSeconds, &item.ListenCount); err != nil {
			return nil, err
		}
		totals[item.Period] = item
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	series := []ListeningPeriod{}
	last := periodKey(granularity, today)
	for day := from; ; day = nextPeriod(granularity, day) {
		key := periodKey(granularity, day)
		item := totals[key]
		item.Period = key
		series = append(series, item)
		if key == last {
			return series, nil
		}
	}
}

func (s Store) recentListeningDays(ctx context.Context, user int64, from time.Time) ([]ListeningDay, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT day,SUM(listened_seconds),SUM(listen_count) FROM user_listening_day WHERE user_id = ? AND day >= ? GROUP BY day ORDER BY day`, user, from.Format(time.DateOnly))
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	days := []ListeningDay{}
	for rows.Next() {
		var day ListeningDay
		if err = rows.Scan(&day.Date, &day.ListenedSeconds, &day.ListenCount); err != nil {
			return nil, err
		}
		days = append(days, day)
	}
	return days, rows.Err()
}

// topWorks ranks by listening time in the range, then by plays. Last played
// always reflects the whole history.
func (s Store) topWorks(ctx context.Context, user int64, period StatisticsRange, from time.Time) ([]HistoryItem, error) {
	var rows *sql.Rows
	var err error
	if period == RangeAll {
		rows, err = s.DB.QueryContext(ctx, historyCTE+`SELECT w.id,w.primary_code,w.title,h.listened_seconds,h.listen_count,h.last_played_at FROM history h JOIN work w ON w.id = h.work_id ORDER BY h.listened_seconds DESC,h.listen_count DESC,w.id LIMIT ?`, user, user, topWorkLimit)
	} else {
		rows, err = s.DB.QueryContext(ctx, historyCTE+`, period AS (SELECT work_id,SUM(listened_seconds) listened_seconds,SUM(listen_count) listen_count FROM user_listening_day WHERE user_id = ? AND day >= ? GROUP BY work_id)
 SELECT w.id,w.primary_code,w.title,p.listened_seconds,p.listen_count,COALESCE(h.last_played_at,'') FROM period p JOIN work w ON w.id = p.work_id LEFT JOIN history h ON h.work_id = p.work_id ORDER BY p.listened_seconds DESC,p.listen_count DESC,w.id LIMIT ?`, user, user, user, from.Format(time.DateOnly), topWorkLimit)
	}
	if err != nil {
		return nil, err
	}
	return historyItems(rows)
}
