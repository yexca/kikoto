package httpapi

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/metasync"
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
	language := normalizeDLsiteLanguage(s.settingStringContext(ctx, "dlsite_metadata_language", "ja-jp"))
	syncer := metasync.NewDLsiteSyncer(s.db, dlsite.NewClient(nil)).
		WithCacheRoot(s.cfg.CacheRoot).
		WithLanguages(dlsiteLanguageFallbacks(language)).
		WithRequestPacing(
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_rate_limit_backoff_seconds", 30)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_max_backoff_seconds", 300)),
		)
	family, err := syncer.SyncFamily(ctx, requestedCode)
	if err != nil {
		result.MetadataStatus = "degraded"
		result.Warnings = append(result.Warnings, err.Error())
	} else {
		result.CanonicalCode = family.CanonicalCode
		if len(family.Failures) > 0 {
			result.MetadataStatus = "partial"
			result.Warnings = append(result.Warnings, family.Failures...)
		}
		if err := s.syncPartiesFromDLsiteSnapshots(ctx); err != nil {
			result.MetadataStatus = "partial"
			result.Warnings = append(result.Warnings, "circle metadata: "+err.Error())
		}
	}
	editions, err := s.loadRemoteFetchEditions(ctx, requestedCode)
	if err != nil {
		result.MetadataStatus = "degraded"
		result.Warnings = append(result.Warnings, err.Error())
		return result
	}
	for index := range editions {
		editions[index].LocalRoots, err = s.loadRemoteFetchLocalRoots(ctx, editions[index].WorkID, editions[index].PrimaryCode)
		if err != nil {
			result.Warnings = append(result.Warnings, editions[index].PrimaryCode+" local roots: "+err.Error())
		}
		checkCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
		availability, checkErr := s.checkWorkSourceAvailabilityForSources(checkCtx, editions[index].PrimaryCode, 0, "manual", "fetch_prepare")
		cancel()
		if checkErr != nil {
			result.Warnings = append(result.Warnings, editions[index].PrimaryCode+" sources: "+checkErr.Error())
		} else {
			editions[index].Sources = availability.Sources
		}
	}
	result.Editions = editions
	return result
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
