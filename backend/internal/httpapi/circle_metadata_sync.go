package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// Circle metadata synchronization owns DLsite profile and product refreshes,
// including their durable catalog snapshots.

func (s *Server) runCircleCatalogRefresh(ctx context.Context, partyID int64, externalID string, mode string, client *dlsite.Client) (dlsite.MakerProfile, error) {
	knownCodes, err := s.knownCircleCatalogCodes(ctx, partyID)
	if err != nil {
		return dlsite.MakerProfile{}, err
	}
	profile, err := client.FetchMakerCatalog(ctx, externalID, dlsite.MakerCatalogOptions{
		Mode:           mode,
		MaxPages:       circleRefreshMaxPages(mode),
		KnownWorkCodes: knownCodes,
		Delay:          s.circleRefreshDelay(ctx),
	})
	if err != nil {
		return profile, err
	}
	if err := s.applyMakerProfile(ctx, partyID, profile, mode == "full"); err != nil {
		return profile, err
	}
	if err := s.recordCircleCatalogRefreshSuccess(ctx, partyID, "dlsite", mode); err != nil {
		return profile, err
	}
	return profile, nil
}

func (s *Server) loadCircleProfileForRefresh(ctx context.Context, partyID int64, externalID string) (dlsite.MakerProfile, error) {
	profile := dlsite.MakerProfile{MakerID: externalID}
	var name string
	if err := s.db.QueryRowContext(ctx, "SELECT display_name FROM party WHERE id = ?", partyID).Scan(&name); err != nil {
		return profile, err
	}
	profile.MakerName = strings.TrimSpace(name)
	rows, err := s.db.QueryContext(ctx, `
		SELECT DISTINCT primary_code
		FROM party_catalog_item
		WHERE party_id = ? AND provider_id = (SELECT id FROM metadata_provider WHERE code = 'dlsite')
		ORDER BY last_seen_at DESC, id DESC
	`, partyID)
	if err != nil {
		return profile, err
	}
	defer rows.Close()
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return profile, err
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			profile.WorkCodes = append(profile.WorkCodes, code)
		}
	}
	return profile, rows.Err()
}

func parseSQLiteTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{time.RFC3339, "2006-01-02 15:04:05", "2006-01-02T15:04:05Z07:00"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid time %q", value)
}

func (s *Server) recordCircleCatalogRefreshSuccess(ctx context.Context, partyID int64, providerCode string, mode string) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO party_catalog_refresh_state (party_id, provider_code, last_success_at, last_attempt_at, last_mode, last_status, last_error, updated_at)
		VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'catalog_synced', '', CURRENT_TIMESTAMP)
		ON CONFLICT(party_id, provider_code) DO UPDATE SET
			last_success_at = excluded.last_success_at,
			last_attempt_at = excluded.last_attempt_at,
			last_mode = excluded.last_mode,
			last_status = excluded.last_status,
			last_error = '',
			updated_at = CURRENT_TIMESTAMP
	`, partyID, providerCode, time.Now().UTC().Format(time.RFC3339), mode)
	return err
}

// recordCircleCatalogRefreshFailure keeps the last successful pull and marks
// the attempt, so the circle shows Attention instead of Never or Synced.
func (s *Server) recordCircleCatalogRefreshFailure(ctx context.Context, partyID int64, mode string, runID int64) {
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO party_catalog_refresh_state (party_id, provider_code, last_attempt_at, last_mode, last_status, last_run_id, last_error, updated_at)
		VALUES (?, 'dlsite', CURRENT_TIMESTAMP, ?, 'failed', ?, 'Circle catalog refresh failed.', CURRENT_TIMESTAMP)
		ON CONFLICT(party_id, provider_code) DO UPDATE SET
			last_attempt_at = excluded.last_attempt_at,
			last_mode = excluded.last_mode,
			last_status = excluded.last_status,
			last_run_id = excluded.last_run_id,
			last_error = excluded.last_error,
			updated_at = CURRENT_TIMESTAMP
	`, partyID, mode, nullableRunID(runID)); err != nil {
		slog.Warn("record circle catalog refresh failure", "party_id", partyID, "error", err)
	}
}

