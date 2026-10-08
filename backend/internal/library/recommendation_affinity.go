package library

import "fmt"

// Evidence saturates at five supporting works. Common tags retain half their
// weight at minimum, so a small library never loses all of its taste signals.
func recommendationEvidenceStrength(count int) float64 {
	if count <= 0 {
		return 0
	}
	return 1 + 0.25*float64(minInt(4, count-1))
}

func recommendationTagSpecificity(frequency, total int) float64 {
	return 1 - 0.5*float64(frequency)/float64(maxInt(1, total))
}

func positiveAffinityExpression(kind string) string {
	table, column, restriction, joins := "work_tag", "tag_id", "", ""
	role := ""
	switch kind {
	case "tag":
		joins = " JOIN tag AS entity_value ON entity_value.id = candidate.tag_id"
		restriction = " AND entity_value.namespace IN ('dlsite', 'metadata')"
	case "voice":
		table, column, restriction = "work_credit", "person_id", " AND candidate.role = 'voice_actor'"
		role = " AND liked.role = 'voice_actor'"
	default:
		table, column, restriction = "work_party", "party_id", " AND candidate.role = 'circle'"
		role = " AND liked.role = 'circle'"
	}
	specificity := "1.0"
	if kind == "tag" {
		specificity = "(1.0 - 0.5 * (SELECT COUNT(DISTINCT common.work_id) FROM work_tag AS common WHERE common.tag_id = candidate.tag_id) / (SELECT MAX(1, COUNT(*)) FROM work))"
	}
	return fmt.Sprintf(`(SELECT COALESCE(SUM(CASE WHEN evidence > 0 THEN
		(1.0 + 0.25 * MIN(4, evidence - 1)) * specificity ELSE 0 END), 0)
		FROM (SELECT DISTINCT candidate.%s,
			(SELECT COUNT(DISTINCT liked.work_id) FROM %s AS liked
			 JOIN user_work_state AS state ON state.work_id = liked.work_id AND state.user_id = ?
			 WHERE liked.%s = candidate.%s AND liked.work_id <> work.id%s
			 AND (state.listening_status = 'relisten' OR state.favorite = 1)) AS evidence,
			%s AS specificity
		FROM %s AS candidate%s WHERE candidate.work_id = work.id%s))`,
		column, table, column, column, role, specificity, table, joins, restriction)
}

type RecommendationAffinity struct {
	Tags    float64 `json:"tags"`
	Voices  float64 `json:"voices"`
	Circles float64 `json:"circles"`
}

func recommendationDiversityProjection(generationID int64) string {
	if generationID > 0 {
		return "COALESCE(recommendation_snapshot.diversity_penalty, 0)"
	}
	return "0"
}
