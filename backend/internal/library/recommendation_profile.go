package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/searchtext"
)

// This SQL is an experimental v5 baseline, never a request-time projection.
const recommendationEntitiesSQL = `SELECT 'tag' AS kind, work_tag.work_id, work_tag.tag_id AS entity_id
 FROM work_tag JOIN tag ON tag.id = work_tag.tag_id WHERE tag.namespace IN ('dlsite', 'metadata')
 GROUP BY work_tag.work_id, work_tag.tag_id
 UNION ALL SELECT 'voice', work_id, person_id FROM work_credit WHERE role = 'voice_actor' GROUP BY work_id, person_id
 UNION ALL SELECT 'circle', work_id, party_id FROM work_party WHERE role = 'circle' GROUP BY work_id, party_id`

type recommendationProfileEntity struct {
	Positive    int     `json:"positive"`
	Paused      int     `json:"paused"`
	Specificity float64 `json:"specificity"`
}

type recommendationFrozenState struct {
	PrimaryCode     string `json:"primaryCode"`
	ListeningStatus string `json:"listeningStatus"`
	Favorite        bool   `json:"favorite"`
}

type RecommendationProfile struct {
	Entities map[string]recommendationProfileEntity `json:"entities"`
	Names    map[string][]string                    `json:"names"`
	States   map[int64]recommendationFrozenState    `json:"states,omitempty"`
	// The private cache key authenticates context ownership after eviction.
	// It is persisted with the generation and never included in public scores.
	ContextSigningKey string `json:"contextSigningKey,omitempty"`
}

type recommendationProfileQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// Feedback is the root of a profile read. No catalog relation scan discovers
// evidence, and no valid feedback is truncated to meet recall budgets.
func (s *Store) prepareRecommendationProfile(ctx context.Context, userID, epoch int64) (RecommendationProfile, error) {
	profile := emptyRecommendationProfile()
	profile.States = map[int64]recommendationFrozenState{}
	var after int64
	for {
		rows, err := s.db.QueryContext(ctx, `SELECT u.work_id,w.primary_code,u.listening_status,u.favorite FROM user_work_state u JOIN work w ON w.id = u.work_id
   WHERE u.user_id = ? AND u.work_id > ? AND (u.listening_status <> 'none' OR u.favorite = 1)
   ORDER BY u.work_id LIMIT 256`, userID, after)
		if err != nil {
			return profile, err
		}
		ids := []int64{}
		for rows.Next() {
			var id int64
			var state recommendationFrozenState
			if err := rows.Scan(&id, &state.PrimaryCode, &state.ListeningStatus, &state.Favorite); err != nil {
				_ = rows.Close()
				return profile, err
			}
			profile.States[id] = state
			s.recommendationDiagnostics.stateRows.Add(1)
			ids = append(ids, id)
			after = id
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return profile, err
		}
		if len(ids) == 0 {
			break
		}
		feedback := []int64{}
		for _, id := range ids {
			state := profile.States[id]
			if state.Favorite || state.ListeningStatus == "relisten" || state.ListeningStatus == "paused" {
				feedback = append(feedback, id)
			}
		}
		features, err := s.loadRecommendationFeatures(ctx, epoch, feedback)
		if err != nil {
			return profile, err
		}
		for _, id := range feedback {
			state := profile.States[id]
			for _, f := range features[id] {
				evidence := profile.Entities[f.key()]
				if state.Favorite || state.ListeningStatus == "relisten" {
					evidence.Positive++
				} else if state.ListeningStatus == "paused" {
					evidence.Paused++
				}
				profile.Entities[f.key()] = evidence
			}
		}
	}
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT work_count FROM recommendation_catalog_epoch WHERE id = ? AND published = 1", epoch).Scan(&total); err != nil {
		return profile, err
	}
	for key, evidence := range profile.Entities {
		f, err := parseRecommendationFeatureKey(key)
		if err != nil {
			return profile, err
		}
		evidence.Specificity = 1
		if f.Kind == "tag" {
			var count int
			if err := s.db.QueryRowContext(ctx, `SELECT work_count FROM recommendation_catalog_frequency WHERE kind = ? AND entity_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY valid_from DESC LIMIT 1`, f.Kind, f.ID, epoch, epoch).Scan(&count); err != nil {
				return profile, err
			}
			evidence.Specificity = recommendationTagSpecificity(count, total)
			s.recommendationDiagnostics.frequencyRows.Add(1)
		}
		profile.Entities[key] = evidence
		rows, err := s.db.QueryContext(ctx, "SELECT DISTINCT name FROM recommendation_catalog_name WHERE kind = ? AND entity_id = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)", f.Kind, f.ID, epoch, epoch)
		if err != nil {
			return profile, err
		}
		names := []string{}
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				_ = rows.Close()
				return profile, err
			}
			names = append(names, name)
			s.recommendationDiagnostics.nameRows.Add(1)
		}
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return profile, err
		}
		for _, name := range names {
			nameKey := f.Kind + ":" + name
			if _, loaded := profile.Names[nameKey]; loaded {
				continue
			}
			// All entities sharing a relevant name participate in ambiguity, including
			// entities absent from this user's feedback.
			matches, err := s.db.QueryContext(ctx, `SELECT DISTINCT entity_id FROM recommendation_catalog_name WHERE kind = ? AND name = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?) ORDER BY entity_id LIMIT 2`, f.Kind, name, epoch, epoch)
			if err != nil {
				return profile, err
			}
			keys := []string{}
			for matches.Next() {
				var id int64
				if err := matches.Scan(&id); err != nil {
					_ = matches.Close()
					return profile, err
				}
				keys = append(keys, f.Kind+":"+strconv.FormatInt(id, 10))
				s.recommendationDiagnostics.nameRows.Add(1)
			}
			err = matches.Err()
			_ = matches.Close()
			if err != nil {
				return profile, err
			}
			profile.Names[nameKey] = keys
		}
	}
	return profile, nil
}

