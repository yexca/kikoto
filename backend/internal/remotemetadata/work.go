package remotemetadata

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
)

// Bounds for remote work metadata. A response or snapshot outside them is
// rejected as a whole; nothing from it is applied. A fallback lookup reads at
// most MaxResponseBytes; stored snapshots share the shared-tag snapshot bound.
const (
	MaxResponseBytes    = 2 << 20
	MaxSnapshotBytes    = 8 << 20
	maxTitleBytes       = 2048
	maxCircleBytes      = 512
	maxAgeRatingBytes   = 64
	maxCoverURLBytes    = 4096
	maxTags             = 256
	maxTagNameBytes     = 512
	maxTagLocalizations = 16
	maxDurationSeconds  = 1_000_000
)

var (
	ErrInvalidWork = errors.New("invalid remote work metadata")
	releasePattern = regexp.MustCompile(`^[0-9]{4}-[0-9]{2}-[0-9]{2}`)
)

// Work is the bounded, validated subset of a remote work used for metadata.
type Work struct {
	Code          string
	Title         string
	Release       string
	AgeRating     string
	Duration      int64
	Circle        string
	CoverURL      string
	Tags          []metadatatags.ProviderTag
	TagsDeclared  bool
	TitleVariants []TitleVariant
}

// Decode validates untrusted remote work JSON. It accepts the shape returned
// by a Kikoeru-compatible workInfo response and by its work lists.
func Decode(raw []byte) (Work, error) {
	if len(raw) == 0 || len(raw) > MaxSnapshotBytes {
		return Work{}, ErrInvalidWork
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return Work{}, ErrInvalidWork
	}
	var remote kikoeru.Work
	if err := json.Unmarshal(raw, &remote); err != nil {
		return Work{}, ErrInvalidWork
	}
	work := Work{
		Code:      kikoeru.WorkCode(remote),
		Title:     strings.TrimSpace(firstNonEmpty(remote.Title, remote.Name)),
		AgeRating: strings.TrimSpace(remote.AgeCategoryString),
		CoverURL:  strings.TrimSpace(remote.MainCoverURL),
	}
	if work.Code == "" {
		return Work{}, ErrInvalidWork
	}
	if len(work.Title) > maxTitleBytes || len(work.AgeRating) > maxAgeRatingBytes || len(work.CoverURL) > maxCoverURLBytes {
		return Work{}, ErrInvalidWork
	}
	if strings.EqualFold(work.Title, work.Code) {
		work.Title = ""
	}
	variants, err := decodeTitleVariants(remote)
	if err != nil {
		return Work{}, err
	}
	work.TitleVariants = variants
	if release := strings.TrimSpace(remote.Release); releasePattern.MatchString(release) {
		work.Release = release[:10]
	}
	if remote.Duration != nil && *remote.Duration > 0 && *remote.Duration <= maxDurationSeconds {
		work.Duration = int64(*remote.Duration)
	}
	if remote.Circle != nil {
		work.Circle = strings.TrimSpace(remote.Circle.Name)
		if len(work.Circle) > maxCircleBytes {
			return Work{}, ErrInvalidWork
		}
	}
	if _, declared := fields["tags"]; declared {
		work.TagsDeclared = true
		if len(remote.Tags) > maxTags {
			return Work{}, ErrInvalidWork
		}
		for _, tag := range remote.Tags {
			decoded, err := decodeTag(tag)
			if err != nil {
				return Work{}, err
			}
			if decoded.Name != "" {
				work.Tags = append(work.Tags, decoded)
			}
		}
	}
	return work, nil
}

func decodeTag(tag kikoeru.Tag) (metadatatags.ProviderTag, error) {
	if len(tag.I18n) > maxTagLocalizations {
		return metadatatags.ProviderTag{}, ErrInvalidWork
	}
	result := metadatatags.ProviderTag{Name: strings.TrimSpace(tag.Name), Names: map[string]string{}}
	if len(result.Name) > maxTagNameBytes {
		return metadatatags.ProviderTag{}, ErrInvalidWork
	}
	for language, localized := range tag.I18n {
		name := strings.TrimSpace(localized.Name)
		if len(name) > maxTagNameBytes {
			return metadatatags.ProviderTag{}, ErrInvalidWork
		}
		normalized := dlsite.NormalizeMetadataLanguage(language)
		if name == "" || normalized == "" || normalized == dlsite.OriginMetadataLanguage {
			continue
		}
		// Keep one deterministic value when two keys normalize to one locale.
		if existing, ok := result.Names[normalized]; !ok || name < existing {
			result.Names[normalized] = name
		}
	}
	if result.Name == "" {
		result.Name = firstNonEmpty(result.Names["ja-jp"], result.Names["en-us"], result.Names["zh-cn"], result.Names["zh-tw"], result.Names["ko-kr"])
	}
	return result, nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
