package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// A ranking page shows one snapshot of one order of a list compared with a
// baseline of the same order. The latest page compares the latest snapshot
// with the one the account last looked at, the previous snapshot, or one the
// account picks. A history page shows the snapshot in effect at a requested
// time, compared with the one before it by default, and says whether a pull
// confirmed that order at the time. Items are codes; a code with a work shows
// that work, others show the ranking's own title and circle.

type rankingSnapshotRef struct {
	ID             int64  `json:"id"`
	PulledAt       string `json:"pulledAt"`
	ConfirmedUntil string `json:"confirmedUntil"`
}

type rankingBaseline struct {
	rankingSnapshotRef
	// Kind is seen, previous, or snapshot.
	Kind string `json:"kind"`
}

// rankingCoverage says how well the history knows the order at a time:
// confirmed when a pull returned it at or after the time, unpulled when no
// pull ran between its last confirmation and the time, and before when the
// time precedes the list's history.
type rankingCoverage struct {
	State          string  `json:"state"`
	ConfirmedUntil *string `json:"confirmedUntil"`
}

type rankingChange struct {
	// Kind is new, reentered, up, down, or same.
	Kind  string `json:"kind"`
	From  *int   `json:"from"`
	Delta int    `json:"delta"`
}

type rankingFallback struct {
	Code      string `json:"code"`
	Title     string `json:"title"`
	Circle    string `json:"circle"`
	CoverURL  string `json:"coverUrl"`
	DLsiteURL string `json:"dlsiteUrl"`
}

type rankingItem struct {
	Rank            int                 `json:"rank"`
	Code            string              `json:"code"`
	Change          rankingChange       `json:"change"`
	FirstSeenAt     string              `json:"firstSeenAt"`
	StreakStartedAt string              `json:"streakStartedAt"`
	BestRank        int                 `json:"bestRank"`
	Appearances     int                 `json:"appearances"`
	Work            *libraryWorkSummary `json:"work"`
	// InLibrary is true when the work has files: available local, cached, or
	// tracked remote locations. A work known only by its metadata is not.
	InLibrary bool `json:"inLibrary"`
	// Watched is true when the Availability Watch pool watches the code or
	// another edition of its family. It is stated only to accounts that may
	// see the pool.
	Watched  bool            `json:"watched"`
	Fallback rankingFallback `json:"fallback"`
}

type rankingDroppedItem struct {
	Code         string              `json:"code"`
	PreviousRank int                 `json:"previousRank"`
	Work         *libraryWorkSummary `json:"work"`
	InLibrary    bool                `json:"inLibrary"`
	Watched      bool                `json:"watched"`
	Fallback     rankingFallback     `json:"fallback"`
}

type rankingCounts struct {
	New       int `json:"new"`
	Reentered int `json:"reentered"`
	Up        int `json:"up"`
	Down      int `json:"down"`
	Dropped   int `json:"dropped"`
	// NotInLibrary counts items whose code has no work with files.
	NotInLibrary int `json:"notInLibrary"`
}

// rankingHistoryBounds tells the history view what it can show: the first
// retained snapshot and the time from which every changed snapshot is kept.
// Earlier days keep only the order in effect at the end of each day.
type rankingHistoryBounds struct {
	FirstPulledAt *string `json:"firstPulledAt"`
	FullFrom      string  `json:"fullFrom"`
}

type rankingPage struct {
	List rankingList `json:"list"`
	// Variant is the shown order of the list.
	Variant rankingVariant `json:"variant"`
	// At is the requested time of a history page, empty for the latest.
	At               *string              `json:"at"`
	Snapshot         *rankingSnapshotRef  `json:"snapshot"`
	Coverage         *rankingCoverage     `json:"coverage"`
	PreviousSnapshot *rankingSnapshotRef  `json:"previousSnapshot"`
	NextSnapshot     *rankingSnapshotRef  `json:"nextSnapshot"`
	Baseline         *rankingBaseline     `json:"baseline"`
	Counts           rankingCounts        `json:"counts"`
	Items            []rankingItem        `json:"items"`
	Dropped          []rankingDroppedItem `json:"dropped"`
	History          rankingHistoryBounds `json:"history"`
	Demo             bool                 `json:"demo"`
}

type rankingEntryRecord struct {
	title, maker, coverURL       string
	firstSeenAt, streakStartedAt string
	bestRank, appearances        int
}

