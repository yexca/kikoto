package library

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

const RecommendationAlgorithmVersion = "heuristic-v4"

const recommendationScoreUserArgumentCount = 9

type RecommendationConfig struct {
	AffinityBase         int `json:"affinityBase"`
	UnmarkedSlots        int `json:"unmarkedSlots"`
	WantSlots            int `json:"wantSlots"`
	ListeningSlots       int `json:"listeningSlots"`
	FinishedSlots        int `json:"finishedSlots"`
	RelistenSlots        int `json:"relistenSlots"`
	ShelvedSlots         int `json:"shelvedSlots"`
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
	ExplorationAmplitude int `json:"explorationAmplitude"`
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

// RecommendationOrdering describes the seed-derived adjustment applied after
// affinity scoring while works are ordered within one recommendation lane.
type RecommendationOrdering struct {
	Seed             int64   `json:"seed"`
	ExplorationBoost float64 `json:"explorationBoost"`
	Jitter           float64 `json:"jitter"`
	TotalAdjustment  float64 `json:"totalAdjustment"`
	RankingScore     float64 `json:"rankingScore"`
}

type RecommendationBreakdown struct {
	AlgorithmVersion string                    `json:"algorithmVersion"`
	Lane             string                    `json:"lane"`
	Score            int                       `json:"score"`
	RawScore         int                       `json:"rawScore"`
	Signals          RecommendationSignals     `json:"signals"`
	Components       []RecommendationComponent `json:"components"`
	Ordering         *RecommendationOrdering   `json:"ordering,omitempty"`
}

func DefaultRecommendationConfig() RecommendationConfig {
	return RecommendationConfig{
		AffinityBase: 35, UnmarkedSlots: 12, WantSlots: 4, ListeningSlots: 4, FinishedSlots: 2, RelistenSlots: 2, ShelvedSlots: 0,
		TagWeight: 5, TagCap: 25, VoiceWeight: 10, VoiceCap: 20, CircleWeight: 15, CircleCap: 15, FavoriteBonus: 10,
		NegativeMinEvidence: 2, NegativeTagWeight: 2, NegativeTagCap: 6, NegativeVoiceWeight: 3, NegativeVoiceCap: 6,
		NegativeCircleWeight: 5, NegativeCircleCap: 5, NegativeTotalCap: 15, JitterAmplitude: 3, ExplorationAmplitude: 18,
	}
}

func ValidateRecommendationConfig(config RecommendationConfig) error {
	if config.AffinityBase < 0 || config.AffinityBase > 100 {
		return fmt.Errorf("affinityBase must be between 0 and 100")
	}
	slots := []int{config.UnmarkedSlots, config.WantSlots, config.ListeningSlots, config.FinishedSlots, config.RelistenSlots, config.ShelvedSlots}
	totalSlots := 0
	for _, value := range slots {
		if value < 0 || value > 100 {
			return fmt.Errorf("recommendation lane slots must be between 0 and 100")
		}
		totalSlots += value
	}
	if config.UnmarkedSlots == 0 {
		return fmt.Errorf("unmarkedSlots must be at least 1")
	}
	if totalSlots < 1 || totalSlots > 100 {
		return fmt.Errorf("recommendation lane slots must total between 1 and 100")
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
	if config.ExplorationAmplitude < 0 || config.ExplorationAmplitude > 40 {
		return fmt.Errorf("explorationAmplitude must be between 0 and 40")
	}
	return nil
}

func (s *Store) LoadRecommendationConfig(ctx context.Context) RecommendationConfig {
	return loadRecommendationConfig(ctx, s.db)
}

type recommendationConfigQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadRecommendationConfig(ctx context.Context, queryer recommendationConfigQueryer) RecommendationConfig {
	var raw string
	if err := queryer.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = 'recommendation_config'").Scan(&raw); err != nil {
		return DefaultRecommendationConfig()
	}
	config, err := decodeRecommendationConfig(raw)
	if err != nil {
		return DefaultRecommendationConfig()
	}
	return config
}

func decodeRecommendationConfig(raw string) (RecommendationConfig, error) {
	config := DefaultRecommendationConfig()
	if err := json.Unmarshal([]byte(raw), &config); err != nil {
		return RecommendationConfig{}, err
	}
	var legacy struct {
		AffinityBase *int `json:"affinityBase"`
		NonePrior    *int `json:"nonePrior"`
	}
	if err := json.Unmarshal([]byte(raw), &legacy); err == nil && legacy.AffinityBase == nil && legacy.NonePrior != nil && *legacy.NonePrior >= 0 && *legacy.NonePrior <= 100 {
		config.AffinityBase = *legacy.NonePrior
	}
	if err := ValidateRecommendationConfig(config); err != nil {
		return RecommendationConfig{}, err
	}
	return config, nil
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
				AND (liked_state.listening_status = 'relisten' OR liked_state.favorite = 1)
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
				AND (liked_state.listening_status = 'relisten' OR liked_state.favorite = 1)
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
				AND (liked_state.listening_status = 'relisten' OR liked_state.favorite = 1)
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
					AND (liked_state.listening_status = 'relisten' OR liked_state.favorite = 1)
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
					AND (liked_state.listening_status = 'relisten' OR liked_state.favorite = 1)
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
					AND (liked_state.listening_status = 'relisten' OR liked_state.favorite = 1)
			))`, minEvidence)
}

func recommendationScoreExpression(config RecommendationConfig) string {
	return recommendationScoreFromSignalExpressions(
		config,
		"COALESCE(user_work_state.favorite, 0)",
		positiveTagMatchCountExpression,
		positiveVoiceMatchCountExpression,
		positiveCircleMatchCountExpression,
		negativeTagMatchCountExpression(config.NegativeMinEvidence),
		negativeVoiceMatchCountExpression(config.NegativeMinEvidence),
		negativeCircleMatchCountExpression(config.NegativeMinEvidence),
	)
}

func recommendationScoreFromSignalExpressions(
	config RecommendationConfig,
	favoriteExpression string,
	positiveTagExpression string,
	positiveVoiceExpression string,
	positiveCircleExpression string,
	negativeTagExpression string,
	negativeVoiceExpression string,
	negativeCircleExpression string,
) string {
	positiveTag := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.TagCap, positiveTagExpression, config.TagWeight)
	positiveVoice := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.VoiceCap, positiveVoiceExpression, config.VoiceWeight)
	positiveCircle := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.CircleCap, positiveCircleExpression, config.CircleWeight)
	negativeTag := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.NegativeTagCap, negativeTagExpression, config.NegativeTagWeight)
	negativeVoice := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.NegativeVoiceCap, negativeVoiceExpression, config.NegativeVoiceWeight)
	negativeCircle := fmt.Sprintf("MIN(%d, COALESCE(%s, 0) * %d)", config.NegativeCircleCap, negativeCircleExpression, config.NegativeCircleWeight)
	return fmt.Sprintf(`MAX(0, MIN(100, %d + %s + %s + %s
		+ CASE WHEN COALESCE(%s, 0) = 1 THEN %d ELSE 0 END
		- MIN(%d, %s + %s + %s)))`, config.AffinityBase, positiveTag, positiveVoice, positiveCircle,
		favoriteExpression, config.FavoriteBonus, config.NegativeTotalCap, negativeTag, negativeVoice, negativeCircle)
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
	return s.RecommendationBreakdownWithConfig(ctx, userID, workID, config)
}

// RecommendationBreakdownWithConfig calculates a breakdown using a supplied
// configuration. Callers that hold an immutable recommendation session use
// this shape so the explanation and its ordering refer to the same settings.
func (s *Store) RecommendationBreakdownWithConfig(ctx context.Context, userID, workID int64, config RecommendationConfig) (RecommendationBreakdown, error) {
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
	raw := config.AffinityBase + tags + voices + circles + favorite - negative
	score := minInt(100, maxInt(0, raw))
	return RecommendationBreakdown{
		AlgorithmVersion: RecommendationAlgorithmVersion,
		Lane:             recommendationLane(signals.ListeningStatus),
		Score:            score,
		RawScore:         raw,
		Signals:          signals,
		Components: []RecommendationComponent{
			{Key: "base", Label: "Affinity baseline", MatchCount: 0, Contribution: config.AffinityBase, Cap: 100},
			{Key: "tags", Label: "Matching tags", MatchCount: signals.PositiveTagMatches, Contribution: tags, Cap: config.TagCap},
			{Key: "voices", Label: "Matching voice actors", MatchCount: signals.PositiveVoiceMatches, Contribution: voices, Cap: config.VoiceCap},
			{Key: "circles", Label: "Matching circles", MatchCount: signals.PositiveCircleMatches, Contribution: circles, Cap: config.CircleCap},
			{Key: "favorite", Label: "Favorite", MatchCount: boolInt(signals.Favorite), Contribution: favorite, Cap: config.FavoriteBonus},
			{Key: "paused_similarity", Label: "Shelved similarity", MatchCount: signals.NegativeTagMatches + signals.NegativeVoiceMatches + signals.NegativeCircleMatches, Contribution: -negative, Cap: config.NegativeTotalCap},
		},
	}
}

func recommendationLane(status string) string {
	switch status {
	case "none":
		return "unmarked"
	case "want_to_listen":
		return "want"
	case "listening":
		return "listening"
	case "finished":
		return "finished"
	case "relisten":
		return "relisten"
	case "paused":
		return "shelved"
	default:
		return "unmarked"
	}
}

const recommendationHashModulus int64 = 2147483647

func recommendationSeededHashParameters(randomSeed int64) (multiplier, offset int64) {
	seed := randomSeed % recommendationHashModulus
	if seed < 0 {
		seed = -seed
	}
	multiplier = (seed*1103515245 + 12345) % recommendationHashModulus
	if multiplier == 0 {
		multiplier = 1
	}
	offset = (seed * 12345) % recommendationHashModulus
	return multiplier, offset
}

// recommendationSeededHash mirrors seededHashExpression. Reducing the work id
// before multiplication keeps both the Go and SQLite calculations within their
// signed integer range without changing the modulo result.
func recommendationSeededHash(workID, randomSeed int64) int64 {
	multiplier, offset := recommendationSeededHashParameters(randomSeed)
	workID %= recommendationHashModulus
	return (workID*multiplier + offset) % recommendationHashModulus
}

// RecommendationOrderingFor returns the deterministic ordering adjustment for
// one work and a particular browse seed. Affinity remains an integer score for
// badges and telemetry; RankingScore is only for the current lane ordering.
func RecommendationOrderingFor(workID int64, affinityScore int, randomSeed int64, config RecommendationConfig) RecommendationOrdering {
	hash := recommendationSeededHash(workID, randomSeed)
	proportion := float64(hash) / float64(recommendationHashModulus)
	explorationBoost := proportion * float64(config.ExplorationAmplitude)
	jitter := (proportion*2.0 - 1.0) * float64(config.JitterAmplitude)
	totalAdjustment := explorationBoost + jitter
	return RecommendationOrdering{
		Seed:             randomSeed,
		ExplorationBoost: explorationBoost,
		Jitter:           jitter,
		TotalAdjustment:  totalAdjustment,
		RankingScore:     float64(affinityScore) + totalAdjustment,
	}
}

type recommendationMixLane struct {
	status   string
	slots    int
	earliest int
	priority int
}

// recommendationSlotOffsets builds one deterministic mix cycle. Listening and
// Want reserve the leading positions, then proportional deficit scheduling
// spreads the remaining states without allowing affinity to change the mix.
func recommendationSlotOffsets(config RecommendationConfig) (int, map[string][]int) {
	total := config.UnmarkedSlots + config.WantSlots + config.ListeningSlots + config.FinishedSlots + config.RelistenSlots + config.ShelvedSlots
	if total <= 0 {
		config = DefaultRecommendationConfig()
		total = config.UnmarkedSlots + config.WantSlots + config.ListeningSlots + config.FinishedSlots + config.RelistenSlots + config.ShelvedSlots
	}
	relistenEarliest := maxInt(5, total/4+1)
	finishedEarliest := maxInt(relistenEarliest+2, total/2-1)
	shelvedEarliest := maxInt(finishedEarliest+2, (total*3)/4)
	lanes := []recommendationMixLane{
		{status: "listening", slots: config.ListeningSlots, earliest: 1, priority: 0},
		{status: "want_to_listen", slots: config.WantSlots, earliest: 1, priority: 1},
		{status: "none", slots: config.UnmarkedSlots, earliest: 1, priority: 2},
		{status: "relisten", slots: config.RelistenSlots, earliest: minInt(total, relistenEarliest), priority: 3},
		{status: "finished", slots: config.FinishedSlots, earliest: minInt(total, finishedEarliest), priority: 4},
		{status: "paused", slots: config.ShelvedSlots, earliest: minInt(total, shelvedEarliest), priority: 5},
	}
	used := make(map[string]int, len(lanes))
	sequence := make([]string, 0, total)
	appendReserved := func(status string) {
		for _, lane := range lanes {
			if lane.status == status && lane.slots > used[status] {
				sequence = append(sequence, status)
				used[status]++
				return
			}
		}
	}
	appendReserved("listening")
	appendReserved("want_to_listen")
	for len(sequence) < total {
		position := len(sequence) + 1
		best := -1
		bestDeficit := 0
		for index, lane := range lanes {
			if lane.slots <= used[lane.status] || position < lane.earliest {
				continue
			}
			deficit := lane.slots*position - used[lane.status]*total
			if best < 0 || deficit > bestDeficit || (deficit == bestDeficit && lane.priority < lanes[best].priority) {
				best = index
				bestDeficit = deficit
			}
		}
		if best < 0 {
			for index, lane := range lanes {
				if lane.slots > used[lane.status] && (best < 0 || lane.earliest < lanes[best].earliest || (lane.earliest == lanes[best].earliest && lane.priority < lanes[best].priority)) {
					best = index
				}
			}
		}
		if best < 0 {
			break
		}
		status := lanes[best].status
		sequence = append(sequence, status)
		used[status]++
	}
	offsets := make(map[string][]int, len(lanes))
	for index, status := range sequence {
		offsets[status] = append(offsets[status], index+1)
	}
	return total, offsets
}

func recommendationLanePositionExpression(config RecommendationConfig, statusExpression string, rankExpression string) string {
	cycleSize, offsets := recommendationSlotOffsets(config)
	lanePosition := func(status string) string {
		positions := offsets[status]
		if len(positions) == 0 {
			return rankExpression
		}
		cases := make([]string, 0, len(positions))
		for index, position := range positions {
			cases = append(cases, fmt.Sprintf("WHEN %d THEN %d", index, position))
		}
		return fmt.Sprintf("(CAST((%s - 1) / %d AS INTEGER) * %d + CASE ((%s - 1) %% %d) %s END)",
			rankExpression, len(positions), cycleSize, rankExpression, len(positions), strings.Join(cases, " "))
	}
	return fmt.Sprintf(`CASE COALESCE(%s, 'none')
		WHEN 'listening' THEN %s
		WHEN 'want_to_listen' THEN %s
		WHEN 'relisten' THEN %s
		WHEN 'finished' THEN %s
		WHEN 'paused' THEN %s
		ELSE %s END`, statusExpression, lanePosition("listening"), lanePosition("want_to_listen"),
		lanePosition("relisten"), lanePosition("finished"), lanePosition("paused"), lanePosition("none"))
}

func recommendationLaneSuppressedExpression(config RecommendationConfig, statusExpression string) string {
	slotCount := func(status string) int {
		switch status {
		case "listening":
			return config.ListeningSlots
		case "want_to_listen":
			return config.WantSlots
		case "relisten":
			return config.RelistenSlots
		case "finished":
			return config.FinishedSlots
		case "paused":
			return config.ShelvedSlots
		default:
			return config.UnmarkedSlots
		}
	}
	value := func(status string) int {
		if slotCount(status) == 0 {
			return 1
		}
		return 0
	}
	return fmt.Sprintf(`CASE COALESCE(%s, 'none')
		WHEN 'listening' THEN %d
		WHEN 'want_to_listen' THEN %d
		WHEN 'relisten' THEN %d
		WHEN 'finished' THEN %d
		WHEN 'paused' THEN %d
		ELSE %d END`, statusExpression, value("listening"), value("want_to_listen"), value("relisten"),
		value("finished"), value("paused"), value("none"))
}

func recommendationListSelectSQL(baseSelect string, direction string, randomSeed int64, config RecommendationConfig) string {
	_, direction = normalizeSort("recommend", direction)
	withinLane := recommendationExplorationOrderBy("id", direction, randomSeed, config.JitterAmplitude, config.ExplorationAmplitude)
	position := recommendationLanePositionExpression(config, "recommendation_lane", "recommendation_lane_rank")
	suppressed := recommendationLaneSuppressedExpression(config, "recommendation_lane")
	return `WITH recommendation_candidates AS (` + baseSelect + `),
	recommendation_ranked AS (
		SELECT recommendation_candidates.*,
			ROW_NUMBER() OVER (PARTITION BY recommendation_lane ORDER BY ` + withinLane + `) AS recommendation_lane_rank
		FROM recommendation_candidates
	),
	recommendation_positioned AS (
		SELECT recommendation_ranked.*,
			` + suppressed + ` AS recommendation_suppressed,
			` + position + ` AS recommendation_position
		FROM recommendation_ranked
	)
	SELECT id, primary_code, title, age_rating, rating_average, sales_count, regular_price, current_price, price_currency, is_permanently_free,
		created_at, track_count, available_locations, available_location_types, source_presence, snapshot_json, party_link,
		listening_status, favorite, recommend_score
	FROM recommendation_positioned
	ORDER BY recommendation_suppressed ASC, recommendation_position ASC, id ASC`
}

// recommendationExplorationOrderBy preserves the stored affinity score while
// giving each candidate a deterministic, seed-specific discovery boost. A new
// seed therefore surfaces different plausible works without breaking stable
// pagination for the current browse session.
func recommendationExplorationOrderBy(idExpression string, direction string, randomSeed int64, jitterAmplitude int, explorationAmplitude int) string {
	hash := seededHashExpression(idExpression, randomSeed)
	exploration := "0"
	if explorationAmplitude > 0 {
		exploration = fmt.Sprintf("((%s / 2147483647.0) * %d)", hash, explorationAmplitude)
	}
	jitter := "0"
	if jitterAmplitude > 0 {
		jitter = fmt.Sprintf("(((%s / 2147483647.0) * 2.0 - 1.0) * %d)", hash, jitterAmplitude)
	}
	return fmt.Sprintf("(recommend_score + %s + %s) %s, %s ASC, %s ASC", exploration, jitter, direction, hash, idExpression)
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
