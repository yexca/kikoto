package library

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/searchtext"
)

const (
	recommendationAffinityBudget  = 1200
	recommendationStateBudget     = 400
	recommendationRecentBudget    = 200
	recommendationExploreBudget   = 200
	recommendationCandidateBudget = 2000
	recommendationPrefixBudget    = 500
	recommendationContextBudget   = 8
)

type recommendationPrefixWork struct {
	id          int64
	rank        int
	signals     RecommendationSignals
	primaryCode string
}

var ErrInvalidRecommendationContext = errors.New("invalid recommendation context")
var ErrRecommendationContextExpired = errors.New("recommendation context expired")

type recommendationRecallPreparation struct {
	done    chan struct{}
	cancel  context.CancelFunc
	waiters int
	prefix  []recommendationPrefixWork
	err     error
}

// The opaque identifier authenticates a digest of effective ordering inputs.
// Page size and page number do not change recall or candidate ordering.
func recommendationContextID(snapshot RecommendationSessionSnapshot, options ListOptions) string {
	clauses := ParseSearchClauses(options.Query)
	for index := range clauses {
		clauses[index].Value = searchtext.Fold(strings.TrimSpace(clauses[index].Value))
	}
	sort.Slice(clauses, func(i, j int) bool {
		if clauses[i].Kind != clauses[j].Kind {
			return clauses[i].Kind < clauses[j].Kind
		}
		return clauses[i].Value < clauses[j].Value
	})
	scope := options.Scope
	switch scope {
	case "local", "tracked", "remote", "no_source":
	default:
		scope = "all"
	}
	status := options.Status
	if status == "" || status == "all" {
		status = "all"
	}
	_, direction := normalizeSort("recommend", options.Direction)
	raw, _ := json.Marshal(struct {
		Generation               int64
		Scope, Status, Direction string
		Clauses                  []SearchClause
		Seed                     int64
		Demo                     bool
	}{snapshot.GenerationID, scope, status, direction, clauses, options.RandomSeed, options.DemoOnly})
	digest := sha256.Sum256(raw)
	identifier := append([]byte{}, digest[:16]...)
	identifier = append(identifier, recommendationContextAuthenticator(snapshot, identifier)...)
	return hex.EncodeToString(identifier)
}

func recommendationContextAuthenticator(snapshot RecommendationSessionSnapshot, digest []byte) []byte {
	mac := hmac.New(sha256.New, []byte(snapshot.contextSigningKey))
	_, _ = fmt.Fprintf(mac, "recommendation-context-v1:%d:%d:", snapshot.UserID, snapshot.GenerationID)
	_, _ = mac.Write(digest)
	return mac.Sum(nil)[:16]
}

func validRecommendationContextToken(snapshot RecommendationSessionSnapshot, id string) bool {
	if snapshot.GenerationID <= 0 || snapshot.UserID <= 0 || len(snapshot.contextSigningKey) != 64 || len(id) != 64 {
		return false
	}
	decoded, err := hex.DecodeString(id)
	if err != nil {
		return false
	}
	return hmac.Equal(decoded[16:], recommendationContextAuthenticator(snapshot, decoded[:16]))
}

