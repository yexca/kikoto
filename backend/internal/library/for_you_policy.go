package library

import (
	"math"
	"math/rand/v2"
	"sort"
	"time"
)

// For you answers "what should I play next" with small stochastic draws over
// the account's local works. It reads the same affinity profile and catalog
// features as the Library's Recommended order and adds no preference signal:
// each column is a policy over that profile, the works' listening history, and
// one temperature.

const ForYouAlgorithmVersion = "for-you-v1"

// ForYouDrawSize is how many works one column draw holds.
const ForYouDrawSize = 10

type ForYouColumn string

const (
	ForYouMaybeLike   ForYouColumn = "maybe_like"
	ForYouTryNew      ForYouColumn = "try_new"
	ForYouListenAgain ForYouColumn = "listen_again"
)

// ForYouColumns is the order of the columns, which also breaks assignment ties.
var ForYouColumns = []ForYouColumn{ForYouMaybeLike, ForYouTryNew, ForYouListenAgain}

func ParseForYouColumn(value string) (ForYouColumn, bool) {
	for _, column := range ForYouColumns {
		if string(column) == value {
			return column, true
		}
	}
	return "", false
}

type ForYouTemperature string

const (
	ForYouSafe        ForYouTemperature = "safe"
	ForYouBalanced    ForYouTemperature = "balanced"
	ForYouAdventurous ForYouTemperature = "adventurous"
)

const DefaultForYouTemperature = ForYouBalanced

func ParseForYouTemperature(value string) (ForYouTemperature, bool) {
	switch ForYouTemperature(value) {
	case ForYouSafe, ForYouBalanced, ForYouAdventurous:
		return ForYouTemperature(value), true
	}
	return "", false
}

// forYouTemperatureSettings is how every column reads one temperature step.
// Softness is T in P ∝ exp(score/T), in score points; window is the candidate
// set as a multiple of the draw size, and 0 keeps every candidate. Try new aims
// at a novelty level instead of the most novel works, and Listen again admits
// more kinds of history as the temperature rises.
type forYouTemperatureSettings struct {
	softness      float64
	window        int
	noveltyTarget float64
	listenTier    int
}

func (t ForYouTemperature) settings() forYouTemperatureSettings {
	switch t {
	case ForYouSafe:
		return forYouTemperatureSettings{softness: 5, window: 2, noveltyTarget: 0.55, listenTier: 0}
	case ForYouAdventurous:
		return forYouTemperatureSettings{softness: 20, window: 0, noveltyTarget: 1, listenTier: 2}
	default:
		return forYouTemperatureSettings{softness: 10, window: 4, noveltyTarget: 0.75, listenTier: 1}
	}
}

const (
	// A work shown in a For you draw and neither opened nor played since loses
	// this many score points per showing, up to forYouRotationLimit showings.
	forYouRotationPenalty = 15
	forYouRotationLimit   = 3
	// A work that is not finished and was played this recently is still being
	// listened to; Library's Continue listening offers it.
	forYouCurrentDays = 14
	// Days since the last play at which Listen again reaches 63% of a work's
	// liking; the factor approaches 1 over the following months.
	forYouListenAgainDays = 45
	// Try new never offers a work whose features are mostly familiar.
	forYouNoveltyFloor = 0.3
)

// ForYouReason is the short explanation a card shows. Kind names the reason;
// the other fields are the facts the sentence uses.
type ForYouReason struct {
	Kind         string  `json:"kind"`
	Name         string  `json:"name,omitempty"`
	Days         int     `json:"days,omitempty"`
	Rating       int     `json:"rating,omitempty"`
	Favorite     bool    `json:"favorite,omitempty"`
	DLsiteRating float64 `json:"dlsiteRating,omitempty"`
	// feature is the tag, voice, or circle whose display name becomes Name.
	feature *recommendationFeature
}

// forYouHistory is one work's playback history for the account.
type forYouHistory struct {
	LastPlayed      time.Time
	Completed       bool
	ListenedSeconds float64
	ListenDays      int
}

func (history forYouHistory) played() bool {
	return !history.LastPlayed.IsZero() || history.ListenedSeconds > 0
}

