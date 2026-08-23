package httpapi

import (
	"context"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type remoteCatalogProjector struct {
	languages []string
}

type remoteCatalogWorkProjection struct {
	RemoteID        string
	RemoteCode      string
	Title           string
	ReleaseDate     string
	CoverURL        string
	SourceURL       string
	Circle          string
	CircleRef       *remoteEntityRef
	AgeRating       string
	Rating          *float64
	RatingCount     *int64
	Sales           *int64
	Price           *int64
	Tags            []string
	VoiceActors     []string
	VoiceRefs       []remoteEntityRef
	DurationSeconds *int64
}

func (s *Server) remoteCatalogProjector(ctx context.Context) remoteCatalogProjector {
	return newRemoteCatalogProjectorWithLanguages(s.preferredMetadataLanguages(ctx))
}

func (s *Server) preferredMetadataLanguage(ctx context.Context) string {
	return s.preferredMetadataLanguages(ctx)[0]
}

func newRemoteCatalogProjector(language string) remoteCatalogProjector {
	return newRemoteCatalogProjectorWithLanguages([]string{language})
}

func newRemoteCatalogProjectorWithLanguages(languages []string) remoteCatalogProjector {
	ordered := make([]string, 0, len(languages))
	seen := map[string]bool{}
	for _, raw := range languages {
		language := dlsite.NormalizeMetadataLanguage(raw)
		if language == "" {
			language = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(raw), "_", "-"))
		}
		if language == "" || seen[language] {
			continue
		}
		seen[language] = true
		ordered = append(ordered, language)
	}
	if len(ordered) == 0 {
		ordered = []string{defaultDLsiteMetadataLanguage}
	}
	return remoteCatalogProjector{languages: ordered}
}

func remoteSourceRequestLanguages(language string) []string {
	language = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(language), "_", "-"))
	if language == "" {
		language = strings.ToLower(defaultRemoteRequestLanguage)
	}
	return []string{language}
}

func remoteWorkMetadataPresentation(work kikoeru.Work, languages []string) workMetadataPresentation {
	result := workMetadataPresentation{Variants: []workMetadataVariant{}}
	originLanguage := remoteWorkOriginLanguage(work)
	requested := normalizeRemotePresentationLanguage(firstNonEmpty(languages...))
	if requested == "" || requested == "origin" {
		requested = normalizeRemotePresentationLanguage(defaultRemoteRequestLanguage)
	}
	available := map[string]bool{requested: true}
	if originLanguage != "" {
		available[originLanguage] = true
	}
	for _, tag := range work.Tags {
		for language, localized := range tag.I18n {
			language = normalizeRemotePresentationLanguage(language)
			if language != "" && strings.TrimSpace(localized.Name) != "" {
				available[language] = true
			}
		}
	}
	ordered := make([]string, 0, len(available)+1)
	if originLanguage != "" {
		ordered = append(ordered, originLanguage)
	}
	if requested != originLanguage {
		ordered = append(ordered, requested)
	}
	delete(available, requested)
	delete(available, originLanguage)
	for _, language := range dlsite.SupportedMetadataLanguages {
		if available[language] {
			ordered = append(ordered, language)
			delete(available, language)
		}
	}
	extra := make([]string, 0, len(available))
	for language := range available {
		extra = append(extra, language)
	}
	sort.Strings(extra)
	ordered = append(ordered, extra...)
	if len(ordered) > 16 {
		ordered = ordered[:16]
	}
	title := firstNonEmpty(strings.TrimSpace(work.Title), strings.TrimSpace(work.Name), normalizedRemoteWorkCode(work))
	for _, language := range ordered {
		tags := make([]string, 0, len(work.Tags))
		for _, tag := range work.Tags {
			if name := remoteTagNameForLanguage(tag, language); name != "" {
				tags = append(tags, name)
			}
		}
		result.Variants = append(result.Variants, workMetadataVariant{
			Key: language, Language: language, Title: title, Tags: cleanProjectedTags(tags),
			Origin: originLanguage != "" && normalizeRemotePresentationLanguage(language) == originLanguage,
		})
	}
	orderWorkMetadataVariants(result.Variants, languages)
	result.DefaultVariantKey = requested
	return result
}

func remoteTagNameForLanguage(tag kikoeru.Tag, language string) string {
	normalizedLanguage := normalizeRemotePresentationLanguage(language)
	if localized, ok := tag.I18n[language]; ok && strings.TrimSpace(localized.Name) != "" {
		return strings.TrimSpace(localized.Name)
	}
	for candidate, localized := range tag.I18n {
		if normalizeRemotePresentationLanguage(candidate) == normalizedLanguage && strings.TrimSpace(localized.Name) != "" {
			return strings.TrimSpace(localized.Name)
		}
	}
	return strings.TrimSpace(tag.Name)
}

func remoteWorkOriginLanguage(work kikoeru.Work) string {
	for _, edition := range normalizedRemoteLanguageEditions(work) {
		if !edition.Origin {
			continue
		}
		if language := normalizeRemotePresentationLanguage(edition.Language); language != "" {
			return language
		}
	}
	return ""
}

func normalizeRemotePresentationLanguage(value string) string {
	value = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "_", "-"))
	if normalized := dlsite.NormalizeMetadataLanguage(value); normalized != "" {
		return normalized
	}
	return value
}

func (projector remoteCatalogProjector) project(sourceID int64, work kikoeru.Work) remoteCatalogWorkProjection {
	tags := make([]string, 0, len(work.Tags))
	for _, tag := range work.Tags {
		if name := kikoeru.TagNameForLanguages(tag, projector.languages); name != "" {
			tags = append(tags, name)
		}
	}

	voiceActors := make([]string, 0, len(work.VAs))
	voiceRefs := make([]remoteEntityRef, 0, len(work.VAs))
	for _, voiceActor := range work.VAs {
		name := strings.TrimSpace(voiceActor.Name)
		if name == "" {
			continue
		}
		voiceActors = append(voiceActors, name)
		voiceRefs = append(voiceRefs, remoteEntityRef{
			SourceID: sourceID, ExternalID: strings.TrimSpace(voiceActor.ID), Name: name,
		})
	}

	circle := ""
	var circleRef *remoteEntityRef
	if work.Circle != nil {
		circle = strings.TrimSpace(work.Circle.Name)
		if work.Circle.ID > 0 {
			circleRef = &remoteEntityRef{
				SourceID: sourceID, ExternalID: strconv.FormatInt(work.Circle.ID, 10), Name: circle,
			}
		}
	}

	var duration *int64
	if work.Duration != nil && *work.Duration > 0 {
		value := int64(*work.Duration)
		duration = &value
	}

	return remoteCatalogWorkProjection{
		RemoteID:        strconv.FormatInt(work.ID, 10),
		RemoteCode:      normalizedRemoteWorkCode(work),
		Title:           firstNonEmpty(work.Title, work.Name),
		ReleaseDate:     work.Release,
		CoverURL:        firstNonEmpty(work.MainCoverURL, work.SamCoverURL, work.ThumbnailCoverURL),
		SourceURL:       strings.TrimSpace(work.SourceURL),
		Circle:          circle,
		CircleRef:       circleRef,
		AgeRating:       strings.TrimSpace(work.AgeCategoryString),
		Rating:          work.RateAverage2DP,
		RatingCount:     work.ReviewCount,
		Sales:           work.DLCount,
		Price:           work.Price,
		Tags:            tags,
		VoiceActors:     voiceActors,
		VoiceRefs:       voiceRefs,
		DurationSeconds: duration,
	}
}
