package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"slices"

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
func archiveLLMTranslation(ctx context.Context, tx *sql.Tx, workID int64, language, field string, userID int64, action string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO work_llm_translation_review(work_id,language,field_name,value_text,source_hash,provider_id,model,user_id,action)
 SELECT work_id,language,field_name,value_text,source_hash,provider_id,model,?,? FROM work_llm_translation WHERE work_id=? AND language=? AND field_name=?`, userID, action, workID, language, field)
	return err
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