var (
	errRankingSnapshotNotFound = errors.New("the snapshot to compare with is not available")
	errRankingTimeInvalid      = errors.New("the time must be an RFC 3339 timestamp")
)

var rankingSnapshotIDPattern = regexp.MustCompile(`^[1-9][0-9]*$`)

// parseRankingTime reads a requested time as UTC.
func parseRankingTime(value string) (time.Time, error) {
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UTC().Truncate(time.Second), nil
		}
	}
	return time.Time{}, errRankingTimeInvalid
}

// parseRankingOrder reads the order a request names: release is 30d for works
// released within 30 days, and sort is sale for the sales order. Omitted, they
// name the list's default order.
func parseRankingOrder(r *http.Request) (rankingOrder, error) {
	order := rankingOrder{
		ReleaseWindow: strings.TrimSpace(r.URL.Query().Get("release")),
		Sort:          strings.TrimSpace(r.URL.Query().Get("sort")),
	}
	if (order.ReleaseWindow != "" && order.ReleaseWindow != rankingReleaseWindow) || (order.Sort != "" && order.Sort != rankingSortSales) {
		return order, errRankingOrderUnknown
	}
	return order, nil
}

// variantFor returns the list's variant of an order, or errRankingOrderUnknown
// when the list is not pulled in it.
func (list rankingList) variantFor(order rankingOrder) (rankingVariant, error) {
	variant, ok := list.variant(order.ReleaseWindow, order.Sort)
	if !ok {
		return rankingVariant{}, errRankingOrderUnknown
	}
	return variant, nil
}

// rankingPageRequest is what a page asks for: the order to show, at selects a
// history page, and compare is seen, previous, a snapshot id, or a time.
type rankingPageRequest struct {
	order   rankingOrder
	at      *time.Time
	compare string
}

func parseRankingPageRequest(r *http.Request) (rankingPageRequest, error) {
	request := rankingPageRequest{compare: strings.TrimSpace(r.URL.Query().Get("compare"))}
	order, err := parseRankingOrder(r)
	if err != nil {
		return request, err
	}
	request.order = order
	if raw := strings.TrimSpace(r.URL.Query().Get("at")); raw != "" {
		at, err := parseRankingTime(raw)
		if err != nil {
			return request, err
		}
		request.at = &at
	}
	switch {
	case request.compare == "", request.compare == "seen", request.compare == "previous", rankingSnapshotIDPattern.MatchString(request.compare):
	default:
		if _, err := parseRankingTime(request.compare); err != nil {
			return request, errRankingSnapshotNotFound
		}
	}
	return request, nil
}

func (s *Server) getRanking(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ranking id"})
		return
	}
	request, err := parseRankingPageRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if s.cfg.IsDemo() {
		page, found, err := demoRankingPage(id, request)
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": errRankingListNotFound.Error()})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, page)
		return
	}
	list, err := s.loadVisibleRankingList(r.Context(), user, id)
	if errors.Is(err, errRankingListNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	page, err := s.loadRankingPage(r.Context(), user.ID, list, request)
	if errors.Is(err, errRankingSnapshotNotFound) || errors.Is(err, errRankingOrderUnknown) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if userHasPermission(user, "workflows:run") {
		if err := s.markRankingWatched(r.Context(), &page); err != nil {
			writeError(w, err)
			return
		}
	}
	writeJSON(w, http.StatusOK, page)
}

// loadVisibleRankingList hides a switched-off list from accounts that cannot
// configure rankings.
func (s *Server) loadVisibleRankingList(ctx context.Context, user currentUser, id int64) (rankingList, error) {
	list, err := s.loadRankingList(ctx, user.ID, id)
	if err == nil && !list.Enabled && !userHasPermission(user, "metadata:sync") {
		return rankingList{}, errRankingListNotFound
	}
	return list, err
}

const rankingSnapshotColumns = "id, pulled_at, COALESCE(confirmed_until, pulled_at)"

func scanRankingSnapshot(row interface{ Scan(...any) error }) (*rankingSnapshotRef, error) {
	var snapshot rankingSnapshotRef
	err := row.Scan(&snapshot.ID, &snapshot.PulledAt, &snapshot.ConfirmedUntil)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &snapshot, nil
}

