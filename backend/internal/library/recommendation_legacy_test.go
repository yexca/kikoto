package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/yexca/kikoto/backend/internal/searchtext"
	"strconv"
)

// The v5 implementation is retained only as an experimental baseline.
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

func buildRecommendationGeneration(
	ctx context.Context,
	tx *sql.Tx,
	userID int64,
	config RecommendationConfig,
	inputRevision int64,
	userRevision int64,
) (int64, error) {
	configJSON, err := json.Marshal(config)
	if err != nil {
		return 0, err
	}
	result, err := tx.ExecContext(ctx, `
		INSERT INTO recommendation_generation (user_id, algorithm_version, config_json, input_revision, user_revision)
		VALUES (?, ?, ?, ?, ?)
	`, userID, RecommendationAlgorithmVersion, string(configJSON), inputRevision, userRevision)
	if err != nil {
		return 0, err
	}
	generationID, err := result.LastInsertId()
	if err != nil {
		return 0, err
	}

	profile, err := loadRecommendationProfile(ctx, tx, userID)
	if err != nil {
		return 0, err
	}
	profileJSON, err := json.Marshal(profile)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO recommendation_generation_profile (generation_id, profile_json) VALUES (?, ?)", generationID, string(profileJSON)); err != nil {
		return 0, err
	}

	if _, err := tx.ExecContext(
		ctx,
		recommendationGenerationInsertSQL(config),
		userID, userID, userID, generationID,
	); err != nil {
		return 0, err
	}
	return generationID, nil
}

