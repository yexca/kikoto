package library

import "context"

const recommendationScoreExpression = `
	MAX(0, MIN(100,
		CASE COALESCE(user_work_state.listening_status, 'none')
			WHEN 'none' THEN 35
			WHEN 'want_to_listen' THEN 20
			WHEN 'listening' THEN 12
			WHEN 'finished' THEN 0
			WHEN 'relisten' THEN 10
			WHEN 'paused' THEN -50
			ELSE 0
		END
		+ MIN(25, COALESCE((
			SELECT COUNT(DISTINCT candidate_tag.tag_id) * 5
			FROM work_tag AS candidate_tag
			INNER JOIN tag AS candidate_tag_value ON candidate_tag_value.id = candidate_tag.tag_id
			WHERE candidate_tag.work_id = work.id
				AND candidate_tag_value.namespace = 'dlsite'
				AND EXISTS (
					SELECT 1
					FROM work_tag AS liked_tag
					INNER JOIN user_work_state AS liked_state
						ON liked_state.work_id = liked_tag.work_id
						AND liked_state.user_id = ?
					WHERE liked_tag.tag_id = candidate_tag.tag_id
						AND liked_tag.work_id <> work.id
						AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
				)
		), 0))
		+ MIN(20, COALESCE((
			SELECT COUNT(DISTINCT candidate_credit.person_id) * 10
			FROM work_credit AS candidate_credit
			WHERE candidate_credit.work_id = work.id
				AND candidate_credit.role = 'voice_actor'
				AND EXISTS (
					SELECT 1
					FROM work_credit AS liked_credit
					INNER JOIN user_work_state AS liked_state
						ON liked_state.work_id = liked_credit.work_id
						AND liked_state.user_id = ?
					WHERE liked_credit.person_id = candidate_credit.person_id
						AND liked_credit.role = 'voice_actor'
						AND liked_credit.work_id <> work.id
						AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
				)
		), 0))
		+ MIN(15, COALESCE((
			SELECT COUNT(DISTINCT candidate_party.party_id) * 15
			FROM work_party AS candidate_party
			WHERE candidate_party.work_id = work.id
				AND candidate_party.role = 'circle'
				AND EXISTS (
					SELECT 1
					FROM work_party AS liked_party
					INNER JOIN user_work_state AS liked_state
						ON liked_state.work_id = liked_party.work_id
						AND liked_state.user_id = ?
					WHERE liked_party.party_id = candidate_party.party_id
						AND liked_party.role = 'circle'
						AND liked_party.work_id <> work.id
						AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
				)
		), 0))
		+ CASE WHEN COALESCE(user_work_state.favorite, 0) = 1 THEN 10 ELSE 0 END
	))`

// RecommendationScore returns the same bounded personal score used by Library
// ordering so card markers and ordered pages cannot drift apart.
func (s *Store) RecommendationScore(ctx context.Context, userID, workID int64) (int, error) {
	if userID <= 0 || workID <= 0 {
		return 0, nil
	}
	var score int
	err := s.db.QueryRowContext(ctx, `
		SELECT `+recommendationScoreExpression+`
		FROM work
		LEFT JOIN user_work_state
			ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		WHERE work.id = ?
	`, userID, userID, userID, userID, workID).Scan(&score)
	return score, err
}
