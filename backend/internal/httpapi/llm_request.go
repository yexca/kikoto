package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikotohelper"
	"github.com/yexca/kikoto/backend/internal/llm"
)

type llmRequestError struct{ Code, Message string }

func (e llmRequestError) Error() string     { return e.Message }
func llmInvalid(code, message string) error { return llmRequestError{code, message} }

var errLLMUnsupportedLanguagePair = llmInvalid("llm_unsupported_language_pair", "This model does not support that translation direction.")

type llmTranslationPlan struct {
	Provider llm.Provider
	Model    string
	// SourceLanguage is the language token of the work's original edition, or
	// empty when unknown.
	SourceLanguage string
	Policy         llm.Policy
	Input          llmWorkInput
	Text           llm.Text
	Source         llm.Text
	CachedTags     map[int64]string
	SendingTagIDs  []int64
	Fields         []string
	TagIDs         []int64
	Assessment     llm.Assessment
	Lyrics         *llmLyricsInput
}

// The policy assesses either the complete selected translation source or the
// work's metadata plus selected lyrics before any input is split or reused.
func (s *Server) prepareLLMTranslation(ctx context.Context, workID int64, payload llmTranslatePayload) (llmTranslationPlan, error) {
	var plan llmTranslationPlan
	if s.cfg.IsDemo() {
		return plan, llmInvalid("llm_disabled", "LLM translation is unavailable in Demo.")
	}
	if payload.Target == "" || !validTitleLanguage(payload.Target) {
		return plan, llmInvalid("invalid_translation_request", "Choose a supported target language.")
	}
	seen := map[string]bool{}
	for _, field := range payload.Fields {
		if field != "title" && field != "description" && field != "tags" && field != "lyrics" {
			return plan, llmInvalid("invalid_translation_request", "Choose supported translation fields.")
		}
		if !seen[field] {
			plan.Fields = append(plan.Fields, field)
			seen[field] = true
		}
	}
	if len(plan.Fields) == 0 {
		return plan, llmInvalid("invalid_translation_request", "Choose at least one field.")
	}
	provider, err := s.llmProvider(ctx, payload.ProviderID)
	model, enabled := provider.ResolveModel(payload.Model)
	if err != nil || !provider.Enabled || !enabled {
		return plan, llmInvalid("llm_not_ready", "Choose an enabled provider and model.")
	}
	plan.Provider, plan.Model = provider, model
	plan.Input, err = loadLLMWorkInput(ctx, s.db, workID)
	if err != nil {
		return plan, err
	}
	plan.SourceLanguage = s.workOriginLyricsLanguage(ctx, workID)
	// A direction the model declares it cannot translate is refused before
	// any task is queued or request sent.
	if !provider.TranslatesDirection(model, plan.SourceLanguage, payload.Target) {
		return plan, errLLMUnsupportedLanguagePair
	}
	if len(plan.Input.Text.Title) > 4096 || len(plan.Input.Text.Description) > 64<<10 || len(plan.Input.TagNames) > 64<<10 || len(plan.Input.ManualTitle) > 64<<10 || len(plan.Input.ManualDescription) > 128<<10 {
		return plan, llmInvalid("llm_input_too_large", "Translation input exceeds the text limit.")
	}
	plan.Policy, err = s.llmStore.Policy(ctx)
	if err != nil {
		return plan, err
	}
	text, _ := llmFields(plan.Input, plan.Fields)
	if seen["tags"] {
		plan.TagIDs, text.Tags, err = loadLLMTagCandidates(ctx, s.db, workID, payload.Target)
		if err != nil {
			return plan, llmInvalid("llm_input_too_large", "Shared tag input exceeds the translation limit.")
		}
	}
	if seen["lyrics"] {
		input, err := s.loadLLMLyrics(ctx, workID, payload, plan.Policy)
		if err != nil {
			return plan, err
		}
		plan.Lyrics = &input
		text.Lyrics = input.Document.Text()
		plan.Input.LyricsHash = input.Hash
	}
	plan.Assessment = assessLLMTranslation(plan.Policy, plan.Input, text)
	if !llmAllowed(plan.Assessment.Class, provider) {
		return plan, llmInvalid("llm_policy_blocked", "Content policy blocks this translation. The content exceeds the provider receive maximum, or its class is unknown or blocked.")
	}
	if text.Title == "" && text.Description == "" && len(text.Tags) == 0 && len(text.Lyrics) == 0 {
		return plan, llmInvalid("llm_empty_input", "Selected fields have no text, or shared names are already available.")
	}
	plan.Text = text
	plan.Source = text
	plan.CachedTags = map[int64]string{}
	if len(plan.TagIDs) > 0 {
		actor, ok := userFromContext(ctx)
		if ok {
			sending := []string{}
			for i, id := range plan.TagIDs {
				var name string
				err := s.db.QueryRowContext(ctx, "SELECT name FROM metadata_tag_llm_candidate WHERE tag_id=? AND language=? AND source_text=? AND config_hash=? AND policy_hash=? AND user_id=?", id, payload.Target, text.Tags[i], s.llmConfigHash(provider, model), llmValueHash(plan.Policy), actor.ID).Scan(&name)
				if err == nil {
					plan.CachedTags[id] = name
				} else {
					if !errors.Is(err, sql.ErrNoRows) {
						return plan, err
					}
					plan.SendingTagIDs = append(plan.SendingTagIDs, id)
					sending = append(sending, text.Tags[i])
				}
			}
			plan.Text.Tags = sending
		} else {
			plan.SendingTagIDs = append([]int64{}, plan.TagIDs...)
		}
	}
	return plan, nil
}

