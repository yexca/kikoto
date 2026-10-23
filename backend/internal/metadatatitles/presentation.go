// Package metadatatitles selects display titles without changing provider data.
package metadatatitles

import (
	"regexp"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

type Variant struct {
	Code        string
	Language    string
	Title       string
	Description string
	Origin      bool
	// RemoteSource names the remote source whose title the work row holds.
	// Remote titles use only provider-declared edition languages. A title
	// without such a declaration remains the languageless fallback.
	RemoteSource   string
	LLM            bool
	LLMDescription bool
	// ManualDescription is a work's own description for one supported
	// language. It carries no title and never stands for an edition.
	ManualDescription bool
}

type Selection struct {
	Title             string `json:"title"`
	Language          string `json:"language"`
	Source            string `json:"source"`
	SourceName        string `json:"sourceName,omitempty"`
	Code              string `json:"code"`
	Description       string `json:"description"`
	DescriptionSource string `json:"descriptionSource,omitempty"`
}

// EditionLanguage preserves declared unsupported languages and never infers a
// work's language from the locale used to request its metadata.
func EditionLanguage(value string) string {
	if language := dlsite.EditionMetadataLanguage(value); language != "" && language != dlsite.OriginMetadataLanguage {
		return language
	}
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "_", "-"))
}

// DLsite edition labels use a language followed by an edition suffix. Match
// that structure rather than a list of languages; genre labels do not match.
var translationLabel = regexp.MustCompile(`^【(?:[^\s【】]+(?:語版|语版|文版)|[A-Za-z]+(?: [A-Za-z]+)* [Vv]ersion|[^\s【】]+ 자막판)】`)

// Display removes one leading edition label only from a non-original edition.
// Authored titles never pass through this function.
func Display(title string, translation bool) string {
	title = strings.TrimSpace(title)
	if translation {
		if label := translationLabel.FindString(title); label != "" {
			if remaining := strings.TrimSpace(strings.TrimPrefix(title, label)); remaining != "" {
				return remaining
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
// interpreted as a translation of the description. A language-specific manual
// description replaces the description in its language. The result reports
// whether this language has its own edition, language-specific manual title or
// description, or accepted machine field. A global manual title replaces only
// the title text: it never lets a language without an edition win the
// priority order.
func ForLanguage(variants []Variant, manual map[string]string, language string, fallback Variant) (Selection, bool) {
	origin := Original(variants, fallback)
	selected := origin
	found := false
	originalRequested := language == dlsite.OriginMetadataLanguage
	if originalRequested {
		language = origin.Language
	}
	for _, variant := range variants {
		if !variant.LLM && !originalRequested && language != "" && variant.Language == language && strings.TrimSpace(variant.Title) != "" {
			selected, found = variant, true
			break
		}
	}
	var machine, manualDescription Variant
	for _, variant := range variants {
		if !originalRequested && variant.LLM && variant.Language == language {
			machine = variant
			break
		}
	}
	for _, variant := range variants {
		if variant.ManualDescription && language != "" && variant.Language == language {
			manualDescription = variant
			break
		}
	}
	result := Selection{Language: selected.Language, Code: selected.Code, Description: selected.Description, DescriptionSource: "original"}
	if found {
		result.DescriptionSource = "dlsite"
	}
	// A machine field fills only its own gap. A title never selects a media
	// edition or suppresses the original introduction.
	if strings.TrimSpace(machine.Description) != "" && (!found || strings.TrimSpace(selected.Description) == "") {
		result.Description, result.DescriptionSource = machine.Description, "llm"
	}
	if strings.TrimSpace(manualDescription.Description) != "" {
		result.Description, result.DescriptionSource = manualDescription.Description, "manual"
	}
	if title := strings.TrimSpace(manual[language]); language != "" && title != "" {
		result.Title, result.Source, result.Language = title, "manual", language
		return result, true
	}
	result.Title = Display(selected.Title, !selected.Origin && selected.RemoteSource == "")
	result.Source = "original"
	if selected.RemoteSource != "" {
		result.Source, result.SourceName = "remote", selected.RemoteSource
	} else if found {
		result.Source = "dlsite"
	}
	if !found && strings.TrimSpace(machine.Title) != "" {
		result.Title, result.Source, result.Language = machine.Title, "llm", language
		result.SourceName = ""
		found = true
	} else if !found && (machine.LLMDescription || strings.TrimSpace(machine.Description) != "" || manualDescription.ManualDescription) {
		result.Language = language
		found = true
	}
	if title := strings.TrimSpace(manual[""]); title != "" {
		result.Title, result.Source, result.SourceName = title, "manual", ""
	}
	return result, found
}

// ForEdition presents this exact edition, including when its language is
// unsupported or unknown. It must never borrow another edition's title.
func ForEdition(edition Variant, manual map[string]string) Selection {
	result, _ := ForLanguage(nil, manual, dlsite.OriginMetadataLanguage, edition)
	if result.Source == "original" {
		result.Source = "dlsite"
	}
	return result
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

// LanguageTitles returns, for each language Select can stop at, the title it
// would show: every supported language with its own edition, language-specific
// manual title or description, or accepted machine field, and always `origin`. Select over a priority
// list therefore equals the first present entry in that list's order, which
// lets a list sort follow a viewer's priority without a stored preference.
func LanguageTitles(input Inputs) map[string]string {
	result := map[string]string{}
	for _, language := range dlsite.SupportedMetadataLanguages {
		if selection, ok := ForLanguage(input.Variants, input.Manual, language, input.Fallback); ok {
			result[language] = selection.Title
		}
	}
	origin, _ := ForLanguage(input.Variants, input.Manual, dlsite.OriginMetadataLanguage, input.Fallback)
	result[dlsite.OriginMetadataLanguage] = origin.Title
	return result
}
