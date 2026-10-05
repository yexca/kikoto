package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metadatatitles"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

func (s *Server) loadWorkMetadataPresentation(ctx context.Context, workID int64) (workMetadataPresentation, error) {
	result := workMetadataPresentation{Variants: []workMetadataVariant{}}
	variants, err := metasync.ListDLsiteMetadataVariantsWithDescriptions(ctx, s.db, workID)
	if err != nil {
		return result, err
	}
	viewerLanguages := s.viewerMetadataLanguages(ctx)
	tagLanguages := s.viewerTagLanguages(ctx)
	selected, selectedOK, err := metasync.SelectDLsiteMetadataVariant(ctx, s.db, workID, viewerLanguages)
	if err != nil {
		return result, err
	}
	var canonical bool
	err = s.db.QueryRowContext(ctx, "SELECT is_canonical FROM work_edition WHERE work_id=?", workID).Scan(&canonical)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	// Every language edition presents the same tag set: the canonical work's
	// fixed tag source, or a non-canonical edition's own genres. Switching
	// language only renames those tags.
	tagSource, tagSourceOK, err := metasync.SelectDLsiteTagSourceVariant(ctx, s.db, workID)
	if err != nil {
		return result, err
	}
	if !canonical {
		for _, variant := range variants {
			if variant.WorkID == workID {
				selected, tagSource = variant, variant
				selectedOK, tagSourceOK = true, true
				break
			}
		}
	}
	var tagSourceLegacy []string
	if tagSourceOK {
		if err := json.Unmarshal([]byte(tagSource.TagsJSON), &tagSourceLegacy); err != nil {
			return result, err
		}
	}
	overrides, err := s.loadWorkManualOverrides(ctx, workID)
	if err != nil {
		return result, err
	}
	selectedTitle, choices, err := s.loadWorkTitleSelection(ctx, workID)
	if err != nil {
		return result, err
	}
	seen := map[string]bool{}
	for _, variant := range variants {
		key := firstNonEmpty(strings.ToUpper(strings.TrimSpace(variant.PrimaryCode)), strings.ToUpper(strings.TrimSpace(variant.ExternalID)))
		if key == "" {
			key = "variant:" + strconv.FormatInt(variant.ID, 10)
		}
		if seen[key] || strings.TrimSpace(variant.Title) == "" {
			continue
		}
		sourceID, legacy := variant.WorkID, []string{}
		if tagSourceOK {
			sourceID, legacy = tagSource.WorkID, tagSourceLegacy
		} else if err := json.Unmarshal([]byte(variant.TagsJSON), &legacy); err != nil {
			return result, err
		}
		locale := strings.ToLower(variant.RequestLocale)
		if locale == "" {
			locale = dlsite.LocaleForMetadataLanguage(dlsite.EditionMetadataLanguage(variant.EditionLanguage))
		}
		tags, err := metadatatags.PresentationFor(ctx, s.db, workID, sourceID, legacy, tagLanguages, locale)
		if err != nil {
			return result, err
		}
		language := metadatatitles.EditionLanguage(variant.EditionLanguage)
		seen[key] = true
		choice := metadatatitles.ForEdition(metadatatitles.Variant{Code: key, Language: language, Title: variant.Title, Description: variant.Description, Origin: variant.IsCanonical}, overrides.Titles)
		result.Variants = append(result.Variants, workMetadataVariant{
			Key: key, Language: language, Title: choice.Title, Description: variant.Description, TitleSource: choice.Source,
			Tags: cleanProjectedTags(tags), Origin: variant.IsCanonical,
		})
		if selectedOK && selected.ID == variant.ID {
			result.DefaultVariantKey = key
		}
	}
	fallbackTags := []string{}
	for _, variant := range result.Variants {
		if variant.Key == result.DefaultVariantKey {
			fallbackTags = variant.Tags
			break
		}
	}
	if len(result.Variants) == 0 && len(overrides.Titles) > 0 {
		shared, projected, err := s.loadProjectedDLsiteTags(ctx, workID)
		if err != nil {
			return result, err
		}
		var snapshot string
		err = s.db.QueryRowContext(ctx, `SELECT snapshot.snapshot_json FROM metadata_snapshot AS snapshot
   JOIN metadata_provider AS provider ON provider.id=snapshot.provider_id
   WHERE snapshot.work_id=? AND provider.code='dlsite' ORDER BY snapshot.fetched_at DESC,snapshot.id DESC LIMIT 1`, workID).Scan(&snapshot)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return result, err
		}
		fallbackTags = presentProjectedTags(parseDLsiteSnapshot(snapshot).Tags, shared, projected)
		originTitle := choices["origin"]
		result.Variants = append(result.Variants, workMetadataVariant{PresentationOnly: true, Key: originTitle.Code, Language: originTitle.Language, Title: originTitle.Title, Description: originTitle.Description, TitleSource: originTitle.Source, Origin: true, Tags: fallbackTags})
		result.DefaultVariantKey = originTitle.Code
	}
	if canonical || len(variants) == 0 {
		matched := false
		for _, variant := range result.Variants {
			if (variant.Language == selectedTitle.Language || selectedTitle.Language == "") && variant.Key == selectedTitle.Code {
				result.DefaultVariantKey, matched = variant.Key, true
				break
			}
		}
		if !matched && overrides.Titles[selectedTitle.Language] != "" && selectedTitle.Language != "" && len(result.Variants) > 0 {
			tags := result.Variants[0].Tags
			for _, variant := range result.Variants {
				if variant.Key == result.DefaultVariantKey {
					tags = variant.Tags
				}
			}
			key := "manual:" + selectedTitle.Language
			result.Variants = append(result.Variants, workMetadataVariant{PresentationOnly: true, Key: key, Language: selectedTitle.Language, Title: selectedTitle.Title, Description: selectedTitle.Description, TitleSource: selectedTitle.Source, Tags: tags})
			result.DefaultVariantKey = key
		}
	}
	orderWorkMetadataVariants(result.Variants, viewerLanguages)
	for _, language := range []string{"ja-jp", "zh-cn", "zh-tw", "en-us", "ko-kr"} {
		choice := choices[language]
		if overrides.Titles[language] == "" {
			continue
		}
		exists := false
		for _, variant := range result.Variants {
			if variant.Language == language {
				exists = true
				break
			}
		}
		if !exists {
			result.Variants = append(result.Variants, workMetadataVariant{PresentationOnly: true, Key: "manual:" + language, Language: language, Title: choice.Title, Description: choice.Description, TitleSource: choice.Source, Tags: fallbackTags})
			if selectedTitle.Language == language {
				result.DefaultVariantKey = "manual:" + language
			}
		}
	}
	if result.DefaultVariantKey == "" && len(result.Variants) > 0 {
		result.DefaultVariantKey = result.Variants[0].Key
	}
	return result, nil
}

