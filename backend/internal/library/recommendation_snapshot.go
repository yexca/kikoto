package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// RecommendationSessionSnapshot identifies the immutable recommendation inputs
// used by one browser tab or native-app session.
type RecommendationSessionSnapshot struct {
	GenerationID int64
	Config       RecommendationConfig
}

const recommendationSessionRetentionSQL = "datetime('now', '-90 days')"

// PrepareRecommendationSession binds a client session to one recommendation
// generation. Existing compatible sessions never switch generations; an
// obsolete algorithm version or a new session rebuilds when required inputs
// have changed.
func (s *Store) PrepareRecommendationSession(ctx context.Context, userID int64, sessionID string) (RecommendationSessionSnapshot, error) {
	sessionID = strings.TrimSpace(sessionID)
	if userID <= 0 || sessionID == "" {
		return RecommendationSessionSnapshot{}, nil
	}
	if len(sessionID) > 64 {
		return RecommendationSessionSnapshot{}, fmt.Errorf("recommendation session id is too long")
	}
	if snapshot, found, err := boundRecommendationSession(ctx, s.db, userID, sessionID); err != nil {
		return RecommendationSessionSnapshot{}, err
	} else if found {
		return snapshot, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RecommendationSessionSnapshot{}, err
	}
	defer func() { _ = tx.Rollback() }()
	return s.prepareRecommendationSessionTx(ctx, tx, userID, sessionID)
}

func (s *Store) prepareRecommendationSessionTx(ctx context.Context, tx *sql.Tx, userID int64, sessionID string) (RecommendationSessionSnapshot, error) {
	if err := initializeRecommendationSession(ctx, tx, userID, sessionID); err != nil {
		return RecommendationSessionSnapshot{}, err
	}
	if snapshot, found, err := boundRecommendationSession(ctx, tx, userID, sessionID); err != nil {
		return RecommendationSessionSnapshot{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return RecommendationSessionSnapshot{}, err
		}
		return snapshot, nil
	}

	config := loadRecommendationConfig(ctx, tx)
	inputRevision, userRevision, err := recommendationSessionRevisions(ctx, tx, userID)
	if err != nil {
		return RecommendationSessionSnapshot{}, err
	}
	generationID, config, err := s.reuseOrBuildRecommendationGeneration(ctx, tx, userID, config, inputRevision, userRevision)
	if err != nil {
		return RecommendationSessionSnapshot{}, err
	}
	if err := bindRecommendationSession(ctx, tx, userID, sessionID, generationID); err != nil {
		return RecommendationSessionSnapshot{}, err
	}
	if err := tx.Commit(); err != nil {
		return RecommendationSessionSnapshot{}, err
	}
	return RecommendationSessionSnapshot{GenerationID: generationID, Config: config}, nil
}

func initializeRecommendationSession(ctx context.Context, tx *sql.Tx, userID int64, sessionID string) error {
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM recommendation_client_session
		WHERE user_id = ? AND created_at < `+recommendationSessionRetentionSQL, userID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO recommendation_client_session (user_id, session_id, generation_id)
		VALUES (?, ?, NULL)
		ON CONFLICT(user_id, session_id) DO NOTHING
	`, userID, sessionID)
	return err
}

func recommendationSessionRevisions(ctx context.Context, tx *sql.Tx, userID int64) (int64, int64, error) {
	inputRevision, err := recommendationInputRevision(ctx, tx)
	if err != nil {
		return 0, 0, err
	}
	userRevision, err := recommendationUserRevision(ctx, tx, userID)
	return inputRevision, userRevision, err
}

