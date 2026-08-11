package httpapi

import (
	"context"
	"strconv"
	"strings"

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
	return remoteCatalogProjector{languages: []string{normalizeDLsiteLanguage(language)}}
}

func newRemoteCatalogProjectorWithLanguages(languages []string) remoteCatalogProjector {
	ordered, ok := parseDLsiteMetadataLanguages(languages)
	if !ok {
		ordered = []string{defaultDLsiteMetadataLanguage}
	}
	return remoteCatalogProjector{languages: ordered}
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
