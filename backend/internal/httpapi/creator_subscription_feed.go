package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

// The release feed lists one entry per work family, newest event first. A
// family's events are its new releases, new language editions, and
// Availability Watch hits. Each family belongs to the day of its newest event
// in the account's time zone, and a page holds a number of days that have
// entries, so a quiet day takes no space.

// releaseFeedDayOptions are the day counts a page can hold.
var releaseFeedDayOptions = []int{5, 10, 15}

const releaseFeedDefaultDays = 10

type releaseFeedSubject struct {
	Kind          string `json:"kind"`
	CircleID      string `json:"circleId,omitempty"`
	CircleName    string `json:"circleName,omitempty"`
	SeriesID      string `json:"seriesId,omitempty"`
	SeriesName    string `json:"seriesName,omitempty"`
	PersonID      int64  `json:"personId,omitempty"`
	VoiceRouteKey string `json:"voiceRouteKey,omitempty"`
	VoiceName     string `json:"voiceName,omitempty"`
}

type releaseFeedEvent struct {
	Type     string             `json:"type"`
	Code     string             `json:"code"`
	Language string             `json:"language"`
	At       string             `json:"at"`
	Subject  releaseFeedSubject `json:"subject"`
}

// releaseFeedFallback describes a family whose work is not in the library
// projection, from what the catalog knows.
type releaseFeedFallback struct {
	Code        string   `json:"code"`
	Title       string   `json:"title"`
	CoverURL    string   `json:"coverUrl"`
	ReleaseDate string   `json:"releaseDate"`
	Circle      string   `json:"circle"`
	VoiceActors []string `json:"voiceActors"`
	Tags        []string `json:"tags"`
	DLsiteURL   string   `json:"dlsiteUrl"`
}

type releaseFeedFamily struct {
	Key      string              `json:"key"`
	LatestAt string              `json:"latestAt"`
	Day      string              `json:"day"`
	Unread   bool                `json:"unread"`
	Events   []releaseFeedEvent  `json:"events"`
	Work     *libraryWorkSummary `json:"work"`
	Fallback releaseFeedFallback `json:"fallback"`
	// Watched is true when the Availability Watch pool watches the family's
	// shown code or another edition of it. It is stated only to accounts that
	// may see the pool.
	Watched bool `json:"watched"`
	// WatchTarget is the available Availability Watch target behind a "Now
	// available" event, so the card can track or fetch it; nil otherwise and
	// for accounts that may not see the pool.
	WatchTarget *releaseFeedWatchTarget `json:"watchTarget"`
}

// releaseFeedWatchTarget is what a feed card needs to act on an available
// target: the edition and source found, and any Track or Fetch started.
type releaseFeedWatchTarget struct {
	ID                int64  `json:"id"`
	WorkCode          string `json:"workCode"`
	AvailableCode     string `json:"availableCode"`
	AvailableSourceID int64  `json:"availableSourceId"`
	TrackRunStatus    string `json:"trackRunStatus"`
	FetchRunStatus    string `json:"fetchRunStatus"`
	InLibrary         bool   `json:"inLibrary"`
}

type releaseFeedPage struct {
	Families []releaseFeedFamily `json:"families"`
	Page     int                 `json:"page"`
	// Days is how many days with entries a page holds, and TotalDays how many
	// the whole feed has.
	Days      int `json:"days"`
	TotalDays int `json:"totalDays"`
	// Total counts the families of the whole feed.
	Total       int `json:"total"`
	UnreadCount int `json:"unreadCount"`
	// Today is the current day in the zone the days are counted in.
	Today string `json:"today"`
	Demo  bool   `json:"demo"`
}

// releaseFeedFamilySQL resolves each feed entry of one account to its family:
// the logical work of its code once metadata knows it, or the code itself.
const releaseFeedFamilySQL = `
	WITH item AS (
		SELECT feed.id, feed.primary_code, feed.event_type, feed.subject_kind, feed.party_id, feed.series_title_id,
			feed.person_id, feed.created_at,
			COALESCE((
				SELECT 'family:' || edition.logical_work_id
				FROM work INNER JOIN work_edition AS edition ON edition.work_id = work.id
				WHERE UPPER(work.primary_code) = feed.primary_code
				LIMIT 1
			), 'code:' || feed.primary_code) AS family_key
		FROM user_release_feed_item AS feed
		WHERE feed.user_id = ?
	)
`

