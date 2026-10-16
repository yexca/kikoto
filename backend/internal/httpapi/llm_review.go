package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"
	"time"

	"github.com/yexca/kikoto/backend/internal/llm"
)

func llmValueHash(value any) string {
	data, _ := json.Marshal(value)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}

// llmConfigHash identifies the connection, data boundary and request settings
// a translation with model uses. The name, the default and the other enabled
// models are left out, so editing them leaves queued work valid. A model that
// is no longer enabled has no digest, so every comparison with a stored one
// fails.
func (s *Server) llmConfigHash(p llm.Provider, model string) string {
	if model == "" || !slices.Contains(p.EnabledModels, model) {
		return ""
	}
	p.Name, p.Revision, p.DefaultModel = "", 0, ""
	p.Models, p.EnabledModels = nil, nil
	p.BaseURL = p.Endpoint(s.cfg.HostProxyAddress())
	return llmValueHash(struct {
		Provider llm.Provider
		Model    string
	}{p, model})
}
func (s *Server) saveLLMPreview(ctx context.Context, id string, p llmPreview) error {
	// Store provenance and a configuration digest, never a duplicate credential.
	p.Provider = llm.Provider{ID: p.Provider.ID, Name: p.Provider.Name}
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO llm_translation_preview(id,work_id,user_id,payload_json,expires_at) VALUES(?,?,?,?,?)`, id, p.WorkID, p.UserID, string(data), p.Expires.Unix())
	return err
}
func loadLLMPreview(ctx context.Context, tx *sql.Tx, id string, userID, workID int64) (llmPreview, error) {
	var raw string
	var p llmPreview
	err := tx.QueryRowContext(ctx, "SELECT payload_json FROM llm_translation_preview WHERE id=? AND user_id=? AND work_id=? AND status='proposed'", id, userID, workID).Scan(&raw)
	if err == nil {
		err = json.Unmarshal([]byte(raw), &p)
	}
	return p, err
}
func loadLLMCurrent(ctx context.Context, tx *sql.Tx, id string) (llm.Provider, llm.Policy, error) {
	var raw string
	if err := tx.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key=?", llm.SettingKey).Scan(&raw); err != nil {
		return llm.Provider{}, llm.Policy{}, err
	}
	var providers []llm.Provider
	if err := json.Unmarshal([]byte(raw), &providers); err != nil {
		return llm.Provider{}, llm.Policy{}, err
	}
	var provider llm.Provider
	for _, p := range providers {
		if p.ID == id {
			provider = p
		}
	}
	if provider.ID == "" {
		return provider, llm.Policy{}, llm.ErrNotFound
	}
	policy := llm.DefaultPolicy()
	err := tx.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key=?", llm.PolicyKey).Scan(&raw)
	if err != nil && err != sql.ErrNoRows {
		return provider, policy, err
	}
	if err == nil {
		if err = json.Unmarshal([]byte(raw), &policy); err != nil {
			return provider, policy, err
		}
	}
	policy, err = policy.Validate()
	return provider, policy, err
}
func (s *Server) expireLLMPreview(w http.ResponseWriter, r *http.Request, tx *sql.Tx, id, code, message string) {
	if _, err := tx.ExecContext(r.Context(), "UPDATE llm_translation_preview SET status='expired',updated_at=CURRENT_TIMESTAMP WHERE id=?", id); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeAPIError(w, 409, code, message, false)
}
func archiveLLMTranslation(ctx context.Context, tx *sql.Tx, workID int64, language, field string, userID int64, action string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO work_llm_translation_review(work_id,language,field_name,value_text,source_hash,provider_id,model,user_id,action)
 SELECT work_id,language,field_name,value_text,source_hash,provider_id,model,?,? FROM work_llm_translation WHERE work_id=? AND language=? AND field_name=?`, userID, action, workID, language, field)
	return err
}
func (s *Server) precheckLLMWork(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	if !s.acquireLLMSlot(w, r) {
		return
	}
	defer func() { <-s.llmRequestSlots }()
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	input, err := loadLLMWorkInput(r.Context(), s.db, id)
	if err == sql.ErrNoRows {
		writeAPIError(w, 404, "work_not_found", "Work not found.", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	policy, err := s.llmStore.Policy(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	var payload llmTranslatePayload
	if r.Body != nil {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			writeAPIError(w, 400, "invalid_translation_request", "Invalid precheck request.", false)
			return
		}
	}
	text, _ := llmFields(input, payload.Fields)
	checked := []string{"title", "description", "tags"}
	if policy.LLMTranslationTextOnly && len(payload.Fields) == 0 {
		writeLLMRequestError(w, llmInvalid("invalid_translation_request", "Choose at least one field."))
		return
	}
	for _, field := range payload.Fields {
		if field != "title" && field != "description" && field != "tags" && field != "lyrics" {
			writeLLMRequestError(w, llmInvalid("invalid_translation_request", "Choose supported translation fields."))
			return
		}
		if field == "tags" && policy.LLMTranslationTextOnly {
			if payload.Target == "" || !validTitleLanguage(payload.Target) {
				writeLLMRequestError(w, llmInvalid("invalid_translation_request", "Choose a supported target language."))
				return
			}
			_, text.Tags, err = loadLLMTagCandidates(r.Context(), s.db, id, payload.Target)
			if err != nil {
				writeLLMRequestError(w, llmInvalid("llm_input_too_large", "Shared tag input exceeds the translation limit."))
				return
			}
		}
		if field == "lyrics" {
			lyrics, err := s.loadLLMLyrics(r.Context(), id, payload, policy)
			if err != nil {
				writeLLMRequestError(w, err)
				return
			}
			text.Lyrics = lyrics.Document.Text()
			checked = append(checked, "lyrics")
		}
	}
	assessment := assessLLMTranslation(policy, input, text)
	if policy.LLMTranslationTextOnly {
		checked = append([]string{}, assessment.CheckedFields...)
	}
	writeJSON(w, 200, map[string]any{"assessment": assessment, "checkedFields": checked, "sentFields": []string{}})
}
func (s *Server) rejectLLMPreview(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	_, err = s.db.ExecContext(r.Context(), "UPDATE llm_translation_preview SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE id=? AND work_id=? AND user_id=? AND status='proposed'", r.PathValue("preview"), id, actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
func (s *Server) listLLMReviews(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `SELECT id,status,expires_at,payload_json FROM llm_translation_preview WHERE work_id=? AND user_id=? ORDER BY created_at DESC,id DESC LIMIT 64`, id, actor.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = rows.Close() }()
	result := []map[string]any{}
	for rows.Next() {
		var token, status, raw string
		var expires int64
		if err := rows.Scan(&token, &status, &expires, &raw); err != nil {
			writeError(w, err)
			return
		}
		if status == "proposed" && expires <= time.Now().Unix() {
			status = "expired"
		}
		var p llmPreview
		if err := json.Unmarshal([]byte(raw), &p); err != nil {
			writeError(w, err)
			return
		}
		source := p.Source
		result = append(result, map[string]any{"previewId": token, "status": status, "targetLanguage": p.Target, "fields": p.Fields, "translation": p.Result, "source": source, "assessment": p.Assessment, "providerId": p.Provider.ID, "providerName": p.Provider.Name, "model": p.Payload.Model, "expiresAt": expires})
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, result)
}
func (s *Server) revokeLLMTranslation(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	language, field := r.PathValue("language"), r.PathValue("field")
	if !validTitleLanguage(language) || language == "" || (field != "title" && field != "description") {
		writeAPIError(w, 400, "invalid_translation", "Invalid language or field.", false)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := archiveLLMTranslation(r.Context(), tx, id, language, field, actor.ID, "revoked"); err != nil {
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE work_llm_translation SET status='rejected',updated_at=CURRENT_TIMESTAMP WHERE work_id=? AND language=? AND field_name=?", id, language, field); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}