type forYouCandidate struct {
	WorkID        int64
	State         recommendationFrozenState
	Features      []recommendationFeature
	History       forYouHistory
	RatingAverage float64
	Sales         int
	// Unopened counts recent For you showings not followed by an open or play.
	Unopened int
}

type forYouScored struct {
	candidate *forYouCandidate
	score     float64
	reason    ForYouReason
}

func (candidate *forYouCandidate) disliked() bool {
	return candidate.State.Rating == 1 || candidate.State.Rating == 2
}

// forYouUnheard is the pool Maybe like and Try new share: Unmarked or Want
// works without playback history.
func (candidate *forYouCandidate) unheard() bool {
	status := candidate.State.ListeningStatus
	return (status == "" || status == "none" || status == "want_to_listen") && !candidate.History.played() && !candidate.disliked()
}

// forYouMaybeLike ranks an unheard work by its affinity score. Without any
// feedback every work has the same affinity, so DLsite rating and popularity
// rank them instead.
func forYouMaybeLike(candidate *forYouCandidate, profile RecommendationProfile, config RecommendationConfig, coldStart bool) (forYouScored, bool) {
	if !candidate.unheard() {
		return forYouScored{}, false
	}
	if coldStart {
		return forYouScored{candidate: candidate, score: forYouPopularity(candidate), reason: forYouPopularReason(candidate)}, true
	}
	signals := profile.workSignals(candidate.Features, candidate.State, config)
	breakdown := buildRecommendationBreakdown(config, signals)
	reason, matched := forYouAffinityReason(candidate, profile, config)
	if !matched {
		switch {
		case candidate.State.ListeningStatus == "want_to_listen":
			reason = ForYouReason{Kind: "want"}
		case candidate.RatingAverage > 0:
			reason = ForYouReason{Kind: "dlsite_rating", DLsiteRating: candidate.RatingAverage}
		default:
			reason = ForYouReason{Kind: "unexplored"}
		}
	}
	return forYouScored{candidate: candidate, score: float64(breakdown.Score), reason: reason}, true
}

// forYouPopularity scores a work from 0 to 100: up to 70 for its DLsite
// rating and up to 30 for its sales, which count logarithmically.
func forYouPopularity(candidate *forYouCandidate) float64 {
	rating := min(5, max(0, candidate.RatingAverage)) / 5 * 70
	sales := min(30, math.Log10(float64(max(0, candidate.Sales))+1)*7.5)
	return rating + sales
}

func forYouPopularReason(candidate *forYouCandidate) ForYouReason {
	if candidate.RatingAverage > 0 {
		return ForYouReason{Kind: "popular", DLsiteRating: candidate.RatingAverage}
	}
	return ForYouReason{Kind: "unexplored"}
}

// forYouAffinityReason names the feature that adds the most affinity, with
// the same evidence, specificity, and weights as the score.
func forYouAffinityReason(candidate *forYouCandidate, profile RecommendationProfile, config RecommendationConfig) (ForYouReason, bool) {
	self := recommendationFeedbackFor(candidate.State, config)
	best, bestContribution := -1, 0.0
	for index, f := range candidate.Features {
		evidence := profile.Entities[f.key()].without(self)
		positive, _ := evidence.affinity(config)
		weight := config.TagWeight
		switch f.Kind {
		case "tag":
			positive *= evidence.Specificity
		case "voice":
			weight = config.VoiceWeight
		case "circle":
			weight = config.CircleWeight
		}
		if contribution := positive * float64(weight); contribution > bestContribution {
			best, bestContribution = index, contribution
		}
	}
	if best < 0 {
		return ForYouReason{}, false
	}
	f := candidate.Features[best]
	return ForYouReason{Kind: "liked_" + f.Kind, feature: &f}, true
}

