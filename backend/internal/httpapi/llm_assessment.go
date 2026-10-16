package httpapi

import (
	"strings"

	"github.com/yexca/kikoto/backend/internal/llm"
)

// assessLLMTranslation uses the complete selected source before chunking or
// per-user tag candidate reuse. Every translation boundary uses this scope.
func assessLLMTranslation(policy llm.Policy, input llmWorkInput, source llm.Text) llm.Assessment {
	if policy.LLMTranslationTextOnly {
		return policy.AssessText(map[string]string{
			"title":       source.Title,
			"description": source.Description,
			"tags":        strings.Join(source.Tags, "\n"),
			"lyrics":      strings.Join(source.Lyrics, "\n"),
		})
	}
	_, scan := llmFields(input, nil)
	scan["lyrics"] = strings.Join(source.Lyrics, "\n")
	return policy.Assess(input.Age, scan, input.Tags)
}