// rankingSnapshotAt is the snapshot in effect at a time: the latest pulled
// at or before it. A nil time reads the latest snapshot.
func (s *Server) rankingSnapshotAt(ctx context.Context, variantID int64, at *time.Time) (*rankingSnapshotRef, error) {
	if at == nil {
		return scanRankingSnapshot(s.db.QueryRowContext(ctx, `
			SELECT `+rankingSnapshotColumns+` FROM ranking_snapshot WHERE ranking_variant_id = ? ORDER BY pulled_at DESC, id DESC LIMIT 1
		`, variantID))
	}
	return scanRankingSnapshot(s.db.QueryRowContext(ctx, `
		SELECT `+rankingSnapshotColumns+` FROM ranking_snapshot WHERE ranking_variant_id = ? AND pulled_at <= ? ORDER BY pulled_at DESC, id DESC LIMIT 1
	`, variantID, formatWorkflowTimestamp(*at)))
}

// rankingNeighborSnapshot is the snapshot right before (direction < 0) or
// after (direction > 0) another one.
func (s *Server) rankingNeighborSnapshot(ctx context.Context, variantID int64, snapshot rankingSnapshotRef, direction int) (*rankingSnapshotRef, error) {
	if direction < 0 {
		return scanRankingSnapshot(s.db.QueryRowContext(ctx, `
			SELECT `+rankingSnapshotColumns+` FROM ranking_snapshot
			WHERE ranking_variant_id = ? AND (pulled_at < ? OR (pulled_at = ? AND id < ?))
			ORDER BY pulled_at DESC, id DESC LIMIT 1
		`, variantID, snapshot.PulledAt, snapshot.PulledAt, snapshot.ID))
	}
	return scanRankingSnapshot(s.db.QueryRowContext(ctx, `
		SELECT `+rankingSnapshotColumns+` FROM ranking_snapshot
		WHERE ranking_variant_id = ? AND (pulled_at > ? OR (pulled_at = ? AND id > ?))
		ORDER BY pulled_at, id LIMIT 1
	`, variantID, snapshot.PulledAt, snapshot.PulledAt, snapshot.ID))
}

// rankingCoverageAt describes how well a snapshot covers a requested time.
func rankingCoverageAt(snapshot *rankingSnapshotRef, at time.Time) *rankingCoverage {
	if snapshot == nil {
		return &rankingCoverage{State: "before"}
	}
	confirmed := snapshot.ConfirmedUntil
	coverage := &rankingCoverage{State: "confirmed", ConfirmedUntil: &confirmed}
	if until, ok := parseWorkflowTimestamp(confirmed); ok && at.After(until) {
		coverage.State = "unpulled"
	}
	return coverage
}

// rankingBaselineFor picks the snapshot to compare a shown one with. With no
// seen snapshot, such as on a first visit or after the seen one was removed,
// "seen" compares with the previous snapshot; a history page compares with the
// previous snapshot unless another one is named.
func (s *Server) rankingBaselineFor(ctx context.Context, userID int64, variantID int64, shown rankingSnapshotRef, previous *rankingSnapshotRef, request rankingPageRequest) (*rankingBaseline, error) {
	previousBaseline := func() *rankingBaseline {
		if previous == nil {
			return nil
		}
		return &rankingBaseline{rankingSnapshotRef: *previous, Kind: "previous"}
	}
	compare := request.compare
	if compare == "" && request.at == nil {
		compare = "seen"
	}
	switch {
	case compare == "" || compare == "previous" || (compare == "seen" && request.at != nil):
		return previousBaseline(), nil
	case compare == "seen":
		var seenID sql.NullInt64
		err := s.db.QueryRowContext(ctx, `
			SELECT seen_snapshot_id FROM user_ranking_state WHERE user_id = ? AND ranking_variant_id = ?
		`, userID, variantID).Scan(&seenID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if !seenID.Valid {
			return previousBaseline(), nil
		}
		seen, err := scanRankingSnapshot(s.db.QueryRowContext(ctx, `
			SELECT `+rankingSnapshotColumns+` FROM ranking_snapshot WHERE id = ? AND ranking_variant_id = ?
		`, seenID.Int64, variantID))
		if err != nil {
			return nil, err
		}
		if seen == nil {
			return previousBaseline(), nil
		}
		return &rankingBaseline{rankingSnapshotRef: *seen, Kind: "seen"}, nil
	case rankingSnapshotIDPattern.MatchString(compare):
		snapshotID, _ := strconv.ParseInt(compare, 10, 64)
		picked, err := scanRankingSnapshot(s.db.QueryRowContext(ctx, `
			SELECT `+rankingSnapshotColumns+` FROM ranking_snapshot WHERE id = ? AND ranking_variant_id = ?
		`, snapshotID, variantID))
		if err != nil {
			return nil, err
		}
		if picked == nil {
			return nil, errRankingSnapshotNotFound
		}
		return &rankingBaseline{rankingSnapshotRef: *picked, Kind: "snapshot"}, nil
	default:
		at, err := parseRankingTime(compare)
		if err != nil {
			return nil, errRankingSnapshotNotFound
		}
		picked, err := s.rankingSnapshotAt(ctx, variantID, &at)
		if err != nil {
			return nil, err
		}
		if picked == nil {
			return nil, errRankingSnapshotNotFound
		}
		return &rankingBaseline{rankingSnapshotRef: *picked, Kind: "snapshot"}, nil
	}
}

func (s *Server) rankingSnapshotCodes(ctx context.Context, snapshotID int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT primary_code FROM ranking_snapshot_item WHERE snapshot_id = ? ORDER BY rank", snapshotID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		codes = append(codes, code)
	}
	return codes, rows.Err()
}