// forYouNovelty is how far a work is from what the account has heard, from 0
// for entirely familiar features to 1 for entirely new ones. Each feature's
// novelty is 1/(1+exposure); circles, voices, and tags are averaged within
// their kind and then weighted across the kinds the work has.
func forYouNovelty(workID int64, features []recommendationFeature, exposure map[string]int) (float64, int) {
	weights := map[string]float64{"circle": 0.4, "voice": 0.35, "tag": 0.25}
	sums, counts := map[string]float64{}, map[string]int{}
	novelties := make([]float64, len(features))
	bestNovelty := -1.0
	for index, f := range features {
		weight, known := weights[f.Kind]
		if !known || weight == 0 {
			novelties[index] = -1
			continue
		}
		novelty := 1 / (1 + float64(exposure[f.key()]))
		novelties[index] = novelty
		sums[f.Kind] += novelty
		counts[f.Kind]++
		bestNovelty = max(bestNovelty, novelty)
	}
	// The reason names one of the most novel features. Which one varies by
	// work, so a column of unheard circles also names new voices and tags.
	tied := []int{}
	for index, novelty := range novelties {
		if novelty == bestNovelty && novelty >= 0 {
			tied = append(tied, index)
		}
	}
	best := -1
	if len(tied) > 0 {
		best = tied[int(workID%int64(len(tied)))]
	}
	total, weightSum := 0.0, 0.0
	for kind, count := range counts {
		total += weights[kind] * sums[kind] / float64(count)
		weightSum += weights[kind]
	}
	if weightSum == 0 {
		return 0, -1
	}
	return total / weightSum, best
}

// forYouTryNew offers an unheard work with little exposure and no disliked
// similarity. The temperature sets the novelty it aims at: Safe stays near the
// listened profile, Adventurous goes as far from it as the library allows.
func forYouTryNew(candidate *forYouCandidate, profile RecommendationProfile, config RecommendationConfig, exposure map[string]int, temperature forYouTemperatureSettings) (forYouScored, bool) {
	if !candidate.unheard() {
		return forYouScored{}, false
	}
	signals := profile.workSignals(candidate.Features, candidate.State, config)
	if signals.NegativeTagMatches+signals.NegativeVoiceMatches+signals.NegativeCircleMatches > 0 {
		return forYouScored{}, false
	}
	novelty, best := forYouNovelty(candidate.WorkID, candidate.Features, exposure)
	if best < 0 || novelty < forYouNoveltyFloor {
		return forYouScored{}, false
	}
	f := candidate.Features[best]
	kind := "new_" + f.Kind
	if f.Kind == "tag" {
		kind = "rare_tag"
	}
	score := 100 * (1 - math.Abs(novelty-temperature.noveltyTarget))
	return forYouScored{candidate: candidate, score: score, reason: ForYouReason{Kind: kind, feature: &f}}, true
}

// forYouListenAgain offers a work with playback history that the account is
// not listening to now. The score is how much the account likes the work
// times how long ago it was last played. Safe offers finished works heard
// more than once or rated well, Balanced adds finished works heard once, and
// Adventurous adds works left half-finished.
func forYouListenAgain(candidate *forYouCandidate, now time.Time, temperature forYouTemperatureSettings) (forYouScored, bool) {
	history := candidate.History
	if !history.played() || candidate.disliked() {
		return forYouScored{}, false
	}
	days := 365.0
	if !history.LastPlayed.IsZero() {
		days = max(0, now.Sub(history.LastPlayed).Hours()/24)
	}
	state := candidate.State
	completed := history.Completed || state.ListeningStatus == "finished" || state.ListeningStatus == "relisten"
	if state.ListeningStatus == "listening" || !completed && days < forYouCurrentDays {
		return forYouScored{}, false
	}
	liked := state.Rating >= 4 || state.Favorite || state.ListeningStatus == "relisten"
	tier := 0
	switch {
	case !completed:
		tier = 2
	case history.ListenDays <= 1 && !liked:
		tier = 1
	}
	if tier > temperature.listenTier {
		return forYouScored{}, false
	}
	liking := forYouLiking(state)
	// Listening time adds up to a quarter: two hours add 0.16, eight hours 0.25.
	hours := history.ListenedSeconds / 3600
	liking = min(1, liking+min(0.25, 0.1*math.Log2(1+hours)))
	recency := 1 - math.Exp(-days/forYouListenAgainDays)
	reason := ForYouReason{Kind: "since_played", Days: int(days), Rating: state.Rating, Favorite: state.Favorite}
	if !completed {
		reason = ForYouReason{Kind: "unfinished", Days: int(days)}
	}
	return forYouScored{candidate: candidate, score: 100 * liking * recency, reason: reason}, true
}

