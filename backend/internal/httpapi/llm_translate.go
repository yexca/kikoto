package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

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
	manualAges := []string{}
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
			manualAges = append(manualAges, value)
		}
	}
	if err := manualRows.Err(); err != nil {
		_ = manualRows.Close()
		return result, err
	}
	_ = manualRows.Close()
	// A manual rating fills in a missing provider rating or makes a known one
	// stricter; one that is not a known rating leaves the work unknown.
	for _, value := range manualAges {
		if agerating.Strictness(value) == 0 {
			result.Age = "unknown"
			break
		}
		result.Age = agerating.Effective(result.Age, value)
	}
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

func (s *Server) listLLMTranslationModels(w http.ResponseWriter, r *http.Request) {
	// Every account that may translate a category chooses among the models.
	actor, ok := userFromContext(r.Context())
	if !ok {
		writeAPIError(w, http.StatusUnauthorized, "login_required", "login required", false)
		return
	}
	if !s.cfg.IsDemo() && !canUseTranslationCenter(actor) && !userHasPermission(actor, "metadata:sync") {
		writeAPIError(w, http.StatusForbidden, "permission_denied", "permission denied", false)
		return
	}
	providers, err := s.translationModelProviders(r.Context())
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
			// Only models restricted to declared directions have targets and
			// pairs; the pairs check sources other than the original, such
			// as a lyrics file in another language.
			targets := map[string][]string{}
			pairs := map[string][]llm.LanguagePair{}
			for _, model := range p.EnabledModels {
				if languages := p.TranslationTargets(model, source); languages != nil {
					targets[model] = languages
					pairs[model] = p.TranslationPairs(model)
				}
			}
			result = append(result, map[string]any{"id": p.ID, "name": p.Name, "defaultModel": p.DefaultModel, "models": p.EnabledModels, "modelTargets": targets, "modelPairs": pairs, "boundary": p.Boundary, "maxContentClass": p.MaxContentClass})
		}
	}
	writeJSON(w, 200, result)
}
