package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
)

// aiTranslationBatchMaxWorks bounds the works one batch request queues.
const aiTranslationBatchMaxWorks = 1000

// aiTranslationBatchRequest queues the same Translate with AI request, without
// lyrics, for each listed work.
type aiTranslationBatchRequest struct {
	WorkIDs    []int64  `json:"workIds"`
	Languages  []string `json:"languages"`
	Categories []string `json:"categories"`
	ProviderID string   `json:"providerId"`
	Model      string   `json:"model,omitempty"`
}

// aiTranslationBatchResult is one work's outcome: the run it queued, or the
// code that refused it.
type aiTranslationBatchResult struct {
	WorkID int64  `json:"workId"`
	RunID  int64  `json:"runId,omitempty"`
	Items  int    `json:"items,omitempty"`
	Code   string `json:"code,omitempty"`
}

// createAITranslationBatch submits one translation per listed work. A work
// that is refused, such as one with nothing missing, does not stop the
// others; each result reports its own outcome.
func (s *Server) createAITranslationBatch(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	var body aiTranslationBatchRequest
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 256<<10))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil || len(body.WorkIDs) == 0 || len(body.WorkIDs) > aiTranslationBatchMaxWorks {
		writeAPIError(w, 400, "invalid_translation_request", "Choose 1–1000 works to translate.", false)
		return
	}
	request := aiTranslationRequest{
		Languages: body.Languages, Categories: body.Categories,
		ProviderID: body.ProviderID, Model: body.Model, Lyrics: []aiLyricsTarget{},
	}
	results := make([]aiTranslationBatchResult, 0, len(body.WorkIDs))
	seen := map[int64]bool{}
	for _, workID := range body.WorkIDs {
		if seen[workID] {
			continue
		}
		seen[workID] = true
		result := aiTranslationBatchResult{WorkID: workID}
		if workID <= 0 {
			result.Code = "invalid_work_id"
			results = append(results, result)
			continue
		}
		response, err := s.submitAITranslation(r.Context(), actor, workID, request)
		var refused llmRequestError
		switch {
		case err == nil:
			result.RunID, result.Items = response.RunID, response.Items
		case r.Context().Err() != nil:
			writeError(w, r.Context().Err())
			return
		case errors.Is(err, sql.ErrNoRows):
			result.Code = "work_not_found"
		case errors.As(err, &refused):
			result.Code = refused.Code
		default:
			slog.Warn("batch translation submission failed", "work", workID, "error", err)
			result.Code = "llm_translation_failed"
		}
		results = append(results, result)
	}
	writeJSON(w, http.StatusOK, map[string]any{"results": results})
}
