package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/demopresentation"
)

// Demo explanations contain display data, without fabricated preference or
// ordering contributions from the production recommendation engine.
type demoRecommendationExplanation struct {
	AlgorithmVersion string `json:"algorithmVersion"`
	ScoreKind        string `json:"scoreKind"`
	Score            int    `json:"score"`
	RawScore         int    `json:"rawScore"`
	Components       []any  `json:"components"`
}

// Numeric details retain their edition content, while their display score uses
// the same unified identity as the Library and simulated remote summaries.
func (s *Server) demoRecommendationScore(ctx context.Context, sessionID, primaryCode string) (int, error) {
	ref, err := s.demoRecommendationWorkRef(ctx, primaryCode)
	if err != nil {
		return 0, err
	}
	if ref.Known && ref.Code != "" {
		primaryCode = ref.Code
	}
	return demopresentation.RecommendationScore(sessionID, primaryCode), nil
}

func (s *Server) demoRecommendationWorkRef(ctx context.Context, primaryCode string) (canonicalWorkRef, error) {
	identity, err := s.resolveWorkCodeIdentity(ctx, primaryCode)
	if errors.Is(err, sql.ErrNoRows) {
		return canonicalWorkRef{}, nil
	}
	if err != nil {
		return canonicalWorkRef{}, err
	}
	return canonicalWorkRef{WorkID: identity.WorkID, Code: identity.Code, Known: true}, nil
}

func (s *Server) writeDemoRecommendation(w http.ResponseWriter, r *http.Request, workID int64, sessionID string) {
	var code string
	if err := s.db.QueryRowContext(r.Context(), "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&code); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "work not found", false)
		} else {
			writeError(w, err)
		}
		return
	}
	score, err := s.demoRecommendationScore(r.Context(), sessionID, code)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, demoRecommendationExplanation{
		AlgorithmVersion: demopresentation.RecommendationVersion, ScoreKind: "demo_random",
		Score: score, RawScore: score, Components: []any{},
	})
}
