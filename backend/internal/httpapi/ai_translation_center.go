package httpapi

import (
	"context"
	"net/http"
	"strconv"
	"strings"
)

// The Translation page shows Translate with AI runs as they progress: per
// work, one row per language. It is a view
// of the runs and their items; it keeps no state of its own.

type translationRunLanguage struct {
	Language string `json:"language"`
	// States counts the language's items by state.
	States map[string]int `json:"states"`
	Total  int            `json:"total"`
	// ChunksDone and Chunks count the lyrics requests of the language.
	ChunksDone int `json:"chunksDone"`
	Chunks     int `json:"chunks"`
}

type translationRunResponse struct {
	RunID       int64                    `json:"runId"`
	Status      string                   `json:"status"`
	CanCancel   bool                     `json:"canCancel"`
	WorkID      int64                    `json:"workId"`
	WorkCode    string                   `json:"workCode"`
	WorkTitle   string                   `json:"workTitle"`
	RequestedBy string                   `json:"requestedBy"`
	CreatedAt   string                   `json:"createdAt"`
	FinishedAt  string                   `json:"finishedAt,omitempty"`
	Languages   []translationRunLanguage `json:"languages"`
}

var translationRunViews = map[string][]string{
	"active": {"running"},
	"queued": {"queued"},
}

func (s *Server) listTranslationRuns(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "Translation is unavailable in Demo.", false)
		return
	}
	actor, ok := userFromContext(r.Context())
	if !ok || !canUseTranslationCenter(actor) {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return
	}
	view := r.URL.Query().Get("view")
	if view == "" {
		view = "active"
	}
	statuses, ok := translationRunViews[view]
	if !ok {
		writeAPIError(w, 400, "invalid_filter", "Invalid translation view.", false)
		return
	}
	limit := 50
	if raw := r.URL.Query().Get("limit"); raw != "" {
		value, err := strconv.Atoi(raw)
		if err != nil || value < 1 || value > 200 {
			writeAPIError(w, 400, "invalid_page", "Invalid limit.", false)
			return
		}
		limit = value
	}
	runs, err := s.translationRuns(r.Context(), actor, statuses, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	counts, err := s.translationCenterCounts(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	settings, err := s.translationSettings(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"runs": runs, "counts": counts, "autoAccept": settings.AutoAccept})
}

// translationCenterCounts are the counts the Translation page's views show.
func (s *Server) translationCenterCounts(ctx context.Context) (map[string]int, error) {
	counts := map[string]int{}
	var active, queued, review, attention int
	if err := s.db.QueryRowContext(ctx, `SELECT
		(SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ? AND status = 'running'),
		(SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ? AND status = 'queued'),
		(SELECT COUNT(*) FROM translation_item WHERE state = 'ready'),
		(SELECT COUNT(*) FROM translation_item WHERE state IN ('failed', 'uncertain', 'invalid', 'policy_blocked'))`,
		aiTranslationWorkflowCode, aiTranslationWorkflowCode).Scan(&active, &queued, &review, &attention); err != nil {
		return nil, err
	}
	counts["active"], counts["queued"], counts["review"], counts["attention"] = active, queued, review, attention
	return counts, nil
}

func (s *Server) translationRuns(ctx context.Context, actor currentUser, statuses []string, limit int) ([]translationRunResponse, error) {
	args := stringsToAny(statuses)
	args = append([]any{aiTranslationWorkflowCode}, args...)
	args = append(args, limit)
	rows, err := s.db.QueryContext(ctx, `SELECT run.id, run.status, COALESCE(json_extract(run.input_json, '$.work_id'), 0), COALESCE(work.primary_code, ''),
		COALESCE(work.title, ''), COALESCE(account.username, ''), run.created_at, COALESCE(run.finished_at, ''),
		COALESCE(CAST(json_extract(run.input_json, '$.requested_by_user_id') AS INTEGER), 0), COALESCE(definition.owner_user_id, 0)
		FROM workflow_run AS run
		LEFT JOIN workflow_definition AS definition ON definition.id = run.workflow_definition_id
		LEFT JOIN work ON work.id = json_extract(run.input_json, '$.work_id')
		LEFT JOIN user_account AS account ON account.id = json_extract(run.input_json, '$.requested_by_user_id')
		WHERE run.workflow_code = ? AND run.status IN (`+strings.TrimSuffix(strings.Repeat("?,", len(statuses)), ",")+`)
		ORDER BY run.id LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	runs := []translationRunResponse{}
	index := map[int64]int{}
	for rows.Next() {
		var run translationRunResponse
		var ownership workflowRunOwnership
		if err := rows.Scan(&run.RunID, &run.Status, &run.WorkID, &run.WorkCode, &run.WorkTitle, &run.RequestedBy, &run.CreatedAt, &run.FinishedAt,
			&ownership.requestedByUserID, &ownership.ownerUserID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		run.CanCancel = canCancelAITranslationRun(actor, ownership, run.Status)
		run.Languages = []translationRunLanguage{}
		index[run.RunID] = len(runs)
		runs = append(runs, run)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if len(runs) == 0 {
		return runs, nil
	}
	ids := make([]any, 0, len(runs))
	for _, run := range runs {
		ids = append(ids, run.RunID)
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	items, err := s.db.QueryContext(ctx, `SELECT workflow_run_id, language, state, COUNT(*),
		SUM(CASE WHEN category = 'lyrics' THEN request_index ELSE 0 END),
		SUM(CASE WHEN category = 'lyrics' THEN COALESCE(json_extract(detail_json, '$.chunks'), 0) ELSE 0 END)
		FROM translation_item WHERE workflow_run_id IN (`+marks+`)
		GROUP BY workflow_run_id, language, state ORDER BY workflow_run_id, MIN(id)`, ids...)
	if err != nil {
		return nil, err
	}
	for items.Next() {
		var runID int64
		var language, state string
		var count, done, chunks int
		if err := items.Scan(&runID, &language, &state, &count, &done, &chunks); err != nil {
			_ = items.Close()
			return nil, err
		}
		run := &runs[index[runID]]
		position := -1
		for i := range run.Languages {
			if run.Languages[i].Language == language {
				position = i
			}
		}
		if position < 0 {
			run.Languages = append(run.Languages, translationRunLanguage{Language: language, States: map[string]int{}})
			position = len(run.Languages) - 1
		}
		entry := &run.Languages[position]
		entry.States[state] += count
		entry.Total += count
		entry.ChunksDone += done
		entry.Chunks += chunks
	}
	return runs, items.Close()
}
