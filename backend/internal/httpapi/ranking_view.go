package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strconv"
	"strings"
)

// A ranking page shows a list's latest snapshot compared with a baseline: the
// snapshot the account last looked at, the previous snapshot, or one the
// account picks. Items are codes; a code with a work shows that work, others
// show the ranking's own title and circle.

type rankingSnapshotRef struct {
	ID       int64  `json:"id"`
	PulledAt string `json:"pulledAt"`
}

type rankingBaseline struct {
	rankingSnapshotRef
	// Kind is seen, previous, or snapshot.
	Kind string `json:"kind"`
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
	Fallback        rankingFallback     `json:"fallback"`
}

type rankingDroppedItem struct {
	Code         string              `json:"code"`
	PreviousRank int                 `json:"previousRank"`
	Work         *libraryWorkSummary `json:"work"`
	Fallback     rankingFallback     `json:"fallback"`
}

type rankingCounts struct {
	New       int `json:"new"`
	Reentered int `json:"reentered"`
	Up        int `json:"up"`
	Down      int `json:"down"`
	Dropped   int `json:"dropped"`
	// NotInLibrary counts items whose code has no work.
	NotInLibrary int `json:"notInLibrary"`
}

type rankingPage struct {
	List      rankingList          `json:"list"`
	Snapshot  *rankingSnapshotRef  `json:"snapshot"`
	Baseline  *rankingBaseline     `json:"baseline"`
	Counts    rankingCounts        `json:"counts"`
	Items     []rankingItem        `json:"items"`
	Dropped   []rankingDroppedItem `json:"dropped"`
	Snapshots []rankingSnapshotRef `json:"snapshots"`
	Demo      bool                 `json:"demo"`
}

