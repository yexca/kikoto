package httpapi

import "context"

func (s *Server) workRecommendationScore(ctx context.Context, userID, workID int64) (int, error) {
	if userID <= 0 || workID <= 0 {
		return 0, nil
	}
	var score int
	err := s.db.QueryRowContext(ctx, `
		SELECT CASE COALESCE(state.listening_status, 'none')
			WHEN 'none' THEN 35 WHEN 'want_to_listen' THEN 12 WHEN 'listening' THEN 8
			WHEN 'finished' THEN 4 WHEN 'relisten' THEN 6 WHEN 'paused' THEN -55 ELSE 0 END
		+ CASE WHEN EXISTS (
			SELECT 1 FROM work_tag candidate
			INNER JOIN work_tag liked ON liked.tag_id = candidate.tag_id
			INNER JOIN user_work_state liked_state ON liked_state.work_id = liked.work_id AND liked_state.user_id = ?
			WHERE candidate.work_id = ? AND liked_state.listening_status IN ('finished', 'relisten')
		) THEN 25 ELSE 0 END
		+ CASE WHEN EXISTS (
			SELECT 1 FROM work_credit candidate
			INNER JOIN work_credit liked ON liked.person_id = candidate.person_id AND liked.role = candidate.role
			INNER JOIN user_work_state liked_state ON liked_state.work_id = liked.work_id AND liked_state.user_id = ?
			WHERE candidate.work_id = ? AND candidate.role = 'voice_actor' AND liked_state.listening_status IN ('finished', 'relisten')
		) THEN 20 ELSE 0 END
		+ CASE WHEN EXISTS (
			SELECT 1 FROM work_party candidate
			INNER JOIN work_party liked ON liked.party_id = candidate.party_id AND liked.role = 'circle'
			INNER JOIN user_work_state liked_state ON liked_state.work_id = liked.work_id AND liked_state.user_id = ?
			WHERE candidate.work_id = ? AND candidate.role = 'circle' AND liked_state.listening_status IN ('finished', 'relisten')
		) THEN 20 ELSE 0 END
		+ CASE WHEN COALESCE(state.favorite, 0) = 1 THEN 10 ELSE 0 END
		FROM work
		LEFT JOIN user_work_state state ON state.work_id = work.id AND state.user_id = ?
		WHERE work.id = ?
	`, userID, workID, userID, workID, userID, workID, userID, workID).Scan(&score)
	return score, err
}
