package httpapi

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/agerating"
	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/llm"
	"github.com/yexca/kikoto/backend/internal/metadatatitles"
)

type llmTranslatePayload struct {
	LyricsLocationID int64  `json:"lyricsLocationId"`
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	FolderID         int64  `json:"folderId"`
	ProviderID       string `json:"providerId"`
	// Model is one of the provider's enabled models; empty requests the
	// default. Stored payloads always hold the resolved model.
	Model  string   `json:"model,omitempty"`
	Target string   `json:"targetLanguage"`
	Fields []string `json:"fields"`
}

type llmWorkInput struct {
	ManualTitle       string
	ManualDescription string
	LyricsHash        string
	SourceID          int64
	Text              llm.Text
	Age               string
	Tags              []int64
	TagNames          string
}

type llmPreview struct {
	Source     llm.Text
	Lyrics     *llmLyricsInput
	Payload    llmTranslatePayload
	Assessment llm.Assessment
	TagIDs     []int64
	PolicyHash string
	ConfigHash string
	WorkID     int64
	UserID     int64
	Expires    time.Time
	Hash       string
	Input      llmWorkInput
	Fields     []string
	Result     llm.Text
	Provider   llm.Provider
	Target     string
}

type llmInputQuerier interface {
	metadatatitles.Querier
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// The original edition supplies translation input regardless of the viewer's
// display language. Tag bases retain hidden and removed risk evidence.
func loadLLMWorkInput(ctx context.Context, q llmInputQuerier, workID int64) (llmWorkInput, error) {
	inputs, err := metadatatitles.LoadInputs(ctx, q, []int64{workID}, true)
	if err != nil {
		return llmWorkInput{}, err
	}
	input, ok := inputs[workID]
	if !ok {
		return llmWorkInput{}, sql.ErrNoRows
	}
	origin := metadatatitles.Original(input.Variants, input.Fallback)
	result := llmWorkInput{Text: llm.Text{Title: origin.Title, Description: origin.Description}, Tags: []int64{}}
	var sourceID int64
	if err := q.QueryRowContext(ctx, "SELECT id,age_rating FROM work WHERE primary_code=?", input.Fallback.Code).Scan(&sourceID, &result.Age); err != nil {
		return result, err
	}
	result.SourceID = sourceID
	manualRows, err := q.QueryContext(ctx, "SELECT field_name,value_json FROM work_manual_override WHERE work_id IN (?,?) AND field_name IN ('title','description','age_rating') ORDER BY work_id,field_name,language", workID, sourceID)
	if err != nil {
		return result, err
	}
	for manualRows.Next() {
		var field, raw, value string
		if err := manualRows.Scan(&field, &raw); err != nil {
			_ = manualRows.Close()
			return result, err
		}
		if json.Unmarshal([]byte(raw), &value) != nil {
			_ = manualRows.Close()
			return result, errors.New("invalid manual metadata")
		}
		switch field {
		case "title":
			result.ManualTitle += value + "\n"
		case "description":
			result.ManualDescription += value + "\n"
		case "age_rating":
			if len(agerating.Aliases(result.Age)) == 0 || len(agerating.Aliases(value)) == 0 {
				result.Age = "unknown"
			} else if !agerating.Matches(value, "general") && agerating.Matches(result.Age, "general") {
				result.Age = value
			}
		}
	}
	if err := manualRows.Err(); err != nil {
		_ = manualRows.Close()
		return result, err
	}
	_ = manualRows.Close()
	rows, err := q.QueryContext(ctx, `WITH risk_tags AS (
 SELECT tag_id FROM work_metadata_tag_base WHERE work_id IN (?,?)
 UNION SELECT tag_id FROM work_tag WHERE work_id IN (?,?)
 UNION SELECT concept.tag_id FROM work_dlsite_genre genres JOIN metadata_tag concept ON concept.dlsite_genre_id=genres.genre_id WHERE genres.work_id IN (?,?)
 UNION SELECT tag_id FROM work_tag_override WHERE work_id IN (?,?) AND action='add'
 ), all_tags AS (
 SELECT tag_id FROM risk_tags UNION SELECT resolution.resolved_tag_id FROM risk_tags JOIN metadata_tag_resolution AS resolution ON resolution.source_tag_id=risk_tags.tag_id
 UNION SELECT alias.source_tag_id FROM risk_tags JOIN metadata_tag_resolution resolved ON resolved.source_tag_id=risk_tags.tag_id JOIN metadata_tag_resolution alias ON alias.resolved_tag_id=resolved.resolved_tag_id
 ) SELECT tag.id,tag.display_name,
 COALESCE((SELECT GROUP_CONCAT(name,' ') FROM metadata_tag_name WHERE tag_id=tag.id),'') || ' ' ||
 COALESCE((SELECT GROUP_CONCAT(name,' ') FROM metadata_tag_provider_name WHERE tag_id=tag.id),'') || ' ' ||
 COALESCE((SELECT GROUP_CONCAT(name,' ') FROM dlsite_genre_name names JOIN metadata_tag concept ON concept.dlsite_genre_id=names.genre_id WHERE concept.tag_id=tag.id),'') || ' ' ||
 COALESCE((SELECT GROUP_CONCAT(source_text,' ') FROM metadata_tag_llm_name WHERE tag_id=tag.id),'')
 FROM all_tags JOIN tag ON tag.id=all_tags.tag_id ORDER BY tag.id`, workID, sourceID, workID, sourceID, workID, sourceID, workID, sourceID)
	if err != nil {
		return result, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var name, aliases string
		if err := rows.Scan(&id, &name, &aliases); err != nil {
			return result, err
		}
		result.Tags = append(result.Tags, id)
		result.TagNames += name + " " + aliases + "\n"
	}
	return result, rows.Err()
}

func llmInputHash(input llmWorkInput) string {
	data, _ := json.Marshal(input)
	hash := sha256.Sum256(data)
	return hex.EncodeToString(hash[:])
}
func llmFields(input llmWorkInput, fields []string) (llm.Text, map[string]string) {
	text := llm.Text{}
	scan := map[string]string{"tags": input.TagNames, "title": input.Text.Title + "\n" + input.ManualTitle, "description": input.Text.Description + "\n" + input.ManualDescription}
	for _, field := range fields {
		switch field {
		case "title":
			text.Title = input.Text.Title
		case "description":
			text.Description = input.Text.Description
		}
	}
	return text, scan
}
func llmAllowed(class string, provider llm.Provider) bool {
	return contentpolicy.Allows(class, provider.MaxContentClass)
}

func (s *Server) translateWorkWithLLM(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	var payload llmTranslatePayload
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&payload); err != nil {
		writeAPIError(w, 400, "invalid_translation_request", "Invalid translation request.", false)
		return
	}
	if !s.acquireLLMSlot(w, r) {
		return
	}
	defer func() { <-s.llmRequestSlots }()
	plan, err := s.prepareLLMTranslation(r.Context(), workID, payload)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, 404, "work_not_found", "Work not found.", false)
		} else {
			writeLLMRequestError(w, err)
		}
		return
	}
	payload.Model = plan.Model
	provider, policy, input, fields, tagIDs, text, assessment := plan.Provider, plan.Policy, plan.Input, plan.Fields, plan.TagIDs, plan.Source, plan.Assessment
	var count int
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM llm_translation_preview WHERE user_id=? AND status='proposed' AND expires_at>?", actor.ID, time.Now().Unix()).Scan(&count); err != nil {
		writeError(w, err)
		return
	}
	if count >= 64 {
		writeAPIError(w, 429, "llm_preview_limit", "Too many translation previews. Try again later.", false)
		return
	}
	result, err := s.requestLLMTranslation(r.Context(), plan, payload.Target, func(ctx context.Context) error { return s.validateLLMSend(ctx, actor.ID, workID, payload, plan) })
	if err != nil {
		writeLLMRequestError(w, err)
		return
	}
	var token [16]byte
	if err := s.saveLLMTagCandidates(r.Context(), actor.ID, payload.Target, plan, result); err != nil {
		writeError(w, err)
		return
	}
	if _, err := rand.Read(token[:]); err != nil {
		writeError(w, err)
		return
	}
	id := hex.EncodeToString(token[:])

	preview := llmPreview{WorkID: workID, UserID: actor.ID, Expires: time.Now().Add(15 * time.Minute), Hash: llmInputHash(input), Input: input, Fields: fields, Result: result, Provider: provider, Target: payload.Target, PolicyHash: llmValueHash(policy), ConfigHash: s.llmConfigHash(provider, plan.Model)}
	preview.TagIDs = tagIDs
	preview.Lyrics = plan.Lyrics
	preview.Payload = payload
	preview.Assessment = assessment
	preview.Source = text
	if err := s.saveLLMPreview(r.Context(), id, preview); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"previewId": id, "providerId": provider.ID, "providerName": provider.Name, "model": plan.Model, "targetLanguage": payload.Target, "assessment": assessment, "source": text, "translation": result})
}

