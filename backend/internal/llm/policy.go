package llm

import "github.com/yexca/kikoto/backend/internal/contentpolicy"

// The shared content policy governs both translation and transcription.
type Policy = contentpolicy.Policy
type KeywordRule = contentpolicy.KeywordRule
type TagRule = contentpolicy.TagRule
type Match = contentpolicy.Match
type Assessment = contentpolicy.Assessment

func DefaultPolicy() Policy             { return contentpolicy.DefaultPolicy() }
func NormalizeText(value string) string { return contentpolicy.NormalizeText(value) }