func (s *Server) requestLLMTranslation(ctx context.Context, plan llmTranslationPlan, target string, beforeRequest func(context.Context) error) (llm.Text, error) {
	if len(llmPlanRequests(plan)) == 0 {
		return completeLLMTags(plan, llm.Text{}), nil
	}
	// Each request is bounded by the provider's request timeout.
	client, closeClient, err := s.llmClient(ctx, plan.Provider, plan.Provider.RequestTimeout())
	if err != nil {
		return llm.Text{}, llmInvalid("llm_unavailable", "The LLM endpoint is unavailable.")
	}
	defer closeClient()
	result := llm.Text{}
	// Check the complete input before splitting. Each chunk has stable order
	// and retries never advance past an uncertain outgoing request.
	requests := []llm.Text{}
	if plan.Text.Title != "" || plan.Text.Description != "" || len(plan.Text.Tags) > 0 {
		requests = append(requests, llm.Text{Title: plan.Text.Title, Description: plan.Text.Description, Tags: plan.Text.Tags})
	}
	for start := 0; start < len(plan.Text.Lyrics); start += llm.LyricsChunkLines {
		requests = append(requests, llm.Text{Lyrics: plan.Text.Lyrics[start:min(start+llm.LyricsChunkLines, len(plan.Text.Lyrics))]})
	}
	for _, input := range requests {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		if beforeRequest != nil {
			if err := beforeRequest(ctx); err != nil {
				return result, err
			}
		}
		translated, err := client.Translate(ctx, plan.Model, plan.SourceLanguage, target, input)
		switch llmHelperRejection(err) {
		case kikotohelper.FailureUnsupportedLanguagePair:
			return result, errLLMUnsupportedLanguagePair
		case kikotohelper.FailureNotReady:
			return result, llmInvalid("llm_service_not_ready", "The provider has no ready model. Install or choose one in the provider.")
		case kikotohelper.FailureStartFailed:
			return result, llmInvalid("llm_service_start_failed", "The provider could not start its model. Check the provider.")
		case kikotohelper.FailureOutOfMemory:
			return result, llmInvalid("llm_service_out_of_memory", "The provider could not load its model because memory ran out. Free GPU memory or set the helper's GPU sharing to take turns, then retry.")
		}
		if err != nil {
			return result, err
		}
		if input.Title != "" {
			result.Title = translated.Title
		}
		if input.Description != "" {
			result.Description = translated.Description
		}
		result.Tags = append(result.Tags, translated.Tags...)
		result.Lyrics = append(result.Lyrics, translated.Lyrics...)
		if len(strings.Join(result.Lyrics, "\n")) > llm.LyricsLimit {
			return result, llmInvalid("llm_output_too_large", "Translated lyrics exceed the text limit.")
		}
	}
	result = completeLLMTags(plan, result)
	if plan.Lyrics != nil {
		if _, err := plan.Lyrics.Document.Render(result.Lyrics); err != nil {
			return result, llmInvalid("llm_invalid_lyrics_output", "Translation changed lyrics structure or exceeded the output limit.")
		}
	}
	return result, nil
}

// llmHelperRejection names a Kikoto Helper rejection that retrying unchanged
// cannot fix, as a kikotohelper failure code, or returns empty. The helper
// rejects these before any model receives the request.
func llmHelperRejection(err error) string {
	var rejected llm.UpstreamError
	if !errors.As(err, &rejected) {
		return ""
	}
	return kikotohelper.Failure(rejected.Rejection)
}

func writeLLMRequestError(w http.ResponseWriter, err error) {
	var invalid llmRequestError
	if errors.As(err, &invalid) {
		writeAPIError(w, 422, invalid.Code, invalid.Message, false)
		return
	}
	writeAPIError(w, 502, "llm_translation_failed", "Translation failed. Check the configured endpoint and model.", false)
}