func (s *Server) applyLLMTranslation(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	actor, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
		return
	}
	var payload struct {
		PreviewID string `json:"previewId"`
	}
	if json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024)).Decode(&payload) != nil {
		writeAPIError(w, 400, "invalid_translation", "Invalid translation preview.", false)
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	preview, err := loadLLMPreview(r.Context(), tx, payload.PreviewID, actor.ID, workID)
	if err != nil || time.Now().After(preview.Expires) {
		writeAPIError(w, 404, "llm_preview_expired", "Translation preview expired or has already been reviewed. Translate again.", false)
		return
	}
	provider, policy, err := loadLLMCurrent(r.Context(), tx, preview.Provider.ID)
	if err != nil || !provider.Enabled || s.llmConfigHash(provider, preview.Payload.Model) != preview.ConfigHash || llmValueHash(policy) != preview.PolicyHash {
		s.expireLLMPreview(w, r, tx, payload.PreviewID, "llm_config_changed", "Provider or content policy changed. Translate again.")
		return
	}
	current, err := loadLLMWorkInput(r.Context(), tx, workID)
	if err != nil {
		writeError(w, err)
		return
	}
	if preview.Lyrics != nil {
		// Read only the explicitly chosen file again; its content and scope
		// must remain identical before accepting the generated asset.
		_ = tx.Rollback()
		lyrics, err := s.loadLLMLyrics(r.Context(), workID, preview.Payload, policy)
		if err != nil || lyrics.Hash != preview.Lyrics.Hash {
			writeAPIError(w, 409, "work_changed", "Lyrics changed or are unavailable. Translate again.", false)
			return
		}
		current.LyricsHash = lyrics.Hash
		tx, err = s.db.BeginTx(r.Context(), nil)
		if err != nil {
			writeError(w, err)
			return
		}
		defer func() { _ = tx.Rollback() }()
		// Retake the bound preview after the file read releases the database.
		preview, err = loadLLMPreview(r.Context(), tx, payload.PreviewID, actor.ID, workID)
		if err != nil {
			writeAPIError(w, 404, "llm_preview_expired", "Translation preview is unavailable.", false)
			return
		}
		provider, policy, err = loadLLMCurrent(r.Context(), tx, preview.Provider.ID)
		if err != nil || s.llmConfigHash(provider, preview.Payload.Model) != preview.ConfigHash || llmValueHash(policy) != preview.PolicyHash {
			writeAPIError(w, 409, "llm_config_changed", "Provider or policy changed. Translate again.", false)
			return
		}
		fresh, err := loadLLMWorkInput(r.Context(), tx, workID)
		if err != nil {
			writeError(w, err)
			return
		}
		fresh.LyricsHash = lyrics.Hash
		current = fresh
	}
	if llmInputHash(current) != preview.Hash {
		s.expireLLMPreview(w, r, tx, payload.PreviewID, "work_changed", "Work metadata changed. Translate again.")
		return
	}
	if time.Now().After(preview.Expires) {
		s.expireLLMPreview(w, r, tx, payload.PreviewID, "llm_preview_expired", "Translation preview expired. Translate again.")
		return
	}
	var role string
	var enabled bool
	if err := tx.QueryRowContext(r.Context(), "SELECT role,enabled FROM user_account WHERE id=?", actor.ID).Scan(&role, &enabled); err != nil || !enabled || missingWorkflowGraphPermission(account.PermissionsForRole(role), []string{"library:write", "metadata:sync"}) != "" {
		writeAPIError(w, 403, "llm_permission_changed", "Translation permission changed.", false)
		return
	}
	_, scan := llmFields(current, preview.Fields)
	if preview.Lyrics != nil {
		scan["lyrics"] = strings.Join(preview.Lyrics.Document.Text(), "\n")
	}
	if !llmAllowed(policy.Assess(current.Age, scan, current.Tags).Class, provider) {
		s.expireLLMPreview(w, r, tx, payload.PreviewID, "llm_policy_blocked", "Content policy blocks this translation.")
		return
	}
	if len(preview.TagIDs) > 0 {
		if err := applyLLMTagNames(r.Context(), tx, preview, actor.ID); err != nil {
			writeAPIError(w, 409, "work_changed", "Shared tag names changed. Translate again.", false)
			return
		}
	}
	if preview.Lyrics != nil {
		if err := saveLLMLyricsAsset(r.Context(), tx, payload.PreviewID, preview, actor.ID); err != nil {
			writeError(w, err)
			return
		}
	}
	for field, value := range map[string]string{"title": preview.Result.Title, "description": preview.Result.Description} {
		if strings.TrimSpace(value) == "" {
			continue
		}
		if err := archiveLLMTranslation(r.Context(), tx, workID, preview.Target, field, actor.ID, "superseded"); err != nil {
			writeError(w, err)
			return
		}
		source := current.Text.Title
		if field == "description" {
			source = current.Text.Description
		}
		metadataInput := current
		metadataInput.LyricsHash = ""
		if _, err := tx.ExecContext(r.Context(), `INSERT INTO work_llm_translation(work_id,language,field_name,value_text,source_hash,provider_id,model,created_by_user_id,source_text,source_work_id)
 VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(work_id,language,field_name) DO UPDATE SET value_text=excluded.value_text,source_hash=excluded.source_hash,provider_id=excluded.provider_id,model=excluded.model,status='accepted',created_by_user_id=excluded.created_by_user_id,source_text=excluded.source_text,source_work_id=excluded.source_work_id,updated_at=CURRENT_TIMESTAMP`, workID, preview.Target, field, value, llmInputHash(metadataInput), preview.Provider.ID, preview.Payload.Model, actor.ID, source, current.SourceID); err != nil {
			writeError(w, err)
			return
		}
		if err := archiveLLMTranslation(r.Context(), tx, workID, preview.Target, field, actor.ID, "accepted"); err != nil {
			writeError(w, err)
			return
		}
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE llm_translation_preview SET status='accepted',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='proposed'", payload.PreviewID); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	if preview.Lyrics != nil {
		if err := s.publishLLMLyricsAsset(r.Context(), payload.PreviewID); err != nil {
			slog.Warn("lyrics translation publication failed", "asset", payload.PreviewID, "work_id", workID, "error", err)
			writeAPIError(w, 409, "llm_asset_pending", "The translation is kept; adding it to the lyrics did not finish. Add it again from Manage lyrics.", true)
			return
		}
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

func (s *Server) listLLMTranslationModels(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		writeAPIError(w, 403, "llm_disabled", "LLM translation is unavailable in Demo.", false)
		return
	}
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	providers, err := s.llmStore.List(r.Context())
	if err != nil {
		writeError(w, err)
		return
	}
	// With a work, model targets follow the language of its original edition;
	// without one, they cover every declared source.
	source := ""
	if raw := r.URL.Query().Get("workId"); raw != "" {
		workID, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || workID <= 0 {
			writeAPIError(w, 400, "invalid_work_id", "Invalid work id.", false)
			return
		}
		source = s.workOriginLyricsLanguage(r.Context(), workID)
	}
	result := []map[string]any{}
	for _, p := range providers {
		if p.Enabled && p.DefaultModel != "" {
			// Only models restricted to declared directions have targets.
			targets := map[string][]string{}
			for _, model := range p.EnabledModels {
				if languages := p.TranslationTargets(model, source); languages != nil {
					targets[model] = languages
				}
			}
			result = append(result, map[string]any{"id": p.ID, "name": p.Name, "defaultModel": p.DefaultModel, "models": p.EnabledModels, "modelTargets": targets, "boundary": p.Boundary, "maxContentClass": p.MaxContentClass})
		}
	}
	writeJSON(w, 200, result)
}
