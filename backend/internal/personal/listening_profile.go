package personal

import (
	"context"
	"database/sql"
	"sort"
	"time"
)

// profileTagLimit is the number of preferred tags a profile draws.
const profileTagLimit = 8

// profileTraitMinimum is the fewest works a trait or the preferred tags are
// read from, on either side of the comparison.
const profileTraitMinimum = 3

// ProfileTrait places the account's listening on one work attribute against
// the library.
type ProfileTrait struct {
	// Value is the attribute's mean over the listened works, weighted by
	// listening time.
	Value float64 `json:"value"`
	// LibraryValue is the attribute's mean over the works it is compared with.
	LibraryValue float64 `json:"libraryValue"`
	// Position runs from 0 to 1, and 0.5 is where the comparison sits.
	Position float64 `json:"position"`
	// WorkCount is the number of the account's works the trait is read from.
	WorkCount int `json:"workCount"`
}

// ProfileMarks counts the listened works the account marked as started.
type ProfileMarks struct {
	Works    int `json:"works"`
	Finished int `json:"finished"`
	Relisten int `json:"relisten"`
}

// Profile describes what an account listens to in one range, against the
// library it listens from.
type Profile struct {
	Range            StatisticsRange `json:"range"`
	ListenedSeconds  float64         `json:"listenedSeconds"`
	WorkCount        int             `json:"workCount"`
	LibraryWorkCount int             `json:"libraryWorkCount"`
	// Tags are the tags whose share of listening time most exceeds their share
	// of the library's works; empty while too few works were listened to.
	Tags []BreakdownEntry `json:"tags"`
	// Duration is in seconds, Release in calendar years, and Popularity in
	// sales. Each is the listening-time-weighted mean of the listened works,
	// placed by their mean percentile among the library's works. A trait
	// without enough works is absent.
	Duration   *ProfileTrait `json:"duration,omitempty"`
	Release    *ProfileTrait `json:"release,omitempty"`
	Popularity *ProfileTrait `json:"popularity,omitempty"`
	// Rating compares every rating the account gave, whatever the range, with
	// the public rating of the same works; 0.5 is equal and each end is two
	// stars apart.
	Rating *ProfileTrait `json:"rating,omitempty"`
	Marks  ProfileMarks  `json:"marks"`
}

type profileAttributes struct {
	duration, release, sales sql.NullFloat64
}

func scanProfileAttributes(duration, sales sql.NullFloat64, release sql.NullString) profileAttributes {
	attributes := profileAttributes{}
	if duration.Valid && duration.Float64 > 0 {
		attributes.duration = duration
	}
	if sales.Valid && sales.Float64 >= 0 {
		attributes.sales = sales
	}
	if release.Valid && len(release.String) >= len(time.DateOnly) {
		if day, err := time.Parse(time.DateOnly, release.String[:len(time.DateOnly)]); err == nil {
			// A calendar year with the elapsed part of the year as its fraction.
			attributes.release = sql.NullFloat64{Float64: float64(day.Year()) + float64(day.YearDay()-1)/365.25, Valid: true}
		}
	}
	return attributes
}

