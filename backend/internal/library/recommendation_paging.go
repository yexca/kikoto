package library

import (
	"context"
	"database/sql"
	"sort"
	"strconv"
	"strings"
)

var recommendationLaneNames = []string{"none", "want_to_listen", "listening", "relisten", "finished", "paused"}

type recommendationMembership struct {
	from, where, exact, lane       string
	fromArgs, whereArgs, exactArgs []any
}

func recommendationMembershipFor(snapshot RecommendationSessionSnapshot, options ListOptions) recommendationMembership {
	where, args := listWhere(options.Scope, options.Status, options.Query, options.UserID, options.DemoOnly)
	exact, exactArgs := searchExactRankSQL(options.Query)
	if exact == "" {
		exact = "0"
	}
	from := ` FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?`
	fromArgs := []any{options.UserID}
	lane := "'none'"
	if snapshot.GenerationID > 0 {
		from += ` LEFT JOIN recommendation_generation_state AS frozen_state ON frozen_state.work_id = work.id AND frozen_state.primary_code=work.primary_code AND frozen_state.generation_id = ? AND EXISTS (SELECT 1 FROM recommendation_catalog_work AS frozen_work WHERE frozen_work.work_id=work.id AND frozen_work.primary_code=work.primary_code AND frozen_work.valid_from<=? AND (frozen_work.valid_to IS NULL OR frozen_work.valid_to>?))`
		fromArgs = append(fromArgs, snapshot.GenerationID, snapshot.CatalogEpoch, snapshot.CatalogEpoch)
		lane = "COALESCE(frozen_state.listening_status, 'none')"
	}
	return recommendationMembership{from, where, exact, lane, fromArgs, args, exactArgs}
}

func (membership recommendationMembership) projectionArgs() []any {
	args := append([]any{}, membership.exactArgs...)
	args = append(args, membership.fromArgs...)
	return append(args, membership.whereArgs...)
}

type recommendationPageID struct {
	id       int64
	position int64
	lane     string
}