func parseRecommendationFeatureKey(key string) (recommendationFeature, error) {
	kind, raw, ok := strings.Cut(key, ":")
	if !ok {
		return recommendationFeature{}, errors.New("invalid recommendation feature")
	}
	id, err := strconv.ParseInt(raw, 10, 64)
	return recommendationFeature{Kind: kind, ID: id}, err
}

func (s *Store) loadFrozenRecommendationProfile(ctx context.Context, snapshot RecommendationSessionSnapshot) (RecommendationProfile, error) {
	if snapshot.GenerationID <= 0 {
		return emptyRecommendationProfile(), nil
	}
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT profile_json FROM recommendation_generation_profile WHERE generation_id = ?", snapshot.GenerationID).Scan(&raw); err != nil {
		return RecommendationProfile{}, err
	}
	var profile RecommendationProfile
	err := json.Unmarshal([]byte(raw), &profile)
	return profile, err
}

func containsProfileKey(keys []string, key string) bool {
	for _, existing := range keys {
		if existing == key {
			return true
		}
	}
	return false
}

// workSignals is the shared pure v5 affinity policy. Removing the candidate's
// own evidence precedes positive-over-negative precedence and thresholding.
func (profile RecommendationProfile) workSignals(features []recommendationFeature, state recommendationFrozenState, config RecommendationConfig) RecommendationSignals {
	signals := RecommendationSignals{ListeningStatus: state.ListeningStatus, Favorite: state.Favorite, Affinity: &RecommendationAffinity{}}
	if signals.ListeningStatus == "" {
		signals.ListeningStatus = "none"
	}
	positiveSelf := 0
	pausedSelf := 0
	if state.Favorite || state.ListeningStatus == "relisten" {
		positiveSelf = 1
	} else if state.ListeningStatus == "paused" {
		pausedSelf = 1
	}
	for _, f := range features {
		evidence := profile.Entities[f.key()]
		positive := max(0, evidence.Positive-positiveSelf)
		paused := max(0, evidence.Paused-pausedSelf)
		strength := recommendationEvidenceStrength(positive)
		if f.Kind == "tag" {
			strength *= evidence.Specificity
		}
		switch f.Kind {
		case "tag":
			if positive > 0 {
				signals.PositiveTagMatches++
				signals.Affinity.Tags += strength
			} else if paused >= config.NegativeMinEvidence {
				signals.NegativeTagMatches++
			}
		case "voice":
			if positive > 0 {
				signals.PositiveVoiceMatches++
				signals.Affinity.Voices += strength
			} else if paused >= config.NegativeMinEvidence {
				signals.NegativeVoiceMatches++
			}
		case "circle":
			if positive > 0 {
				signals.PositiveCircleMatches++
				signals.Affinity.Circles += strength
			} else if paused >= config.NegativeMinEvidence {
				signals.NegativeCircleMatches++
			}
		}
	}
	return signals
}

// RecommendationCandidate describes a transient remote result, never a work
// identity or a request to import metadata.
type RecommendationCandidate struct {
	PrimaryCode string   `json:"primaryCode"`
	WorkID      *int64   `json:"workId"`
	Tags        []string `json:"tags"`
	VoiceActors []string `json:"voiceActors"`
	Circle      string   `json:"circle"`
}