func nullableRunID(id int64) any {
	if id <= 0 {
		return nil
	}
	return id
}

func (s *Server) applyMakerProfile(ctx context.Context, partyID int64, profile dlsite.MakerProfile, pruneMissing bool) error {
	providerID, err := s.metadataProviderID(ctx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	name, raw, err := makerProfileSnapshot(profile)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := updateMakerPartySnapshot(ctx, tx, partyID, providerID, name, profile.MakerID, raw); err != nil {
		return err
	}
	if pruneMissing {
		if err := pruneMakerProfileRows(ctx, tx, partyID, providerID); err != nil {
			return err
		}
	}
	if err := s.upsertMakerCatalogItems(ctx, tx, partyID, providerID, profile.WorkCodes, raw); err != nil {
		return err
	}
	if err := upsertMakerSeries(ctx, tx, partyID, providerID, profile.Series); err != nil {
		return err
	}
	return tx.Commit()
}

func makerProfileSnapshot(profile dlsite.MakerProfile) (string, string, error) {
	name := strings.TrimSpace(profile.MakerName)
	if name == "" {
		name = "Unfetched circle " + profile.MakerID
	}
	raw, err := json.Marshal(map[string]any{
		"maker_id":      profile.MakerID,
		"maker_name":    name,
		"site_id":       profile.SiteID,
		"url":           profile.URL,
		"work_codes":    profile.WorkCodes,
		"series":        profile.Series,
		"pages_fetched": profile.PagesFetched,
		"reached_end":   profile.ReachedEnd,
		"total_works":   profile.TotalWorks,
	})
	return name, string(raw), err
}

func updateMakerPartySnapshot(ctx context.Context, tx *sql.Tx, partyID, providerID int64, name, makerID, raw string) error {
	if err := renameParty(ctx, tx, partyID, name); err != nil {
		return err
	}
	return insertPartyMetadataSnapshot(ctx, tx, partyID, providerID, makerID, raw)
}

// renameParty follows a provider's circle name without rewriting a party
// whose name already matches.
func renameParty(ctx context.Context, tx *sql.Tx, partyID int64, name string) error {
	_, err := tx.ExecContext(ctx, `UPDATE party SET provider_name=?,display_name=CASE WHEN manual_name<>'' THEN manual_name ELSE ? END,
 sort_name=LOWER(CASE WHEN manual_name<>'' THEN manual_name ELSE ? END),updated_at=CURRENT_TIMESTAMP
 WHERE id=? AND NOT EXISTS(SELECT 1 FROM party_alias WHERE party_id=party.id AND source IN ('merged_name','merged_alias') AND LOWER(alias)=LOWER(?))
 AND (provider_name IS NOT ? OR display_name IS NOT CASE WHEN manual_name<>'' THEN manual_name ELSE ? END)`, name, name, name, partyID, name, name, name)
	return err
}

// partyMetadataSnapshotRetention is how many snapshots each circle keeps per
// provider, matching metadata_snapshot's retention per work. Nothing reads
// older rows, so keeping more would only grow the database.
const partyMetadataSnapshotRetention = 2

// insertPartyMetadataSnapshot records raw unless the circle already retains
// the same snapshot, then drops snapshots beyond the retention.
func insertPartyMetadataSnapshot(ctx context.Context, tx *sql.Tx, partyID, providerID int64, externalID, raw string) error {
	result, err := tx.ExecContext(ctx, `
		INSERT INTO party_metadata_snapshot (party_id, provider_id, external_id, snapshot_json)
		SELECT ?, ?, ?, ?
		WHERE NOT EXISTS (
			SELECT 1
			FROM party_metadata_snapshot
			WHERE party_id = ?
				AND provider_id = ?
				AND external_id = ?
				AND snapshot_json = ?
		)
	`, partyID, providerID, externalID, raw, partyID, providerID, externalID, raw)
	if err != nil {
		return err
	}
	if inserted, err := result.RowsAffected(); err != nil || inserted == 0 {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		DELETE FROM party_metadata_snapshot
		WHERE id IN (
			SELECT id
			FROM party_metadata_snapshot
			WHERE party_id = ? AND provider_id = ?
			ORDER BY fetched_at DESC, id DESC
			LIMIT -1 OFFSET ?
		)
	`, partyID, providerID, partyMetadataSnapshotRetention)
	return err
}

func pruneMakerProfileRows(ctx context.Context, tx *sql.Tx, partyID, providerID int64) error {
	if _, err := tx.ExecContext(ctx, "UPDATE party_catalog_item SET dlsite_available = 0 WHERE party_id = ? AND provider_id = ?", partyID, providerID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM party_series WHERE party_id = ? AND provider_id = ?", partyID, providerID)
	return err
}

func (s *Server) upsertMakerCatalogItems(ctx context.Context, tx *sql.Tx, partyID, providerID int64, codes []string, raw string) error {
	for _, code := range codes {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO party_catalog_item (party_id, provider_id, primary_code, title, url, catalog_status, dlsite_available, raw_json, last_seen_at)
			VALUES (?, ?, ?, ?, ?, 'catalog', 1, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(party_id, provider_id, primary_code) DO UPDATE SET
				url = excluded.url,
				catalog_status = CASE
					WHEN party_catalog_item.catalog_status = 'imported' THEN party_catalog_item.catalog_status
					ELSE excluded.catalog_status
				END,
				dlsite_available = 1,
				raw_json = excluded.raw_json,
				last_seen_at = CURRENT_TIMESTAMP
		`, partyID, providerID, code, code, s.dlsiteURL(code), raw); err != nil {
			return err
		}
	}
	return nil
}

