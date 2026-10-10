package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

// Remote catalog adaptation translates source pages into the shared circle
// catalog projection without materializing unknown work identities.

func (s *Server) syncCircleRemoteSourceCatalogs(ctx context.Context, partyID int64, circleName string, mode string, sourceIDs []int64) (int, int, error) {
	circleName = strings.TrimSpace(circleName)
	if circleName == "" || strings.HasPrefix(circleName, "Unfetched circle ") {
		return 0, 0, nil
	}
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return 0, 0, err
	}
	selected := map[int64]bool{}
	for _, id := range sourceIDs {
		selected[id] = true
	}
	totalSynced, failed := 0, 0
	for _, source := range sources {
		if !selected[source.ID] || !isKikoeruSourceType(source.SourceType) || !source.Enabled || strings.TrimSpace(source.Endpoint.APIURL) == "" {
			continue
		}
		synced, err := s.syncCircleRemoteSourceCatalog(ctx, partyID, circleName, source, mode)
		if err != nil {
			if ctx.Err() != nil {
				return totalSynced, failed, ctx.Err()
			}
			slog.Warn("circle source check failed", "party_id", partyID, "source_id", source.ID, "error", err)
			_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			failed++
			continue
		}
		if synced > 0 {
			_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		}
		totalSynced += synced
	}
	return totalSynced, failed, nil
}

func (s *Server) syncCircleRemoteSourceCatalog(ctx context.Context, partyID int64, circleName string, source remoteSourceForUse, mode string) (int, error) {
	providerID, err := s.metadataProviderID(ctx, "kikoeru_source_"+source.Code, source.DisplayName)
	if err != nil {
		return 0, err
	}
	knownCodes, err := s.knownCircleCatalogCodesForProvider(ctx, partyID, providerID)
	if err != nil {
		return 0, err
	}
	client := s.kikoeruCrawlClientForSource(ctx, source)
	keyword := "$circle:" + circleName + "$"
	pageSize := 20
	maxPages := 10
	if mode == "full" {
		maxPages = 100
	}
	synced := 0
	for page := 1; page <= maxPages; page++ {
		pageSynced, stop, err := s.syncCircleRemoteSourceCatalogPage(ctx, partyID, providerID, source, client, keyword, mode, knownCodes, page, pageSize)
		if err != nil {
			return synced, err
		}
		synced += pageSynced
		if stop {
			break
		}
	}
	return synced, nil
}

func (s *Server) syncCircleRemoteSourceCatalogPage(ctx context.Context, partyID, providerID int64, source remoteSourceForUse, client *kikoeru.Client, keyword, mode string, knownCodes map[string]bool, page, pageSize int) (int, bool, error) {
	worksPage, err := client.ListWorks(ctx, page, pageSize, keyword)
	if err != nil {
		return 0, false, err
	}
	pageCodes, remoteWorks := remoteCircleCatalogPageWorks(worksPage.Works)
	if mode != "full" {
		if beforeKnown, foundKnown := codesBeforeFirstKnown(pageCodes, knownCodes); foundKnown {
			synced, err := s.upsertCircleRemoteCatalogPage(ctx, partyID, providerID, source, beforeKnown, remoteWorks)
			return synced, true, err
		}
	}
	synced, err := s.upsertCircleRemoteCatalogPage(ctx, partyID, providerID, source, pageCodes, remoteWorks)
	if err != nil {
		return 0, false, err
	}
	total := worksPage.Pagination.TotalCount
	if total == 0 {
		total = worksPage.Pagination.Total
	}
	if total == 0 {
		total = worksPage.Pagination.Count
	}
	stop := (pagesFromTotal(total, pageSize) > 0 && page >= pagesFromTotal(total, pageSize)) ||
		(total == 0 && (len(worksPage.Works) == 0 || len(worksPage.Works) < pageSize))
	return synced, stop, nil
}

func remoteCircleCatalogPageWorks(works []kikoeru.Work) ([]string, map[string]kikoeru.Work) {
	codes := []string{}
	remoteWorks := map[string]kikoeru.Work{}
	for _, remoteWork := range works {
		code := normalizedRemoteWorkCode(remoteWork)
		if code == "" {
			continue
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		codes = append(codes, code)
		remoteWorks[code] = remoteWork
	}
	return codes, remoteWorks
}

func (s *Server) upsertCircleRemoteCatalogPage(ctx context.Context, partyID, providerID int64, source remoteSourceForUse, codes []string, remoteWorks map[string]kikoeru.Work) (int, error) {
	synced := 0
	for _, code := range codes {
		remoteWork, ok := remoteWorks[code]
		if !ok {
			continue
		}
		if err := s.upsertRemoteSourceCatalogWork(ctx, partyID, providerID, source, remoteWork); err != nil {
			return synced, err
		}
		synced++
	}
	return synced, nil
}

func (s *Server) upsertRemoteSourceCatalogWork(ctx context.Context, partyID int64, providerID int64, source remoteSourceForUse, remoteWork kikoeru.Work) error {
	code := normalizedRemoteWorkCode(remoteWork)
	if code == "" {
		return nil
	}
	raw, err := json.Marshal(remoteWork)
	if err != nil {
		return err
	}
	title := firstNonEmpty(remoteWork.Title, remoteWork.Name, code)
	release := nullableStringFromText(normalizeDateText(remoteWork.Release))
	if err := s.upsertPartyCatalogItemForProvider(ctx, partyID, providerID, code, title, release, remoteWork.SourceURL, "remote_catalog", string(raw), false); err != nil {
		return err
	}
	var workID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id
		FROM work
		WHERE UPPER(primary_code) = UPPER(?)
	`, code).Scan(&workID); errors.Is(err, sql.ErrNoRows) {
		// A remote catalog hit is discovery provenance. Unknown codes remain in
		// party_catalog_item until an explicit Track, Fetch, or metadata sync
		// crosses the work-materialization boundary.
		return nil
	} else if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID:       workID,
		FileSourceID: source.ID,
		PresenceType: sourcePresenceTypeRemoteSource,
		RemoteID:     strconv.FormatInt(remoteWork.ID, 10),
		RemoteCode:   normalizedRemoteWorkCode(remoteWork),
		SourceURL:    remoteWork.SourceURL,
		Availability: "available",
		RawJSON:      string(raw),
	}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Server) knownCircleCatalogCodes(ctx context.Context, partyID int64) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT primary_code
		FROM party_catalog_item
		WHERE party_id = ?
	`, partyID)
	if err != nil {
		return nil, err
	}
	return scanCatalogCodeRows(rows)
}