// ProfileFor describes the range ending on now's calendar day with the scope
// of StatisticsFor.
func (s Store) ProfileFor(ctx context.Context, user int64, period StatisticsRange, now time.Time) (Profile, error) {
	result := Profile{Range: period, Tags: []BreakdownEntry{}}
	window, err := rangeWindow(period, calendarDay(now))
	if err != nil {
		return result, err
	}
	listened, args := listenedWorks(user, window)

	type listenedWork struct {
		seconds float64
		profileAttributes
	}
	works := []listenedWork{}
	rows, err := s.DB.QueryContext(ctx, listened+`SELECT l.listened_seconds,w.duration_seconds,w.sales_count,w.release_date FROM listened l JOIN work w ON w.id = l.work_id WHERE l.listened_seconds > 0`, args...)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var work listenedWork
		var duration, sales sql.NullFloat64
		var release sql.NullString
		if err = rows.Scan(&work.seconds, &duration, &sales, &release); err != nil {
			_ = rows.Close()
			return result, err
		}
		work.profileAttributes = scanProfileAttributes(duration, sales, release)
		works = append(works, work)
		result.ListenedSeconds += work.seconds
	}
	if err = rows.Close(); err != nil {
		return result, err
	}
	result.WorkCount = len(works)

	library := []profileAttributes{}
	rows, err = s.DB.QueryContext(ctx, libraryWorkCTE+`SELECT w.duration_seconds,w.sales_count,w.release_date FROM library JOIN work w ON w.id = library.work_id`)
	if err != nil {
		return result, err
	}
	for rows.Next() {
		var duration, sales sql.NullFloat64
		var release sql.NullString
		if err = rows.Scan(&duration, &sales, &release); err != nil {
			_ = rows.Close()
			return result, err
		}
		library = append(library, scanProfileAttributes(duration, sales, release))
	}
	if err = rows.Close(); err != nil {
		return result, err
	}
	result.LibraryWorkCount = len(library)

	for _, trait := range []struct {
		target **ProfileTrait
		read   func(profileAttributes) sql.NullFloat64
	}{
		{&result.Duration, func(a profileAttributes) sql.NullFloat64 { return a.duration }},
		{&result.Release, func(a profileAttributes) sql.NullFloat64 { return a.release }},
		{&result.Popularity, func(a profileAttributes) sql.NullFloat64 { return a.sales }},
	} {
		values := []float64{}
		for _, work := range library {
			if value := trait.read(work); value.Valid {
				values = append(values, value.Float64)
			}
		}
		weighted := []weightedValue{}
		for _, work := range works {
			if value := trait.read(work.profileAttributes); value.Valid {
				weighted = append(weighted, weightedValue{value: value.Float64, weight: work.seconds})
			}
		}
		*trait.target = percentileTrait(weighted, values)
	}

	if result.ListenedSeconds > 0 && result.WorkCount >= profileTraitMinimum && result.LibraryWorkCount >= profileTraitMinimum {
		dimension := breakdownDimensions[0]
		entries, err := s.breakdownEntries(ctx, listened+`, entity AS (`+dimension.listened+`)
 SELECT entity_id,MAX(name),MAX(external_id),SUM(listened_seconds),SUM(listen_count),COUNT(*) FROM entity GROUP BY entity_id`, args)
		if err != nil {
			return result, err
		}
		if entries, err = s.rankByPreference(ctx, entries, dimension.library, result.ListenedSeconds, result.LibraryWorkCount); err != nil {
			return result, err
		}
		result.Tags = entries[:min(len(entries), profileTagLimit)]
	}

	// An edition's mark counts for the work the library lists; the furthest
	// mark of a family stands for it.
	const marked = `, marked AS (SELECT ` + canonicalWorkID + ` work_id,MAX(CASE stored.listening_status WHEN 'relisten' THEN 3 WHEN 'finished' THEN 2 WHEN 'listening' THEN 1 WHEN 'paused' THEN 1 ELSE 0 END) level FROM user_work_state stored` + canonicalWorkJoin + `WHERE stored.user_id = ? GROUP BY 1) `
	if err = s.DB.QueryRowContext(ctx, listened+marked+`SELECT COUNT(*),COALESCE(SUM(m.level >= 2),0),COALESCE(SUM(m.level = 3),0) FROM listened l JOIN marked m ON m.work_id = l.work_id WHERE m.level > 0`, append(append([]any{}, args...), user)...).Scan(&result.Marks.Works, &result.Marks.Finished, &result.Marks.Relisten); err != nil {
		return result, err
	}

	var mine, public sql.NullFloat64
	var rated int
	if err = s.DB.QueryRowContext(ctx, `SELECT AVG(r.rating),AVG(w.rating_average),COUNT(*) FROM (SELECT `+canonicalWorkID+` work_id,MAX(stored.rating) rating FROM user_work_state stored`+canonicalWorkJoin+`WHERE stored.user_id = ? AND stored.rating > 0 GROUP BY 1) r JOIN work w ON w.id = r.work_id WHERE w.rating_average > 0`, user).Scan(&mine, &public, &rated); err != nil {
		return result, err
	}
	if rated >= profileTraitMinimum && mine.Valid && public.Valid {
		result.Rating = &ProfileTrait{Value: mine.Float64, LibraryValue: public.Float64, Position: min(1, max(0, 0.5+(mine.Float64-public.Float64)/4)), WorkCount: rated}
	}
	return result, nil
}

type weightedValue struct{ value, weight float64 }

// percentileTrait places weighted values among a population: the weighted
// mean of each value's percentile, with ties at the middle of their run. It
// is nil when either side has too few works to compare.
func percentileTrait(weighted []weightedValue, population []float64) *ProfileTrait {
	if len(weighted) < profileTraitMinimum || len(population) < profileTraitMinimum {
		return nil
	}
	sort.Float64s(population)
	trait := ProfileTrait{WorkCount: len(weighted)}
	total := 0.0
	for _, value := range population {
		trait.LibraryValue += value
	}
	trait.LibraryValue /= float64(len(population))
	for _, item := range weighted {
		below := sort.SearchFloat64s(population, item.value)
		through := sort.Search(len(population), func(index int) bool { return population[index] > item.value })
		trait.Position += item.weight * float64(below+through) / 2 / float64(len(population))
		trait.Value += item.weight * item.value
		total += item.weight
	}
	if total <= 0 {
		return nil
	}
	trait.Value /= total
	trait.Position /= total
	return &trait
}
