package httpapi

import (
	"context"
	"slices"
	"strings"
)

// Long previews and chunked requests retain their exact source and endpoint.
// Recheck mutable boundaries immediately before each outgoing request.
func (s *Server) validateLLMSend(ctx context.Context, userID, workID int64, payload llmTranslatePayload, plan llmTranslationPlan) error {
	actor, err := s.accountStore.LoadByID(ctx, userID)
	if err != nil || !userHasPermission(actor, "library:write") || !userHasPermission(actor, "metadata:sync") {
		return llmInvalid("llm_permission_changed", "Translation permission changed.")
	}
	provider, err := s.llmProvider(ctx, payload.ProviderID)
	if err != nil || !provider.Enabled || s.llmConfigHash(provider, plan.Model) != s.llmConfigHash(plan.Provider, plan.Model) {
		return llmInvalid("llm_config_changed", "Provider configuration changed. Translate again.")
	}
	policy, err := s.llmStore.Policy(ctx)
	if err != nil || llmValueHash(policy) != llmValueHash(plan.Policy) {
		return llmInvalid("llm_policy_changed", "Content policy changed. Translate again.")
	}
	input, err := loadLLMWorkInput(ctx, s.db, workID)
	if err != nil {
		return llmInvalid("work_changed", "Source metadata is unavailable.")
	}
	input.LyricsHash = plan.Input.LyricsHash
	if llmInputHash(input) != llmInputHash(plan.Input) {
		return llmInvalid("work_changed", "Source metadata changed. Translate again.")
	}
	if slices.Contains(plan.Fields, "tags") {
		ids, names, err := loadLLMTagCandidates(ctx, s.db, workID, payload.Target)
		if err != nil || !slices.Equal(ids, plan.TagIDs) || !slices.Equal(names, plan.Source.Tags) {
			return llmInvalid("work_changed", "Shared tag names changed. Translate again.")
		}
	}
	_, scan := llmFields(input, plan.Fields)
	if plan.Lyrics != nil {
		scan["lyrics"] = strings.Join(plan.Text.Lyrics, "\n")
	}
	if !llmAllowed(policy.Assess(input.Age, scan, input.Tags).Class, provider) {
		return llmInvalid("llm_policy_blocked", "Content policy blocks this translation.")
	}
	return nil
}