func (s *Store) recommendationContext(ctx context.Context, snapshot RecommendationSessionSnapshot, options ListOptions) (string, []recommendationPrefixWork, error) {
	if snapshot.GenerationID <= 0 {
		return "", nil, nil
	}
	id := recommendationContextID(snapshot, options)
	prefix, exists, err := s.loadRecommendationPrefix(ctx, id, snapshot.GenerationID)
	if err != nil || exists {
		return id, prefix, err
	}
	select {
	case s.recommendationQueue <- struct{}{}:
		defer func() { <-s.recommendationQueue }()
	default:
		return "", nil, ErrRecommendationBusy
	}
	s.recommendationMu.Lock()
	call := s.recommendationContextFlights[id]
	if call == nil {
		taskCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		call = &recommendationRecallPreparation{done: make(chan struct{}), cancel: cancel}
		s.recommendationContextFlights[id] = call
		go func() {
			call.prefix, call.err = s.prepareRecommendationContext(taskCtx, id, snapshot, options)
			s.recommendationMu.Lock()
			if s.recommendationContextFlights[id] == call {
				delete(s.recommendationContextFlights, id)
			}
			close(call.done)
			s.recommendationMu.Unlock()
			cancel()
		}()
	}
	call.waiters++
	s.recommendationMu.Unlock()
	defer func() {
		s.recommendationMu.Lock()
		call.waiters--
		if call.waiters == 0 {
			if s.recommendationContextFlights[id] == call {
				delete(s.recommendationContextFlights, id)
			}
			call.cancel()
		}
		s.recommendationMu.Unlock()
	}()
	select {
	case <-ctx.Done():
		return "", nil, ctx.Err()
	case <-call.done:
		return id, call.prefix, call.err
	}
}

func (s *Store) prepareRecommendationContext(ctx context.Context, id string, snapshot RecommendationSessionSnapshot, options ListOptions) ([]recommendationPrefixWork, error) {
	// Preparation waits without a borrowed SQLite connection. Duplicate cold
	// preparations produce the same prefix; only the first publishes it.
	select {
	case s.recommendationCPU <- struct{}{}:
		defer func() { <-s.recommendationCPU }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	prefix, exists, err := s.loadRecommendationPrefix(ctx, id, snapshot.GenerationID)
	if err != nil || exists {
		return prefix, err
	}
	profile, err := s.loadFrozenRecommendationProfile(ctx, snapshot)
	if err != nil {
		return nil, err
	}
	ids, err := s.recallRecommendationWorks(ctx, snapshot, profile, options)
	if err != nil {
		return nil, err
	}
	codes, err := s.recommendationWorkCodes(ctx, ids)
	if err != nil {
		return nil, err
	}
	features, err := s.loadRecommendationFeatures(ctx, snapshot.CatalogEpoch, ids)
	if err != nil {
		return nil, err
	}
	scores := make(map[int64]RecommendationBreakdown, len(ids))
	s.recommendationDiagnostics.scoredWorks.Add(int64(len(ids)))
	for _, workID := range ids {
		state := profile.States[workID]
		if _, exists := features[workID]; !exists {
			state = recommendationFrozenState{ListeningStatus: "none"}
		}
		scores[workID] = buildRecommendationBreakdown(snapshot.Config, profile.workSignals(features[workID], state, snapshot.Config))
	}
	ordered := append([]int64(nil), ids...)
	// The creator repetition adjustment has the same 0–8 intent as the
	// heuristic score, evaluated only inside this finite candidate pool.
	sort.Slice(ordered, func(i, j int) bool {
		if scores[ordered[i]].Score != scores[ordered[j]].Score {
			return scores[ordered[i]].Score > scores[ordered[j]].Score
		}
		return ordered[i] < ordered[j]
	})
	seen := map[string]int{}
	for _, workID := range ordered {
		group := recommendationCreatorGroup(features[workID], workID)
		breakdown := scores[workID]
		key := breakdown.Lane + ":" + group
		breakdown.Signals.DiversityPenalty = min(8, seen[key]*2)
		seen[key]++
		scores[workID] = breakdown
	}
	_, direction := normalizeSort("recommend", options.Direction)
	sort.Slice(ordered, func(i, j int) bool {
		left, right := scores[ordered[i]], scores[ordered[j]]
		a := RecommendationOrderingFor(ordered[i], left.Score, options.RandomSeed, snapshot.Config, left.Signals.DiversityPenalty)
		b := RecommendationOrderingFor(ordered[j], right.Score, options.RandomSeed, snapshot.Config, right.Signals.DiversityPenalty)
		if a.RankingScore != b.RankingScore {
			if direction == "ASC" {
				return a.RankingScore < b.RankingScore
			}
			return a.RankingScore > b.RankingScore
		}
		ha, hb := recommendationSeededHash(ordered[i], options.RandomSeed), recommendationSeededHash(ordered[j], options.RandomSeed)
		if ha != hb {
			return ha < hb
		}
		return ordered[i] < ordered[j]
	})
	prefix = make([]recommendationPrefixWork, min(len(ordered), recommendationPrefixBudget))
	encoded := make([]string, len(prefix))
	for index := range prefix {
		workID := ordered[index]
		prefix[index] = recommendationPrefixWork{id: workID, rank: index + 1, signals: scores[workID].Signals, primaryCode: codes[workID]}
		raw, err := json.Marshal(scores[workID].Signals)
		if err != nil {
			return nil, err
		}
		encoded[index] = string(raw)
	}
	writeStarted := time.Now()
	select {
	case s.recommendationWrite <- struct{}{}:
		defer func() { <-s.recommendationWrite }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	s.recommendationDiagnostics.writerWait.Add(time.Since(writeStarted).Nanoseconds())
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var changesBefore, changesAfter int64
	if err := tx.QueryRowContext(ctx, "SELECT total_changes()").Scan(&changesBefore); err != nil {
		return nil, err
	}
	result, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO recommendation_query_context(id, generation_id, seed, direction, candidate_count) VALUES (?, ?, ?, ?, ?)`, id, snapshot.GenerationID, options.RandomSeed, direction, len(ids))
	if err != nil {
		return nil, err
	}
	inserted, err := result.RowsAffected()
	if err != nil {
		return nil, err
	}
	if inserted > 0 {
		statement, err := tx.PrepareContext(ctx, `INSERT INTO recommendation_query_candidate(context_id, work_id, rank, signals_json,primary_code) SELECT ?,?,?,?,work.primary_code FROM work WHERE work.id=? AND work.primary_code=?`)
		if err != nil {
			return nil, err
		}
		for index, work := range prefix {
			if _, err := statement.ExecContext(ctx, id, work.id, work.rank, encoded[index], work.id, work.primaryCode); err != nil {
				_ = statement.Close()
				return nil, err
			}
		}
		if err := statement.Close(); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM recommendation_query_context WHERE generation_id = ? AND id NOT IN (SELECT id FROM recommendation_query_context WHERE generation_id = ? ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT ?)`, snapshot.GenerationID, snapshot.GenerationID, id, recommendationContextBudget); err != nil {
			return nil, err
		}
	} else {
		// Independent Store instances share the same first-writer binding.
		// Returning a losing preparation could disagree with later explanations.
		prefix, _, err = s.loadRecommendationPrefixWithQueryer(ctx, tx, id, snapshot.GenerationID)
		if err != nil {
			return nil, err
		}
	}
	if err := tx.QueryRowContext(ctx, "SELECT total_changes()").Scan(&changesAfter); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	s.recommendationDiagnostics.writtenRows.Add(changesAfter - changesBefore)
	return prefix, nil
}

