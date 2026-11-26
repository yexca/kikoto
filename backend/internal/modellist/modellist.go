// Package modellist validates the model selection a model service provider
// stores, shared by the llm and asr configurations.
package modellist

import (
	"errors"
	"slices"
	"strings"
	"unicode"
)

// Normalize trims and deduplicates the enabled models and keeps the default
// among them, falling back to the first. It rejects an invalid model id and a
// list longer than limit.
func Normalize(enabled []string, defaultModel string, limit int) ([]string, string, error) {
	result := []string{}
	for _, id := range enabled {
		id = strings.TrimSpace(id)
		if id == "" || slices.Contains(result, id) {
			continue
		}
		if len(id) > 256 || strings.ContainsFunc(id, unicode.IsControl) {
			return nil, "", errors.New("invalid model id")
		}
		result = append(result, id)
	}
	if len(result) > limit {
		return nil, "", errors.New("too many enabled models")
	}
	defaultModel = strings.TrimSpace(defaultModel)
	if !slices.Contains(result, defaultModel) {
		defaultModel = ""
		if len(result) > 0 {
			defaultModel = result[0]
		}
	}
	return result, defaultModel, nil
}