func (s *Server) loadRankingPage(ctx context.Context, userID int64, list rankingList, request rankingPageRequest) (rankingPage, error) {
	variant, err := list.variantFor(request.order)
	if err != nil {
		return rankingPage{}, err
	}
	now := time.Now().UTC()
	page := rankingPage{List: list, Variant: variant, Items: []rankingItem{}, Dropped: []rankingDroppedItem{}}
	page.History.FullFrom = formatWorkflowTimestamp(s.rankingRetentionSettings(ctx).fullHistoryFrom(now))
	var firstPulled sql.NullString
	if err := s.db.QueryRowContext(ctx, "SELECT MIN(pulled_at) FROM ranking_snapshot WHERE ranking_variant_id = ?", variant.ID).Scan(&firstPulled); err != nil {
		return page, err
	}
	if firstPulled.Valid {
		page.History.FirstPulledAt = &firstPulled.String
	}
	shown, err := s.rankingSnapshotAt(ctx, variant.ID, request.at)
	if err != nil {
		return page, err
	}
	if request.at != nil {
		at := formatWorkflowTimestamp(*request.at)
		page.At = &at
		page.Coverage = rankingCoverageAt(shown, *request.at)
	}
	if shown == nil {
		if request.at != nil && firstPulled.Valid {
			page.NextSnapshot, err = scanRankingSnapshot(s.db.QueryRowContext(ctx, `
				SELECT `+rankingSnapshotColumns+` FROM ranking_snapshot WHERE ranking_variant_id = ? ORDER BY pulled_at, id LIMIT 1
			`, variant.ID))
		}
		return page, err
	}
	page.Snapshot = shown
	if page.PreviousSnapshot, err = s.rankingNeighborSnapshot(ctx, variant.ID, *shown, -1); err != nil {
		return page, err
	}
	if page.NextSnapshot, err = s.rankingNeighborSnapshot(ctx, variant.ID, *shown, 1); err != nil {
		return page, err
	}
	baseline, err := s.rankingBaselineFor(ctx, userID, variant.ID, *shown, page.PreviousSnapshot, request)
	if err != nil {
		return page, err
	}
	page.Baseline = baseline
	codes, err := s.rankingSnapshotCodes(ctx, shown.ID)
	if err != nil {
		return page, err
	}
	baseCodes := []string{}
	if baseline != nil {
		if baseCodes, err = s.rankingSnapshotCodes(ctx, baseline.ID); err != nil {
			return page, err
		}
	}
	entries, err := s.rankingEntries(ctx, variant.ID)
	if err != nil {
		return page, err
	}
	fillRankingPageItems(&page, codes, baseCodes, entries)
	if err := s.attachRankingWorks(ctx, userID, list, entries, &page); err != nil {
		return page, err
	}
	for _, item := range page.Items {
		if !item.InLibrary {
			page.Counts.NotInLibrary++
		}
	}
	return page, nil
}

