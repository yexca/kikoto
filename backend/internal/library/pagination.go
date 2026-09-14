package library

// Page candidates carry only normalized work fields and ordering inputs. Keeping
// snapshots and correlated media projections outside the materialized page bounds
// their cost by page size, including when recommendation lanes require sorting.
// Both stages execute in one statement and therefore share one SQLite snapshot.
func listPageSelectSQL(where, sortKey, direction string, randomSeed int64, config RecommendationConfig, includeRecommendation bool, generationID int64) string {
	score, join := listRecommendationProjection(includeRecommendation, config, generationID)
	normalizedSort, _ := normalizeSort(sortKey, direction)
	extra := ""
	if normalizedSort == "recommend" {
		lane := "user_work_state.listening_status"
		if generationID > 0 {
			lane = "recommendation_snapshot.listening_status"
		}
		extra = ", COALESCE(" + lane + ", 'none') AS recommendation_lane"
	}
	candidates := `SELECT ` + listWorkColumnsSQL + `, work.release_date,
		COALESCE(user_work_state.listening_status, 'none') AS listening_status,
		COALESCE(user_work_state.favorite, 0) AS favorite` + score + extra + `
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?` + join + `
		WHERE ` + where
	orderBy := listOrderBy(sortKey, direction, randomSeed, config)
	if normalizedSort == "recommend" {
		candidates = recommendationOrderedSelectSQL(candidates, direction, randomSeed, config, "*")
		orderBy = "work.recommendation_suppressed ASC, work.recommendation_position ASC, work.id ASC"
	} else {
		candidates += " ORDER BY " + orderBy
	}
	return `WITH library_page AS MATERIALIZED (` + candidates + ` LIMIT ? OFFSET ?)
		SELECT ` + listSummaryColumnsSQL + `, work.listening_status, work.favorite, work.recommend_score
		FROM library_page AS work ORDER BY ` + orderBy
}
