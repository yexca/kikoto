package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
)

const RecommendationAlgorithmVersion = "heuristic-v2"

const recommendationScoreUserArgumentCount = 9

type RecommendationConfig struct {
	NonePrior            int `json:"nonePrior"`
	WantPrior            int `json:"wantPrior"`
	ListeningPrior       int `json:"listeningPrior"`
	FinishedPrior        int `json:"finishedPrior"`
	RelistenPrior        int `json:"relistenPrior"`
	PausedPrior          int `json:"pausedPrior"`
	TagWeight            int `json:"tagWeight"`
	TagCap               int `json:"tagCap"`
	VoiceWeight          int `json:"voiceWeight"`
	VoiceCap             int `json:"voiceCap"`
	CircleWeight         int `json:"circleWeight"`
	CircleCap            int `json:"circleCap"`
	FavoriteBonus        int `json:"favoriteBonus"`
	NegativeMinEvidence  int `json:"negativeMinEvidence"`
	NegativeTagWeight    int `json:"negativeTagWeight"`
	NegativeTagCap       int `json:"negativeTagCap"`
	NegativeVoiceWeight  int `json:"negativeVoiceWeight"`
	NegativeVoiceCap     int `json:"negativeVoiceCap"`
	NegativeCircleWeight int `json:"negativeCircleWeight"`
	NegativeCircleCap    int `json:"negativeCircleCap"`
	NegativeTotalCap     int `json:"negativeTotalCap"`
	JitterAmplitude      int `json:"jitterAmplitude"`
}

type RecommendationSignals struct {
	ListeningStatus       string `json:"listeningStatus"`
	Favorite              bool   `json:"favorite"`
	PositiveTagMatches    int    `json:"positiveTagMatches"`
	PositiveVoiceMatches  int    `json:"positiveVoiceMatches"`
	PositiveCircleMatches int    `json:"positiveCircleMatches"`
	NegativeTagMatches    int    `json:"negativeTagMatches"`
	NegativeVoiceMatches  int    `json:"negativeVoiceMatches"`
	NegativeCircleMatches int    `json:"negativeCircleMatches"`
}

type RecommendationComponent struct {
	Key          string `json:"key"`
	Label        string `json:"label"`
	MatchCount   int    `json:"matchCount"`
	Contribution int    `json:"contribution"`
	Cap          int    `json:"cap"`
}

type RecommendationBreakdown struct {
	AlgorithmVersion string                    `json:"algorithmVersion"`
	Score            int                       `json:"score"`
	RawScore         int                       `json:"rawScore"`
	Signals          RecommendationSignals     `json:"signals"`
	Components       []RecommendationComponent `json:"components"`
}

func DefaultRecommendationConfig() RecommendationConfig {
	return RecommendationConfig{
		NonePrior: 35, WantPrior: 20, ListeningPrior: 12, FinishedPrior: 0, RelistenPrior: 10, PausedPrior: -50,
		TagWeight: 5, TagCap: 25, VoiceWeight: 10, VoiceCap: 20, CircleWeight: 15, CircleCap: 15, FavoriteBonus: 10,
		NegativeMinEvidence: 2, NegativeTagWeight: 2, NegativeTagCap: 6, NegativeVoiceWeight: 3, NegativeVoiceCap: 6,
		NegativeCircleWeight: 5, NegativeCircleCap: 5, NegativeTotalCap: 15, JitterAmplitude: 3,
	}
}

func ValidateRecommendationConfig(config RecommendationConfig) error {
	priors := []int{config.NonePrior, config.WantPrior, config.ListeningPrior, config.FinishedPrior, config.RelistenPrior, config.PausedPrior}
	for _, value := range priors {
		if value < -100 || value > 100 {
			return fmt.Errorf("recommendation state priors must be between -100 and 100")
		}
	}
	weights := []int{config.TagWeight, config.VoiceWeight, config.CircleWeight, config.FavoriteBonus, config.NegativeTagWeight, config.NegativeVoiceWeight, config.NegativeCircleWeight}
	for _, value := range weights {
		if value < 0 || value > 50 {
			return fmt.Errorf("recommendation weights must be between 0 and 50")
		}
	}
	caps := []int{config.TagCap, config.VoiceCap, config.CircleCap, config.NegativeTagCap, config.NegativeVoiceCap, config.NegativeCircleCap, config.NegativeTotalCap}
	for _, value := range caps {
		if value < 0 || value > 100 {
			return fmt.Errorf("recommendation caps must be between 0 and 100")
		}
	}
	if config.NegativeMinEvidence < 1 || config.NegativeMinEvidence > 10 {
		return fmt.Errorf("negativeMinEvidence must be between 1 and 10")
	}
	if config.JitterAmplitude < 0 || config.JitterAmplitude > 10 {
		return fmt.Errorf("jitterAmplitude must be between 0 and 10")
	}
	return nil
}