func (s *Server) listReleaseFeed(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	page, days := max(1, queryInt(r, "page", 1)), releaseFeedDaysPerPage(queryInt(r, "days", releaseFeedDefaultDays))
	zone, _ := s.accountTimeZone(r, user.ID)
	location, err := time.LoadLocation(zone)
	if err != nil {
		location = time.UTC
	}
	var feed releaseFeedPage
	if s.cfg.IsDemo() {
		feed = demoReleaseFeedPage(page, days, location)
	} else if feed, err = s.loadReleaseFeed(r.Context(), user.ID, page, days, location); err != nil {
		writeError(w, err)
		return
	} else if userHasPermission(user, "workflows:run") {
		if err := s.markReleaseFeedWatched(r.Context(), feed.Families); err != nil {
			writeError(w, err)
			return
		}
	}
	feed.Today = time.Now().In(location).Format(time.DateOnly)
	writeJSON(w, http.StatusOK, feed)
}

// releaseFeedShownCode is the code a family's card shows and watches: its
// work's, or the fallback's.
func releaseFeedShownCode(family releaseFeedFamily) string {
	if family.Work != nil {
		return strings.ToUpper(family.Work.PrimaryCode)
	}
	return strings.ToUpper(family.Fallback.Code)
}

// markReleaseFeedWatched states which families' shown codes the
// Availability Watch pool watches.
func (s *Server) markReleaseFeedWatched(ctx context.Context, families []releaseFeedFamily) error {
	codes := make([]string, 0, len(families))
	for _, family := range families {
		codes = append(codes, releaseFeedShownCode(family))
	}
	watched, err := s.activeAvailabilityWatchCodes(ctx, codes)
	if err != nil {
		return err
	}
	for index := range families {
		families[index].Watched = watched[releaseFeedShownCode(families[index])]
	}
	return s.attachReleaseFeedWatchTargets(ctx, families)
}

// attachReleaseFeedWatchTargets gives each family with a "Now available"
// event the available target that reported it.
func (s *Server) attachReleaseFeedWatchTargets(ctx context.Context, families []releaseFeedFamily) error {
	codes := []string{}
	for _, family := range families {
		for _, event := range family.Events {
			if event.Type == "available" {
				codes = append(codes, strings.ToUpper(event.Code))
			}
		}
	}
	if len(codes) == 0 {
		return nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT target.work_code, target.id, COALESCE(NULLIF(target.available_code, ''), target.work_code),
			target.available_source_id, COALESCE(track_run.status, ''), COALESCE(fetch_run.status, ''),
			`+availabilityWatchInLibrarySQL+`
		FROM availability_watch_target AS target
		LEFT JOIN workflow_run AS track_run ON track_run.id = target.track_run_id
		LEFT JOIN workflow_run AS fetch_run ON fetch_run.id = target.fetch_run_id
		WHERE target.watch_id = ? AND target.active = 1 AND target.state = 'ready'
			AND target.available_source_id IS NOT NULL
			AND target.work_code IN (SELECT value FROM json_each(?))
	`, availabilityWatchID, mustJSON(codes))
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	targets := map[string]*releaseFeedWatchTarget{}
	for rows.Next() {
		var code string
		var target releaseFeedWatchTarget
		if err := rows.Scan(&code, &target.ID, &target.AvailableCode, &target.AvailableSourceID, &target.TrackRunStatus, &target.FetchRunStatus, &target.InLibrary); err != nil {
			return err
		}
		target.WorkCode = code
		targets[code] = &target
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for index := range families {
		for _, event := range families[index].Events {
			if target := targets[strings.ToUpper(event.Code)]; event.Type == "available" && target != nil {
				families[index].WatchTarget = target
				break
			}
		}
	}
	return nil
}

func releaseFeedDaysPerPage(days int) int {
	if slices.Contains(releaseFeedDayOptions, days) {
		return days
	}
	return releaseFeedDefaultDays
}

// releaseFeedDay is the day, in location, of a stored UTC timestamp.
func releaseFeedDay(at string, location *time.Location) string {
	parsed, err := parseSQLiteTime(at)
	if err != nil {
		return ""
	}
	return parsed.In(location).Format(time.DateOnly)
}

// pageReleaseFeedDays dates families, newest first, and keeps the ones on the
// page's days. It returns the kept families and how many days the feed has.
func pageReleaseFeedDays(families []releaseFeedFamily, page, days int, location *time.Location) ([]releaseFeedFamily, int) {
	kept := []releaseFeedFamily{}
	first, last := (page-1)*days, page*days
	dayIndex, previous := -1, ""
	for _, family := range families {
		family.Day = releaseFeedDay(family.LatestAt, location)
		if dayIndex < 0 || family.Day != previous {
			dayIndex++
			previous = family.Day
		}
		if dayIndex >= first && dayIndex < last {
			kept = append(kept, family)
		}
	}
	return kept, dayIndex + 1
}

func (s *Server) releaseFeedUnread(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeJSON(w, http.StatusOK, map[string]int{"count": 0})
		return
	}
	count, err := s.releaseFeedUnreadCount(r.Context(), user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": count})
}

func (s *Server) markReleaseFeedSeen(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_release_feed_state (user_id, seen_at) VALUES (?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id) DO UPDATE SET seen_at = excluded.seen_at
	`, user.ID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int{"count": 0})
}

