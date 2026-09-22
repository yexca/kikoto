package httpapi

import (
	"context"
	"strings"
)

func (s *Server) loadWorkTranslations(ctx context.Context, primaryCode string, baseCode string, editions []workTranslation) ([]workTranslation, error) {
	familyCode := normalizeDLsiteCode(baseCode)
	if familyCode == "" {
		familyCode = normalizeDLsiteCode(primaryCode)
	}
	if familyCode == "" {
		return []workTranslation{}, nil
	}

	translations := []workTranslation{}
	seen := map[string]bool{}
	for _, edition := range editions {
		appendWorkTranslation(&translations, seen, edition, primaryCode)
	}

	if logicalTranslations, err := s.loadLogicalWorkTranslations(ctx, primaryCode); err != nil {
		return nil, err
	} else if len(logicalTranslations) > 0 {
		for _, item := range logicalTranslations {
			if !mergeLogicalWorkTranslation(translations, seen, item, primaryCode) {
				appendWorkTranslation(&translations, seen, item, primaryCode)
			}
		}
	}

	unresolvedCodes := unresolvedWorkTranslationCodes(translations, primaryCode, familyCode)
	materialized, err := s.loadMaterializedWorkTranslationsByCodes(ctx, unresolvedCodes)
	if err != nil {
		return nil, err
	}
	for _, item := range materialized {
		if !mergeMaterializedWorkTranslation(translations, seen, item, primaryCode) {
			appendWorkTranslation(&translations, seen, item, primaryCode)
		}
	}
	if len(translations) <= 1 {
		return []workTranslation{}, nil
	}
	return translations, nil
}

func appendWorkTranslation(translations *[]workTranslation, seen map[string]bool, item workTranslation, primaryCode string) {
	item.PrimaryCode = normalizeDLsiteCode(item.PrimaryCode)
	if item.PrimaryCode == "" || seen[item.PrimaryCode] {
		return
	}
	seen[item.PrimaryCode] = true
	item.Current = strings.EqualFold(item.PrimaryCode, primaryCode)
	item.MediaState = normalizedWorkMediaState(item.WorkID, item.HasMedia, false, item.MediaState)
	*translations = append(*translations, item)
}

func workTranslationIndex(translations []workTranslation, code string) int {
	for index := range translations {
		if strings.EqualFold(translations[index].PrimaryCode, code) {
			return index
		}
	}
	return -1
}

func mergeLogicalWorkTranslation(translations []workTranslation, seen map[string]bool, item workTranslation, primaryCode string) bool {
	code := normalizeDLsiteCode(item.PrimaryCode)
	if !seen[code] {
		return false
	}
	index := workTranslationIndex(translations, code)
	if index < 0 {
		return false
	}
	target := &translations[index]
	target.WorkID = item.WorkID
	target.Title = item.Title
	target.HasMedia = item.HasMedia
	target.MediaState = item.MediaState
	target.LocalAvailable = item.LocalAvailable
	target.EditionLabel = firstNonEmpty(target.EditionLabel, item.EditionLabel)
	target.TranslationKind = item.TranslationKind
	target.Official = item.Official
	if target.MetadataLanguage == "" {
		target.MetadataLanguage = item.MetadataLanguage
	}
	target.Current = strings.EqualFold(item.PrimaryCode, primaryCode)
	return true
}

func mergeMaterializedWorkTranslation(translations []workTranslation, seen map[string]bool, item workTranslation, primaryCode string) bool {
	code := normalizeDLsiteCode(item.PrimaryCode)
	if !seen[code] {
		return false
	}
	index := workTranslationIndex(translations, code)
	if index < 0 {
		return false
	}
	target := &translations[index]
	target.WorkID = item.WorkID
	target.Title = item.Title
	target.HasMedia = item.HasMedia
	target.MediaState = item.MediaState
	target.LocalAvailable = item.LocalAvailable
	target.Current = strings.EqualFold(item.PrimaryCode, primaryCode)
	return true
}

func unresolvedWorkTranslationCodes(translations []workTranslation, primaryCode, familyCode string) []string {
	codes := make([]string, 0, len(translations)+2)
	seen := map[string]bool{}
	add := func(code string) {
		code = normalizeDLsiteCode(code)
		if code == "" || seen[code] {
			return
		}
		seen[code] = true
		codes = append(codes, code)
	}
	for _, item := range translations {
		if item.WorkID == nil {
			add(item.PrimaryCode)
		}
	}
	add(primaryCode)
	add(familyCode)
	return codes
}