func (s *Store) LoadRecommendationConfig(ctx context.Context) RecommendationConfig {
	config := DefaultRecommendationConfig()
	var raw string
	if err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = 'recommendation_config'").Scan(&raw); err != nil {
		return config
	}
	if err := json.Unmarshal([]byte(raw), &config); err != nil || ValidateRecommendationConfig(config) != nil {
		return DefaultRecommendationConfig()
	}
	return config
}

const positiveTagMatchCountExpression = `(SELECT COUNT(DISTINCT candidate_tag.tag_id)
	FROM work_tag AS candidate_tag
	INNER JOIN tag AS candidate_tag_value ON candidate_tag_value.id = candidate_tag.tag_id
	WHERE candidate_tag.work_id = work.id
		AND candidate_tag_value.namespace = 'dlsite'
		AND EXISTS (
			SELECT 1
			FROM work_tag AS liked_tag
			INNER JOIN user_work_state AS liked_state
				ON liked_state.work_id = liked_tag.work_id AND liked_state.user_id = ?
			WHERE liked_tag.tag_id = candidate_tag.tag_id
				AND liked_tag.work_id <> work.id
				AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
		))`

const positiveVoiceMatchCountExpression = `(SELECT COUNT(DISTINCT candidate_credit.person_id)
	FROM work_credit AS candidate_credit
	WHERE candidate_credit.work_id = work.id
		AND candidate_credit.role = 'voice_actor'
		AND EXISTS (
			SELECT 1
			FROM work_credit AS liked_credit
			INNER JOIN user_work_state AS liked_state
				ON liked_state.work_id = liked_credit.work_id AND liked_state.user_id = ?
			WHERE liked_credit.person_id = candidate_credit.person_id
				AND liked_credit.role = 'voice_actor'
				AND liked_credit.work_id <> work.id
				AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
		))`

const positiveCircleMatchCountExpression = `(SELECT COUNT(DISTINCT candidate_party.party_id)
	FROM work_party AS candidate_party
	WHERE candidate_party.work_id = work.id
		AND candidate_party.role = 'circle'
		AND EXISTS (
			SELECT 1
			FROM work_party AS liked_party
			INNER JOIN user_work_state AS liked_state
				ON liked_state.work_id = liked_party.work_id AND liked_state.user_id = ?
			WHERE liked_party.party_id = candidate_party.party_id
				AND liked_party.role = 'circle'
				AND liked_party.work_id <> work.id
				AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
		))`

func negativeTagMatchCountExpression(minEvidence int) string {
	return fmt.Sprintf(`(SELECT COUNT(DISTINCT candidate_tag.tag_id)
		FROM work_tag AS candidate_tag
		INNER JOIN tag AS candidate_tag_value ON candidate_tag_value.id = candidate_tag.tag_id
		WHERE candidate_tag.work_id = work.id
			AND candidate_tag_value.namespace = 'dlsite'
			AND (SELECT COUNT(DISTINCT paused_tag.work_id)
				FROM work_tag AS paused_tag
				INNER JOIN user_work_state AS paused_state ON paused_state.work_id = paused_tag.work_id AND paused_state.user_id = ?
				WHERE paused_tag.tag_id = candidate_tag.tag_id AND paused_tag.work_id <> work.id
					AND paused_state.listening_status = 'paused' AND paused_state.favorite = 0) >= %d
			AND NOT EXISTS (
				SELECT 1 FROM work_tag AS liked_tag
				INNER JOIN user_work_state AS liked_state ON liked_state.work_id = liked_tag.work_id AND liked_state.user_id = ?
				WHERE liked_tag.tag_id = candidate_tag.tag_id AND liked_tag.work_id <> work.id
					AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
			))`, minEvidence)
}

