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
	var canonical bool
	err = s.db.QueryRowContext(ctx, "SELECT is_canonical FROM work_edition WHERE work_id=?", workID).Scan(&canonical)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if !canonical {
		for _, variant := range variants {
			if variant.WorkID == workID {
				selected = variant
				selectedOK = true
				break
			}
		}
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
		locale := strings.ToLower(variant.RequestLocale)
		if locale == "" {
			locale = dlsite.LocaleForMetadataLanguage(dlsite.EditionMetadataLanguage(variant.EditionLanguage))
		}
		tags, err = metadatatags.Presentation(ctx, s.db, workID, variant.WorkID, tags, locale)
		if err != nil {
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
	orderWorkMetadataVariants(result.Variants, s.preferredMetadataLanguages(ctx))
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

// loadProjectedDLsiteMetadata returns the language-selected title and tags for
// a work family.  The canonical work row is normally kept in sync by the
// projection writer, but catalog and voice pages can arrive through a
// non-canonical edition and therefore read the variant directly as well.
func (s *Server) loadProjectedDLsiteMetadata(ctx context.Context, workID int64) (string, []string, bool, error) {
	selected, ok, err := metasync.SelectDLsiteMetadataVariant(ctx, s.db, workID, s.preferredMetadataLanguages(ctx))
	if err != nil {
		return "", nil, false, err
	}
	if ok {
		var legacy []string
		if err := json.Unmarshal([]byte(selected.TagsJSON), &legacy); err != nil {
			return "", nil, false, err
		}
		tags, err := metadatatags.Presentation(ctx, s.db, workID, selected.WorkID, legacy)
		return strings.TrimSpace(selected.Title), cleanProjectedTags(tags), true, err
	}
	tags, err := metadatatags.Read(ctx, s.db, workID)
	if err != nil {
		return "", nil, false, err
	}
	names := []string{}
	for _, tag := range tags {
		names = append(names, tag.DisplayName)
	}
	projected, err := metadatatags.Projected(ctx, s.db, workID)
	if err != nil {
		return "", nil, false, err
	}
	if !projected && len(names) == 0 {
		return "", nil, false, nil
	}
	return "", cleanProjectedTags(names), projected, nil
}
func (s *Server) loadProjectedDLsiteTags(ctx context.Context, workID int64) ([]string, bool, error) {
	_, tags, ok, err := s.loadProjectedDLsiteMetadata(ctx, workID)
	return tags, ok, err
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
		SELECT work_tag.work_id, tag.display_name
		FROM work_tag
		INNER JOIN tag ON tag.id = work_tag.tag_id
		WHERE tag.namespace IN ('dlsite','metadata') AND work_tag.work_id IN (`+strings.Join(placeholders, ",")+`)
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
		if _, exists := result[workID]; !exists {
			result[workID] = append([]string{}, legacy[workID]...)
		}
		result[workID] = append(result[workID], tag)
	}
	if err := rows.Err(); err != nil {
		return nil, err
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
