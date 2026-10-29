package library

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"errors"
	"math"
	mathrand "math/rand/v2"
	"strings"
	"time"
)

type ForYouRequest struct {
	UserID      int64
	Temperature ForYouTemperature
	Columns     []ForYouColumn
	// Exclude holds works another column shows, which this draw leaves out.
	Exclude []int64
	// Seed fixes the draw for tests; 0 draws a fresh seed.
	Seed int64
	Now  time.Time
}

type ForYouPick struct {
	WorkID int64        `json:"workId"`
	Score  int          `json:"score"`
	Reason ForYouReason `json:"reason"`
}

type ForYouColumnDraw struct {
	Column ForYouColumn `json:"column"`
	Picks  []ForYouPick `json:"picks"`
	// ColdStart marks a draw made without any feedback in the profile.
	ColdStart bool `json:"coldStart"`
}

type ForYouDraw struct {
	Temperature ForYouTemperature  `json:"temperature"`
	Seed        int64              `json:"seed"`
	Columns     []ForYouColumnDraw `json:"columns"`
}

const (
	// History beyond this many works, most recent first, does not widen the
	// Listen again pool or the heard profile Try new measures against.
	forYouHistoryBudget     = 1000
	forYouRotationWindowSQL = "datetime('now', '-3 days')"
)

// DrawForYou draws the requested columns from the latest preference profile.
// Candidates come from the Library's bounded recommendation recall over local
// works plus the account's recent history; nothing outside the library is
// read or created. Every shown work is recorded as a For you impression.
func (s *Store) DrawForYou(ctx context.Context, request ForYouRequest) (ForYouDraw, error) {
	if request.UserID <= 0 {
		return ForYouDraw{}, errors.New("for you requires an account")
	}
	if _, ok := ParseForYouTemperature(string(request.Temperature)); !ok {
		request.Temperature = DefaultForYouTemperature
	}
	if request.Now.IsZero() {
		request.Now = time.Now()
	}
	if request.Seed == 0 {
		var raw [8]byte
		if _, err := rand.Read(raw[:]); err != nil {
			return ForYouDraw{}, err
		}
		request.Seed = int64(binary.LittleEndian.Uint64(raw[:]) &^ (1 << 63))
	}
	// An empty session id binds the generation of the current inputs, so a
	// draw always reads the latest marks and ratings.
	snapshot, err := s.snapshotForRecommendation(ctx, request.UserID, "")
	if err != nil {
		return ForYouDraw{}, err
	}
	profile, err := s.loadFrozenRecommendationProfile(ctx, snapshot)
	if err != nil {
		return ForYouDraw{}, err
	}
	recalled, err := s.recallRecommendationWorks(ctx, snapshot, profile, ListOptions{
		UserID: request.UserID, Scope: "local", Status: "all", Sort: "recommend", RandomSeed: request.Seed,
	})
	if err != nil {
		return ForYouDraw{}, err
	}
	heard, err := s.forYouHeardWorks(ctx, request.UserID)
	if err != nil {
		return ForYouDraw{}, err
	}
	localHeard, err := s.forYouLocalWorks(ctx, request.UserID, heard)
	if err != nil {
		return ForYouDraw{}, err
	}
	candidates, err := s.loadForYouCandidates(ctx, request.UserID, snapshot.CatalogEpoch, uniqueInt64s(append(recalled, localHeard...)))
	if err != nil {
		return ForYouDraw{}, err
	}
	// A work marked as listened to counts as heard even without playback here.
	familiar := append([]int64{}, heard...)
	for id, state := range profile.States {
		if state.ListeningStatus != "none" && state.ListeningStatus != "want_to_listen" || state.Rating > 0 {
			familiar = append(familiar, id)
		}
	}
	exposure, err := s.forYouExposure(ctx, snapshot.CatalogEpoch, uniqueInt64s(familiar))
	if err != nil {
		return ForYouDraw{}, err
	}
	coldStart := len(profile.Entities) == 0
	settings := request.Temperature.settings()
	pools := map[ForYouColumn][]forYouScored{}
	for _, candidate := range candidates {
		if scored, ok := forYouMaybeLike(candidate, profile, snapshot.Config, coldStart); ok {
			pools[ForYouMaybeLike] = append(pools[ForYouMaybeLike], scored)
		}
		if scored, ok := forYouTryNew(candidate, profile, snapshot.Config, exposure, settings); ok {
			pools[ForYouTryNew] = append(pools[ForYouTryNew], scored)
		}
		if scored, ok := forYouListenAgain(candidate, request.Now, settings); ok {
			pools[ForYouListenAgain] = append(pools[ForYouListenAgain], scored)
		}
	}
	columns := request.Columns
	if len(columns) == 0 {
		columns = ForYouColumns
	}
	exclude := map[int64]bool{}
	for _, id := range request.Exclude {
		exclude[id] = true
	}
	rng := mathrand.New(mathrand.NewPCG(uint64(request.Seed), 0x666f72796f75))
	drawn := forYouAssemble(pools, columns, exclude, settings, rng)
	if err := s.nameForYouReasons(ctx, drawn); err != nil {
		return ForYouDraw{}, err
	}
	result := ForYouDraw{Temperature: request.Temperature, Seed: request.Seed}
	for _, column := range columns {
		draw := ForYouColumnDraw{Column: column, Picks: []ForYouPick{}, ColdStart: coldStart}
		for _, item := range drawn[column] {
			draw.Picks = append(draw.Picks, ForYouPick{
				WorkID: item.candidate.WorkID,
				Score:  int(math.Round(min(100, max(0, item.score)))),
				Reason: item.reason,
			})
		}
		result.Columns = append(result.Columns, draw)
	}
	return result, s.recordForYouImpressions(ctx, request.UserID, result)
}

