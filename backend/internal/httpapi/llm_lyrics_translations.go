package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"slices"
	"time"
)

type llmLyricsTranslationResponse struct {
	TaskID           int64  `json:"taskId"`
	RunID            int64  `json:"runId"`
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	LyricsLocationID int64  `json:"lyricsLocationId"`
	TargetLanguage   string `json:"targetLanguage"`
	ProviderName     string `json:"providerName"`
	Model            string `json:"model"`
	State            string `json:"state"`
	FailureCode      string `json:"failureCode,omitempty"`
	PreviewID        string `json:"previewId,omitempty"`
	UpdatedAt        string `json:"updatedAt"`
}

// llmLyricsTranslationState is the one state a lyrics translation shows: the
// task's state while it runs or stopped, then its review and publication.
func llmLyricsTranslationState(task, previewStatus string, expires int64, assetStatus string, now time.Time) string {
	if task != "ready" {
		return task
	}
	switch {
	case assetStatus == "accepted":
		return "accepted"
	case assetStatus == "publishing":
		return "publishing"
	case previewStatus == "proposed" && expires > now.Unix():
		return "ready"
	case previewStatus == "rejected":
		return "rejected"
	default:
		return "expired"
	}
}

// listLLMLyricsTranslations lists the requester's background lyrics
// translations of a work, newest first. Each belongs to its requester, who
// alone reviews it.
func (s *Server) listLLMLyricsTranslations(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermissions(w, r, "library:write", "metadata:sync")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	providers, err := s.llmStore.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT task.id, task.workflow_run_id, task.request_json, task.state, task.failure_code,
			COALESCE(task.preview_id, ''), task.updated_at, COALESCE(preview.status, ''),
			COALESCE(preview.expires_at, 0), COALESCE(asset.status, '')
		FROM llm_translation_task AS task
		LEFT JOIN llm_translation_preview AS preview ON preview.id = task.preview_id
		LEFT JOIN llm_lyrics_asset AS asset ON asset.id = task.preview_id
		WHERE task.work_id = ? AND task.user_id = ? AND task.request_json LIKE '%"lyrics"%'
		ORDER BY task.id DESC
		LIMIT 64
	`, workID, actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = rows.Close() }()
	now := time.Now()
	result := []llmLyricsTranslationResponse{}
	for rows.Next() {
		var item llmLyricsTranslationResponse
		var request, taskState, previewStatus, assetStatus string
		var expires int64
		if err := rows.Scan(&item.TaskID, &item.RunID, &request, &taskState, &item.FailureCode, &item.PreviewID, &item.UpdatedAt, &previewStatus, &expires, &assetStatus); err != nil {
			writeError(w, err)
			return
		}
		var payload llmTranslatePayload
		if json.Unmarshal([]byte(request), &payload) != nil || !slices.Contains(payload.Fields, "lyrics") {
			continue
		}
		item.AudioMediaItemID, item.LyricsLocationID, item.TargetLanguage, item.Model = payload.AudioMediaItemID, payload.LyricsLocationID, payload.Target, payload.Model
		for _, provider := range providers {
			if provider.ID == payload.ProviderID {
				item.ProviderName = provider.Name
			}
		}
		item.State = llmLyricsTranslationState(taskState, previewStatus, expires, assetStatus, now)
		if item.State != "ready" && item.State != "publishing" {
			item.PreviewID = ""
		}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, result)
}

// llmPreviewLyricsText returns the translated lyrics of a preview as the file
// they become, so the reviewer sees their timing.
func (s *Server) llmPreviewLyricsText(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	var raw string
	err = s.db.QueryRowContext(r.Context(), "SELECT payload_json FROM llm_translation_preview WHERE id=? AND user_id=? AND work_id=?", r.PathValue("preview"), actor.ID, workID).Scan(&raw)
	var preview llmPreview
	if err == nil {
		err = json.Unmarshal([]byte(raw), &preview)
	}
	if errors.Is(err, sql.ErrNoRows) || err == nil && preview.Lyrics == nil {
		writeAPIError(w, 404, "llm_preview_not_found", "Translation preview not found.", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	text, err := preview.Lyrics.Document.Render(preview.Result.Lyrics)
	if err != nil {
		writeAPIError(w, 409, "llm_invalid_lyrics_output", "Translation changed lyrics structure.", false)
		return
	}
	setUntrustedFileHeaders(w)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = io.WriteString(w, text)
}
