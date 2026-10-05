// Package metadatatitles selects display titles without changing provider data.
package metadatatitles

import (
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"strings"
)

type Variant struct {
	Code        string
	Language    string
	Title       string
	Description string
	Origin      bool
	Translation bool
}

type Selection struct {
	Title       string `json:"title"`
	Language    string `json:"language"`
	Source      string `json:"source"`
	Code        string `json:"code"`
	Description string `json:"description"`
}

// Display removes a known leading edition label only from declared translations.
// Authored titles never pass through this function.
func Display(title string, translation bool) string {
	title = strings.TrimSpace(title)
	if translation {
		for _, label := range []string{"【简体中文版】", "【簡体中文版】", "【繁體中文版】", "【繁体中文版】", "【한국어 자막판】", "【English Version】", "【English version】", "【英語版】", "【韓国語版】"} {
			if strings.HasPrefix(title, label) && strings.TrimSpace(strings.TrimPrefix(title, label)) != "" {
				return strings.TrimSpace(strings.TrimPrefix(title, label))
			}
		}
	}
	return title
}

func Original(variants []Variant, fallback Variant) Variant {
	for _, variant := range variants {
		if variant.Origin && strings.TrimSpace(variant.Title) != "" {
			return variant
		}
	}
	return fallback
}

// ForLanguage applies locale manual > global manual > matching edition.
// Missing editions use the original description; a manual title is never
// interpreted as a translation of the description.
func ForLanguage(variants []Variant, manual map[string]string, language string, fallback Variant) (Selection, bool) {
	origin := Original(variants, fallback)
	selected := origin
	found := false
	originalRequested := language == dlsite.OriginMetadataLanguage
	if originalRequested {
		language = origin.Language
	}
	for _, variant := range variants {
		if !originalRequested && language != "" && variant.Language == language && strings.TrimSpace(variant.Title) != "" {
			selected, found = variant, true
			break
		}
	}
	result := Selection{Language: language, Code: selected.Code, Description: selected.Description}
	if title := strings.TrimSpace(manual[language]); language != "" && title != "" {
		result.Title, result.Source = title, "manual"
		return result, true
	}
	if title := strings.TrimSpace(manual[""]); title != "" {
		result.Title, result.Source = title, "manual"
		return result, true
	}
	result.Title = Display(selected.Title, selected.Translation)
	result.Source = "original"
	if found {
		result.Source = "dlsite"
	}
	return result, found
}

func Select(variants []Variant, manual map[string]string, priorities []string, fallback Variant) Selection {
	for _, language := range dlsite.NormalizeMetadataPriority(priorities) {
		result, ok := ForLanguage(variants, manual, language, fallback)
		if ok || language == dlsite.OriginMetadataLanguage {
			return result
		}
	}
	result, _ := ForLanguage(variants, manual, dlsite.OriginMetadataLanguage, fallback)
	return result
}