func (s *Store) recommendationPage(ctx context.Context, options ListOptions) (RawPage, error) {
	snapshot, err := s.snapshotForRecommendation(ctx, options.UserID, options.RecommendationSessionID)
	if err != nil {
		return RawPage{}, err
	}
	contextID, prefix, err := s.recommendationContext(ctx, snapshot, options)
	if err != nil {
		return RawPage{}, err
	}
	// A deleted SQLite row ID can be reused by another primary_code. Cache
	// identity remains the unified code, including newly created neutral works.
	if len(prefix) > 0 {
		ids := make([]int64, len(prefix))
		for index, work := range prefix {
			ids[index] = work.id
		}
		codes, err := s.recommendationWorkCodes(ctx, ids)
		if err != nil {
			return RawPage{}, err
		}
		valid := make([]recommendationPrefixWork, 0, len(prefix))
		for _, work := range prefix {
			if codes[work.id] == work.primaryCode {
				valid = append(valid, work)
			}
		}
		prefix = valid
	}
	membership := recommendationMembershipFor(snapshot, options)
	counts, err := s.recommendationLaneCounts(ctx, membership)
	if err != nil {
		return RawPage{}, err
	}
	page := RawPage{Works: []RawWork{}, Page: options.Page, PageSize: options.PageSize, RecommendationContext: contextID}
	exacts := make([]int, 0, len(counts))
	for exact, lanes := range counts {
		exacts = append(exacts, exact)
		for _, count := range lanes {
			page.Total += count
		}
	}
	sort.Sort(sort.Reverse(sort.IntSlice(exacts)))
	if (options.Page-1)*options.PageSize >= page.Total {
		return page, nil
	}
	groups, err := s.recommendationPrefixGroups(ctx, membership, prefix)
	if err != nil {
		return RawPage{}, err
	}
	ids := []int64{}
	offset, remaining := (options.Page-1)*options.PageSize, options.PageSize
	for _, exact := range exacts {
		groupTotal := 0
		for _, count := range counts[exact] {
			groupTotal += count
		}
		if offset >= groupTotal {
			offset -= groupTotal
			continue
		}
		limit := min(remaining, groupTotal-offset)
		groupIDs, err := s.recommendationGroupPage(ctx, snapshot, options, contextID, membership, prefix, groups[exact], counts[exact], exact, offset, limit)
		if err != nil {
			return RawPage{}, err
		}
		ids = append(ids, groupIDs...)
		remaining -= len(groupIDs)
		offset = 0
		if remaining <= 0 {
			break
		}
	}
	if len(ids) == 0 {
		return page, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	args := []any{options.UserID}
	for _, id := range ids {
		args = append(args, id)
	}
	rows, err := s.db.QueryContext(ctx, listBaseSelectSQLWithExtra("work.id IN ("+placeholders+")", false, ""), args...)
	if err != nil {
		return RawPage{}, err
	}
	works, err := ScanRows(rows)
	if err != nil {
		return RawPage{}, err
	}
	byID := make(map[int64]RawWork, len(works))
	for _, work := range works {
		byID[work.ID] = work
	}
	// Prefix signals already contain true affinity. Only page members outside
	// that prefix need the page-sized feature and scoring read.
	prefixScores := map[int64]int{}
	for _, work := range prefix {
		if current, exists := byID[work.id]; exists && current.PrimaryCode == work.primaryCode {
			prefixScores[work.id] = buildRecommendationBreakdown(snapshot.Config, work.signals).Score
		}
	}
	tailIDs := []int64{}
	for _, id := range ids {
		if _, ok := prefixScores[id]; !ok {
			tailIDs = append(tailIDs, id)
		}
	}
	tailScores, err := s.scoreRecommendationWorks(ctx, snapshot, tailIDs)
	if err != nil {
		return RawPage{}, err
	}
	for _, id := range ids {
		work, exists := byID[id]
		if !exists {
			continue
		}
		if score, ok := prefixScores[id]; ok {
			work.RecommendScore = score
		} else {
			work.RecommendScore = tailScores[id].Score
		}
		page.Works = append(page.Works, work)
	}
	return page, nil
}

func (s *Store) recommendationLaneCounts(ctx context.Context, membership recommendationMembership) (map[int]map[string]int, error) {
	query := `SELECT ` + membership.exact + ` AS exact_rank, ` + membership.lane + ` AS lane, COUNT(*)` + membership.from + ` WHERE ` + membership.where + ` GROUP BY exact_rank, lane`
	rows, err := s.db.QueryContext(ctx, query, membership.projectionArgs()...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	counts := map[int]map[string]int{}
	for rows.Next() {
		var exact, count int
		var lane string
		if err := rows.Scan(&exact, &lane, &count); err != nil {
			return nil, err
		}
		if counts[exact] == nil {
			counts[exact] = map[string]int{}
		}
		counts[exact][lane] = count
		s.recommendationDiagnostics.membershipRows.Add(int64(count))
	}
	return counts, rows.Err()
}

func (s *Store) recommendationPrefixGroups(ctx context.Context, membership recommendationMembership, prefix []recommendationPrefixWork) (map[int]map[string][]int64, error) {
	groups := map[int]map[string][]int64{}
	if len(prefix) == 0 {
		return groups, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(prefix)), ",")
	args := membership.projectionArgs()
	for _, work := range prefix {
		args = append(args, work.id)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT work.id, `+membership.exact+` AS exact_rank, `+membership.lane+` AS lane`+membership.from+` WHERE `+membership.where+` AND work.id IN (`+placeholders+`)`, args...)
	if err != nil {
		return nil, err
	}
	matched := map[int64]struct {
		exact int
		lane  string
	}{}
	for rows.Next() {
		var id int64
		var exact int
		var lane string
		if err := rows.Scan(&id, &exact, &lane); err != nil {
			_ = rows.Close()
			return nil, err
		}
		matched[id] = struct {
			exact int
			lane  string
		}{exact, lane}
		s.recommendationDiagnostics.contextRows.Add(1)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	for _, work := range prefix {
		match, ok := matched[work.id]
		if !ok {
			continue
		}
		if groups[match.exact] == nil {
			groups[match.exact] = map[string][]int64{}
		}
		groups[match.exact][match.lane] = append(groups[match.exact][match.lane], work.id)
	}
	return groups, nil
}

type recommendationRankWindow struct {
	lane       string
	start, end int
	suppressed bool
}

// Rank windows invert the existing sparse slot schedule arithmetically. They
// do not enumerate prior pages or rank the complete matching work collection.
func recommendationRankWindows(config RecommendationConfig, counts map[string]int, offset, limit int) ([]recommendationRankWindow, int) {
	cycle, offsets := recommendationSlotOffsets(config)
	activeTotal := 0
	for lane, count := range counts {
		if len(offsets[lane]) > 0 {
			activeTotal += count
		}
	}
	if offset < activeTotal {
		limit = min(limit, activeTotal-offset)
		return recommendationPhaseWindows(cycle, offsets, counts, offset, limit, false)
	}
	return recommendationPhaseWindows(cycle, offsets, counts, offset-activeTotal, limit, true)
}

func recommendationRanksThrough(position int64, cycle int, offsets []int, count int, suppressed bool) int {
	if position <= 0 || count <= 0 {
		return 0
	}
	if suppressed {
		return min(count, int(position))
	}
	if len(offsets) == 0 {
		return 0
	}
	complete := (position - 1) / int64(cycle)
	remainder := int((position-1)%int64(cycle)) + 1
	ranks := complete * int64(len(offsets))
	for _, slot := range offsets {
		if slot <= remainder {
			ranks++
		}
	}
	return min(count, int(ranks))
}

func recommendationPhaseWindows(cycle int, offsets map[string][]int, counts map[string]int, offset, limit int, suppressed bool) ([]recommendationRankWindow, int) {
	if limit <= 0 {
		return nil, 0
	}
	countThrough := func(position int64) int {
		total := 0
		for lane, count := range counts {
			if (len(offsets[lane]) == 0) != suppressed {
				continue
			}
			total += recommendationRanksThrough(position, cycle, offsets[lane], count, suppressed)
		}
		return total
	}
	maximum := int64(1)
	for lane, count := range counts {
		if count == 0 || (len(offsets[lane]) == 0) != suppressed {
			continue
		}
		position := recommendationRankPosition(cycle, offsets[lane], count)
		if position > maximum {
			maximum = position
		}
	}
	boundary := func(target int) int64 {
		low, high := int64(1), maximum
		for low < high {
			middle := low + (high-low)/2
			if countThrough(middle) >= target {
				high = middle
			} else {
				low = middle + 1
			}
		}
		return low
	}
	low, high := boundary(offset+1), boundary(offset+limit)
	windows := []recommendationRankWindow{}
	for _, lane := range recommendationLaneNames {
		count := counts[lane]
		if count == 0 || (len(offsets[lane]) == 0) != suppressed {
			continue
		}
		start := recommendationRanksThrough(low-1, cycle, offsets[lane], count, suppressed) + 1
		end := recommendationRanksThrough(high, cycle, offsets[lane], count, suppressed)
		if end >= start {
			windows = append(windows, recommendationRankWindow{lane, start, end, suppressed})
		}
	}
	return windows, offset - countThrough(low-1)
}

func recommendationRankPosition(cycle int, offsets []int, rank int) int64 {
	if len(offsets) == 0 {
		return int64(rank)
	}
	return int64((rank-1)/len(offsets))*int64(cycle) + int64(offsets[(rank-1)%len(offsets)])
}

func (s *Store) recommendationGroupPage(ctx context.Context, snapshot RecommendationSessionSnapshot, options ListOptions, contextID string, membership recommendationMembership, prefix []recommendationPrefixWork, groups map[string][]int64, counts map[string]int, exact, offset, limit int) ([]int64, error) {
	cycle, slots := recommendationSlotOffsets(snapshot.Config)
	activeTotal := 0
	for lane, count := range counts {
		if len(slots[lane]) > 0 {
			activeTotal += count
		}
	}
	// A page can cross the active/suppressed boundary. Process each phase
	// separately, retaining the ID tie break between zero-slot lanes.
	result := []int64{}
	for len(result) < limit {
		phaseLimit := limit - len(result)
		if offset < activeTotal {
			phaseLimit = min(phaseLimit, activeTotal-offset)
		}
		windows, skip := recommendationRankWindows(snapshot.Config, counts, offset, phaseLimit)
		positioned := []recommendationPageID{}
		for _, window := range windows {
			lanePrefix := groups[window.lane]
			prefixEnd := min(window.end, len(lanePrefix))
			for rank := window.start; rank <= prefixEnd; rank++ {
				positioned = append(positioned, recommendationPageID{lanePrefix[rank-1], recommendationRankPosition(cycle, slots[window.lane], rank), window.lane})
			}
			if window.end > len(lanePrefix) {
				start := max(1, window.start-len(lanePrefix))
				end := window.end - len(lanePrefix)
				membershipRevision := strconv.Itoa(counts[window.lane]) + ":" + strconv.Itoa(len(lanePrefix))
				tail, err := s.recommendationTailWindow(ctx, options, contextID, membership, prefix, window.lane, exact, start, end, membershipRevision)
				if err != nil {
					return nil, err
				}
				for index, work := range tail {
					rank := len(lanePrefix) + start + index
					positioned = append(positioned, recommendationPageID{work.id, recommendationRankPosition(cycle, slots[window.lane], rank), window.lane})
				}
			}
		}
		sort.Slice(positioned, func(i, j int) bool {
			if positioned[i].position != positioned[j].position {
				return positioned[i].position < positioned[j].position
			}
			return positioned[i].id < positioned[j].id
		})
		if skip >= len(positioned) {
			break
		}
		for _, work := range positioned[skip:min(skip+phaseLimit, len(positioned))] {
			result = append(result, work.id)
		}
		offset += phaseLimit
		if len(positioned)-skip < phaseLimit {
			break
		}
	}
	return result, nil
}

type recommendationTailWork struct{ id, key int64 }

func recommendationTailPredicate(membership recommendationMembership, prefix []recommendationPrefixWork, lane string, exact int) (string, []any) {
	where := membership.where + " AND " + membership.lane + " = ? AND " + membership.exact + " = ?"
	args := append([]any{}, membership.whereArgs...)
	args = append(args, lane)
	args = append(args, membership.exactArgs...)
	args = append(args, exact)
	if len(prefix) > 0 {
		where += " AND work.id NOT IN (" + strings.TrimSuffix(strings.Repeat("?,", len(prefix)), ",") + ")"
		for _, work := range prefix {
			args = append(args, work.id)
		}
	}
	return where, args
}

// A ring contains two ordinary ordered index ranges; it never hashes every
// matching work or uses a temporary sort for the complete exploration tail.
func recommendationRingSegment(options ListOptions, segment int) (string, string, int64) {
	pivot := recommendationExplorePivot(options.RandomSeed)
	_, direction := normalizeSort("recommend", options.Direction)
	operator := ">="
	if direction == "DESC" {
		operator = "<="
	}
	if segment == 1 {
		if direction == "DESC" {
			operator = ">"
		} else {
			operator = "<"
		}
	}
	return "work.recommendation_explore_key " + operator + " ?", direction, pivot
}

// Mixing a nonzero input uses both seed-derived hash parameters. An offset
// alone clusters ordinary small seeds near zero and barely rotates the ring.
func recommendationExplorePivot(seed int64) int64 { return recommendationSeededHash(1, seed) }

func (s *Store) recommendationTailWindow(ctx context.Context, options ListOptions, contextID string, membership recommendationMembership, prefix []recommendationPrefixWork, lane string, exact, start, end int, membershipRevision string) ([]recommendationTailWork, error) {
	where, whereArgs := recommendationTailPredicate(membership, prefix, lane, exact)
	from := strings.Replace(membership.from, " FROM work ", " FROM work INDEXED BY idx_work_recommendation_explore ", 1)
	skip := start - 1
	segmentStart := 0
	var cursor *recommendationTailWork
	if contextID != "" && skip > 0 {
		var rank int
		var key, id int64
		err := s.db.QueryRowContext(ctx, `SELECT tail_rank, explore_key, work_id FROM recommendation_query_checkpoint WHERE context_id = ? AND lane = ? AND exact_rank = ? AND tail_rank <= ? AND membership_revision = ? ORDER BY tail_rank DESC LIMIT 1`, contextID, lane, exact, skip, membershipRevision).Scan(&rank, &key, &id)
		if err != nil && err != sql.ErrNoRows {
			return nil, err
		}
		if err == nil {
			checkpoint := recommendationTailWork{id, key}
			valid, segment, err := s.recommendationCheckpointRank(ctx, options, from, membership.fromArgs, where, whereArgs, checkpoint)
			if err != nil {
				return nil, err
			}
			if valid == rank {
				cursor = &checkpoint
				segmentStart = segment
				skip -= rank
			}
		}
	}
	result := make([]recommendationTailWork, 0, end-start+1)
	for segment := segmentStart; segment < 2 && len(result) < end-start+1; segment++ {
		ring, direction, pivot := recommendationRingSegment(options, segment)
		predicate := where + " AND " + ring
		args := append(append([]any{}, membership.fromArgs...), whereArgs...)
		args = append(args, pivot)
		if cursor != nil && segment == segmentStart {
			operator := ">"
			if direction == "DESC" {
				operator = "<"
			}
			predicate += " AND (work.recommendation_explore_key, work.id) " + operator + " (?, ?)"
			args = append(args, cursor.key, cursor.id)
		}
		query := `SELECT work.id, work.recommendation_explore_key` + from + ` WHERE ` + predicate + ` ORDER BY work.recommendation_explore_key ` + direction + `, work.id ` + direction + ` LIMIT ? OFFSET ?`
		readArgs := append(append([]any{}, args...), end-start+1-len(result), skip)
		rows, err := s.db.QueryContext(ctx, query, readArgs...)
		if err != nil {
			return nil, err
		}
		part := []recommendationTailWork{}
		for rows.Next() {
			var work recommendationTailWork
			if err := rows.Scan(&work.id, &work.key); err != nil {
				_ = rows.Close()
				return nil, err
			}
			part = append(part, work)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
		result = append(result, part...)
		s.recommendationDiagnostics.membershipRows.Add(int64(len(part)))
		if len(part) == 0 && skip > 0 {
			var count int
			if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*)`+from+` WHERE `+predicate, args...).Scan(&count); err != nil {
				return nil, err
			}
			s.recommendationDiagnostics.membershipRows.Add(int64(count))
			skip = max(0, skip-count)
		} else {
			skip = 0
		}
		cursor = nil
	}
	if contextID != "" && len(result) > 0 {
		last := result[len(result)-1]
		if err := s.saveRecommendationCheckpoint(ctx, contextID, lane, exact, start+len(result)-1, last, membershipRevision); err != nil {
			return nil, err
		}
	}
	return result, nil
}