func orderWorkMetadataVariants(variants []workMetadataVariant, priorities []string) {
	orderedPriorities := dlsite.NormalizeMetadataPriority(priorities)
	priorityRanks := make(map[string]int, len(orderedPriorities))
	for index, language := range orderedPriorities {
		if language != dlsite.OriginMetadataLanguage {
			priorityRanks[language] = index
		}
	}
	unknownRank := len(orderedPriorities) + 1
	variantRank := func(variant workMetadataVariant) int {
		language := dlsite.NormalizeMetadataLanguage(variant.Language)
		if rank, ok := priorityRanks[language]; ok {
			return rank
		}
		return unknownRank
	}
	sort.SliceStable(variants, func(left, right int) bool {
		if variants[left].Origin != variants[right].Origin {
			return variants[left].Origin
		}
		if leftRank, rightRank := variantRank(variants[left]), variantRank(variants[right]); leftRank != rightRank {
			return leftRank < rightRank
		}
		leftLanguage := strings.ToLower(strings.TrimSpace(variants[left].Language))
		rightLanguage := strings.ToLower(strings.TrimSpace(variants[right].Language))
		if leftLanguage != rightLanguage {
			return leftLanguage < rightLanguage
		}
		return strings.ToUpper(variants[left].Key) < strings.ToUpper(variants[right].Key)
	})
}

// loadProjectedDLsiteTags returns a work family's shared tags named for the
// viewer. The canonical work row is normally kept in sync by the projection
// writer, but catalog and voice pages can arrive through a non-canonical
// edition and therefore read the fixed tag source edition directly as well.
func (s *Server) loadProjectedDLsiteTags(ctx context.Context, workID int64) ([]string, bool, error) {
	tagLanguages := s.viewerTagLanguages(ctx)
	selected, ok, err := metasync.SelectDLsiteTagSourceVariant(ctx, s.db, workID)
	if err != nil {
		return nil, false, err
	}
	if ok {
		var legacy []string
		if err := json.Unmarshal([]byte(selected.TagsJSON), &legacy); err != nil {
			return nil, false, err
		}
		tags, err := metadatatags.PresentationFor(ctx, s.db, workID, selected.WorkID, legacy, tagLanguages)
		return cleanProjectedTags(tags), true, err
	}
	tags, err := metadatatags.Read(ctx, s.db, workID)
	if err != nil {
		return nil, false, err
	}
	if tagLanguages != nil {
		if tags, err = metadatatags.Localize(ctx, s.db, tags, tagLanguages); err != nil {
			return nil, false, err
		}
	}
	names := []string{}
	for _, tag := range tags {
		names = append(names, tag.DisplayName)
	}
	projected, err := metadatatags.Projected(ctx, s.db, workID)
	if err != nil {
		return nil, false, err
	}
	if !projected && len(names) == 0 {
		return nil, false, nil
	}
	return cleanProjectedTags(names), projected, nil
}

