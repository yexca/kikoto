package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

var dlsiteWorkNoPattern = regexp.MustCompile(`(?i)^(RJ|BJ|VJ)[0-9]{5,8}$`)

type DLsiteClient interface {
	FetchProduct(ctx context.Context, workno string) (dlsite.Product, error)
	DownloadCover(ctx context.Context, product dlsite.Product, cacheRoot string) (string, error)
}

type DLsiteClientWithOptions interface {
	FetchProductWithOptions(ctx context.Context, workno string, options dlsite.ProductOptions) (dlsite.Product, error)
}

type DLsiteSyncer struct {
	db        *sql.DB
	client    DLsiteClient
	cacheRoot string
	languages []string
}

type DLsiteSyncResult struct {
	RunID       int64    `json:"runId"`
	JobID       int64    `json:"jobId"`
	Status      string   `json:"status"`
	TargetWorks int      `json:"targetWorks"`
	SyncedWorks int      `json:"syncedWorks"`
	FailedWorks int      `json:"failedWorks"`
	Failures    []string `json:"failures"`
}

type workTarget struct {
	ID          int64
	PrimaryCode string
}

func NewDLsiteSyncer(db *sql.DB, client DLsiteClient) *DLsiteSyncer {
	return &DLsiteSyncer{db: db, client: client}
}

func (s *DLsiteSyncer) WithCacheRoot(cacheRoot string) *DLsiteSyncer {
	s.cacheRoot = cacheRoot
	return s
}

func (s *DLsiteSyncer) WithLanguages(languages []string) *DLsiteSyncer {
	s.languages = normalizeLanguages(languages)
	return s
}

func (s *DLsiteSyncer) SyncAll(ctx context.Context) (DLsiteSyncResult, error) {
	targets, err := s.loadTargets(ctx)
	if err != nil {
		return DLsiteSyncResult{}, err
	}

	result := DLsiteSyncResult{
		Status:      "succeeded",
		TargetWorks: len(targets),
		Failures:    []string{},
	}

	for _, target := range targets {
		product, err := s.fetchProduct(ctx, target.PrimaryCode)
		if err != nil {
			result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", target.PrimaryCode, err.Error()))
			continue
		}
		if err := s.applyProduct(ctx, target.ID, product); err != nil {
			result.Failures = append(result.Failures, fmt.Sprintf("%s: %s", target.PrimaryCode, err.Error()))
			continue
		}
		if s.cacheRoot != "" {
			if _, err := s.client.DownloadCover(ctx, product, s.cacheRoot); err != nil {
				result.Failures = append(result.Failures, fmt.Sprintf("%s cover: %s", target.PrimaryCode, err.Error()))
			}
		}
		result.SyncedWorks++
	}

	result.FailedWorks = len(result.Failures)
	if result.FailedWorks > 0 && result.SyncedWorks == 0 && result.TargetWorks > 0 {
		result.Status = "failed"
	} else if result.FailedWorks > 0 {
		result.Status = "partial"
	}

	runID, jobID, err := s.recordWorkflow(ctx, result)
	if err != nil {
		return DLsiteSyncResult{}, err
	}
	result.RunID = runID
	result.JobID = jobID
	return result, nil
}

func (s *DLsiteSyncer) fetchProduct(ctx context.Context, workno string) (dlsite.Product, error) {
	if client, ok := s.client.(DLsiteClientWithOptions); ok {
		return client.FetchProductWithOptions(ctx, workno, dlsite.ProductOptions{Languages: s.languages})
	}
	return s.client.FetchProduct(ctx, workno)
}

