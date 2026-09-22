package httpapi

import (
	"encoding/json"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

type dlsiteSnapshotMetadata struct {
	Circle           string
	CircleExternalID string
	BaseCode         string
	MetadataLanguage string
	LanguageEditions []workTranslation
	ReleaseDate      *string
	RatingCount      *int64
	Series           string
	DLsiteUpdatedAt  *string
	Tags             []string
	VoiceActors      []string
}

type dlsiteSnapshotLanguage struct {
	Language         string `json:"language"`
	ResponseLanguage string `json:"response_language"`
	EditionLanguage  string `json:"edition_language"`
}

type dlsiteSnapshotEnvelope struct {
	Product json.RawMessage        `json:"product"`
	Dynamic json.RawMessage        `json:"dynamic"`
	Kikoto  dlsiteSnapshotLanguage `json:"_kikoto"`
}

type dlsiteSnapshotGenre struct {
	Name     string `json:"name"`
	NameBase string `json:"name_base"`
}

type dlsiteSnapshotSeriesWork struct {
	Title string `json:"title"`
	Name  string `json:"name"`
}

type dlsiteSnapshotTranslationInfo struct {
	OriginalWorkNo string `json:"original_workno"`
	ParentWorkNo   string `json:"parent_workno"`
	Lang           string `json:"lang"`
}

type dlsiteSnapshotEdition struct {
	WorkNo       string `json:"workno"`
	DisplayOrder int    `json:"display_order"`
	Label        string `json:"label"`
	Lang         string `json:"lang"`
}

type dlsiteSnapshotPayload struct {
	MakerName          string                        `json:"maker_name"`
	MakerID            string                        `json:"maker_id"`
	CircleID           string                        `json:"circle_id"`
	BrandID            string                        `json:"brand_id"`
	LabelID            string                        `json:"label_id"`
	WorkNo             string                        `json:"workno"`
	ProductID          string                        `json:"product_id"`
	OriginalWorkNo     string                        `json:"original_workno"`
	OriginalWorkNumber string                        `json:"original_work_number"`
	BaseWorkNo         string                        `json:"base_workno"`
	BaseCode           string                        `json:"base_code"`
	Language           string                        `json:"language"`
	Locale             string                        `json:"locale"`
	ReleaseDate        string                        `json:"release_date"`
	UpdateDate         string                        `json:"update_date"`
	ModifyDate         string                        `json:"modify_date"`
	RateCount          *int64                        `json:"rate_count"`
	ReviewCount        *int64                        `json:"review_count"`
	SeriesName         string                        `json:"series_name"`
	Series             string                        `json:"series"`
	Genres             []dlsiteSnapshotGenre         `json:"genres"`
	SeriesWork         []dlsiteSnapshotSeriesWork    `json:"series_work"`
	Creators           dlsite.Creators               `json:"creaters"`
	Kikoto             dlsiteSnapshotLanguage        `json:"_kikoto"`
	TranslationInfo    dlsiteSnapshotTranslationInfo `json:"translation_info"`
	LanguageEditions   []dlsiteSnapshotEdition       `json:"language_editions"`
}

func parseDLsiteSnapshot(raw string) dlsiteSnapshotMetadata {
	metadata := dlsiteSnapshotMetadata{Tags: []string{}, VoiceActors: []string{}}
	envelope, payload, ok := decodeDLsiteSnapshot(raw)
	if !ok {
		return metadata
	}
	metadata.Circle = strings.TrimSpace(payload.MakerName)
	metadata.CircleExternalID = strings.ToUpper(strings.TrimSpace(firstNonEmpty(payload.MakerID, payload.CircleID, payload.BrandID, payload.LabelID)))
	metadata.BaseCode = normalizeDLsiteCode(firstNonEmpty(payload.TranslationInfo.OriginalWorkNo, payload.TranslationInfo.ParentWorkNo, payload.OriginalWorkNo, payload.OriginalWorkNumber, payload.BaseWorkNo, payload.BaseCode))
	currentCode := normalizeDLsiteCode(firstNonEmpty(payload.WorkNo, payload.ProductID))
	originCode, currentLanguage := dlsiteEditionSummary(payload.LanguageEditions, currentCode)
	metadata.LanguageEditions = buildDLsiteLanguageEditions(payload.LanguageEditions, originCode, currentCode)
	if metadata.BaseCode == "" && originCode != "" && !strings.EqualFold(originCode, currentCode) {
		metadata.BaseCode = originCode
	}
	if metadata.BaseCode == currentCode {
		metadata.BaseCode = ""
	}
	metadata.MetadataLanguage = strings.TrimSpace(firstNonEmpty(
		envelope.Kikoto.EditionLanguage, payload.Kikoto.EditionLanguage, currentLanguage,
		envelope.Kikoto.Language, payload.Kikoto.Language, payload.Language, payload.Locale,
		payload.TranslationInfo.Lang,
	))
	metadata.ReleaseDate = trimmedSnapshotPointer(payload.ReleaseDate)
	metadata.DLsiteUpdatedAt = trimmedSnapshotPointer(firstNonEmpty(payload.UpdateDate, payload.ModifyDate))
	if payload.RateCount != nil {
		metadata.RatingCount = payload.RateCount
	} else {
		metadata.RatingCount = payload.ReviewCount
	}
	metadata.Series = dlsiteSnapshotSeries(payload)
	metadata.Tags = uniqueDLsiteSnapshotTags(payload.Genres)
	metadata.VoiceActors = uniqueDLsiteSnapshotActors(payload.Creators)
	return metadata
}

func decodeDLsiteSnapshot(raw string) (dlsiteSnapshotEnvelope, dlsiteSnapshotPayload, bool) {
	if strings.TrimSpace(raw) == "" {
		return dlsiteSnapshotEnvelope{}, dlsiteSnapshotPayload{}, false
	}
	envelope := dlsiteSnapshotEnvelope{}
	rawBytes := []byte(raw)
	if err := json.Unmarshal(rawBytes, &envelope); err == nil && len(envelope.Product) > 0 {
		rawBytes = envelope.Product
	}
	payload := dlsiteSnapshotPayload{}
	if err := json.Unmarshal(rawBytes, &payload); err != nil {
		return dlsiteSnapshotEnvelope{}, dlsiteSnapshotPayload{}, false
	}
	applyDLsiteDynamicCounts(&payload, envelope.Dynamic)
	return envelope, payload, true
}

func applyDLsiteDynamicCounts(payload *dlsiteSnapshotPayload, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var dynamic struct {
		RateCount   *int64 `json:"rate_count"`
		ReviewCount *int64 `json:"review_count"`
	}
	if err := json.Unmarshal(raw, &dynamic); err != nil {
		return
	}
	if dynamic.RateCount != nil {
		payload.RateCount = dynamic.RateCount
	} else if dynamic.ReviewCount != nil {
		payload.ReviewCount = dynamic.ReviewCount
	}
}

func dlsiteEditionSummary(editions []dlsiteSnapshotEdition, currentCode string) (string, string) {
	originCode := ""
	originOrder := 0
	currentLanguage := ""
	for index, edition := range editions {
		code := normalizeDLsiteCode(edition.WorkNo)
		if code == "" {
			continue
		}
		order := edition.DisplayOrder
		if order <= 0 {
			order = index + 1
		}
		if originCode == "" || order < originOrder {
			originCode, originOrder = code, order
		}
		if strings.EqualFold(code, currentCode) {
			currentLanguage = strings.TrimSpace(firstNonEmpty(edition.Lang, edition.Label))
		}
	}
	return originCode, currentLanguage
}

func buildDLsiteLanguageEditions(editions []dlsiteSnapshotEdition, originCode, currentCode string) []workTranslation {
	translations := []workTranslation{}
	for _, edition := range editions {
		code := normalizeDLsiteCode(edition.WorkNo)
		if code == "" {
			continue
		}
		isOrigin := strings.EqualFold(code, originCode)
		translations = append(translations, workTranslation{
			PrimaryCode: code, MetadataLanguage: firstNonEmpty(edition.Lang, edition.Label),
			EditionLabel: strings.TrimSpace(edition.Label), Origin: isOrigin, Official: false,
			TranslationKind: map[bool]string{true: "origin", false: "unknown"}[isOrigin],
			Current:         strings.EqualFold(code, currentCode),
		})
	}
	return translations
}

func trimmedSnapshotPointer(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}

func dlsiteSnapshotSeries(payload dlsiteSnapshotPayload) string {
	series := strings.TrimSpace(firstNonEmpty(payload.SeriesName, payload.Series))
	if series != "" {
		return series
	}
	for _, item := range payload.SeriesWork {
		if series = strings.TrimSpace(firstNonEmpty(item.Title, item.Name)); series != "" {
			return series
		}
	}
	return ""
}

func uniqueDLsiteSnapshotTags(genres []dlsiteSnapshotGenre) []string {
	seen := map[string]bool{}
	tags := []string{}
	for _, genre := range genres {
		name := strings.TrimSpace(genre.Name)
		if name == "" {
			name = strings.TrimSpace(genre.NameBase)
		}
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		tags = append(tags, name)
	}
	return tags
}

func uniqueDLsiteSnapshotActors(creators dlsite.Creators) []string {
	seen := map[string]bool{}
	actors := []string{}
	for _, creator := range creators["voice_by"] {
		name := strings.TrimSpace(creator.Name)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		actors = append(actors, name)
	}
	return actors
}

func parsePartyLink(value string) (string, string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ""
	}
	parts := strings.SplitN(value, "|", 2)
	name := strings.TrimSpace(parts[0])
	externalID := ""
	if len(parts) > 1 {
		externalID = strings.ToUpper(strings.TrimSpace(parts[1]))
	}
	return name, externalID
}

func parseSeriesLink(value string) (string, string) {
	value = strings.TrimSpace(value)
	if value == "" {
		return "", ""
	}
	parts := strings.SplitN(value, "|", 2)
	name := strings.TrimSpace(parts[0])
	titleID := ""
	if len(parts) > 1 {
		titleID = strings.TrimSpace(parts[1])
	}
	return name, titleID
}

func normalizeDLsiteCode(value string) string {
	value = strings.ToUpper(strings.TrimSpace(value))
	if len(value) >= 7 && len(value) <= 10 && (strings.HasPrefix(value, "RJ") || strings.HasPrefix(value, "BJ") || strings.HasPrefix(value, "VJ")) {
		for _, char := range value[2:] {
			if char < '0' || char > '9' {
				return ""
			}
		}
		return value
	}
	return ""
}

func (s *Server) dlsiteURL(primaryCode string) string { return s.dlsiteEndpoints.WorkURL(primaryCode) }