// recommendationGenerationInsertSQL aggregates each user's entity evidence
// once, then derives per-work signals without repeating history scans.
func recommendationGenerationInsertSQL(config RecommendationConfig) string {
	scoreExpression := recommendationScoreFromSignalExpressions(
		config,
		"favorite",
		"positive_tag_affinity",
		"positive_voice_affinity",
		"positive_circle_affinity",
		"negative_tag_matches",
		"negative_voice_matches",
		"negative_circle_matches",
	)
	return fmt.Sprintf(`
		WITH candidate_entities(entity_type, work_id, entity_id) AS MATERIALIZED (
			SELECT 'tag', work_tag.work_id, work_tag.tag_id
			FROM work_tag
			INNER JOIN tag ON tag.id = work_tag.tag_id
			WHERE tag.namespace IN ('dlsite', 'metadata')
			GROUP BY work_tag.work_id, work_tag.tag_id
			UNION ALL
			SELECT 'voice', work_credit.work_id, work_credit.person_id
			FROM work_credit
			WHERE work_credit.role = 'voice_actor'
			GROUP BY work_credit.work_id, work_credit.person_id
			UNION ALL
			SELECT 'circle', work_party.work_id, work_party.party_id
			FROM work_party
			WHERE work_party.role = 'circle'
			GROUP BY work_party.work_id, work_party.party_id
		),
		entity_frequency AS MATERIALIZED (
			SELECT entity_type, entity_id, COUNT(*) AS work_count FROM candidate_entities GROUP BY entity_type, entity_id
		),
		user_entity_evidence AS MATERIALIZED (
			SELECT candidate_entities.entity_type, candidate_entities.entity_id,
				SUM(CASE WHEN evidence_state.listening_status = 'relisten' OR evidence_state.favorite = 1 THEN 1 ELSE 0 END) AS positive_work_count,
				SUM(CASE WHEN evidence_state.listening_status = 'paused' AND evidence_state.favorite = 0 THEN 1 ELSE 0 END) AS paused_work_count
			FROM candidate_entities
			INNER JOIN user_work_state AS evidence_state
				ON evidence_state.work_id = candidate_entities.work_id AND evidence_state.user_id = ?
			WHERE evidence_state.listening_status IN ('relisten', 'paused') OR evidence_state.favorite = 1
			GROUP BY candidate_entities.entity_type, candidate_entities.entity_id
		),
		candidate_entity_evidence AS (
			SELECT candidate_entities.work_id, candidate_entities.entity_type,
				CASE WHEN candidate_entities.entity_type = 'tag' THEN 1.0 - 0.5 * entity_frequency.work_count / (SELECT MAX(1, COUNT(*)) FROM work) ELSE 1.0 END AS specificity,
				COALESCE(user_entity_evidence.positive_work_count, 0)
					- CASE WHEN candidate_state.listening_status = 'relisten' OR candidate_state.favorite = 1 THEN 1 ELSE 0 END
					AS positive_other_work_count,
				COALESCE(user_entity_evidence.paused_work_count, 0)
					- CASE WHEN candidate_state.listening_status = 'paused' AND candidate_state.favorite = 0 THEN 1 ELSE 0 END
					AS paused_other_work_count
			FROM candidate_entities
			JOIN entity_frequency ON entity_frequency.entity_type = candidate_entities.entity_type AND entity_frequency.entity_id = candidate_entities.entity_id
			LEFT JOIN user_entity_evidence
				ON user_entity_evidence.entity_type = candidate_entities.entity_type
				AND user_entity_evidence.entity_id = candidate_entities.entity_id
			LEFT JOIN user_work_state AS candidate_state
				ON candidate_state.work_id = candidate_entities.work_id AND candidate_state.user_id = ?
		),
		work_entity_signals AS (
			SELECT work_id,
				SUM(CASE WHEN entity_type = 'tag' AND positive_other_work_count > 0 THEN 1 ELSE 0 END) AS positive_tag_matches,
				SUM(CASE WHEN entity_type = 'tag' AND positive_other_work_count > 0 THEN (1.0 + 0.25 * MIN(4, positive_other_work_count - 1)) * specificity ELSE 0 END) AS positive_tag_affinity,
				SUM(CASE WHEN entity_type = 'voice' AND positive_other_work_count > 0 THEN 1.0 + 0.25 * MIN(4, positive_other_work_count - 1) ELSE 0 END) AS positive_voice_affinity,
				SUM(CASE WHEN entity_type = 'circle' AND positive_other_work_count > 0 THEN 1.0 + 0.25 * MIN(4, positive_other_work_count - 1) ELSE 0 END) AS positive_circle_affinity,
				SUM(CASE WHEN entity_type = 'voice' AND positive_other_work_count > 0 THEN 1 ELSE 0 END) AS positive_voice_matches,
				SUM(CASE WHEN entity_type = 'circle' AND positive_other_work_count > 0 THEN 1 ELSE 0 END) AS positive_circle_matches,
				SUM(CASE WHEN entity_type = 'tag' AND paused_other_work_count >= %d AND positive_other_work_count = 0 THEN 1 ELSE 0 END) AS negative_tag_matches,
				SUM(CASE WHEN entity_type = 'voice' AND paused_other_work_count >= %d AND positive_other_work_count = 0 THEN 1 ELSE 0 END) AS negative_voice_matches,
				SUM(CASE WHEN entity_type = 'circle' AND paused_other_work_count >= %d AND positive_other_work_count = 0 THEN 1 ELSE 0 END) AS negative_circle_matches
			FROM candidate_entity_evidence
			GROUP BY work_id
		),
		recommendation_signals AS MATERIALIZED (
			SELECT work.id AS work_id,
				COALESCE(user_work_state.listening_status, 'none') AS listening_status,
				COALESCE(user_work_state.favorite, 0) AS favorite,
				COALESCE(work_entity_signals.positive_tag_matches, 0) AS positive_tag_matches,
				COALESCE(work_entity_signals.positive_voice_matches, 0) AS positive_voice_matches,
				COALESCE(work_entity_signals.positive_circle_matches, 0) AS positive_circle_matches,
				COALESCE(work_entity_signals.positive_tag_affinity, 0) AS positive_tag_affinity,
				COALESCE(work_entity_signals.positive_voice_affinity, 0) AS positive_voice_affinity,
				COALESCE(work_entity_signals.positive_circle_affinity, 0) AS positive_circle_affinity,
				COALESCE(work_entity_signals.negative_tag_matches, 0) AS negative_tag_matches,
				COALESCE(work_entity_signals.negative_voice_matches, 0) AS negative_voice_matches,
				COALESCE(work_entity_signals.negative_circle_matches, 0) AS negative_circle_matches
			FROM work
            LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
            LEFT JOIN work_entity_signals ON work_entity_signals.work_id = work.id
        ), affinity_scores AS (
            SELECT recommendation_signals.*, %s AS affinity_score,
                COALESCE('circle:' || (SELECT MIN(party_id) FROM work_party WHERE work_id = recommendation_signals.work_id AND role = 'circle'),
                    'voice:' || (SELECT MIN(person_id) FROM work_credit WHERE work_id = recommendation_signals.work_id AND role = 'voice_actor'),
                    'work:' || work_id) AS diversity_group
            FROM recommendation_signals
        ), diversity_ranked AS (
            SELECT affinity_scores.*, ROW_NUMBER() OVER (PARTITION BY listening_status, diversity_group ORDER BY affinity_score DESC, work_id) AS diversity_rank
            FROM affinity_scores
        )
		INSERT INTO recommendation_snapshot (
			generation_id, work_id, listening_status, favorite,
			positive_tag_matches, positive_voice_matches, positive_circle_matches,
			negative_tag_matches, negative_voice_matches, negative_circle_matches, score, affinity_json, diversity_penalty
		)
		SELECT ?, work_id, listening_status, favorite,
			positive_tag_matches, positive_voice_matches, positive_circle_matches,
			negative_tag_matches, negative_voice_matches, negative_circle_matches, affinity_score,
			json_object('tags', positive_tag_affinity, 'voices', positive_voice_affinity, 'circles', positive_circle_affinity), MIN(8, (diversity_rank - 1) * 2)
		FROM diversity_ranked
	`, config.NegativeMinEvidence, config.NegativeMinEvidence, config.NegativeMinEvidence, scoreExpression)
}