func (s *DLsiteSyncer) loadTargets(ctx context.Context) ([]workTarget, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, primary_code
		FROM work
		ORDER BY id ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	targets := []workTarget{}
	for rows.Next() {
		var target workTarget
		if err := rows.Scan(&target.ID, &target.PrimaryCode); err != nil {
			return nil, err
		}
		target.PrimaryCode = strings.ToUpper(strings.TrimSpace(target.PrimaryCode))
		if dlsiteWorkNoPattern.MatchString(target.PrimaryCode) {
			targets = append(targets, target)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return targets, nil
}

func (s *DLsiteSyncer) applyProduct(ctx context.Context, workID int64, product dlsite.Product) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	providerID, err := ensureMetadataProvider(ctx, tx, "dlsite", "DLsite")
	if err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_external_id (work_id, provider_id, id_type, external_id, url, is_primary)
		VALUES (?, ?, 'workno', ?, ?, 1)
		ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
			work_id = excluded.work_id,
			url = excluded.url,
			is_primary = excluded.is_primary
	`, workID, providerID, product.WorkNo, productURL(product)); err != nil {
		return err
	}

	raw := product.Raw
	if strings.TrimSpace(product.Language) != "" {
		raw = snapshotWithKikotoMeta(raw, map[string]any{"language": product.Language})
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_snapshot (work_id, provider_id, external_id, snapshot_json)
		VALUES (?, ?, ?, ?)
	`, workID, providerID, product.WorkNo, string(raw)); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE work
		SET title = ?,
			title_kana = ?,
			description = ?,
			release_date = ?,
			age_rating = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, chooseTitle(product), product.WorkNameKana, chooseDescription(product), nullableText(product.RegistDate), product.AgeCategoryString, workID); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *DLsiteSyncer) recordWorkflow(ctx context.Context, result DLsiteSyncResult) (int64, int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, 0, err
	}
	defer func() {
		_ = tx.Rollback()
	}()

	summary := map[string]any{
		"target_works": result.TargetWorks,
		"synced_works": result.SyncedWorks,
		"failed_works": result.FailedWorks,
		"failures":     result.Failures,
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "metadata_sync", "Sync work metadata", "Select works and sync normalized metadata snapshots.", map[string]any{
		"nodes": []map[string]string{
			{"id": "select", "type": "select_works"},
			{"id": "sync", "type": "sync_metadata"},
		},
	})
	if err != nil {
		return 0, 0, err
	}

	runID, err := workflow.InsertRun(ctx, tx, definitionID, "metadata_sync", "Sync work metadata", result.Status, "manual", "manual", map[string]any{}, summary)
	if err != nil {
		return 0, 0, err
	}

	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "select",
		NodeType:    "select_works",
		DisplayName: "Select works",
		Position:    1,
		Status:      "succeeded",
		Input:       map[string]any{},
		Output: map[string]any{
			"target_works": result.TargetWorks,
		},
	}); err != nil {
		return 0, 0, err
	}
	syncNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID:      "sync",
		NodeType:    "sync_metadata",
		DisplayName: "Sync metadata",
		Position:    2,
		Status:      result.Status,
		Input: map[string]any{
			"target_works": result.TargetWorks,
		},
		Output: map[string]any{
			"synced_works": result.SyncedWorks,
			"failed_works": result.FailedWorks,
			"failures":     result.Failures,
		},
		Error: strings.Join(result.Failures, "\n"),
	})
	if err != nil {
		return 0, 0, err
	}

	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID:       syncNodeID,
		WorkerType:      "metadata_sync",
		Status:          result.Status,
		Payload:         map[string]any{},
		ProgressCurrent: result.SyncedWorks,
		ProgressTotal:   result.TargetWorks,
		Error:           strings.Join(result.Failures, "\n"),
	})
	if err != nil {
		return 0, 0, err
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return runID, jobID, nil
}

func ensureMetadataProvider(ctx context.Context, tx *sql.Tx, code string, displayName string) (int64, error) {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_provider (code, display_name)
		VALUES (?, ?)
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name
	`, code, displayName); err != nil {
		return 0, err
	}

	var id int64
	if err := tx.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = ?", code).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, sql.ErrNoRows
		}
		return 0, err
	}
	return id, nil
}

func insertAndID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	result, err := tx.ExecContext(ctx, query, args...)
	if err != nil {
		return 0, err
	}
	return result.LastInsertId()
}

func selectID(ctx context.Context, tx *sql.Tx, query string, args ...any) (int64, error) {
	var id int64
	if err := tx.QueryRowContext(ctx, query, args...).Scan(&id); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return 0, sql.ErrNoRows
		}
		return 0, err
	}
	return id, nil
}

func chooseTitle(product dlsite.Product) string {
	if strings.TrimSpace(product.ProductName) != "" {
		return strings.TrimSpace(product.ProductName)
	}
	if strings.TrimSpace(product.WorkName) != "" {
		return strings.TrimSpace(product.WorkName)
	}
	return product.WorkNo
}

func chooseDescription(product dlsite.Product) string {
	if strings.TrimSpace(product.IntroShort) != "" {
		return strings.TrimSpace(product.IntroShort)
	}
	return strings.TrimSpace(product.Intro)
}

func nullableText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}

func normalizeLanguages(values []string) []string {
	seen := map[string]bool{}
	result := []string{}
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result
}

func snapshotWithKikotoMeta(raw json.RawMessage, metadata map[string]any) json.RawMessage {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err == nil {
		encoded, err := json.Marshal(metadata)
		if err == nil {
			object["_kikoto"] = encoded
			if next, err := json.Marshal(object); err == nil {
				return next
			}
		}
	}
	return raw
}

func productURL(product dlsite.Product) string {
	site := product.SiteID
	if site == "" {
		if strings.HasPrefix(product.WorkNo, "VJ") {
			site = "pro"
		} else {
			site = "maniax"
		}
	}
	return fmt.Sprintf("https://www.dlsite.com/%s/work/=/product_id/%s.html", site, product.WorkNo)
}