func negativeVoiceMatchCountExpression(minEvidence int) string {
	return fmt.Sprintf(`(SELECT COUNT(DISTINCT candidate_credit.person_id)
		FROM work_credit AS candidate_credit
		WHERE candidate_credit.work_id = work.id AND candidate_credit.role = 'voice_actor'
			AND (SELECT COUNT(DISTINCT paused_credit.work_id)
				FROM work_credit AS paused_credit
				INNER JOIN user_work_state AS paused_state ON paused_state.work_id = paused_credit.work_id AND paused_state.user_id = ?
				WHERE paused_credit.person_id = candidate_credit.person_id AND paused_credit.role = 'voice_actor'
					AND paused_credit.work_id <> work.id AND paused_state.listening_status = 'paused' AND paused_state.favorite = 0) >= %d
			AND NOT EXISTS (
				SELECT 1 FROM work_credit AS liked_credit
				INNER JOIN user_work_state AS liked_state ON liked_state.work_id = liked_credit.work_id AND liked_state.user_id = ?
				WHERE liked_credit.person_id = candidate_credit.person_id AND liked_credit.role = 'voice_actor'
					AND liked_credit.work_id <> work.id
					AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
			))`, minEvidence)
}

func negativeCircleMatchCountExpression(minEvidence int) string {
	return fmt.Sprintf(`(SELECT COUNT(DISTINCT candidate_party.party_id)
		FROM work_party AS candidate_party
		WHERE candidate_party.work_id = work.id AND candidate_party.role = 'circle'
			AND (SELECT COUNT(DISTINCT paused_party.work_id)
				FROM work_party AS paused_party
				INNER JOIN user_work_state AS paused_state ON paused_state.work_id = paused_party.work_id AND paused_state.user_id = ?
				WHERE paused_party.party_id = candidate_party.party_id AND paused_party.role = 'circle'
					AND paused_party.work_id <> work.id AND paused_state.listening_status = 'paused' AND paused_state.favorite = 0) >= %d
			AND NOT EXISTS (
				SELECT 1 FROM work_party AS liked_party
				INNER JOIN user_work_state AS liked_state ON liked_state.work_id = liked_party.work_id AND liked_state.user_id = ?
				WHERE liked_party.party_id = candidate_party.party_id AND liked_party.role = 'circle'
					AND liked_party.work_id <> work.id
					AND (liked_state.listening_status IN ('finished', 'relisten') OR liked_state.favorite = 1)
			))`, minEvidence)
}

func recommendationScoreExpression(config RecommendationConfig) string {
	positiveTag := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.TagCap, positiveTagMatchCountExpression, config.TagWeight)
	positiveVoice := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.VoiceCap, positiveVoiceMatchCountExpression, config.VoiceWeight)
	positiveCircle := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.CircleCap, positiveCircleMatchCountExpression, config.CircleWeight)
	negativeTag := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.NegativeTagCap, negativeTagMatchCountExpression(config.NegativeMinEvidence), config.NegativeTagWeight)
	negativeVoice := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.NegativeVoiceCap, negativeVoiceMatchCountExpression(config.NegativeMinEvidence), config.NegativeVoiceWeight)
	negativeCircle := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.NegativeCircleCap, negativeCircleMatchCountExpression(config.NegativeMinEvidence), config.NegativeCircleWeight)
	statePrior := fmt.Sprintf(`CASE COALESCE(user_work_state.listening_status, 'none')
		WHEN 'none' THEN %d WHEN 'want_to_listen' THEN %d WHEN 'listening' THEN %d
		WHEN 'finished' THEN %d WHEN 'relisten' THEN %d WHEN 'paused' THEN %d ELSE 0 END`,
		config.NonePrior, config.WantPrior, config.ListeningPrior, config.FinishedPrior, config.RelistenPrior, config.PausedPrior)
	return fmt.Sprintf(`MAX(0, MIN(100, %s + %s + %s + %s
		+ CASE WHEN COALESCE(user_work_state.favorite, 0) = 1 THEN %d ELSE 0 END
		- MIN(%d, %s + %s + %s)))`, statePrior, positiveTag, positiveVoice, positiveCircle,
		config.FavoriteBonus, config.NegativeTotalCap, negativeTag, negativeVoice, negativeCircle)
}

func recommendationUserArgs(userID int64) []any {
	args := make([]any, recommendationScoreUserArgumentCount)
	for index := range args {
		args[index] = userID
	}
	return args
}