// forYouHeardWorks lists the works the account has playback history for,
// most recently played first: a playback cursor, listening days, or an
// imported listening total.
func (s *Store) forYouHeardWorks(ctx context.Context, userID int64) ([]int64, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT work_id FROM (
		SELECT work_id, last_played_at AS played FROM user_work_playback_cursor WHERE user_id = ? AND last_played_at IS NOT NULL
		UNION ALL SELECT work_id, MAX(day) FROM user_listening_day WHERE user_id = ? AND listened_seconds > 0 GROUP BY work_id
		UNION ALL SELECT work_id, COALESCE(last_played_at, '') FROM user_listening_import WHERE user_id = ? AND listened_seconds > 0
	) GROUP BY work_id ORDER BY MAX(played) DESC, work_id LIMIT ?`, userID, userID, userID, forYouHistoryBudget)
	if err != nil {
		return nil, err
	}
	return scanInt64Rows(rows)
}

// forYouLocalWorks keeps the visible local works among ids.
func (s *Store) forYouLocalWorks(ctx context.Context, userID int64, ids []int64) ([]int64, error) {
	result := []int64{}
	where, args := listWhere("local", "all", "", userID, false)
	for start := 0; start < len(ids); start += 500 {
		batch := ids[start:min(start+500, len(ids))]
		query, batchArgs := int64InQuery(`SELECT work.id FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE work.id IN (%s) AND `+where, batch)
		rows, err := s.db.QueryContext(ctx, query, append(append([]any{userID}, batchArgs...), args...)...)
		if err != nil {
			return nil, err
		}
		found, err := scanInt64Rows(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, found...)
	}
	return result, nil
}

// forYouExposure counts, for each feature, the heard works that carry it.
func (s *Store) forYouExposure(ctx context.Context, epoch int64, heard []int64) (map[string]int, error) {
	features, err := s.loadRecommendationFeatures(ctx, epoch, heard)
	if err != nil {
		return nil, err
	}
	exposure := map[string]int{}
	for _, workFeatures := range features {
		for _, f := range workFeatures {
			exposure[f.key()]++
		}
	}
	return exposure, nil
}

func (s *Store) loadForYouCandidates(ctx context.Context, userID, epoch int64, ids []int64) ([]*forYouCandidate, error) {
	candidates := make(map[int64]*forYouCandidate, len(ids))
	ordered := make([]*forYouCandidate, 0, len(ids))
	for _, id := range ids {
		candidate := &forYouCandidate{WorkID: id, State: recommendationFrozenState{ListeningStatus: "none"}}
		candidates[id] = candidate
		ordered = append(ordered, candidate)
	}
	features, err := s.loadRecommendationFeatures(ctx, epoch, ids)
	if err != nil {
		return nil, err
	}
	for id, workFeatures := range features {
		candidates[id].Features = workFeatures
	}
	progress := map[int64]Progress{}
	for start := 0; start < len(ids); start += 500 {
		batch := ids[start:min(start+500, len(ids))]
		found, err := s.LoadProgress(ctx, userID, batch)
		if err != nil {
			return nil, err
		}
		for id, item := range found {
			progress[id] = item
		}
	}
	for id, item := range progress {
		history := &candidates[id].History
		history.Completed = item.Completed
		if item.LastPlayedAt != nil {
			history.LastPlayed = laterForYouTime(history.LastPlayed, *item.LastPlayedAt)
		}
	}
	for start := 0; start < len(ids); start += 500 {
		batch := ids[start:min(start+500, len(ids))]
		if err := s.loadForYouBatch(ctx, userID, batch, candidates); err != nil {
			return nil, err
		}
	}
	if err := s.loadForYouRotation(ctx, userID, candidates); err != nil {
		return nil, err
	}
	return ordered, nil
}

// loadForYouBatch reads the live personal state, listening totals, and DLsite
// rating and sales of one batch of candidates.
func (s *Store) loadForYouBatch(ctx context.Context, userID int64, ids []int64, candidates map[int64]*forYouCandidate) error {
	query, args := int64InQuery(`SELECT work.id, COALESCE(work.rating_average, 0), COALESCE(work.sales_count, 0),
		COALESCE(state.listening_status, 'none'), COALESCE(state.favorite, 0), COALESCE(state.rating, 0), COALESCE(state.last_played_at, '')
		FROM work LEFT JOIN user_work_state AS state ON state.work_id = work.id AND state.user_id = ?
		WHERE work.id IN (%s)`, ids)
	rows, err := s.db.QueryContext(ctx, query, append([]any{userID}, args...)...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var rating float64
		var sales int
		var state recommendationFrozenState
		var lastPlayed string
		if err := rows.Scan(&id, &rating, &sales, &state.ListeningStatus, &state.Favorite, &state.Rating, &lastPlayed); err != nil {
			_ = rows.Close()
			return err
		}
		if state.Rating < 1 || state.Rating > 5 {
			state.Rating = 0
		}
		candidate := candidates[id]
		candidate.State, candidate.RatingAverage, candidate.Sales = state, rating, sales
		candidate.History.LastPlayed = laterForYouTime(candidate.History.LastPlayed, lastPlayed)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	query, args = int64InQuery(`SELECT work_id, SUM(seconds), SUM(days), MAX(played) FROM (
		SELECT work_id, listened_seconds AS seconds, 1 AS days, day AS played FROM user_listening_day WHERE user_id = ? AND listened_seconds > 0 AND work_id IN (%[1]s)
		UNION ALL SELECT work_id, listened_seconds, listen_count, COALESCE(last_played_at, '') FROM user_listening_import WHERE user_id = ? AND work_id IN (%[1]s)
	) GROUP BY work_id`, ids)
	rows, err = s.db.QueryContext(ctx, query, append(append(append([]any{userID}, args...), userID), args...)...)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var seconds float64
		var days int
		var played string
		if err := rows.Scan(&id, &seconds, &days, &played); err != nil {
			return err
		}
		history := &candidates[id].History
		history.ListenedSeconds, history.ListenDays = seconds, days
		history.LastPlayed = laterForYouTime(history.LastPlayed, played)
	}
	return rows.Err()
}

// loadForYouRotation counts each candidate's For you impressions of the last
// three days that no open or play followed.
func (s *Store) loadForYouRotation(ctx context.Context, userID int64, candidates map[int64]*forYouCandidate) error {
	rows, err := s.db.QueryContext(ctx, `SELECT work_id, event_type, created_at FROM recommendation_event
		WHERE user_id = ? AND surface = 'for_you' AND work_id IS NOT NULL AND created_at >= `+forYouRotationWindowSQL+`
		ORDER BY created_at, id LIMIT 5000`, userID)
	if err != nil {
		return err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var eventType, createdAt string
		if err := rows.Scan(&id, &eventType, &createdAt); err != nil {
			return err
		}
		candidate := candidates[id]
		if candidate == nil {
			continue
		}
		switch eventType {
		case "impression":
			if shown, ok := parseForYouTime(createdAt); !ok || !candidate.History.LastPlayed.After(shown) {
				candidate.Unopened++
			}
		case "open", "play":
			candidate.Unopened = 0
		}
	}
	return rows.Err()
}

// nameForYouReasons fills in the display name of each reason's feature.
func (s *Store) nameForYouReasons(ctx context.Context, drawn map[ForYouColumn][]forYouScored) error {
	ids := map[string][]int64{}
	for _, items := range drawn {
		for _, item := range items {
			if f := item.reason.feature; f != nil {
				ids[f.Kind] = append(ids[f.Kind], f.ID)
			}
		}
	}
	queries := map[string]string{
		"tag":    `SELECT id, display_name FROM tag WHERE id IN (%s)`,
		"voice":  `SELECT id, display_name FROM person WHERE id IN (%s)`,
		"circle": `SELECT id, COALESCE(NULLIF(manual_name, ''), display_name) FROM party WHERE id IN (%s)`,
	}
	names := map[string]string{}
	for kind, kindIDs := range ids {
		query, args := int64InQuery(queries[kind], kindIDs)
		rows, err := s.db.QueryContext(ctx, query, args...)
		if err != nil {
			return err
		}
		for rows.Next() {
			var id int64
			var name string
			if err := rows.Scan(&id, &name); err != nil {
				_ = rows.Close()
				return err
			}
			names[recommendationFeature{Kind: kind, ID: id}.key()] = name
		}
		if err := rows.Close(); err != nil {
			return err
		}
	}
	for _, items := range drawn {
		for index := range items {
			if f := items[index].reason.feature; f != nil {
				items[index].reason.Name = names[f.key()]
			}
		}
	}
	return nil
}

func (s *Store) recordForYouImpressions(ctx context.Context, userID int64, draw ForYouDraw) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	statement, err := tx.PrepareContext(ctx, `INSERT INTO recommendation_event (user_id, work_id, event_type, context_id, algorithm_version, seed, rank, score, surface)
		VALUES (?, ?, 'impression', ?, ?, ?, ?, ?, 'for_you')`)
	if err != nil {
		return err
	}
	defer func() { _ = statement.Close() }()
	for _, column := range draw.Columns {
		for rank, pick := range column.Picks {
			if _, err := statement.ExecContext(ctx, userID, pick.WorkID, string(column.Column), ForYouAlgorithmVersion, draw.Seed, rank+1, pick.Score); err != nil {
				return err
			}
		}
	}
	return tx.Commit()
}

func scanInt64Rows(rows *sql.Rows) ([]int64, error) {
	defer func() { _ = rows.Close() }()
	result := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		result = append(result, id)
	}
	return result, rows.Err()
}

// parseForYouTime reads a stored time: RFC 3339, SQLite's CURRENT_TIMESTAMP in
// UTC, or a listening day.
func parseForYouTime(value string) (time.Time, bool) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02 15:04:05", "2006-01-02T15:04:05", "2006-01-02"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, true
		}
	}
	return time.Time{}, false
}

func laterForYouTime(current time.Time, value string) time.Time {
	if parsed, ok := parseForYouTime(value); ok && parsed.After(current) {
		return parsed
	}
	return current
}
