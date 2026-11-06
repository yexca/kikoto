package httpapi

import (
	"math/rand/v2"
	"net/http"
	"slices"

	"github.com/yexca/kikoto/backend/internal/library"
)

// demoForYouAlgorithmVersion marks a Demo draw, which no recommendation model made.
const demoForYouAlgorithmVersion = "demo"

// writeDemoForYou answers a For you draw in Demo. The shared Demo account has
// no listening of its own and Demo records nothing, so each column is a random
// sample of the admitted works with an example reason and score. A column
// prefers works no earlier column of the draw, or of the request's exclusions,
// shows, and repeats one only when the library is too small.
func (s *Server) writeDemoForYou(w http.ResponseWriter, r *http.Request, userID int64, request library.ForYouRequest) {
	works, err := demoAdmittedLocalWorks(r.Context(), s.db)
	if err != nil {
		writeError(w, err)
		return
	}
	columns := request.Columns
	if len(columns) == 0 {
		columns = []library.ForYouColumn{library.ForYouMaybeLike, library.ForYouTryNew, library.ForYouListenAgain}
	}
	draw := demoForYouDraw(works, columns, request.Exclude, rand.N[int])
	ids := []int64{}
	for _, column := range draw {
		for _, pick := range column.Picks {
			ids = append(ids, pick.WorkID)
		}
	}
	summaries, err := s.forYouWorkSummaries(r.Context(), userID, ids)
	if err != nil {
		writeError(w, err)
		return
	}
	response := forYouResponse{Temperature: request.Temperature, AlgorithmVersion: demoForYouAlgorithmVersion, Columns: []forYouColumnResponse{}}
	for _, column := range draw {
		items := []forYouItem{}
		for _, pick := range column.Picks {
			if summary, ok := summaries[pick.WorkID]; ok {
				items = append(items, forYouItem{Work: summary, Score: pick.Score, Reason: demoForYouCardReason(pick.Reason, summary)})
			}
		}
		response.Columns = append(response.Columns, forYouColumnResponse{Column: column.Column, Items: items})
	}
	writeJSON(w, http.StatusOK, response)
}

// demoForYouDraw picks each column's works and example reasons. random(n)
// returns a value in [0, n).
func demoForYouDraw(works []demoShowcaseWork, columns []library.ForYouColumn, exclude []int64, random func(int) int) []library.ForYouColumnDraw {
	shown := map[int64]bool{}
	for _, id := range exclude {
		shown[id] = true
	}
	draw := []library.ForYouColumnDraw{}
	for _, column := range columns {
		order := slices.Clone(works)
		for index := len(order) - 1; index > 0; index-- {
			swap := random(index + 1)
			order[index], order[swap] = order[swap], order[index]
		}
		// Works not shown yet come first; the shuffle orders each group.
		slices.SortStableFunc(order, func(a, b demoShowcaseWork) int {
			switch {
			case shown[a.id] == shown[b.id]:
				return 0
			case shown[a.id]:
				return 1
			default:
				return -1
			}
		})
		picks := []library.ForYouPick{}
		for _, work := range order[:min(library.ForYouDrawSize, len(order))] {
			shown[work.id] = true
			picks = append(picks, library.ForYouPick{WorkID: work.id, Score: 40 + random(56), Reason: demoForYouReason(column, random)})
		}
		draw = append(draw, library.ForYouColumnDraw{Column: column, Picks: picks})
	}
	return draw
}

func demoForYouReason(column library.ForYouColumn, random func(int) int) library.ForYouReason {
	switch column {
	case library.ForYouTryNew:
		return library.ForYouReason{Kind: "new_circle"}
	case library.ForYouListenAgain:
		return library.ForYouReason{Kind: "since_played", Days: 7 + random(84)}
	default:
		return library.ForYouReason{Kind: "dlsite_rating"}
	}
}

// demoForYouCardReason fills an example reason from the drawn card: its DLsite
// rating, or its circle. A card without one is simply not heard yet.
func demoForYouCardReason(reason library.ForYouReason, work libraryWorkSummary) library.ForYouReason {
	switch reason.Kind {
	case "dlsite_rating":
		if work.Rating != nil && *work.Rating > 0 {
			reason.DLsiteRating = *work.Rating
			return reason
		}
	case "new_circle":
		if work.Circle != "" {
			reason.Name = work.Circle
			return reason
		}
	default:
		return reason
	}
	return library.ForYouReason{Kind: "unexplored"}
}
