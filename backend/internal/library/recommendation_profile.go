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

type RecommendationProfile struct {
	Entities map[string]recommendationProfileEntity `json:"entities"`
	Names    map[string][]string                    `json:"names"`
}

type recommendationProfileQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadRecommendationProfile(ctx context.Context, queryer recommendationProfileQueryer, userID int64) (RecommendationProfile, error) {
	profile := RecommendationProfile{Entities: map[string]recommendationProfileEntity{}, Names: map[string][]string{}}
	if userID <= 0 {
		return profile, nil
	}
	rows, err := queryer.QueryContext(ctx, `WITH entities AS MATERIALIZED (`+recommendationEntitiesSQL+`)
		SELECT kind, entity_id,
		 SUM(CASE WHEN state.listening_status = 'relisten' OR state.favorite = 1 THEN 1 ELSE 0 END),
		 SUM(CASE WHEN state.listening_status = 'paused' AND state.favorite = 0 THEN 1 ELSE 0 END),
		 COUNT(*), (SELECT COUNT(*) FROM work)
		FROM entities LEFT JOIN user_work_state AS state ON state.work_id = entities.work_id AND state.user_id = ?
		GROUP BY kind, entity_id
		HAVING SUM(CASE WHEN state.listening_status IN ('relisten', 'paused') OR state.favorite = 1 THEN 1 ELSE 0 END) > 0`, userID)
	if err != nil {
		return profile, err
	}
	for rows.Next() {
		var kind string
		var id int64
		var entity recommendationProfileEntity
		var frequency, total int
		if err := rows.Scan(&kind, &id, &entity.Positive, &entity.Paused, &frequency, &total); err != nil {
			_ = rows.Close()
			return profile, err
		}
		entity.Specificity = 1
		if kind == "tag" {
			entity.Specificity = recommendationTagSpecificity(frequency, total)
		}
		profile.Entities[kind+":"+strconv.FormatInt(id, 10)] = entity
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return profile, err
	}
	if err := rows.Close(); err != nil {
		return profile, err
	}
	if len(profile.Entities) == 0 {
		return profile, nil
	}
	// Aliases resolve to the same entity. Ambiguous names are kept ambiguous and
	// never become several independent matches for one source-supplied name.
	rows, err = queryer.QueryContext(ctx, `
		SELECT 'tag', COALESCE(resolved.resolved_tag_id, tag.id), tag.display_name FROM tag
		LEFT JOIN metadata_tag_resolution AS resolved ON resolved.source_tag_id = tag.id
		WHERE tag.namespace IN ('dlsite', 'metadata')
		UNION ALL SELECT 'tag', resolved.resolved_tag_id, name.name FROM metadata_tag_name AS name
		JOIN metadata_tag_resolution AS resolved ON resolved.source_tag_id = name.tag_id
		UNION ALL SELECT 'tag', resolved.resolved_tag_id, name.name FROM metadata_tag_provider_name AS name
		JOIN metadata_tag_resolution AS resolved ON resolved.source_tag_id = name.tag_id
		UNION ALL SELECT 'tag', resolved.resolved_tag_id, name.name FROM dlsite_genre_name AS name
		JOIN metadata_tag AS concept ON concept.dlsite_genre_id = name.genre_id
		JOIN metadata_tag_resolution AS resolved ON resolved.source_tag_id = concept.tag_id
		UNION ALL SELECT 'voice', id, display_name FROM person
		UNION ALL SELECT 'voice', person_id, alias FROM person_alias
		UNION ALL SELECT 'circle', id, display_name FROM party
		UNION ALL SELECT 'circle', id, manual_name FROM party
		UNION ALL SELECT 'circle', id, provider_name FROM party
		UNION ALL SELECT 'circle', party_id, alias FROM party_alias`)
	if err != nil {
		return profile, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var kind, name string
		var id int64
		if err := rows.Scan(&kind, &id, &name); err != nil {
			return profile, err
		}
		name = searchtext.Fold(name)
		if name == "" {
			continue
		}
		key := kind + ":" + strconv.FormatInt(id, 10)
		nameKey := kind + ":" + name
		if !containsProfileKey(profile.Names[nameKey], key) {
			profile.Names[nameKey] = append(profile.Names[nameKey], key)
		}
	}
	for name, keys := range profile.Names {
		relevant := false
		for _, key := range keys {
			if _, exists := profile.Entities[key]; exists {
				relevant = true
				break
			}
		}
		if !relevant {
			delete(profile.Names, name)
		}
	}
	return profile, rows.Err()
}

func containsProfileKey(keys []string, key string) bool {
	for _, existing := range keys {
		if existing == key {
			return true
		}
	}
	return false
}

// RecommendationCandidate describes a transient remote result, never a work
// identity or a request to import metadata. Known candidates use stored signals.
type RecommendationCandidate struct {
	PrimaryCode string   `json:"primaryCode"`
	WorkID      *int64   `json:"workId"`
	Tags        []string `json:"tags"`
	VoiceActors []string `json:"voiceActors"`
	Circle      string   `json:"circle"`
}

var ErrInvalidRecommendationCandidate = errors.New("invalid recommendation candidate")