func (s *Store) legacyRecommendationBreakdownWithConfig(ctx context.Context, userID, workID int64, config RecommendationConfig) (RecommendationBreakdown, error) {
	if workID <= 0 {
		return buildRecommendationBreakdown(config, RecommendationSignals{ListeningStatus: "none"}), nil
	}
	query := fmt.Sprintf(`SELECT COALESCE(user_work_state.listening_status, 'none'), COALESCE(user_work_state.favorite, 0),
		%s, %s, %s, %s, %s, %s, %s, %s, %s
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		WHERE work.id = ?`, positiveTagMatchCountExpression, positiveVoiceMatchCountExpression, positiveCircleMatchCountExpression,
		negativeTagMatchCountExpression(config.NegativeMinEvidence), negativeVoiceMatchCountExpression(config.NegativeMinEvidence), negativeCircleMatchCountExpression(config.NegativeMinEvidence), positiveAffinityExpression("tag"), positiveAffinityExpression("voice"), positiveAffinityExpression("circle"))
	args := append(recommendationUserArgs(userID), userID, userID, userID, userID, workID)
	var signals RecommendationSignals
	signals.Affinity = &RecommendationAffinity{}
	var favorite int
	err := s.db.QueryRowContext(ctx, query, args...).Scan(
		&signals.ListeningStatus, &favorite,
		&signals.PositiveTagMatches, &signals.PositiveVoiceMatches, &signals.PositiveCircleMatches,
		&signals.NegativeTagMatches, &signals.NegativeVoiceMatches, &signals.NegativeCircleMatches,
		&signals.Affinity.Tags, &signals.Affinity.Voices, &signals.Affinity.Circles,
	)
	if err != nil {
		return RecommendationBreakdown{}, err
	}
	signals.Favorite = favorite != 0
	return buildRecommendationBreakdown(config, signals), nil
}
