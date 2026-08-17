package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

type remoteFetchPreparation struct {
	RequestedCode  string               `json:"requestedCode"`
	CanonicalCode  string               `json:"canonicalCode"`
	MetadataStatus string               `json:"metadataStatus"`
	Warnings       []string             `json:"warnings"`
	Editions       []remoteFetchEdition `json:"editions"`
}

type remoteFetchEdition struct {
	WorkID               int64                       `json:"workId"`
	PrimaryCode          string                      `json:"primaryCode"`
	Title                string                      `json:"title"`
	MetadataLanguage     string                      `json:"metadataLanguage"`
	EditionLabel         string                      `json:"editionLabel"`
	TranslationKind      string                      `json:"translationKind"`
	ClassificationSource string                      `json:"classificationSource"`
	MakerID              string                      `json:"makerId"`
	OriginMakerID        string                      `json:"originMakerId"`
	Origin               bool                        `json:"origin"`
	LocalRoots           []remoteFetchLocalRoot      `json:"localRoots"`
	Sources              []sourceAvailabilitySummary `json:"sources"`
}

type remoteFetchLocalRoot struct {
	ID           int64  `json:"id"`
	FileSourceID int64  `json:"fileSourceId"`
	RootPath     string `json:"rootPath"`
	Role         string `json:"role"`
	State        string `json:"state"`
	Primary      bool   `json:"primary"`
}

func (s *Server) prepareRemoteFetch(ctx context.Context, requestedCode string) remoteFetchPreparation {
	requestedCode = strings.ToUpper(strings.TrimSpace(requestedCode))
	result := remoteFetchPreparation{
		RequestedCode:  requestedCode,
		CanonicalCode:  requestedCode,
		MetadataStatus: "complete",
		Warnings:       []string{},
		Editions:       []remoteFetchEdition{},
	}
	editions, err := s.loadRemoteFetchEditions(ctx, requestedCode)
	if err != nil {
		result.MetadataStatus = "degraded"
		result.Warnings = append(result.Warnings, err.Error())
		return result
	}
	for _, edition := range editions {
		if edition.Origin {
			result.CanonicalCode = edition.PrimaryCode
			break
		}
	}
	for index := range editions {
		editions[index].LocalRoots, err = s.loadRemoteFetchLocalRoots(ctx, editions[index].WorkID, editions[index].PrimaryCode)
		if err != nil {
			result.Warnings = append(result.Warnings, editions[index].PrimaryCode+" local roots: "+err.Error())
		}
		availability, checkErr := s.readWorkSourceAvailability(ctx, editions[index].PrimaryCode)
		if checkErr != nil {
			result.Warnings = append(result.Warnings, editions[index].PrimaryCode+" sources: "+checkErr.Error())
		} else {
			editions[index].Sources = availability.Sources
		}
	}
	result.Editions = editions
	return result
}

func (s *Server) ensureRemoteFetchMetadata(ctx context.Context, requestedCode string) error {
	requestedCode = normalizeDLsiteCode(requestedCode)
	if requestedCode == "" {
		return nil
	}
	ready, err := s.remoteFetchMetadataReady(ctx, requestedCode)
	if err != nil {
		return err
	}
	if ready {
		return nil
	}
	return s.syncWorkEntityMetadata(ctx, requestedCode)
}