func upsertMakerSeries(ctx context.Context, tx *sql.Tx, partyID, providerID int64, seriesList []dlsite.MakerSeries) error {
	for _, series := range seriesList {
		titleID := strings.ToUpper(strings.TrimSpace(series.TitleID))
		name := strings.TrimSpace(series.Name)
		if titleID == "" || name == "" {
			continue
		}
		rawSeries, err := json.Marshal(series)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO party_series (party_id, provider_id, title_id, name, url, declared_works, raw_json, last_seen_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(party_id, provider_id, title_id) DO UPDATE SET
				name = excluded.name,
				url = excluded.url,
				declared_works = excluded.declared_works,
				raw_json = excluded.raw_json,
				last_seen_at = CURRENT_TIMESTAMP
		`, partyID, providerID, titleID, name, strings.TrimSpace(series.URL), series.WorkCount, string(rawSeries)); err != nil {
			return err
		}
		seriesID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM party_series WHERE party_id = ? AND provider_id = ? AND title_id = ?", partyID, providerID, titleID)
		if err != nil {
			return err
		}
		if err := replaceMakerSeriesWorks(ctx, tx, seriesID, series.WorkCodes); err != nil {
			return err
		}
	}
	return nil
}

func replaceMakerSeriesWorks(ctx context.Context, tx *sql.Tx, seriesID int64, codes []string) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM party_series_work WHERE series_id = ?", seriesID); err != nil {
		return err
	}
	for position, code := range codes {
		code = strings.ToUpper(strings.TrimSpace(code))
		if code == "" {
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO party_series_work (series_id, primary_code, position, updated_at)
			VALUES (?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(series_id, primary_code) DO UPDATE SET
				position = excluded.position,
				updated_at = CURRENT_TIMESTAMP
		`, seriesID, code, position+1); err != nil {
			return err
		}
	}
	return nil
}

type circleProductSyncResult struct {
	Synced   int
	Skipped  int
	Failures []string
}