// Counts verify that a cached cursor still names the same rank after live
// membership or filtering changes, including changes that preserve total.
func (s *Store) recommendationCheckpointRank(ctx context.Context, options ListOptions, from string, fromArgs []any, where string, whereArgs []any, checkpoint recommendationTailWork) (int, int, error) {
	_, direction, pivot := recommendationRingSegment(options, 0)
	segment := 0
	if direction == "DESC" {
		if checkpoint.key > pivot {
			segment = 1
		}
	} else if checkpoint.key < pivot {
		segment = 1
	}
	total := 0
	for part := 0; part <= segment; part++ {
		ring, _, pivot := recommendationRingSegment(options, part)
		predicate := where + " AND " + ring
		args := append(append([]any{}, fromArgs...), whereArgs...)
		args = append(args, pivot)
		if part == segment {
			operator := "<="
			if direction == "DESC" {
				operator = ">="
			}
			predicate += " AND (work.recommendation_explore_key,work.id) " + operator + " (?, ?)"
			args = append(args, checkpoint.key, checkpoint.id)
		}
		var count int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*)`+from+` WHERE `+predicate, args...).Scan(&count); err != nil {
			return 0, 0, err
		}
		total += count
		s.recommendationDiagnostics.membershipRows.Add(int64(count))
	}
	// A deleted cursor has no stable keyset continuation even if its old rank
	// happens to equal the number of surviving preceding rows.
	args := append(append([]any{}, fromArgs...), whereArgs...)
	args = append(args, checkpoint.id)
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*)`+from+` WHERE `+where+` AND work.id = ?`, args...).Scan(&exists); err != nil {
		return 0, 0, err
	}
	if exists == 0 {
		return -1, segment, nil
	}
	return total, segment, nil
}

func (s *Store) saveRecommendationCheckpoint(ctx context.Context, contextID, lane string, exact, rank int, work recommendationTailWork, revision string) error {
	return s.withRecommendationWrite(ctx, func(tx *sql.Tx) error {
		// Context eviction can happen while a page is read; an evicted context
		// does not turn an otherwise valid Library page into an error.
		if _, err := tx.ExecContext(ctx, `INSERT OR REPLACE INTO recommendation_query_checkpoint(context_id,lane,exact_rank,tail_rank,explore_key,work_id,membership_revision) SELECT ?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM recommendation_query_context WHERE id = ?)`, contextID, lane, exact, rank, work.key, work.id, revision, contextID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM recommendation_query_checkpoint WHERE context_id = ? AND rowid NOT IN (SELECT rowid FROM recommendation_query_checkpoint WHERE context_id = ? ORDER BY tail_rank DESC, lane, exact_rank LIMIT 64)`, contextID, contextID); err != nil {
			return err
		}
		return nil
	})
}