func (profile RecommendationProfile) candidateSignals(candidate RecommendationCandidate, config RecommendationConfig) RecommendationSignals {
	signals := RecommendationSignals{ListeningStatus: "none", Affinity: &RecommendationAffinity{}}
	for _, group := range []struct {
		kind     string
		names    []string
		matches  *int
		negative *int
		strength *float64
	}{
		{"tag", candidate.Tags, &signals.PositiveTagMatches, &signals.NegativeTagMatches, &signals.Affinity.Tags},
		{"voice", candidate.VoiceActors, &signals.PositiveVoiceMatches, &signals.NegativeVoiceMatches, &signals.Affinity.Voices},
		{"circle", []string{candidate.Circle}, &signals.PositiveCircleMatches, &signals.NegativeCircleMatches, &signals.Affinity.Circles},
	} {
		seen := map[string]bool{}
		for _, name := range group.names {
			keys := profile.Names[group.kind+":"+searchtext.Fold(name)]
			if len(keys) != 1 || seen[keys[0]] {
				continue
			}
			seen[keys[0]] = true
			entity := profile.Entities[keys[0]]
			if entity.Positive > 0 {
				*group.matches++
				*group.strength += recommendationEvidenceStrength(entity.Positive) * entity.Specificity
			} else if entity.Paused >= config.NegativeMinEvidence {
				*group.negative++
			}
		}
	}
	return signals
}

// ScoreRecommendationCandidates reads a profile once and scores the bounded
// current page without upstream requests or catalog materialization.
func (s *Store) ScoreRecommendationCandidates(ctx context.Context, userID int64, sessionID string, candidates []RecommendationCandidate) ([]RecommendationBreakdown, error) {
	config := s.LoadUserRecommendationConfig(ctx, userID)
	var profile RecommendationProfile
	var snapshot RecommendationSessionSnapshot
	var err error
	if userID > 0 && sessionID != "" {
		snapshot, err = s.PrepareRecommendationSession(ctx, userID, sessionID)
		if err != nil {
			return nil, err
		}
		config = snapshot.Config
		var raw string
		if err := s.db.QueryRowContext(ctx, "SELECT profile_json FROM recommendation_generation_profile WHERE generation_id = ?", snapshot.GenerationID).Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &profile); err != nil {
			return nil, err
		}
	} else {
		profile, err = loadRecommendationProfile(ctx, s.db, userID)
		if err != nil {
			return nil, err
		}
	}
	known := map[int64]RecommendationBreakdown{}
	ids := []any{}
	for _, candidate := range candidates {
		if candidate.WorkID != nil {
			ids = append(ids, *candidate.WorkID)
		}
	}
	if len(ids) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
		query := `SELECT work.id, work.primary_code, COALESCE(snapshot.listening_status, 'none'), COALESCE(snapshot.favorite, 0),
			COALESCE(snapshot.positive_tag_matches, 0), COALESCE(snapshot.positive_voice_matches, 0), COALESCE(snapshot.positive_circle_matches, 0),
			COALESCE(snapshot.negative_tag_matches, 0), COALESCE(snapshot.negative_voice_matches, 0), COALESCE(snapshot.negative_circle_matches, 0),
			COALESCE(snapshot.affinity_json, '{}'), COALESCE(snapshot.diversity_penalty, 0) FROM work LEFT JOIN recommendation_snapshot AS snapshot
			ON snapshot.work_id = work.id AND snapshot.generation_id = ? WHERE work.id IN (` + placeholders + `)`
		args := append([]any{snapshot.GenerationID}, ids...)
		rows, err := s.db.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, err
		}
		codes := map[int64]string{}
		for rows.Next() {
			var id int64
			var code string
			var signals RecommendationSignals
			var favorite int
			var affinityJSON string
			if err := rows.Scan(&id, &code, &signals.ListeningStatus, &favorite,
				&signals.PositiveTagMatches, &signals.PositiveVoiceMatches, &signals.PositiveCircleMatches,
				&signals.NegativeTagMatches, &signals.NegativeVoiceMatches, &signals.NegativeCircleMatches, &affinityJSON, &signals.DiversityPenalty); err != nil {
				_ = rows.Close()
				return nil, err
			}
			codes[id] = code
			signals.Favorite = favorite != 0
			signals.Affinity = &RecommendationAffinity{}
			if err := json.Unmarshal([]byte(affinityJSON), signals.Affinity); err != nil {
				_ = rows.Close()
				return nil, err
			}
			known[id] = buildRecommendationBreakdown(config, signals)
		}
		if err := rows.Err(); err != nil {
			_ = rows.Close()
			return nil, err
		}
		_ = rows.Close()
		for _, candidate := range candidates {
			if candidate.WorkID == nil {
				continue
			}
			id := *candidate.WorkID
			if !strings.EqualFold(codes[id], candidate.PrimaryCode) {
				return nil, ErrInvalidRecommendationCandidate
			}
			if snapshot.GenerationID <= 0 {
				known[id], err = s.RecommendationBreakdownWithConfig(ctx, userID, id, config)
			}
			if err != nil {
				return nil, err
			}
		}
	}
	result := make([]RecommendationBreakdown, len(candidates))
	for index, candidate := range candidates {
		if candidate.WorkID != nil {
			result[index] = known[*candidate.WorkID]
		} else {
			result[index] = buildRecommendationBreakdown(config, profile.candidateSignals(candidate, config))
		}
	}
	return result, nil
}