func (s *Store) reuseOrBuildRecommendationGeneration(ctx context.Context, tx *sql.Tx, userID int64, config RecommendationConfig, inputRevision, userRevision int64) (int64, RecommendationConfig, error) {
	generationID, storedConfig, reusable, err := loadReusableRecommendationGeneration(ctx, tx, userID, config, inputRevision, userRevision)
	if err != nil {
		return 0, config, err
	}
	if reusable {
		return generationID, storedConfig, nil
	}
	generationID, err = buildRecommendationGeneration(ctx, tx, userID, config, inputRevision, userRevision)
	if err != nil {
		return 0, config, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO recommendation_snapshot_state (user_id, current_generation_id)
		VALUES (?, ?)
		ON CONFLICT(user_id) DO UPDATE SET
			current_generation_id = excluded.current_generation_id,
			updated_at = CURRENT_TIMESTAMP
	`, userID, generationID); err != nil {
		return 0, config, err
	}
	return generationID, config, nil
}

func loadReusableRecommendationGeneration(ctx context.Context, tx *sql.Tx, userID int64, config RecommendationConfig, inputRevision, userRevision int64) (int64, RecommendationConfig, bool, error) {
	var currentGenerationID sql.NullInt64
	if err := tx.QueryRowContext(ctx, `
		SELECT current_generation_id
		FROM recommendation_snapshot_state
		WHERE user_id = ?
	`, userID).Scan(&currentGenerationID); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, config, false, err
	}
	if !currentGenerationID.Valid {
		return 0, config, false, nil
	}
	var algorithmVersion, configJSON string
	var generationInputRevision, generationUserRevision int64
	err := tx.QueryRowContext(ctx, `
		SELECT algorithm_version, config_json, input_revision, user_revision
		FROM recommendation_generation
		WHERE id = ? AND user_id = ?
	`, currentGenerationID.Int64, userID).Scan(&algorithmVersion, &configJSON, &generationInputRevision, &generationUserRevision)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, config, false, nil
	}
	if err != nil {
		return 0, config, false, err
	}
	storedConfig, decodeErr := decodeRecommendationConfig(configJSON)
	if algorithmVersion != RecommendationAlgorithmVersion || generationInputRevision != inputRevision || generationUserRevision != userRevision || decodeErr != nil || storedConfig != config {
		return 0, config, false, nil
	}
	return currentGenerationID.Int64, storedConfig, true, nil
}

func bindRecommendationSession(ctx context.Context, tx *sql.Tx, userID int64, sessionID string, generationID int64) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE recommendation_client_session
		SET generation_id = ?
		WHERE user_id = ? AND session_id = ?
	`, generationID, userID, sessionID); err != nil {
		return err
	}
	// Keep generations referenced by active sessions. Unreferenced old
	// generations are safe to remove once a newer generation is current.
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM recommendation_generation
		WHERE user_id = ? AND id <> ?
		  AND NOT EXISTS (
			SELECT 1 FROM recommendation_client_session AS session
			WHERE session.generation_id = recommendation_generation.id
		  )
		`, userID, generationID); err != nil {
		return err
	}
	return nil
}

func boundRecommendationSession(
	ctx context.Context,
	queryer recommendationConfigQueryer,
	userID int64,
	sessionID string,
) (RecommendationSessionSnapshot, bool, error) {
	var generationID sql.NullInt64
	var algorithmVersion, configJSON string
	err := queryer.QueryRowContext(ctx, `
		SELECT session.generation_id, COALESCE(generation.algorithm_version, ''), COALESCE(generation.config_json, '')
		FROM recommendation_client_session AS session
		LEFT JOIN recommendation_generation AS generation ON generation.id = session.generation_id
		WHERE session.user_id = ? AND session.session_id = ?
	`, userID, sessionID).Scan(&generationID, &algorithmVersion, &configJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return RecommendationSessionSnapshot{}, false, nil
	}
	if err != nil {
		return RecommendationSessionSnapshot{}, false, err
	}
	if !generationID.Valid || algorithmVersion != RecommendationAlgorithmVersion {
		return RecommendationSessionSnapshot{}, false, nil
	}
	config, err := decodeRecommendationConfig(configJSON)
	if err != nil {
		return RecommendationSessionSnapshot{}, false, nil
	}
	return RecommendationSessionSnapshot{GenerationID: generationID.Int64, Config: config}, true, nil
}

func recommendationInputRevision(ctx context.Context, queryer recommendationConfigQueryer) (int64, error) {
	var revision int64
	err := queryer.QueryRowContext(ctx, `SELECT revision FROM recommendation_input_revision WHERE id = 1`).Scan(&revision)
	return revision, err
}

func recommendationUserRevision(ctx context.Context, queryer recommendationConfigQueryer, userID int64) (int64, error) {
	var revision int64
	err := queryer.QueryRowContext(ctx, `SELECT COALESCE((SELECT revision FROM recommendation_user_revision WHERE user_id = ?), 0)`, userID).Scan(&revision)
	return revision, err
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
		"positive_tag_matches",
		"positive_voice_matches",
		"positive_circle_matches",
		"negative_tag_matches",
		"negative_voice_matches",
		"negative_circle_matches",
	)
	return fmt.Sprintf(`
		WITH candidate_entities(entity_type, work_id, entity_id) AS MATERIALIZED (
			SELECT 'tag', work_tag.work_id, work_tag.tag_id
			FROM work_tag
			INNER JOIN tag ON tag.id = work_tag.tag_id
			WHERE tag.namespace = 'dlsite'
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
				COALESCE(user_entity_evidence.positive_work_count, 0)
					- CASE WHEN candidate_state.listening_status = 'relisten' OR candidate_state.favorite = 1 THEN 1 ELSE 0 END
					AS positive_other_work_count,
				COALESCE(user_entity_evidence.paused_work_count, 0)
					- CASE WHEN candidate_state.listening_status = 'paused' AND candidate_state.favorite = 0 THEN 1 ELSE 0 END
					AS paused_other_work_count
			FROM candidate_entities
			LEFT JOIN user_entity_evidence
				ON user_entity_evidence.entity_type = candidate_entities.entity_type
				AND user_entity_evidence.entity_id = candidate_entities.entity_id
			LEFT JOIN user_work_state AS candidate_state
				ON candidate_state.work_id = candidate_entities.work_id AND candidate_state.user_id = ?
		),
		work_entity_signals AS (
			SELECT work_id,
				SUM(CASE WHEN entity_type = 'tag' AND positive_other_work_count > 0 THEN 1 ELSE 0 END) AS positive_tag_matches,
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
				COALESCE(work_entity_signals.negative_tag_matches, 0) AS negative_tag_matches,
				COALESCE(work_entity_signals.negative_voice_matches, 0) AS negative_voice_matches,
				COALESCE(work_entity_signals.negative_circle_matches, 0) AS negative_circle_matches
			FROM work
			LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
			LEFT JOIN work_entity_signals ON work_entity_signals.work_id = work.id
		)
		INSERT INTO recommendation_snapshot (
			generation_id, work_id, listening_status, favorite,
			positive_tag_matches, positive_voice_matches, positive_circle_matches,
			negative_tag_matches, negative_voice_matches, negative_circle_matches, score
		)
		SELECT ?, work_id, listening_status, favorite,
			positive_tag_matches, positive_voice_matches, positive_circle_matches,
			negative_tag_matches, negative_voice_matches, negative_circle_matches, %s
		FROM recommendation_signals
	`, config.NegativeMinEvidence, config.NegativeMinEvidence, config.NegativeMinEvidence, scoreExpression)
}

// RecommendationSnapshotBreakdown returns the explanation stored with a
// generation. A work added after generation creation receives the same neutral
// recommendation defaults used by the list query until the next session.
func (s *Store) RecommendationSnapshotBreakdown(
	ctx context.Context,
	snapshot RecommendationSessionSnapshot,
	workID int64,
) (RecommendationBreakdown, error) {
	if snapshot.GenerationID <= 0 || workID <= 0 {
		return RecommendationBreakdown{}, sql.ErrNoRows
	}
	var signals RecommendationSignals
	var favorite int
	err := s.db.QueryRowContext(ctx, `
		SELECT listening_status, favorite,
			positive_tag_matches, positive_voice_matches, positive_circle_matches,
			negative_tag_matches, negative_voice_matches, negative_circle_matches
		FROM recommendation_snapshot
		WHERE generation_id = ? AND work_id = ?
	`, snapshot.GenerationID, workID).Scan(
		&signals.ListeningStatus,
		&favorite,
		&signals.PositiveTagMatches,
		&signals.PositiveVoiceMatches,
		&signals.PositiveCircleMatches,
		&signals.NegativeTagMatches,
		&signals.NegativeVoiceMatches,
		&signals.NegativeCircleMatches,
	)
	if errors.Is(err, sql.ErrNoRows) {
		var exists bool
		if existsErr := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM work WHERE id = ?)`, workID).Scan(&exists); existsErr != nil {
			return RecommendationBreakdown{}, existsErr
		}
		if !exists {
			return RecommendationBreakdown{}, sql.ErrNoRows
		}
		return buildRecommendationBreakdown(snapshot.Config, RecommendationSignals{ListeningStatus: "none"}), nil
	}
	if err != nil {
		return RecommendationBreakdown{}, err
	}
	signals.Favorite = favorite != 0
	return buildRecommendationBreakdown(snapshot.Config, signals), nil
}

// RecommendationSnapshotScore returns a score from a materialized generation.
// The boolean is false for works that were added after that generation.
func (s *Store) RecommendationSnapshotScore(ctx context.Context, generationID, workID int64) (int, bool, error) {
	if generationID <= 0 || workID <= 0 {
		return 0, false, nil
	}
	var score int
	err := s.db.QueryRowContext(ctx, `
		SELECT score FROM recommendation_snapshot WHERE generation_id = ? AND work_id = ?
	`, generationID, workID).Scan(&score)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	return score, true, nil
}
