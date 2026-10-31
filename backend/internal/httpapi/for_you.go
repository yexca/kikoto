package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/library"
)

// maxForYouExclude bounds the works a single-column draw may leave out: the
// other two columns' cards.
const maxForYouExclude = 2 * library.ForYouDrawSize

type forYouItem struct {
	Work   libraryWorkSummary   `json:"work"`
	Score  int                  `json:"score"`
	Reason library.ForYouReason `json:"reason"`
}

type forYouColumnResponse struct {
	Column    library.ForYouColumn `json:"column"`
	ColdStart bool                 `json:"coldStart"`
	Items     []forYouItem         `json:"items"`
}

type forYouResponse struct {
	Temperature      library.ForYouTemperature `json:"temperature"`
	AlgorithmVersion string                    `json:"algorithmVersion"`
	Columns          []forYouColumnResponse    `json:"columns"`
}

// drawForYou draws the named For you columns, or all three, for the signed-in
// account. A draw records impressions, so it is a POST.
func (s *Server) drawForYou(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	if s.cfg.IsDemo() {
		writeAPIError(w, http.StatusForbidden, "demo_unavailable", "For you is not available in the demo", false)
		return
	}
	var payload struct {
		Columns     []string `json:"columns"`
		Temperature string   `json:"temperature"`
		Exclude     []int64  `json:"exclude"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&payload); err != nil || len(payload.Exclude) > maxForYouExclude {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid For you draw", false)
		return
	}
	request := library.ForYouRequest{UserID: user.ID, Exclude: payload.Exclude}
	seenColumns := map[library.ForYouColumn]bool{}
	for _, raw := range payload.Columns {
		column, ok := library.ParseForYouColumn(raw)
		if !ok {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "unknown For you column", false)
			return
		}
		if seenColumns[column] {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "duplicate For you column", false)
			return
		}
		seenColumns[column] = true
		request.Columns = append(request.Columns, column)
	}
	if payload.Temperature != "" {
		temperature, ok := library.ParseForYouTemperature(payload.Temperature)
		if !ok {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "unknown For you temperature", false)
			return
		}
		request.Temperature = temperature
	} else {
		temperature, err := s.forYouTemperature(r.Context(), user.ID)
		if err != nil {
			writeError(w, err)
			return
		}
		request.Temperature = temperature
	}
	draw, err := s.libraryStore.DrawForYou(r.Context(), request)
	if err != nil {
		writeError(w, err)
		return
	}
	ids := []int64{}
	for _, column := range draw.Columns {
		for _, pick := range column.Picks {
			ids = append(ids, pick.WorkID)
		}
	}
	summaries, err := s.forYouWorkSummaries(r.Context(), user.ID, ids)
	if err != nil {
		writeError(w, err)
		return
	}
	response := forYouResponse{Temperature: draw.Temperature, AlgorithmVersion: library.ForYouAlgorithmVersion, Columns: []forYouColumnResponse{}}
	for _, column := range draw.Columns {
		items := []forYouItem{}
		for _, pick := range column.Picks {
			if summary, ok := summaries[pick.WorkID]; ok {
				items = append(items, forYouItem{Work: summary, Score: pick.Score, Reason: pick.Reason})
			}
		}
		response.Columns = append(response.Columns, forYouColumnResponse{Column: column.Column, ColdStart: column.ColdStart, Items: items})
	}
	writeJSON(w, http.StatusOK, response)
}

// forYouTemperature is the account's saved temperature, Balanced by default.
func (s *Server) forYouTemperature(ctx context.Context, userID int64) (library.ForYouTemperature, error) {
	var raw sql.NullString
	err := s.db.QueryRowContext(ctx, "SELECT for_you_temperature FROM user_preference WHERE user_id = ?", userID).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if temperature, ok := library.ParseForYouTemperature(raw.String); ok {
		return temperature, nil
	}
	return library.DefaultForYouTemperature, nil
}

// forYouWorkSummaries reads the drawn works as Library cards.
func (s *Server) forYouWorkSummaries(ctx context.Context, userID int64, ids []int64) (map[int64]libraryWorkSummary, error) {
	result := map[int64]libraryWorkSummary{}
	for start := 0; start < len(ids); start += 100 {
		chunk := ids[start:min(start+100, len(ids))]
		args := make([]any, len(chunk))
		for index, id := range chunk {
			args[index] = id
		}
		raw, err := s.libraryStore.ListMatching(ctx, userID, fmt.Sprintf("work.id IN (%s)", sqlPlaceholders(len(chunk))), args, 1, len(chunk), false)
		if err != nil {
			return nil, err
		}
		summaries, err := s.scanLibraryWorkRows(ctx, userID, raw, true)
		if err != nil {
			return nil, err
		}
		for _, summary := range summaries {
			result[summary.ID] = summary
		}
	}
	return result, nil
}
