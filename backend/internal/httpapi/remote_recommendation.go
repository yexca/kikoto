package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/demopresentation"
	"github.com/yexca/kikoto/backend/internal/library"
)

type remoteRecommendationRequest struct {
	SessionID string                            `json:"recommendationSession"`
	Works     []library.RecommendationCandidate `json:"works"`
}

type remoteRecommendationScore struct {
	PrimaryCode string `json:"primaryCode"`
	Score       int    `json:"score"`
}

func (s *Server) scoreRemoteRecommendations(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid source id", false)
		return
	}
	source, err := s.loadRemoteSourceForUse(r.Context(), id)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "source_not_found", "source not found", false)
		return
	}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		writeAPIError(w, http.StatusBadRequest, "source_unavailable", "source is unavailable", false)
		return
	}
	var request remoteRecommendationRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 512<<10))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid recommendation request", false)
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid recommendation request", false)
		return
	}
	request.SessionID = strings.TrimSpace(request.SessionID)
	validSession := recommendationSessionIDPattern.MatchString(request.SessionID) || s.cfg.IsDemo() && request.SessionID == ""
	if !validSession || len(request.Works) == 0 || len(request.Works) > 100 {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid recommendation request", false)
		return
	}
	for _, candidate := range request.Works {
		if candidate.PrimaryCode == "" || len(candidate.PrimaryCode) > 32 || len(candidate.Circle) > 512 || len(candidate.Tags) > 256 || len(candidate.VoiceActors) > 256 || (candidate.WorkID != nil && *candidate.WorkID <= 0) {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid recommendation candidate", false)
			return
		}
		for _, names := range [][]string{candidate.Tags, candidate.VoiceActors} {
			for _, name := range names {
				if len(name) > 512 {
					writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid recommendation candidate", false)
					return
				}
			}
		}
	}
	if s.cfg.IsDemo() {
		result := make([]remoteRecommendationScore, len(request.Works))
		for index, candidate := range request.Works {
			ref, err := s.demoRecommendationWorkRef(r.Context(), candidate.PrimaryCode)
			if err != nil {
				writeError(w, err)
				return
			}
			if !ref.Known || (candidate.WorkID != nil && *candidate.WorkID != ref.WorkID) {
				writeAPIError(w, http.StatusNotFound, "not_found", "work not found", false)
				return
			}
			if !s.requireDemoWork(w, r, ref.WorkID) {
				return
			}
			result[index] = remoteRecommendationScore{PrimaryCode: candidate.PrimaryCode, Score: demopresentation.RecommendationScore(request.SessionID, ref.Code)}
		}
		writeJSON(w, http.StatusOK, map[string]any{"scores": result})
		return
	}
	breakdowns, err := s.libraryStore.ScoreRecommendationCandidates(r.Context(), user.ID, request.SessionID, request.Works)
	if err != nil {
		if errors.Is(err, library.ErrInvalidRecommendationCandidate) {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid recommendation candidate", false)
			return
		}
		writeError(w, err)
		return
	}
	result := make([]remoteRecommendationScore, len(request.Works))
	for index, candidate := range request.Works {
		result[index] = remoteRecommendationScore{PrimaryCode: candidate.PrimaryCode, Score: breakdowns[index].Score}
	}
	writeJSON(w, http.StatusOK, map[string]any{"scores": result})
}

func (s *Server) scoreRemoteWorkSummaries(r *http.Request, userID int64, works []remoteWorkSummary) error {
	if s.cfg.IsDemo() {
		sessionID := strings.TrimSpace(r.URL.Query().Get("recommendationSession"))
		for index := range works {
			works[index].RecommendScore = demopresentation.RecommendationScore(sessionID, works[index].PrimaryCode)
		}
		return nil
	}
	candidates := make([]library.RecommendationCandidate, len(works))
	for index, work := range works {
		candidates[index] = library.RecommendationCandidate{PrimaryCode: work.PrimaryCode, WorkID: work.WorkID, Tags: work.Tags, VoiceActors: work.VoiceActors, Circle: work.Circle}
	}
	breakdowns, err := s.libraryStore.ScoreRecommendationCandidates(r.Context(), userID, "", candidates)
	if err != nil {
		return err
	}
	for index := range works {
		works[index].RecommendScore = breakdowns[index].Score
	}
	return nil
}