func (s *Store) RecommendationBreakdown(ctx context.Context, userID, workID int64) (RecommendationBreakdown, error) {
	config := s.LoadRecommendationConfig(ctx)
	if workID <= 0 {
		return buildRecommendationBreakdown(config, RecommendationSignals{ListeningStatus: "none"}), nil
	}
	query := fmt.Sprintf(`SELECT COALESCE(user_work_state.listening_status, 'none'), COALESCE(user_work_state.favorite, 0),
		%s, %s, %s, %s, %s, %s
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		WHERE work.id = ?`, positiveTagMatchCountExpression, positiveVoiceMatchCountExpression, positiveCircleMatchCountExpression,
		negativeTagMatchCountExpression(config.NegativeMinEvidence), negativeVoiceMatchCountExpression(config.NegativeMinEvidence), negativeCircleMatchCountExpression(config.NegativeMinEvidence))
	args := append(recommendationUserArgs(userID), userID, workID)
	var signals RecommendationSignals
	var favorite int
	err := s.db.QueryRowContext(ctx, query, args...).Scan(
		&signals.ListeningStatus, &favorite,
		&signals.PositiveTagMatches, &signals.PositiveVoiceMatches, &signals.PositiveCircleMatches,
		&signals.NegativeTagMatches, &signals.NegativeVoiceMatches, &signals.NegativeCircleMatches,
	)
	if err != nil {
		return RecommendationBreakdown{}, err
	}
	signals.Favorite = favorite != 0
	return buildRecommendationBreakdown(config, signals), nil
}

func (s *Store) RecommendationScore(ctx context.Context, userID, workID int64) (int, error) {
	breakdown, err := s.RecommendationBreakdown(ctx, userID, workID)
	if err != nil {
		if err == sql.ErrNoRows {
			return 0, err
		}
		return 0, err
	}
	return breakdown.Score, nil
}

func buildRecommendationBreakdown(config RecommendationConfig, signals RecommendationSignals) RecommendationBreakdown {
	state := recommendationStatePrior(config, signals.ListeningStatus)
	tags := minInt(config.TagCap, signals.PositiveTagMatches*config.TagWeight)
	voices := minInt(config.VoiceCap, signals.PositiveVoiceMatches*config.VoiceWeight)
	circles := minInt(config.CircleCap, signals.PositiveCircleMatches*config.CircleWeight)
	favorite := 0
	if signals.Favorite {
		favorite = config.FavoriteBonus
	}
	negativeTags := minInt(config.NegativeTagCap, signals.NegativeTagMatches*config.NegativeTagWeight)
	negativeVoices := minInt(config.NegativeVoiceCap, signals.NegativeVoiceMatches*config.NegativeVoiceWeight)
	negativeCircles := minInt(config.NegativeCircleCap, signals.NegativeCircleMatches*config.NegativeCircleWeight)
	negative := minInt(config.NegativeTotalCap, negativeTags+negativeVoices+negativeCircles)
	raw := state + tags + voices + circles + favorite - negative
	score := minInt(100, maxInt(0, raw))
	return RecommendationBreakdown{
		AlgorithmVersion: RecommendationAlgorithmVersion,
		Score:            score,
		RawScore:         raw,
		Signals:          signals,
		Components: []RecommendationComponent{
			{Key: "state", Label: "Listening state", MatchCount: 1, Contribution: state, Cap: 100},
			{Key: "tags", Label: "Matching tags", MatchCount: signals.PositiveTagMatches, Contribution: tags, Cap: config.TagCap},
			{Key: "voices", Label: "Matching voice actors", MatchCount: signals.PositiveVoiceMatches, Contribution: voices, Cap: config.VoiceCap},
			{Key: "circles", Label: "Matching circles", MatchCount: signals.PositiveCircleMatches, Contribution: circles, Cap: config.CircleCap},
			{Key: "favorite", Label: "Favorite", MatchCount: boolInt(signals.Favorite), Contribution: favorite, Cap: config.FavoriteBonus},
			{Key: "paused_similarity", Label: "Shelved similarity", MatchCount: signals.NegativeTagMatches + signals.NegativeVoiceMatches + signals.NegativeCircleMatches, Contribution: -negative, Cap: config.NegativeTotalCap},
		},
	}
}

func recommendationStatePrior(config RecommendationConfig, status string) int {
	switch status {
	case "none":
		return config.NonePrior
	case "want_to_listen":
		return config.WantPrior
	case "listening":
		return config.ListeningPrior
	case "finished":
		return config.FinishedPrior
	case "relisten":
		return config.RelistenPrior
	case "paused":
		return config.PausedPrior
	default:
		return 0
	}
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func boolInt(value bool) int {
	if value {
		return 1
	}
	return 0
}