func (s *Server) syncCircleProductJSON(ctx context.Context, partyID int64, workCodes []string, productMode string, client *dlsite.Client, progress func(done int, total int)) (circleProductSyncResult, error) {
	if len(workCodes) == 0 {
		return circleProductSyncResult{}, nil
	}
	candidates, err := s.circleProductSyncCandidates(ctx, partyID, workCodes, productMode)
	if err != nil {
		return circleProductSyncResult{}, err
	}
	syncer := metasync.NewDLsiteSyncer(s.db, client).
		WithCoordinator(s.metadataCoordinator).
		WithProductURLBuilder(s.dlsiteEndpoints.ProductURL).
		WithCacheRoot(s.cfg.CacheRoot).
		WithMetadataPriority(s.instanceMetadataLanguages(ctx)).
		WithLanguages(dlsiteLanguageFallbacksForLanguages(s.instanceMetadataLanguages(ctx)))
	result := circleProductSyncResult{Skipped: len(workCodes) - len(candidates), Failures: []string{}}
	for index, code := range candidates {
		if progress != nil {
			progress(index, len(candidates))
		}
		failure, err := s.syncCircleProduct(ctx, partyID, code, client, syncer)
		if err != nil {
			return result, err
		}
		if failure != "" {
			result.Failures = append(result.Failures, failure)
			continue
		}
		result.Synced++
	}
	if progress != nil {
		progress(len(candidates), len(candidates))
	}
	return result, nil
}

func (s *Server) circleProductSyncCandidates(ctx context.Context, partyID int64, workCodes []string, productMode string) ([]string, error) {
	if productMode == "all" {
		return workCodes, nil
	}
	missing, err := s.circleCatalogCodesMissingMetadata(ctx, partyID, workCodes)
	if err != nil {
		return nil, err
	}
	candidates := make([]string, 0, len(workCodes))
	for _, code := range workCodes {
		if missing[strings.ToUpper(strings.TrimSpace(code))] {
			candidates = append(candidates, code)
		}
	}
	return candidates, nil
}

func (s *Server) syncCircleProduct(ctx context.Context, partyID int64, code string, client *dlsite.Client, syncer *metasync.DLsiteSyncer) (string, error) {
	if err := s.waitRemoteDownloadDelay(ctx); err != nil {
		return "", err
	}
	product, err := client.FetchProduct(ctx, code)
	if err != nil {
		return fmt.Sprintf("%s: %s", strings.ToUpper(strings.TrimSpace(code)), err.Error()), nil
	}
	raw := string(product.Raw)
	title := firstNonEmpty(product.WorkName, product.ProductName, product.WorkNo)
	release := nullableStringFromText(product.RegistDate)
	if err := s.upsertPartyCatalogItem(ctx, partyID, product.WorkNo, title, release, s.dlsiteURL(product.WorkNo), "catalog", raw); err != nil {
		return "", err
	}
	if _, err := syncer.SyncFamily(ctx, product.WorkNo); err != nil {
		return "", err
	}
	var workID int64
	if err := s.db.QueryRowContext(ctx, `
		SELECT id
		FROM work
		WHERE UPPER(primary_code) = UPPER(?)
	`, product.WorkNo).Scan(&workID); err != nil {
		return "", err
	}
	party := parsedParty{ExternalID: normalizeMakerID(product.MakerID), DisplayName: strings.TrimSpace(product.MakerName)}
	if !dlsiteMakerIDPattern.MatchString(party.ExternalID) || party.DisplayName == "" {
		return "", nil
	}
	syncedPartyID, err := s.upsertDLsiteParty(ctx, party.ExternalID, party.DisplayName, raw)
	if err != nil {
		return "", err
	}
	if syncedPartyID > 0 {
		if err := s.upsertAuthoritativeWorkParty(ctx, workID, syncedPartyID, "dlsite_product"); err != nil {
			return "", err
		}
	}
	return "", nil
}

// syncCircleRemoteSourceCatalogs matches a circle's works on the selected
// compatible sources. A failing source is marked unavailable and counted; the
// remaining sources still run.