func (s *Server) knownCircleCatalogCodesForProvider(ctx context.Context, partyID int64, providerID int64) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT primary_code
		FROM party_catalog_item
		WHERE party_id = ? AND provider_id = ?
	`, partyID, providerID)
	if err != nil {
		return nil, err
	}
	return scanCatalogCodeRows(rows)
}

func scanCatalogCodeRows(rows *sql.Rows) (map[string]bool, error) {
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			result[code] = true
		}
	}
	return result, rows.Err()
}

func (s *Server) circleCatalogCodesMissingMetadata(ctx context.Context, partyID int64, workCodes []string) (map[string]bool, error) {
	wanted := map[string]bool{}
	for _, code := range workCodes {
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			wanted[code] = true
		}
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT catalog.primary_code
		FROM party_catalog_item AS catalog
		INNER JOIN metadata_provider AS provider ON provider.code = 'dlsite' AND provider.id = catalog.provider_id
		LEFT JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		WHERE catalog.party_id = ?
			AND NOT EXISTS (
				SELECT 1
				FROM metadata_snapshot AS snapshot
				WHERE snapshot.work_id = work.id
					AND snapshot.provider_id = provider.id
			)
	`, partyID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" && wanted[code] {
			result[code] = true
		}
	}
	return result, rows.Err()
}

func (s *Server) availableCircleCatalogCodes(ctx context.Context, partyID int64, workCodes []string) (map[string]bool, error) {
	result, err := s.queryCircleCatalogCodes(ctx, `
		SELECT DISTINCT catalog.primary_code
		FROM `+circleCatalogProjection+` AS catalog
		INNER JOIN work ON UPPER(work.primary_code) = UPPER(catalog.primary_code)
		INNER JOIN media_item AS item ON item.work_id = work.id
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE catalog.party_id = ?
			AND location.availability = 'available'
	`, partyID)
	if err != nil {
		return nil, err
	}
	otherCodes, err := s.queryCircleCatalogCodes(ctx, `
		SELECT DISTINCT catalog.primary_code
		FROM `+circleCatalogProjection+` AS catalog
		INNER JOIN metadata_provider AS provider ON provider.id = catalog.provider_id
		WHERE catalog.party_id = ?
			AND provider.code != 'dlsite'
	`, partyID)
	if err != nil {
		return nil, err
	}
	for code := range otherCodes {
		result[code] = true
	}
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	for _, code := range workCodes {
		code = strings.ToUpper(strings.TrimSpace(code))
		if code == "" || result[code] {
			continue
		}
		if s.circleWorkAvailableInAnyRemoteSource(ctx, sources, code) {
			result[code] = true
		}
	}
	return result, nil
}

func (s *Server) queryCircleCatalogCodes(ctx context.Context, query string, args ...any) (map[string]bool, error) {
	rows, err := s.db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := map[string]bool{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return nil, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			result[code] = true
		}
	}
	return result, rows.Err()
}

func (s *Server) circleWorkAvailableInAnyRemoteSource(ctx context.Context, sources []remoteSourceForUse, code string) bool {
	for _, source := range sources {
		if !isKikoeruSourceType(source.SourceType) || !source.Enabled {
			continue
		}
		remoteWork, err := s.checkRemoteWorkAvailabilityWithClass(ctx, source, code, sourceRequestCrawl)
		if err != nil {
			if errors.Is(err, errRemoteWorkNotFound) {
				_ = s.updateSourceHealth(ctx, source.ID, "healthy")
			} else {
				_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
			}
			continue
		}
		_ = s.updateSourceHealth(ctx, source.ID, "healthy")
		if normalizedRemoteWorkCode(remoteWork) != "" || remoteWork.ID > 0 {
			return true
		}
	}
	return false
}

func circleRefreshMaxPages(mode string) int {
	if mode == "full" {
		return 100
	}
	return 10
}

func codesBeforeFirstKnown(codes []string, known map[string]bool) ([]string, bool) {
	if len(known) == 0 {
		return codes, false
	}
	for index, code := range codes {
		if known[strings.ToUpper(strings.TrimSpace(code))] {
			return codes[:index], true
		}
	}
	return codes, false
}

func pagesFromTotal(total int, perPage int) int {
	if total <= 0 || perPage <= 0 {
		return 0
	}
	return (total + perPage - 1) / perPage
}

func (s *Server) circleRefreshDelay(ctx context.Context) time.Duration {
	base := s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)
	if base < 0.25 {
		base = 0.25
	}
	return time.Duration(base * float64(time.Second))
}

func normalizeDateText(value string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if len(value) >= 10 {
		return value[:10]
	}
	return value
}

func nullableStringFromText(value string) *string {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return &value
}