// fillRankingPageItems lists the shown codes with their change against the
// baseline, and the baseline's codes missing from the shown order as dropped.
func fillRankingPageItems(page *rankingPage, codes, baseCodes []string, entries map[string]rankingEntryRecord) {
	baseRanks := map[string]int{}
	for index, code := range baseCodes {
		baseRanks[code] = index + 1
	}
	current := map[string]bool{}
	for index, code := range codes {
		rank := index + 1
		current[code] = true
		entry := entries[code]
		item := rankingItem{
			Rank: rank, Code: code, Change: rankingItemChange(rank, code, entry, page.Baseline, baseRanks),
			FirstSeenAt: entry.firstSeenAt, StreakStartedAt: entry.streakStartedAt,
			BestRank: entry.bestRank, Appearances: entry.appearances,
		}
		switch item.Change.Kind {
		case "new":
			page.Counts.New++
		case "reentered":
			page.Counts.Reentered++
		case "up":
			page.Counts.Up++
		case "down":
			page.Counts.Down++
		}
		page.Items = append(page.Items, item)
	}
	for _, code := range baseCodes {
		if !current[code] {
			page.Dropped = append(page.Dropped, rankingDroppedItem{Code: code, PreviousRank: baseRanks[code]})
		}
	}
	sort.SliceStable(page.Dropped, func(i, j int) bool { return page.Dropped[i].PreviousRank < page.Dropped[j].PreviousRank })
	page.Counts.Dropped = len(page.Dropped)
}

// rankingItemChange compares an item with the baseline. A code missing from
// the baseline is new when the list first held it after the baseline, and
// re-entered otherwise.
func rankingItemChange(rank int, code string, entry rankingEntryRecord, baseline *rankingBaseline, baseRanks map[string]int) rankingChange {
	if baseline == nil {
		return rankingChange{Kind: "same"}
	}
	from, found := baseRanks[code]
	if !found {
		if entry.firstSeenAt == "" || entry.firstSeenAt > baseline.PulledAt {
			return rankingChange{Kind: "new"}
		}
		return rankingChange{Kind: "reentered"}
	}
	change := rankingChange{From: &from, Delta: from - rank}
	switch {
	case change.Delta > 0:
		change.Kind = "up"
	case change.Delta < 0:
		change.Kind = "down"
	default:
		change.Kind = "same"
	}
	return change
}