func (s *Server) loadProjectedDLsiteTagsBatch(ctx context.Context, workIDs []int64, legacy map[int64][]string) (map[int64][]string, error) {
	result := make(map[int64][]string, len(workIDs))
	unique := make([]int64, 0, len(workIDs))
	seen := map[int64]bool{}
	for _, workID := range workIDs {
		if workID <= 0 || seen[workID] {
			continue
		}
		seen[workID] = true
		unique = append(unique, workID)
	}
	if len(unique) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(unique))
	args := make([]any, len(unique))
	for index, workID := range unique {
		placeholders[index] = "?"
		args[index] = workID
	}
	// Only a completed per-work projection makes an empty tag set authoritative.
	// A global backfill marker cannot attest to a later snapshot or new work.
	variantRows, err := s.db.QueryContext(ctx, `
		SELECT work_id
		FROM work_metadata_tag_projection
		WHERE work_id IN (`+strings.Join(placeholders, ",")+`)
	`, args...)
	if err != nil {
		return nil, err
	}
	for variantRows.Next() {
		var workID int64
		if err := variantRows.Scan(&workID); err != nil {
			_ = variantRows.Close()
			return nil, err
		}
		result[workID] = []string{}
	}
	if err := variantRows.Err(); err != nil {
		_ = variantRows.Close()
		return nil, err
	}
	if err := variantRows.Close(); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT work_tag.work_id, tag.id, tag.display_name
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE tag.namespace IN ('dlsite','metadata') AND work_tag.work_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY work_tag.work_id ASC, LOWER(tag.display_name), tag.id
	`, args...)
	if err != nil {
		return nil, err
	}
	linked := map[int64][]metadatatags.EffectiveTag{}
	order := []int64{}
	tagIDs := []int64{}
	for rows.Next() {
		var workID int64
		var tag metadatatags.EffectiveTag
		if err := rows.Scan(&workID, &tag.ID, &tag.DisplayName); err != nil {
			_ = rows.Close()
			return nil, err
		}
		if _, exists := linked[workID]; !exists {
			order = append(order, workID)
		}
		linked[workID] = append(linked[workID], tag)
		tagIDs = append(tagIDs, tag.ID)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if tagLanguages := s.viewerTagLanguages(ctx); tagLanguages != nil && len(tagIDs) > 0 {
		names, err := metadatatags.LocalizedNames(ctx, s.db, tagIDs, tagLanguages)
		if err != nil {
			return nil, err
		}
		for _, workID := range order {
			tags := linked[workID]
			for index := range tags {
				if name, ok := names[tags[index].ID]; ok {
					tags[index].DisplayName = name
				}
			}
			sort.SliceStable(tags, func(i, j int) bool {
				left, right := strings.ToLower(tags[i].DisplayName), strings.ToLower(tags[j].DisplayName)
				if left != right {
					return left < right
				}
				return tags[i].ID < tags[j].ID
			})
		}
	}
	for _, workID := range order {
		if _, exists := result[workID]; !exists {
			result[workID] = append([]string{}, legacy[workID]...)
		}
		for _, tag := range linked[workID] {
			result[workID] = append(result[workID], tag.DisplayName)
		}
	}
	// Marker rows denote replacement; links alone are additions to the existing
	// snapshot display (notably remote-only works).
	for _, workID := range unique {
		if tags, exists := result[workID]; exists {
			result[workID] = cleanProjectedTags(tags)
		}
	}
	return result, nil
}

func presentProjectedTags(legacy, shared []string, authoritative bool) []string {
	if authoritative {
		return shared
	}
	return cleanProjectedTags(append(append([]string{}, legacy...), shared...))
}

func cleanProjectedTags(tags []string) []string {
	result := make([]string, 0, len(tags))
	seen := map[string]bool{}
	for _, tag := range tags {
		tag = strings.TrimSpace(tag)
		key := strings.ToLower(tag)
		if tag == "" || seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, tag)
	}
	return result
}