func (s *Server) releaseFeedSeenAt(ctx context.Context, userID int64) (string, error) {
	var seenAt string
	err := s.db.QueryRowContext(ctx, "SELECT seen_at FROM user_release_feed_state WHERE user_id = ?", userID).Scan(&seenAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return seenAt, err
}

// releaseFeedUnreadCount counts the families with an event since the account
// last opened the feed.
func (s *Server) releaseFeedUnreadCount(ctx context.Context, userID int64) (int, error) {
	seenAt, err := s.releaseFeedSeenAt(ctx, userID)
	if err != nil {
		return 0, err
	}
	var count int
	err = s.db.QueryRowContext(ctx, releaseFeedFamilySQL+`
		SELECT COUNT(DISTINCT family_key) FROM item WHERE created_at > ?
	`, userID, seenAt).Scan(&count)
	return count, err
}

// loadReleaseFeed reads one page of an account's feed, with days counted in
// location. Paging by days reads every family's newest time first; the
// details are loaded for the page's families only.
func (s *Server) loadReleaseFeed(ctx context.Context, userID int64, page, days int, location *time.Location) (releaseFeedPage, error) {
	result := releaseFeedPage{Families: []releaseFeedFamily{}, Page: page, Days: days}
	seenAt, err := s.releaseFeedSeenAt(ctx, userID)
	if err != nil {
		return result, err
	}
	rows, err := s.db.QueryContext(ctx, releaseFeedFamilySQL+`
		SELECT family_key, MAX(created_at), MAX(id) FROM item
		GROUP BY family_key
		ORDER BY MAX(created_at) DESC, MAX(id) DESC
	`, userID)
	if err != nil {
		return result, err
	}
	all := []releaseFeedFamily{}
	for rows.Next() {
		var family releaseFeedFamily
		var latestID int64
		if err := rows.Scan(&family.Key, &family.LatestAt, &latestID); err != nil {
			_ = rows.Close()
			return result, err
		}
		family.Unread = family.LatestAt > seenAt
		family.Events = []releaseFeedEvent{}
		if family.Unread {
			result.UnreadCount++
		}
		all = append(all, family)
	}
	if err := rows.Close(); err != nil {
		return result, err
	}
	result.Total = len(all)
	result.Families, result.TotalDays = pageReleaseFeedDays(all, page, days, location)
	if len(result.Families) == 0 {
		return result, nil
	}
	keys := make([]string, 0, len(result.Families))
	byKey := map[string]*releaseFeedFamily{}
	for index := range result.Families {
		keys = append(keys, result.Families[index].Key)
		byKey[result.Families[index].Key] = &result.Families[index]
	}
	args := []any{userID}
	for _, key := range keys {
		args = append(args, key)
	}
	eventRows, err := s.db.QueryContext(ctx, releaseFeedFamilySQL+`
		SELECT item.family_key, item.primary_code, item.event_type, item.created_at, item.subject_kind,
			COALESCE(item.party_id, 0), item.series_title_id, COALESCE(item.person_id, 0),
			COALESCE(party.display_name, ''),
			COALESCE((
				SELECT external.external_id FROM party_external_id AS external
				WHERE external.party_id = item.party_id AND external.id_type = 'maker_id'
				ORDER BY external.is_primary DESC, external.id
				LIMIT 1
			), ''),
			COALESCE((
				SELECT series.name FROM party_series AS series
				WHERE series.party_id = item.party_id AND UPPER(series.title_id) = item.series_title_id
				ORDER BY series.id DESC
				LIMIT 1
			), ''),
			COALESCE(person.display_name, ''),
			CASE WHEN person.id IS NULL THEN '' ELSE `+voiceRouteKeySQL("person.id")+` END,
			COALESCE((
				SELECT edition.metadata_language
				FROM work INNER JOIN work_edition AS edition ON edition.work_id = work.id
				WHERE UPPER(work.primary_code) = item.primary_code
				LIMIT 1
			), '')
		FROM item
		LEFT JOIN party ON party.id = item.party_id
		LEFT JOIN person ON person.id = item.person_id
		WHERE item.family_key IN (`+sqlPlaceholders(len(keys))+`)
		ORDER BY item.created_at DESC, item.id DESC
	`, args...)
	if err != nil {
		return result, err
	}
	for eventRows.Next() {
		var key string
		var event releaseFeedEvent
		var partyID int64
		if err := eventRows.Scan(&key, &event.Code, &event.Type, &event.At, &event.Subject.Kind, &partyID,
			&event.Subject.SeriesID, &event.Subject.PersonID, &event.Subject.CircleName, &event.Subject.CircleID,
			&event.Subject.SeriesName, &event.Subject.VoiceName, &event.Subject.VoiceRouteKey, &event.Language); err != nil {
			_ = eventRows.Close()
			return result, err
		}
		event.Subject.CircleID = normalizeMakerID(event.Subject.CircleID)
		if family := byKey[key]; family != nil {
			family.Events = append(family.Events, event)
		}
	}
	if err := eventRows.Close(); err != nil {
		return result, err
	}
	if err := s.attachReleaseFeedWorks(ctx, userID, result.Families); err != nil {
		return result, err
	}
	return result, nil
}

// attachReleaseFeedWorks shows each family through its canonical work, or the
// fallback catalog details when the family has no work yet.
func (s *Server) attachReleaseFeedWorks(ctx context.Context, userID int64, families []releaseFeedFamily) error {
	workIDs := map[string]int64{}
	ids := []any{}
	for _, family := range families {
		var workID sql.NullInt64
		var err error
		if logicalID, found := strings.CutPrefix(family.Key, "family:"); found {
			id, _ := strconv.ParseInt(logicalID, 10, 64)
			err = s.db.QueryRowContext(ctx, `
				SELECT COALESCE(logical.canonical_work_id, (
					SELECT edition.work_id FROM work_edition AS edition
					WHERE edition.logical_work_id = logical.id
					ORDER BY edition.is_canonical DESC, edition.work_id
					LIMIT 1
				))
				FROM logical_work AS logical WHERE logical.id = ?
			`, id).Scan(&workID)
		} else {
			err = s.db.QueryRowContext(ctx, "SELECT id FROM work WHERE UPPER(primary_code) = ? LIMIT 1", strings.TrimPrefix(family.Key, "code:")).Scan(&workID)
		}
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if workID.Valid && workID.Int64 > 0 {
			workIDs[family.Key] = workID.Int64
			ids = append(ids, workID.Int64)
		}
	}
	works := map[int64]libraryWorkSummary{}
	if len(ids) > 0 {
		raw, err := s.libraryStore.ListMatching(ctx, userID, fmt.Sprintf("work.id IN (%s)", sqlPlaceholders(len(ids))), ids, 1, len(ids), false)
		if err != nil {
			return err
		}
		summaries, err := s.scanLibraryWorkRows(ctx, userID, raw, true)
		if err != nil {
			return err
		}
		for _, summary := range summaries {
			works[summary.ID] = summary
		}
	}
	for index := range families {
		family := &families[index]
		if work, ok := works[workIDs[family.Key]]; ok {
			family.Work = &work
		}
		code := strings.TrimPrefix(family.Key, "code:")
		if len(family.Events) > 0 {
			code = family.Events[len(family.Events)-1].Code
		}
		family.Fallback = s.releaseFeedFallback(ctx, code)
	}
	return nil
}

func (s *Server) releaseFeedFallback(ctx context.Context, code string) releaseFeedFallback {
	fallback := releaseFeedFallback{Code: code, VoiceActors: []string{}, Tags: []string{}, DLsiteURL: s.dlsiteURL(code), CoverURL: s.coverURL(code)}
	var title, releaseDate, circle sql.NullString
	err := s.db.QueryRowContext(ctx, `
		SELECT title, release_date, circle FROM voice_catalog_item WHERE UPPER(primary_code) = ? ORDER BY updated_at DESC LIMIT 1
	`, code).Scan(&title, &releaseDate, &circle)
	if err != nil {
		_ = s.db.QueryRowContext(ctx, `
			SELECT item.title, item.release_date, party.display_name
			FROM party_catalog_item AS item INNER JOIN party ON party.id = item.party_id
			WHERE UPPER(item.primary_code) = ?
			ORDER BY item.last_seen_at DESC
			LIMIT 1
		`, code).Scan(&title, &releaseDate, &circle)
	}
	fallback.Title = firstNonEmpty(strings.TrimSpace(title.String), code)
	fallback.ReleaseDate = normalizeGraphReleaseDate(releaseDate.String)
	fallback.Circle = strings.TrimSpace(circle.String)
	return fallback
}