func (s *Server) rankingEntries(ctx context.Context, variantID int64) (map[string]rankingEntryRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT primary_code, title, maker_name, remote_cover_url, first_seen_at, streak_started_at, best_rank, appearances
		FROM ranking_entry WHERE ranking_variant_id = ?
	`, variantID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	entries := map[string]rankingEntryRecord{}
	for rows.Next() {
		var code string
		var entry rankingEntryRecord
		if err := rows.Scan(&code, &entry.title, &entry.maker, &entry.coverURL, &entry.firstSeenAt, &entry.streakStartedAt, &entry.bestRank, &entry.appearances); err != nil {
			return nil, err
		}
		entries[code] = entry
	}
	return entries, rows.Err()
}

// attachRankingWorks shows each code through its work when one exists, and
// gives every code a text card from the ranking and the catalogs.
func (s *Server) attachRankingWorks(ctx context.Context, userID int64, list rankingList, entries map[string]rankingEntryRecord, page *rankingPage) error {
	codes := make([]string, 0, len(page.Items)+len(page.Dropped))
	for _, item := range page.Items {
		codes = append(codes, item.Code)
	}
	for _, item := range page.Dropped {
		codes = append(codes, item.Code)
	}
	works, err := s.rankingWorkSummaries(ctx, userID, codes)
	if err != nil {
		return err
	}
	for index := range page.Items {
		item := &page.Items[index]
		if work, ok := works[item.Code]; ok {
			item.Work = &work
			item.InLibrary = workHasFiles(work.Availability)
		}
		item.Fallback = s.rankingFallback(ctx, list, item.Code, entries[item.Code])
	}
	for index := range page.Dropped {
		item := &page.Dropped[index]
		if work, ok := works[item.Code]; ok {
			item.Work = &work
			item.InLibrary = workHasFiles(work.Availability)
		}
		item.Fallback = s.rankingFallback(ctx, list, item.Code, entries[item.Code])
	}
	return nil
}

// workHasFiles reports whether a work's availability names a location that
// plays: local, cached, or a tracked remote work's stream or download.
func workHasFiles(availability []string) bool {
	for _, kind := range availability {
		switch kind {
		case "local", "cache", "remote":
			return true
		}
	}
	return false
}

// markRankingWatched states which shown codes the Availability Watch pool
// watches.
func (s *Server) markRankingWatched(ctx context.Context, page *rankingPage) error {
	codes := make([]string, 0, len(page.Items)+len(page.Dropped))
	for _, item := range page.Items {
		codes = append(codes, item.Code)
	}
	for _, item := range page.Dropped {
		codes = append(codes, item.Code)
	}
	watched, err := s.activeAvailabilityWatchCodes(ctx, codes)
	if err != nil {
		return err
	}
	for index := range page.Items {
		page.Items[index].Watched = watched[page.Items[index].Code]
	}
	for index := range page.Dropped {
		page.Dropped[index].Watched = watched[page.Dropped[index].Code]
	}
	return nil
}

func (s *Server) rankingWorkSummaries(ctx context.Context, userID int64, codes []string) (map[string]libraryWorkSummary, error) {
	result := map[string]libraryWorkSummary{}
	if len(codes) == 0 {
		return result, nil
	}
	args := make([]any, 0, len(codes))
	for _, code := range codes {
		args = append(args, code)
	}
	rows, err := s.db.QueryContext(ctx, fmt.Sprintf("SELECT id, UPPER(primary_code) FROM work WHERE UPPER(primary_code) IN (%s)", sqlPlaceholders(len(codes))), args...)
	if err != nil {
		return nil, err
	}
	codeByID := map[int64]string{}
	ids := []any{}
	for rows.Next() {
		var id int64
		var code string
		if err := rows.Scan(&id, &code); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if _, seen := codeByID[id]; !seen {
			codeByID[id] = code
			ids = append(ids, id)
		}
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	// The Library list reads at most 100 works at a time.
	for start := 0; start < len(ids); start += 100 {
		chunk := ids[start:min(start+100, len(ids))]
		raw, err := s.libraryStore.ListMatching(ctx, userID, fmt.Sprintf("work.id IN (%s)", sqlPlaceholders(len(chunk))), chunk, 1, len(chunk), false)
		if err != nil {
			return nil, err
		}
		summaries, err := s.scanLibraryWorkRows(ctx, userID, raw, true)
		if err != nil {
			return nil, err
		}
		for _, summary := range summaries {
			if code, ok := codeByID[summary.ID]; ok {
				result[code] = summary
			}
		}
	}
	return result, nil
}

// rankingFallback describes a code from the ranking's own text, then the
// circle and voice actor catalogs. A remote list's cover goes through the
// image proxy, never as the source's address.
func (s *Server) rankingFallback(ctx context.Context, list rankingList, code string, entry rankingEntryRecord) rankingFallback {
	fallback := rankingFallback{Code: code, Title: entry.title, Circle: entry.maker, CoverURL: s.coverURL(code), DLsiteURL: s.dlsiteURL(code)}
	if fallback.Title == "" {
		catalog := s.releaseFeedFallback(ctx, code)
		fallback.Title = catalog.Title
		fallback.Circle = firstNonEmpty(fallback.Circle, catalog.Circle)
	}
	if fallback.CoverURL == "" && entry.coverURL != "" && list.SourceID != nil {
		fallback.CoverURL = s.remoteImageProxyURL(*list.SourceID, entry.coverURL)
	}
	return fallback
}

const (
	rankingTimelineDefaultLimit = 100
	rankingTimelineMaxLimit     = 500
)

// rankingTimeline is one page of an order's snapshots, oldest first, within a
// requested time range.
type rankingTimeline struct {
	Snapshots     []rankingSnapshotRef `json:"snapshots"`
	NextAfterID   *int64               `json:"nextAfterId"`
	FirstPulledAt *string              `json:"firstPulledAt"`
	LastPulledAt  *string              `json:"lastPulledAt"`
	Demo          bool                 `json:"demo"`
}

type rankingTimelineRequest struct {
	order    rankingOrder
	from, to *time.Time
	afterID  int64
	limit    int
}

func parseRankingTimelineRequest(r *http.Request) (rankingTimelineRequest, error) {
	query := r.URL.Query()
	request := rankingTimelineRequest{limit: rankingTimelineDefaultLimit}
	order, err := parseRankingOrder(r)
	if err != nil {
		return request, err
	}
	request.order = order
	for _, bound := range []struct {
		key    string
		target **time.Time
	}{{"from", &request.from}, {"to", &request.to}} {
		if raw := strings.TrimSpace(query.Get(bound.key)); raw != "" {
			parsed, err := parseRankingTime(raw)
			if err != nil {
				return request, err
			}
			*bound.target = &parsed
		}
	}
	if raw := strings.TrimSpace(query.Get("afterId")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value <= 0 {
			return request, fmt.Errorf("afterId must be a snapshot id")
		}
		request.afterID = value
	}
	if raw := strings.TrimSpace(query.Get("limit")); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > rankingTimelineMaxLimit {
			return request, fmt.Errorf("limit must be between 1 and %d", rankingTimelineMaxLimit)
		}
		request.limit = value
	}
	return request, nil
}

func (s *Server) listRankingSnapshots(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ranking id"})
		return
	}
	request, err := parseRankingTimelineRequest(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if s.cfg.IsDemo() {
		timeline, found, err := demoRankingTimeline(id, request)
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": errRankingListNotFound.Error()})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, timeline)
		return
	}
	list, err := s.loadVisibleRankingList(r.Context(), user, id)
	if errors.Is(err, errRankingListNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	variant, err := list.variantFor(request.order)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	timeline, err := s.loadRankingTimeline(r.Context(), variant.ID, request)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, timeline)
}

func (s *Server) loadRankingTimeline(ctx context.Context, variantID int64, request rankingTimelineRequest) (rankingTimeline, error) {
	timeline := rankingTimeline{Snapshots: []rankingSnapshotRef{}}
	var first, last sql.NullString
	if err := s.db.QueryRowContext(ctx, "SELECT MIN(pulled_at), MAX(pulled_at) FROM ranking_snapshot WHERE ranking_variant_id = ?", variantID).Scan(&first, &last); err != nil {
		return timeline, err
	}
	if first.Valid {
		timeline.FirstPulledAt, timeline.LastPulledAt = &first.String, &last.String
	}
	where, args := "ranking_variant_id = ?", []any{variantID}
	if request.from != nil {
		where += " AND pulled_at >= ?"
		args = append(args, formatWorkflowTimestamp(*request.from))
	}
	if request.to != nil {
		where += " AND pulled_at < ?"
		args = append(args, formatWorkflowTimestamp(*request.to))
	}
	if request.afterID > 0 {
		where += " AND (pulled_at, id) > (SELECT pulled_at, id FROM ranking_snapshot WHERE id = ? AND ranking_variant_id = ?)"
		args = append(args, request.afterID, variantID)
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+rankingSnapshotColumns+" FROM ranking_snapshot WHERE "+where+" ORDER BY pulled_at, id LIMIT ?", append(args, request.limit+1)...)
	if err != nil {
		return timeline, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		snapshot, err := scanRankingSnapshot(rows)
		if err != nil {
			return timeline, err
		}
		timeline.Snapshots = append(timeline.Snapshots, *snapshot)
	}
	if err := rows.Err(); err != nil {
		return timeline, err
	}
	if len(timeline.Snapshots) > request.limit {
		timeline.Snapshots = timeline.Snapshots[:request.limit]
		next := timeline.Snapshots[request.limit-1].ID
		timeline.NextAfterID = &next
	}
	return timeline, nil
}

func (s *Server) markRankingSeen(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid ranking id"})
		return
	}
	var payload struct {
		SnapshotID int64 `json:"snapshotId"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&payload); err != nil || payload.SnapshotID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "snapshotId is required"})
		return
	}
	// The seen snapshot is kept for the order it belongs to.
	var variantID int64
	err = s.db.QueryRowContext(r.Context(), `
		SELECT snapshot.ranking_variant_id FROM ranking_snapshot AS snapshot
		INNER JOIN ranking_variant AS variant ON variant.id = snapshot.ranking_variant_id
		WHERE snapshot.id = ? AND variant.ranking_list_id = ?
	`, payload.SnapshotID, id).Scan(&variantID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": errRankingSnapshotNotFound.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	// The displayed snapshot is recorded, never an older one than the stored
	// snapshot, so a page opened before a refresh does not move it back.
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_ranking_state (user_id, ranking_variant_id, seen_snapshot_id, seen_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, ranking_variant_id) DO UPDATE SET
			seen_snapshot_id = excluded.seen_snapshot_id,
			seen_at = excluded.seen_at
		WHERE user_ranking_state.seen_snapshot_id IS NULL OR user_ranking_state.seen_snapshot_id < excluded.seen_snapshot_id
	`, user.ID, variantID, payload.SnapshotID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