var ErrInvalidRecommendationCandidate = errors.New("invalid recommendation candidate")

func (profile RecommendationProfile) candidateSignals(candidate RecommendationCandidate, config RecommendationConfig) RecommendationSignals {
	features := []recommendationFeature{}
	seen := map[string]bool{}
	for _, group := range []struct {
		kind  string
		names []string
	}{{"tag", candidate.Tags}, {"voice", candidate.VoiceActors}, {"circle", []string{candidate.Circle}}} {
		for _, name := range group.names {
			keys := profile.Names[group.kind+":"+searchtext.Fold(name)]
			if len(keys) != 1 || seen[keys[0]] {
				continue
			}
			seen[keys[0]] = true
			f, err := parseRecommendationFeatureKey(keys[0])
			if err == nil {
				features = append(features, f)
			}
		}
	}
	return profile.workSignals(features, recommendationFrozenState{ListeningStatus: "none"}, config)
}

// ScoreRecommendationCandidates prepares one profile and batch-scores at most
// one remote page. Known id/code pairs use the same frozen features as details.
func (s *Store) ScoreRecommendationCandidates(ctx context.Context, userID int64, sessionID string, candidates []RecommendationCandidate) ([]RecommendationBreakdown, error) {
	if len(candidates) > 100 {
		return nil, ErrInvalidRecommendationCandidate
	}
	snapshot, err := s.snapshotForRecommendation(ctx, userID, sessionID)
	if err != nil {
		return nil, err
	}
	profile, err := s.loadFrozenRecommendationProfile(ctx, snapshot)
	if err != nil {
		return nil, err
	}
	ids := []int64{}
	seen := map[int64]bool{}
	for _, candidate := range candidates {
		if candidate.WorkID != nil && !seen[*candidate.WorkID] {
			ids = append(ids, *candidate.WorkID)
			seen[*candidate.WorkID] = true
		}
	}
	codes := map[int64]string{}
	if len(ids) > 0 {
		args := []any{}
		for _, id := range ids {
			args = append(args, id)
		}
		rows, err := s.db.QueryContext(ctx, "SELECT id,primary_code FROM work WHERE id IN ("+strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")+")", args...)
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
		err = rows.Err()
		_ = rows.Close()
		if err != nil {
			return nil, err
		}
	}
	for _, candidate := range candidates {
		if candidate.WorkID != nil && !strings.EqualFold(codes[*candidate.WorkID], candidate.PrimaryCode) {
			return nil, ErrInvalidRecommendationCandidate
		}
	}
	known, err := s.scoreRecommendationWorksWithProfile(ctx, snapshot, profile, ids)
	if err != nil {
		return nil, err
	}
	result := make([]RecommendationBreakdown, len(candidates))
	for i, candidate := range candidates {
		if candidate.WorkID != nil {
			result[i] = known[*candidate.WorkID]
		} else {
			result[i] = buildRecommendationBreakdown(snapshot.Config, profile.candidateSignals(candidate, snapshot.Config))
		}
	}
	return result, nil
}

func (s *Store) scoreRecommendationWorks(ctx context.Context, snapshot RecommendationSessionSnapshot, ids []int64) (map[int64]RecommendationBreakdown, error) {
	profile, err := s.loadFrozenRecommendationProfile(ctx, snapshot)
	if err != nil {
		return nil, err
	}
	return s.scoreRecommendationWorksWithProfile(ctx, snapshot, profile, ids)
}

func (s *Store) scoreRecommendationWorksWithProfile(ctx context.Context, snapshot RecommendationSessionSnapshot, profile RecommendationProfile, ids []int64) (map[int64]RecommendationBreakdown, error) {
	if len(ids) > 2000 {
		return nil, errors.New("recommendation scoring budget exceeded")
	}
	result := map[int64]RecommendationBreakdown{}
	s.recommendationDiagnostics.scoredWorks.Add(int64(len(ids)))
	features, err := s.loadRecommendationFeatures(ctx, snapshot.CatalogEpoch, ids)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		state := profile.States[id]
		// A work absent from the bound epoch is a valid neutral newcomer, including
		// any feedback recorded before its first shared projection is published.
		if _, exists := features[id]; !exists {
			state = recommendationFrozenState{ListeningStatus: "none"}
		}
		result[id] = buildRecommendationBreakdown(snapshot.Config, profile.workSignals(features[id], state, snapshot.Config))
	}
	return result, nil
}
