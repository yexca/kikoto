package library

// Evidence is measured in hundredths of one favorite work. It grows linearly to
// one favorite, then saturates at the strength of five favorites. Common tags
// retain half their weight at minimum, so a small library never loses all of
// its taste signals.
func recommendationEvidenceStrength(units int) float64 {
	if units <= 0 {
		return 0
	}
	if units < recommendationFavoriteEvidence {
		return float64(units) / recommendationFavoriteEvidence
	}
	return min(2, 0.75+0.25*float64(units)/recommendationFavoriteEvidence)
}

// recommendationFavoriteEvidence is the evidence one unrated favorite work
// supplies; the configured feedback weights are percentages of it.
const recommendationFavoriteEvidence = 100

func recommendationTagSpecificity(frequency, total int) float64 {
	return 1 - 0.5*float64(frequency)/float64(maxInt(1, total))
}

// recommendationFeedback is what one work's personal state says about taste.
// Disliked and Shelved mark which negative evidence it is, because a shelved
// mark only counts once enough shelved works agree.
type recommendationFeedback struct {
	Positive int
	Negative int
	Disliked bool
	Shelved  bool
}

// recommendationFeedbackFor applies the rating-first policy: a rating from one
// to five stars is the whole statement about a work. Without one, Favorite,
// then Relisten, then Shelved stand in for it.
func recommendationFeedbackFor(state recommendationFrozenState, config RecommendationConfig) recommendationFeedback {
	switch state.Rating {
	case 5:
		return recommendationFeedback{Positive: config.RatingFiveWeight}
	case 4:
		return recommendationFeedback{Positive: config.RatingFourWeight}
	case 3:
		return recommendationFeedback{}
	case 2:
		return recommendationFeedback{Negative: config.RatingTwoWeight, Disliked: true}
	case 1:
		return recommendationFeedback{Negative: config.RatingOneWeight, Disliked: true}
	}
	switch {
	case state.Favorite:
		return recommendationFeedback{Positive: recommendationFavoriteEvidence}
	case state.ListeningStatus == "relisten":
		return recommendationFeedback{Positive: config.RelistenWeight}
	case state.ListeningStatus == "paused":
		return recommendationFeedback{Negative: config.ShelvedWeight, Shelved: true}
	}
	return recommendationFeedback{}
}

func (feedback recommendationFeedback) informative() bool {
	return feedback.Positive > 0 || feedback.Negative > 0 || feedback.Disliked || feedback.Shelved
}

// add records one feedback work as evidence for an entity it carries.
func (entity *recommendationProfileEntity) add(feedback recommendationFeedback) {
	entity.Positive += feedback.Positive
	entity.Negative += feedback.Negative
	if feedback.Disliked {
		entity.Disliked++
	}
	if feedback.Shelved {
		entity.Shelved++
	}
}

// without removes a work's own feedback, so a work never recommends itself.
func (entity recommendationProfileEntity) without(feedback recommendationFeedback) recommendationProfileEntity {
	entity.Positive = max(0, entity.Positive-feedback.Positive)
	entity.Negative = max(0, entity.Negative-feedback.Negative)
	if feedback.Disliked {
		entity.Disliked = max(0, entity.Disliked-1)
	}
	if feedback.Shelved {
		entity.Shelved = max(0, entity.Shelved-1)
	}
	return entity
}

// affinity nets an entity's evidence. Positive evidence that outweighs the
// negative is a match; negative evidence that outweighs the positive is a
// deduction once one disliked work or enough shelved works support it.
func (entity recommendationProfileEntity) affinity(config RecommendationConfig) (positive, negative float64) {
	net := entity.Positive - entity.Negative
	if net > 0 {
		return recommendationEvidenceStrength(net), 0
	}
	if net < 0 && (entity.Disliked > 0 || entity.Shelved >= config.NegativeMinEvidence) {
		return 0, recommendationEvidenceStrength(-net)
	}
	return 0, 0
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