func (s *Server) remoteFetchMetadataReady(ctx context.Context, requestedCode string) (bool, error) {
	var originLanguage, editionLanguage, requestLocale string
	err := s.db.QueryRowContext(ctx, `
		SELECT origin.metadata_language,
			variant.edition_language,
			variant.request_locale
		FROM work_edition AS requested
		INNER JOIN work_edition AS origin
			ON origin.logical_work_id = requested.logical_work_id
			AND origin.is_canonical = 1
		INNER JOIN dlsite_metadata_variant AS variant
			ON variant.work_id = origin.work_id
		INNER JOIN metadata_provider AS provider
			ON provider.id = variant.provider_id AND provider.code = 'dlsite'
		WHERE UPPER(requested.primary_code) = UPPER(?)
			AND TRIM(variant.title) <> ''
			AND TRIM(variant.request_locale) <> ''
		ORDER BY variant.fetched_at DESC, variant.id DESC
		LIMIT 1
	`, requestedCode).Scan(&originLanguage, &editionLanguage, &requestLocale)
	if err == nil {
		return metadataRequestMatchesEdition(requestLocale, firstNonEmpty(editionLanguage, originLanguage)), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}

	// Keep older installations and snapshots written before the variant table
	// usable.  The request must match the canonical edition language; it is no
	// longer assumed that the canonical/origin edition is Japanese.
	var snapshotJSON string
	err = s.db.QueryRowContext(ctx, `
		SELECT origin.metadata_language, snapshot.snapshot_json
		FROM work_edition AS requested
		INNER JOIN work_edition AS origin
			ON origin.logical_work_id = requested.logical_work_id
			AND origin.is_canonical = 1
		INNER JOIN metadata_snapshot AS snapshot ON snapshot.work_id = origin.work_id
		INNER JOIN metadata_provider AS provider
			ON provider.id = snapshot.provider_id AND provider.code = 'dlsite'
		WHERE UPPER(requested.primary_code) = UPPER(?)
		ORDER BY snapshot.fetched_at DESC, snapshot.id DESC
		LIMIT 1
	`, requestedCode).Scan(&originLanguage, &snapshotJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return originSnapshotMatchesEditionLanguage(snapshotJSON, originLanguage), nil
}

func originSnapshotMatchesEditionLanguage(snapshotJSON string, editionLanguage string) bool {
	var payload struct {
		Kikoto struct {
			ResponseLanguage string `json:"response_language"`
			RequestLocale    string `json:"request_locale"`
			EditionLanguage  string `json:"edition_language"`
		} `json:"_kikoto"`
	}
	if err := json.Unmarshal([]byte(snapshotJSON), &payload); err != nil {
		return false
	}
	observed := firstNonEmpty(payload.Kikoto.RequestLocale, payload.Kikoto.ResponseLanguage)
	if observed == "" {
		observed = payload.Kikoto.EditionLanguage
	}
	if observed == "" {
		return false
	}
	expected := dlsite.LocaleForMetadataLanguage(editionLanguage)
	if expected != "" {
		return normalizeMetadataLocale(observed) == normalizeMetadataLocale(expected)
	}
	// Unknown source languages are retained, but there is no reliable locale
	// mapping to validate.  A non-empty provider declaration is sufficient for
	// the legacy readiness check; future syncs still preserve the raw value.
	return strings.TrimSpace(payload.Kikoto.EditionLanguage) != "" || strings.TrimSpace(editionLanguage) != ""
}

// Kept as a compatibility shim for package-local callers and older tests.
func originSnapshotUsesJapaneseLocale(snapshotJSON string, editionLanguage string) bool {
	return originSnapshotMatchesEditionLanguage(snapshotJSON, editionLanguage)
}

func metadataRequestMatchesEdition(requestLocale, editionLanguage string) bool {
	expected := dlsite.LocaleForMetadataLanguage(editionLanguage)
	if expected == "" {
		return strings.TrimSpace(requestLocale) != ""
	}
	return normalizeMetadataLocale(requestLocale) == normalizeMetadataLocale(expected)
}

func normalizeMetadataLocale(value string) string {
	return strings.ToLower(strings.ReplaceAll(strings.TrimSpace(value), "_", "-"))
}

func (s *Server) loadRemoteFetchEditions(ctx context.Context, requestedCode string) ([]remoteFetchEdition, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT edition.work_id, edition.primary_code, work.title,
			edition.metadata_language, edition.edition_label,
			edition.translation_kind, edition.classification_source,
			edition.maker_id, edition.origin_maker_id, edition.is_canonical
		FROM work_edition AS requested
		INNER JOIN work_edition AS edition ON edition.logical_work_id = requested.logical_work_id
		INNER JOIN work ON work.id = edition.work_id
		WHERE UPPER(requested.primary_code) = UPPER(?)
		ORDER BY edition.is_canonical DESC, edition.primary_code ASC
	`, requestedCode)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []remoteFetchEdition{}
	for rows.Next() {
		var item remoteFetchEdition
		if err := rows.Scan(&item.WorkID, &item.PrimaryCode, &item.Title, &item.MetadataLanguage, &item.EditionLabel, &item.TranslationKind, &item.ClassificationSource, &item.MakerID, &item.OriginMakerID, &item.Origin); err != nil {
			return nil, err
		}
		item.LocalRoots = []remoteFetchLocalRoot{}
		item.Sources = []sourceAvailabilitySummary{}
		result = append(result, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(result) > 0 {
		return result, nil
	}
	var item remoteFetchEdition
	if err := s.db.QueryRowContext(ctx, "SELECT id, primary_code, title FROM work WHERE UPPER(primary_code) = UPPER(?)", requestedCode).Scan(&item.WorkID, &item.PrimaryCode, &item.Title); err != nil {
		return nil, err
	}
	item.TranslationKind = "unknown"
	item.LocalRoots = []remoteFetchLocalRoot{}
	item.Sources = []sourceAvailabilitySummary{}
	return []remoteFetchEdition{item}, nil
}

func (s *Server) loadRemoteFetchLocalRoots(ctx context.Context, workID int64, code string) ([]remoteFetchLocalRoot, error) {
	if err := s.discoverRemoteFetchLocalRoots(ctx, workID, code); err != nil {
		return nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, file_source_id, root_path, role, state, is_primary
		FROM work_folder_location
		WHERE work_id = ? AND state IN ('active', 'pending_cleanup', 'ignored')
		ORDER BY is_primary DESC, role = 'managed_fetch' DESC, root_path ASC
	`, workID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []remoteFetchLocalRoot{}
	for rows.Next() {
		var item remoteFetchLocalRoot
		if err := rows.Scan(&item.ID, &item.FileSourceID, &item.RootPath, &item.Role, &item.State, &item.Primary); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

func (s *Server) discoverRemoteFetchLocalRoots(ctx context.Context, workID int64, code string) error {
	type candidate struct {
		sourceID int64
		path     string
	}
	candidates := []candidate{}
	rows, err := s.db.QueryContext(ctx, `
		SELECT file_source_id, source_url
		FROM work_source_presence
		WHERE work_id = ? AND presence_type = 'local' AND availability = 'available' AND source_url <> ''
		UNION
		SELECT location.file_source_id, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
	`, workID, workID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.sourceID, &item.path); err != nil {
			_ = rows.Close()
			return err
		}
		candidates = append(candidates, item)
	}
	if err := rows.Close(); err != nil {
		return err
	}
	seen := map[string]bool{}
	for _, item := range candidates {
		root := remoteFetchRootFromPath(item.path, code)
		if root == "" {
			continue
		}
		key := strings.Join([]string{strings.TrimSpace(code), root}, "|")
		if seen[key] {
			continue
		}
		seen[key] = true
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO work_folder_location (work_id, file_source_id, root_path, role, state, is_primary, last_scanned_at, updated_at)
			VALUES (?, ?, ?, 'external', 'active', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
			ON CONFLICT(file_source_id, root_path) DO UPDATE SET
				work_id = excluded.work_id,
				last_scanned_at = CURRENT_TIMESTAMP,
				updated_at = CURRENT_TIMESTAMP
		`, workID, item.sourceID, root); err != nil {
			return err
		}
	}
	return nil
}

func remoteFetchRootFromPath(value string, code string) string {
	value = filepath.ToSlash(strings.TrimSpace(value))
	code = strings.ToUpper(strings.TrimSpace(code))
	parts := strings.Split(strings.Trim(value, "/"), "/")
	for index, part := range parts {
		found, _ := localfs.ExtractWorkCode(part)
		if strings.EqualFold(found, code) {
			return strings.Join(parts[:index+1], "/")
		}
	}
	return ""
}

func (s *Server) validateRemoteFetchTargetRoot(ctx context.Context, code string, root string) (string, error) {
	root = filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(root))))
	if root == "" || root == "." {
		return "", errors.New("fetch target root is required")
	}
	if _, err := safeDataPath(s.cfg.DataRoot, root); err != nil {
		return "", err
	}
	var exists bool
	if err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS(
			SELECT 1
			FROM work_folder_location AS folder
			INNER JOIN work ON work.id = folder.work_id
			WHERE UPPER(work.primary_code) = UPPER(?)
				AND folder.root_path = ?
				AND folder.state = 'active'
		)
	`, code, root).Scan(&exists); err != nil {
		return "", err
	}
	if !exists {
		return "", fmt.Errorf("target root %q does not belong to edition %s", root, strings.ToUpper(strings.TrimSpace(code)))
	}
	return root, nil
}

func attachRemoteFetchPreparation(plan *remoteWorkSavePlan, preparation remoteFetchPreparation) {
	plan.Preparation = preparation
	if plan.Preparation.Warnings == nil {
		plan.Preparation.Warnings = []string{}
	}
	if plan.Preparation.Editions == nil {
		plan.Preparation.Editions = []remoteFetchEdition{}
	}
}

func remoteFetchEditionForCode(editions []remoteFetchEdition, code string) (remoteFetchEdition, bool) {
	for _, edition := range editions {
		if strings.EqualFold(edition.PrimaryCode, code) {
			return edition, true
		}
	}
	return remoteFetchEdition{}, false
}

func sortRemoteFetchRoots(roots []remoteFetchLocalRoot) {
	sort.Slice(roots, func(i, j int) bool { return roots[i].RootPath < roots[j].RootPath })
}