func recommendationCreatorGroup(features []recommendationFeature, workID int64) string {
	for _, kind := range []string{"circle", "voice"} {
		var chosen int64
		for _, feature := range features {
			if feature.Kind == kind && (chosen == 0 || feature.ID < chosen) {
				chosen = feature.ID
			}
		}
		if chosen != 0 {
			return kind + ":" + strconv.FormatInt(chosen, 10)
		}
	}
	return "work:" + strconv.FormatInt(workID, 10)
}

func (s *Store) loadRecommendationPrefix(ctx context.Context, id string, generationID int64) ([]recommendationPrefixWork, bool, error) {
	return s.loadRecommendationPrefixWithQueryer(ctx, s.db, id, generationID)
}

func (s *Store) loadRecommendationPrefixWithQueryer(ctx context.Context, queryer recommendationProfileQueryer, id string, generationID int64) ([]recommendationPrefixWork, bool, error) {
	// Context existence and its prefix share one SQLite read snapshot. A
	// concurrent eviction cannot turn an existing prefix into an empty hit.
	rows, err := queryer.QueryContext(ctx, `SELECT candidate.work_id,candidate.rank,candidate.signals_json,candidate.primary_code
		FROM recommendation_query_context AS context LEFT JOIN recommendation_query_candidate AS candidate
		ON candidate.context_id=context.id AND EXISTS(SELECT 1 FROM work WHERE work.id=candidate.work_id AND work.primary_code=candidate.primary_code)
		WHERE context.id=? AND context.generation_id=? ORDER BY candidate.rank`, id, generationID)
	if err != nil {
		return nil, false, err
	}
	defer func() { _ = rows.Close() }()
	prefix := []recommendationPrefixWork{}
	exists := false
	for rows.Next() {
		var work recommendationPrefixWork
		var workID, rank sql.NullInt64
		var raw, code sql.NullString
		if err := rows.Scan(&workID, &rank, &raw, &code); err != nil {
			return nil, false, err
		}
		exists = true
		if !workID.Valid {
			continue
		}
		work.id, work.rank, work.primaryCode = workID.Int64, int(rank.Int64), code.String
		if err := json.Unmarshal([]byte(raw.String), &work.signals); err != nil {
			return nil, false, err
		}
		prefix = append(prefix, work)
	}
	s.recommendationDiagnostics.contextRows.Add(int64(len(prefix)))
	return prefix, exists, rows.Err()
}