type rankingEntryRecord struct {
	title, maker, coverURL       string
	firstSeenAt, streakStartedAt string
	bestRank, appearances        int
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
	compare := strings.TrimSpace(r.URL.Query().Get("compare"))
	if s.cfg.IsDemo() {
		page, found := demoRankingPage(id, compare)
		if !found {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": errRankingListNotFound.Error()})
			return
		}
		writeJSON(w, http.StatusOK, page)
		return
	}
	list, err := s.loadRankingList(r.Context(), user.ID, id)
	if err == nil && !list.Enabled && !userHasPermission(user, "metadata:sync") {
		err = errRankingListNotFound
	}
	if errors.Is(err, errRankingListNotFound) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	page, err := s.loadRankingPage(r.Context(), user.ID, list, compare)
	if errors.Is(err, errRankingSnapshotNotFound) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

var errRankingSnapshotNotFound = errors.New("the snapshot to compare with is not available")

func (s *Server) loadRankingSnapshots(ctx context.Context, listID int64) ([]rankingSnapshotRef, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, pulled_at FROM ranking_snapshot WHERE ranking_list_id = ? ORDER BY pulled_at DESC, id DESC LIMIT ?
	`, listID, rankingSnapshotChoices)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	snapshots := []rankingSnapshotRef{}
	for rows.Next() {
		var snapshot rankingSnapshotRef
		if err := rows.Scan(&snapshot.ID, &snapshot.PulledAt); err != nil {
			return nil, err
		}
		snapshots = append(snapshots, snapshot)
	}
	return snapshots, rows.Err()
}

// rankingBaselineFor picks the snapshot to compare the latest one with. With
// no seen snapshot, such as on a first visit or after the seen one was
// removed, "seen" compares with the previous snapshot.
func (s *Server) rankingBaselineFor(ctx context.Context, userID int64, listID int64, snapshots []rankingSnapshotRef, compare string) (*rankingBaseline, error) {
	previous := func() *rankingBaseline {
		if len(snapshots) < 2 {
			return nil
		}
		return &rankingBaseline{rankingSnapshotRef: snapshots[1], Kind: "previous"}
	}
	switch compare {
	case "", "seen":
		var seenID sql.NullInt64
		err := s.db.QueryRowContext(ctx, `
			SELECT seen_snapshot_id FROM user_ranking_state WHERE user_id = ? AND ranking_list_id = ?
		`, userID, listID).Scan(&seenID)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if !seenID.Valid {
			return previous(), nil
		}
		var baseline rankingBaseline
		err = s.db.QueryRowContext(ctx, `
			SELECT id, pulled_at FROM ranking_snapshot WHERE id = ? AND ranking_list_id = ?
		`, seenID.Int64, listID).Scan(&baseline.ID, &baseline.PulledAt)
		if errors.Is(err, sql.ErrNoRows) {
			return previous(), nil
		}
		if err != nil {
			return nil, err
		}
		baseline.Kind = "seen"
		return &baseline, nil
	case "previous":
		return previous(), nil
	default:
		snapshotID, err := strconv.ParseInt(compare, 10, 64)
		if err != nil || snapshotID <= 0 {
			return nil, errRankingSnapshotNotFound
		}
		var baseline rankingBaseline
		err = s.db.QueryRowContext(ctx, `
			SELECT id, pulled_at FROM ranking_snapshot WHERE id = ? AND ranking_list_id = ?
		`, snapshotID, listID).Scan(&baseline.ID, &baseline.PulledAt)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, errRankingSnapshotNotFound
		}
		if err != nil {
			return nil, err
		}
		baseline.Kind = "snapshot"
		return &baseline, nil
	}
}

func (s *Server) rankingSnapshotRanks(ctx context.Context, snapshotID int64) ([]string, map[string]int, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT rank, primary_code FROM ranking_snapshot_item WHERE snapshot_id = ? ORDER BY rank", snapshotID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	ranks := map[string]int{}
	for rows.Next() {
		var rank int
		var code string
		if err := rows.Scan(&rank, &code); err != nil {
			return nil, nil, err
		}
		codes = append(codes, code)
		ranks[code] = rank
	}
	return codes, ranks, rows.Err()
}

func (s *Server) loadRankingPage(ctx context.Context, userID int64, list rankingList, compare string) (rankingPage, error) {
	page := rankingPage{List: list, Items: []rankingItem{}, Dropped: []rankingDroppedItem{}}
	snapshots, err := s.loadRankingSnapshots(ctx, list.ID)
	if err != nil {
		return page, err
	}
	page.Snapshots = snapshots
	if len(snapshots) == 0 {
		return page, nil
	}
	latest := snapshots[0]
	page.Snapshot = &latest
	baseline, err := s.rankingBaselineFor(ctx, userID, list.ID, snapshots, compare)
	if err != nil {
		return page, err
	}
	page.Baseline = baseline
	codes, _, err := s.rankingSnapshotRanks(ctx, latest.ID)
	if err != nil {
		return page, err
	}
	baseRanks := map[string]int{}
	baseCodes := []string{}
	if baseline != nil {
		if baseCodes, baseRanks, err = s.rankingSnapshotRanks(ctx, baseline.ID); err != nil {
			return page, err
		}
	}
	entries, err := s.rankingEntries(ctx, list.ID)
	if err != nil {
		return page, err
	}
	current := map[string]bool{}
	for index, code := range codes {
		rank := index + 1
		current[code] = true
		entry := entries[code]
		item := rankingItem{
			Rank: rank, Code: code, Change: rankingItemChange(rank, code, entry, baseline, baseRanks),
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
	if err := s.attachRankingWorks(ctx, userID, list, entries, &page); err != nil {
		return page, err
	}
	for _, item := range page.Items {
		if item.Work == nil {
			page.Counts.NotInLibrary++
		}
	}
	return page, nil
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

func (s *Server) rankingEntries(ctx context.Context, listID int64) (map[string]rankingEntryRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT primary_code, title, maker_name, remote_cover_url, first_seen_at, streak_started_at, best_rank, appearances
		FROM ranking_entry WHERE ranking_list_id = ?
	`, listID)
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
		}
		item.Fallback = s.rankingFallback(ctx, list, item.Code, entries[item.Code])
	}
	for index := range page.Dropped {
		item := &page.Dropped[index]
		if work, ok := works[item.Code]; ok {
			item.Work = &work
		}
		item.Fallback = s.rankingFallback(ctx, list, item.Code, entries[item.Code])
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
	var pulledAt string
	err = s.db.QueryRowContext(r.Context(), `
		SELECT pulled_at FROM ranking_snapshot WHERE id = ? AND ranking_list_id = ?
	`, payload.SnapshotID, id).Scan(&pulledAt)
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
		INSERT INTO user_ranking_state (user_id, ranking_list_id, seen_snapshot_id, seen_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, ranking_list_id) DO UPDATE SET
			seen_snapshot_id = excluded.seen_snapshot_id,
			seen_at = excluded.seen_at
		WHERE user_ranking_state.seen_snapshot_id IS NULL OR user_ranking_state.seen_snapshot_id < excluded.seen_snapshot_id
	`, user.ID, id, payload.SnapshotID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