func (s *Server) loadMaterializedWorkTranslationsByCodes(ctx context.Context, codes []string) ([]workTranslation, error) {
	if len(codes) == 0 {
		return []workTranslation{}, nil
	}
	marks := make([]string, len(codes))
	args := make([]any, len(codes))
	for index, code := range codes {
		marks[index] = "?"
		args[index] = normalizeDLsiteCode(code)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			work.id,
			work.primary_code,
			work.title,
			EXISTS (
				SELECT 1
				FROM media_file_location AS location
				INNER JOIN media_item AS media ON media.id = location.media_item_id
				WHERE media.work_id = work.id
					AND location.availability = 'available'
			),
			EXISTS (
				SELECT 1
				FROM work_source_presence AS presence
				INNER JOIN file_source AS source ON source.id = presence.file_source_id
				WHERE presence.work_id = work.id
					AND presence.presence_type = 'local'
					AND presence.availability = 'available'
					AND source.source_type = 'local_folder'
			),
			EXISTS (
				SELECT 1
				FROM media_file_location AS location
				INNER JOIN media_item AS media ON media.id = location.media_item_id
				WHERE media.work_id = work.id
					AND location.location_type = 'local'
					AND location.availability = 'available'
			)
		FROM work
		WHERE UPPER(work.primary_code) IN (`+strings.Join(marks, ",")+`)
		ORDER BY work.primary_code ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()

	translations := make([]workTranslation, 0, len(codes))
	for rows.Next() {
		var item workTranslation
		var workID int64
		var hasLocalPresence bool
		var hasLocalMedia bool
		if err := rows.Scan(&workID, &item.PrimaryCode, &item.Title, &item.HasMedia, &hasLocalPresence, &hasLocalMedia); err != nil {
			return nil, err
		}
		item.WorkID = &workID
		item.LocalAvailable = hasLocalPresence || hasLocalMedia
		item.MediaState = normalizedWorkMediaState(item.WorkID, item.HasMedia, hasLocalPresence, "")
		translations = append(translations, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return translations, nil
}

func (s *Server) loadLogicalWorkTranslations(ctx context.Context, primaryCode string) ([]workTranslation, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			edition.work_id,
			edition.primary_code,
			work.title,
			edition.metadata_language,
			edition.edition_label,
			edition.is_canonical,
			 edition.translation_kind,
			EXISTS (
				SELECT 1
				FROM media_file_location AS location
				INNER JOIN media_item AS media ON media.id = location.media_item_id
				WHERE media.work_id = edition.work_id
					AND location.availability = 'available'
			),
			EXISTS (
				SELECT 1
				FROM work_source_presence AS presence
				INNER JOIN file_source AS source ON source.id = presence.file_source_id
				WHERE presence.work_id = edition.work_id
					AND presence.presence_type = 'local'
					AND presence.availability = 'available'
					AND source.source_type = 'local_folder'
			),
			EXISTS (
				SELECT 1
				FROM media_file_location AS location
				INNER JOIN media_item AS media ON media.id = location.media_item_id
				WHERE media.work_id = edition.work_id
					AND location.location_type = 'local'
					AND location.availability = 'available'
			)
		FROM work_edition AS current
		INNER JOIN work_edition AS edition ON edition.logical_work_id = current.logical_work_id
		INNER JOIN work ON work.id = edition.work_id
		WHERE UPPER(current.primary_code) = UPPER(?)
		ORDER BY edition.is_canonical DESC, edition.primary_code ASC
	`, primaryCode)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	translations := []workTranslation{}
	for rows.Next() {
		var item workTranslation
		var workID int64
		var hasLocalPresence bool
		var hasLocalMedia bool
		if err := rows.Scan(&workID, &item.PrimaryCode, &item.Title, &item.MetadataLanguage, &item.EditionLabel, &item.Origin, &item.TranslationKind, &item.HasMedia, &hasLocalPresence, &hasLocalMedia); err != nil {
			return nil, err
		}
		item.WorkID = &workID
		item.LocalAvailable = hasLocalPresence || hasLocalMedia
		item.Official = item.TranslationKind == "official"
		item.Current = strings.EqualFold(item.PrimaryCode, primaryCode)
		item.MediaState = normalizedWorkMediaState(item.WorkID, item.HasMedia, hasLocalPresence, "")
		translations = append(translations, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return translations, nil
}
