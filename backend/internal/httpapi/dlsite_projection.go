package httpapi

import (
	"context"
	"encoding/json"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
)

func (s *Server) loadWorkMetadataPresentation(ctx context.Context, workID int64) (workMetadataPresentation, error) {
	result := workMetadataPresentation{Variants: []workMetadataVariant{}}
	variants, err := metasync.ListDLsiteMetadataVariants(ctx, s.db, workID)
	if err != nil {
		return result, err
	}
	selected, selectedOK, err := metasync.SelectDLsiteMetadataVariant(ctx, s.db, workID, s.preferredMetadataLanguages(ctx))
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
		var tags []string
		if err := json.Unmarshal([]byte(variant.TagsJSON), &tags); err != nil {
			return result, err
		}
		language := dlsite.EditionMetadataLanguage(variant.EditionLanguage)
		if language == "" {
			language = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(variant.EditionLanguage), "_", "-"))
		}
		if language == "" {
			language = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(variant.RequestLocale), "_", "-"))
		}
		seen[key] = true
		result.Variants = append(result.Variants, workMetadataVariant{
			Key: key, Language: language, Title: strings.TrimSpace(variant.Title),
			Tags: cleanProjectedTags(tags), Origin: variant.IsCanonical,
		})
		if selectedOK && selected.ID == variant.ID {
			result.DefaultVariantKey = key
		}
	}
	if result.DefaultVariantKey == "" && len(result.Variants) > 0 {
		result.DefaultVariantKey = result.Variants[0].Key
	}
	return result, nil
}

// loadProjectedDLsiteMetadata returns the language-selected title and tags for
// a work family.  The canonical work row is normally kept in sync by the
// projection writer, but catalog and voice pages can arrive through a
// non-canonical edition and therefore read the variant directly as well.
func (s *Server) loadProjectedDLsiteMetadata(ctx context.Context, workID int64) (string, []string, bool, error) {
	selected, ok, err := metasync.SelectDLsiteMetadataVariant(ctx, s.db, workID, s.preferredMetadataLanguages(ctx))
	if err != nil || !ok {
		return "", nil, false, err
	}
	var tags []string
	if err := json.Unmarshal([]byte(selected.TagsJSON), &tags); err != nil {
		return "", nil, false, err
	}
	return strings.TrimSpace(selected.Title), cleanProjectedTags(tags), true, nil
}

func (s *Server) loadProjectedDLsiteTags(ctx context.Context, workID int64) ([]string, bool, error) {
	_, tags, ok, err := s.loadProjectedDLsiteMetadata(ctx, workID)
	if err != nil {
		return nil, false, err
	}
	if ok {
		return tags, true, nil
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT tag.display_name
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE work_tag.work_id = ? AND work_tag.source = 'dlsite'
		ORDER BY LOWER(tag.display_name), tag.id
	`, workID)
	if err != nil {
		return nil, false, err
	}
	defer rows.Close()
	tags = []string{}
	for rows.Next() {
		var tag string
		if err := rows.Scan(&tag); err != nil {
			return nil, false, err
		}
		tags = append(tags, tag)
	}
	if err := rows.Err(); err != nil {
		return nil, false, err
	}
	if len(tags) == 0 {
		return nil, false, nil
	}
	return cleanProjectedTags(tags), false, nil
}

func (s *Server) loadProjectedDLsiteTagsBatch(ctx context.Context, workIDs []int64) (map[int64][]string, error) {
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
	// An empty localized tag set is meaningful. Mark works with a stored
	// variant before loading rows from work_tag so an empty projection clears
	// the snapshot fallback instead of leaving stale tags in the card.
	variantRows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT work_id
		FROM dlsite_metadata_variant
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
		SELECT work_tag.work_id, tag.display_name
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE work_tag.source = 'dlsite' AND work_tag.work_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY work_tag.work_id ASC, LOWER(tag.display_name), tag.id
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var tag string
		if err := rows.Scan(&workID, &tag); err != nil {
			return nil, err
		}
		result[workID] = append(result[workID], tag)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for workID, tags := range result {
		result[workID] = cleanProjectedTags(tags)
	}
	return result, nil
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