func (s *Store) recommendationWorkCodes(ctx context.Context, ids []int64) (map[int64]string, error) {
	codes := make(map[int64]string, len(ids))
	for start := 0; start < len(ids); start += 256 {
		batch := ids[start:min(start+256, len(ids))]
		args := make([]any, len(batch))
		for index, id := range batch {
			args[index] = id
		}
		rows, err := s.db.QueryContext(ctx, `SELECT id,primary_code FROM work WHERE id IN (`+strings.TrimSuffix(strings.Repeat("?,", len(batch)), ",")+`)`, args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var id int64
			var code string
			if err := rows.Scan(&id, &code); err != nil {
				_ = rows.Close()
				return nil, err
			}
			codes[id] = code
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if err := rows.Close(); err != nil {
			return nil, err
		}
	}
	return codes, nil
}

type recommendationRecallEntity struct {
	kind         string
	id           int64
	contribution float64
}

func (s *Store) recallRecommendationWorks(ctx context.Context, snapshot RecommendationSessionSnapshot, profile RecommendationProfile, options ListOptions) ([]int64, error) {
	where, filterArgs := listWhere(options.Scope, options.Status, options.Query, options.UserID, options.DemoOnly)
	seen := map[int64]bool{}
	ids := make([]int64, 0, recommendationCandidateBudget)
	add := func(found []int64, budget int) int {
		added := 0
		for _, id := range found {
			if !seen[id] && added < budget && len(ids) < recommendationCandidateBudget {
				seen[id] = true
				ids = append(ids, id)
				added++
			}
		}
		return added
	}
	// Materializing the indexed probe before applying arbitrary browse filters
	// bounds popular-entity work. Filters never trigger an unbounded refill.
	probe := func(source string, sourceArgs []any) ([]int64, error) {
		query := `WITH recall_probe AS MATERIALIZED (` + source + `) SELECT work.id FROM recall_probe JOIN work ON work.id = recall_probe.work_id LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE ` + where + ` ORDER BY work.id`
		args := append(append([]any{}, sourceArgs...), options.UserID)
		args = append(args, filterArgs...)
		rows, err := s.db.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		defer func() { _ = rows.Close() }()
		found := []int64{}
		for rows.Next() {
			var id int64
			if err := rows.Scan(&id); err != nil {
				return nil, err
			}
			found = append(found, id)
		}
		s.recommendationDiagnostics.recallRows.Add(int64(len(found)))
		return found, rows.Err()
	}
	entities := []recommendationRecallEntity{}
	_, direction := normalizeSort("recommend", options.Direction)
	for key, entity := range profile.Entities {
		kind, rawID, ok := strings.Cut(key, ":")
		if !ok {
			continue
		}
		id, err := strconv.ParseInt(rawID, 10, 64)
		if err != nil {
			continue
		}
		weight, negative := snapshot.Config.TagWeight, snapshot.Config.NegativeTagWeight
		switch kind {
		case "voice":
			weight, negative = snapshot.Config.VoiceWeight, snapshot.Config.NegativeVoiceWeight
		case "circle":
			weight, negative = snapshot.Config.CircleWeight, snapshot.Config.NegativeCircleWeight
		}
		contribution := 0.0
		if entity.Positive > 0 {
			contribution = float64(weight) * recommendationEvidenceStrength(entity.Positive) * entity.Specificity
		} else if entity.Paused >= snapshot.Config.NegativeMinEvidence {
			contribution = -float64(negative)
		}
		if contribution != 0 {
			entities = append(entities, recommendationRecallEntity{kind, id, contribution})
		}
	}
	sort.Slice(entities, func(i, j int) bool {
		if entities[i].contribution != entities[j].contribution {
			if direction == "ASC" {
				return entities[i].contribution < entities[j].contribution
			}
			return entities[i].contribution > entities[j].contribution
		}
		if entities[i].kind != entities[j].kind {
			return entities[i].kind < entities[j].kind
		}
		return entities[i].id < entities[j].id
	})
	entities = entities[:min(len(entities), 24)]
	pivot := recommendationExplorePivot(options.RandomSeed)
	affinityRemaining := recommendationAffinityBudget
	for _, entity := range entities {
		if affinityRemaining <= 0 {
			break
		}
		perEntity := min(200, (recommendationAffinityBudget+len(entities)-1)/len(entities))
		found := []int64{}
		for segment := 0; segment < 2 && len(found) < perEntity; segment++ {
			operator := ">="
			if segment == 1 {
				operator = "<"
			}
			for attempt := 0; attempt < 2 && len(found) < perEntity; attempt++ {
				part, err := probe(`WITH entity_probe AS MATERIALIZED (SELECT work_id,valid_from,valid_to FROM recommendation_catalog_entity INDEXED BY idx_recommendation_catalog_entity_recall WHERE kind = ? AND entity_id = ? AND explore_key `+operator+` ? ORDER BY explore_key, work_id LIMIT ? OFFSET ?) SELECT work_id FROM entity_probe WHERE valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)`, []any{entity.kind, entity.id, pivot, perEntity * 2, attempt * perEntity * 2, snapshot.CatalogEpoch, snapshot.CatalogEpoch})
				if err != nil {
					return nil, err
				}
				found = append(found, part...)
				if len(part) == 0 {
					break
				}
			}
		}
		affinityRemaining -= add(found, min(perEntity, affinityRemaining))
	}
	found, err := probe(`SELECT work_id FROM recommendation_generation_state WHERE generation_id = ? ORDER BY work_id LIMIT ?`, []any{snapshot.GenerationID, recommendationStateBudget * 4})
	if err != nil {
		return nil, err
	}
	add(found, recommendationStateBudget)
	found, err = probe(`SELECT id AS work_id FROM work INDEXED BY idx_work_created_at ORDER BY created_at DESC, id DESC LIMIT ?`, []any{recommendationRecentBudget * 4})
	if err != nil {
		return nil, err
	}
	add(found, recommendationRecentBudget)
	exploreRemaining := recommendationExploreBudget
	for segment := 0; segment < 2 && exploreRemaining > 0; segment++ {
		operator := ">="
		if segment == 1 {
			operator = "<"
		}
		found, err = probe(`SELECT id AS work_id FROM work INDEXED BY idx_work_recommendation_explore WHERE recommendation_explore_key `+operator+` ? ORDER BY recommendation_explore_key, id LIMIT ?`, []any{pivot, recommendationExploreBudget * 4})
		if err != nil {
			return nil, err
		}
		exploreRemaining -= add(found, exploreRemaining)
	}
	// Rare filters can miss every bounded raw probe. Reading membership of a
	// demonstrably small matching set is allowed, but never escalates into
	// personal scoring of the complete catalog or exceeds the explore budget.
	if exploreRemaining > 0 && (options.Query != "" || options.Scope != "" && options.Scope != "all" || options.Status != "" && options.Status != "all" || options.DemoOnly) {
		args := append([]any{options.UserID}, filterArgs...)
		var matched int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id=work.id AND user_work_state.user_id=? WHERE `+where, args...).Scan(&matched); err != nil {
			return nil, err
		}
		s.recommendationDiagnostics.membershipRows.Add(int64(matched))
		if matched <= recommendationCandidateBudget {
			rows, err := s.db.QueryContext(ctx, `SELECT work.id FROM work LEFT JOIN user_work_state ON user_work_state.work_id=work.id AND user_work_state.user_id=? WHERE `+where+` ORDER BY work.id LIMIT ?`, append(args, recommendationCandidateBudget)...)
			if err != nil {
				return nil, err
			}
			found := []int64{}
			for rows.Next() {
				var id int64
				if err := rows.Scan(&id); err != nil {
					_ = rows.Close()
					return nil, err
				}
				found = append(found, id)
			}
			if err := rows.Err(); err != nil {
				_ = rows.Close()
				return nil, err
			}
			if err := rows.Close(); err != nil {
				return nil, err
			}
			s.recommendationDiagnostics.recallRows.Add(int64(len(found)))
			add(found, exploreRemaining)
		}
	}
	return ids, nil
}

// RecommendationContextBreakdown validates the user/generation boundary even
// when a requested work is outside the finite prefix. Such a work retains its
// true affinity and carries no invented creator penalty or ordering position.
func (s *Store) RecommendationContextBreakdown(ctx context.Context, userID int64, snapshot RecommendationSessionSnapshot, contextID string, workID int64) (RecommendationBreakdown, error) {
	if snapshot.UserID != userID || userID <= 0 {
		return RecommendationBreakdown{}, ErrInvalidRecommendationContext
	}
	var generation, owner int64
	var seed int64
	if err := s.db.QueryRowContext(ctx, `SELECT context.generation_id, generation.user_id, context.seed FROM recommendation_query_context AS context JOIN recommendation_generation AS generation ON generation.id = context.generation_id WHERE context.id = ?`, contextID).Scan(&generation, &owner, &seed); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			if validRecommendationContextToken(snapshot, contextID) {
				return RecommendationBreakdown{}, ErrRecommendationContextExpired
			}
			return RecommendationBreakdown{}, ErrInvalidRecommendationContext
		}
		return RecommendationBreakdown{}, err
	}
	if owner != userID || snapshot.UserID != userID || generation != snapshot.GenerationID {
		return RecommendationBreakdown{}, ErrInvalidRecommendationContext
	}
	var exists int
	if err := s.db.QueryRowContext(ctx, `SELECT 1 FROM work WHERE id=?`, workID).Scan(&exists); err != nil {
		return RecommendationBreakdown{}, err
	}
	var raw string
	err := s.db.QueryRowContext(ctx, `SELECT candidate.signals_json FROM recommendation_query_candidate AS candidate JOIN work ON work.id=candidate.work_id AND work.primary_code=candidate.primary_code WHERE candidate.context_id = ? AND candidate.work_id = ?`, contextID, workID).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		breakdowns, err := s.scoreRecommendationWorks(ctx, snapshot, []int64{workID})
		return breakdowns[workID], err
	}
	if err != nil {
		return RecommendationBreakdown{}, err
	}
	var signals RecommendationSignals
	if err := json.Unmarshal([]byte(raw), &signals); err != nil {
		return RecommendationBreakdown{}, err
	}
	breakdown := buildRecommendationBreakdown(snapshot.Config, signals)
	ordering := RecommendationOrderingFor(workID, breakdown.Score, seed, snapshot.Config, signals.DiversityPenalty)
	breakdown.Ordering = &ordering
	return breakdown, nil
}