// forYouLiking is how much the account's marks say it likes a work, from 0 to
// 1, rating first as the affinity profile reads them.
func forYouLiking(state recommendationFrozenState) float64 {
	switch state.Rating {
	case 5:
		return 1
	case 4:
		return 0.8
	case 3:
		return 0.5
	}
	switch {
	case state.Favorite, state.ListeningStatus == "relisten":
		return 0.85
	case state.ListeningStatus == "finished":
		return 0.6
	}
	return 0.45
}

// forYouSample orders a column's candidates for one draw. Recent unopened
// showings lower a score first; the window then keeps the best candidates and
// Gumbel keys over score/T order them, which draws without replacement with
// P ∝ exp(score/T).
func forYouSample(pool []forYouScored, temperature forYouTemperatureSettings, rng *rand.Rand) []forYouScored {
	adjusted := make([]forYouScored, len(pool))
	for index, item := range pool {
		item.score -= float64(forYouRotationPenalty * min(forYouRotationLimit, item.candidate.Unopened))
		adjusted[index] = item
	}
	sort.SliceStable(adjusted, func(i, j int) bool {
		if adjusted[i].score != adjusted[j].score {
			return adjusted[i].score > adjusted[j].score
		}
		return adjusted[i].candidate.WorkID < adjusted[j].candidate.WorkID
	})
	if temperature.window > 0 {
		adjusted = adjusted[:min(len(adjusted), temperature.window*ForYouDrawSize)]
	}
	keys := make(map[int64]float64, len(adjusted))
	for _, item := range adjusted {
		uniform := max(rng.Float64(), math.SmallestNonzeroFloat64)
		keys[item.candidate.WorkID] = item.score/temperature.softness - math.Log(-math.Log(uniform))
	}
	sort.SliceStable(adjusted, func(i, j int) bool {
		return keys[adjusted[i].candidate.WorkID] > keys[adjusted[j].candidate.WorkID]
	})
	return adjusted
}

// forYouPercentiles places each pool's works by score within the pool, so
// columns with different score scales can be compared.
func forYouPercentiles(pool []forYouScored) map[int64]float64 {
	result := make(map[int64]float64, len(pool))
	if len(pool) == 0 {
		return result
	}
	scores := make([]float64, len(pool))
	for index, item := range pool {
		scores[index] = item.score
	}
	sort.Float64s(scores)
	for _, item := range pool {
		below := sort.SearchFloat64s(scores, item.score)
		result[item.candidate.WorkID] = float64(below) / float64(len(pool))
	}
	return result
}

// forYouAssemble draws each requested column from its pool and keeps a work in
// one column only: the column where it places highest among that column's
// candidates. The column that gives a work up refills from its own order.
func forYouAssemble(pools map[ForYouColumn][]forYouScored, columns []ForYouColumn, exclude map[int64]bool, temperature forYouTemperatureSettings, rng *rand.Rand) map[ForYouColumn][]forYouScored {
	orders := map[ForYouColumn][]forYouScored{}
	percentiles := map[ForYouColumn]map[int64]float64{}
	for _, column := range columns {
		available := make([]forYouScored, 0, len(pools[column]))
		for _, item := range pools[column] {
			if !exclude[item.candidate.WorkID] {
				available = append(available, item)
			}
		}
		percentiles[column] = forYouPercentiles(pools[column])
		orders[column] = forYouSample(available, temperature, rng)
	}
	owner := map[int64]ForYouColumn{}
	for _, column := range columns {
		for _, item := range orders[column][:min(ForYouDrawSize, len(orders[column]))] {
			id := item.candidate.WorkID
			current, claimed := owner[id]
			if !claimed || percentiles[column][id] > percentiles[current][id] {
				owner[id] = column
			}
		}
	}
	result := map[ForYouColumn][]forYouScored{}
	taken := map[int64]bool{}
	for id := range owner {
		taken[id] = true
	}
	for _, column := range columns {
		picks := []forYouScored{}
		for _, item := range orders[column] {
			if len(picks) == ForYouDrawSize {
				break
			}
			id := item.candidate.WorkID
			if owned, claimed := owner[id]; claimed && owned == column || !taken[id] {
				picks = append(picks, item)
				taken[id] = true
				owner[id] = column
			}
		}
		result[column] = picks
	}
	return result
}
