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
	db            *sql.DB
	client        DLsiteClient
	cacheRoot     string
	languages     []string
	triggerType   string
	triggerReason string
}

type DLsiteSyncResult struct {
	RunID        int64    `json:"runId"`
	JobID        int64    `json:"jobId"`
	Status       string   `json:"status"`
	TargetWorks  int      `json:"targetWorks"`
	SyncedWorks  int      `json:"syncedWorks"`
	SkippedWorks int      `json:"skippedWorks"`
	FailedWorks  int      `json:"failedWorks"`
	Failures     []string `json:"failures"`
}

type workTarget struct {
	ID          int64
	PrimaryCode string
}

func NewDLsiteSyncer(db *sql.DB, client DLsiteClient) *DLsiteSyncer {
	return &DLsiteSyncer{db: db, client: client, triggerType: "manual", triggerReason: "manual"}
}

func (s *DLsiteSyncer) WithCacheRoot(cacheRoot string) *DLsiteSyncer {
	s.cacheRoot = cacheRoot
	return s
}

func (s *DLsiteSyncer) WithLanguages(languages []string) *DLsiteSyncer {
	s.languages = normalizeLanguages(languages)
	return s
}

func (s *DLsiteSyncer) WithTrigger(triggerType string, triggerReason string) *DLsiteSyncer {
	triggerType = strings.TrimSpace(triggerType)
	triggerReason = strings.TrimSpace(triggerReason)
	if triggerType == "" {
		triggerType = "manual"
	}
	if triggerReason == "" {
		triggerReason = triggerType
	}
	s.triggerType = triggerType
	s.triggerReason = triggerReason
	return s
}

func (s *DLsiteSyncer) SyncAll(ctx context.Context) (DLsiteSyncResult, error) {
	targets, err := s.loadTargets(ctx)
	if err != nil {
		return DLsiteSyncResult{}, err
	}
	totalWorks, err := s.countSyncableWorks(ctx)
	if err != nil {
		return DLsiteSyncResult{}, err
	}

	result := DLsiteSyncResult{
		Status:       "succeeded",
		TargetWorks:  len(targets),
		SkippedWorks: maxInt(0, totalWorks-len(targets)),
		Failures:     []string{},
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
		if baseCode := baseProductCode(product); baseCode != "" && !strings.EqualFold(baseCode, product.WorkNo) {
			baseProduct, err := s.fetchProduct(ctx, baseCode)
			if err != nil {
				result.Failures = append(result.Failures, fmt.Sprintf("%s base %s: %s", target.PrimaryCode, baseCode, err.Error()))
			} else {
				baseWorkID, err := s.ensureWorkForProduct(ctx, baseProduct)
				if err != nil {
					result.Failures = append(result.Failures, fmt.Sprintf("%s base %s: %s", target.PrimaryCode, baseCode, err.Error()))
				} else {
					if err := s.applyProduct(ctx, baseWorkID, baseProduct); err != nil {
						result.Failures = append(result.Failures, fmt.Sprintf("%s base %s: %s", target.PrimaryCode, baseCode, err.Error()))
					} else if s.cacheRoot != "" {
						if _, err := s.client.DownloadCover(ctx, baseProduct, s.cacheRoot); err != nil {
							result.Failures = append(result.Failures, fmt.Sprintf("%s base cover: %s", baseCode, err.Error()))
						}
					}
				}
			}
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

func (s *DLsiteSyncer) SyncProduct(ctx context.Context, product dlsite.Product) (int64, error) {
	workID, err := s.ensureWorkForProduct(ctx, product)
	if err != nil {
		return 0, err
	}
	if err := s.applyProduct(ctx, workID, product); err != nil {
		return 0, err
	}
	if s.cacheRoot != "" {
		_, _ = s.client.DownloadCover(ctx, product, s.cacheRoot)
	}
	return workID, nil
}

func (s *DLsiteSyncer) fetchProduct(ctx context.Context, workno string) (dlsite.Product, error) {
	if client, ok := s.client.(DLsiteClientWithOptions); ok {
		return client.FetchProductWithOptions(ctx, workno, dlsite.ProductOptions{Languages: s.languages})
	}
	return s.client.FetchProduct(ctx, workno)
}

func (s *DLsiteSyncer) loadTargets(ctx context.Context) ([]workTarget, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id, work.primary_code
		FROM work
		LEFT JOIN metadata_provider AS provider ON provider.code = 'dlsite'
		WHERE NOT EXISTS (
			SELECT 1
			FROM metadata_snapshot AS snapshot
			WHERE snapshot.work_id = work.id
				AND snapshot.provider_id = provider.id
		)
		ORDER BY work.id ASC
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

func (s *DLsiteSyncer) countSyncableWorks(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT primary_code FROM work`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	total := 0
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			return 0, err
		}
		if dlsiteWorkNoPattern.MatchString(strings.ToUpper(strings.TrimSpace(code))) {
			total++
		}
	}
	return total, rows.Err()
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
	if err := ensureLogicalWorkSchema(ctx, tx); err != nil {
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
	if err := upsertDLsiteWorkEdition(ctx, tx, providerID, workID, product); err != nil {
		return err
	}

	return tx.Commit()
}

func (s *DLsiteSyncer) ensureWorkForProduct(ctx context.Context, product dlsite.Product) (int64, error) {
	code := strings.ToUpper(strings.TrimSpace(product.WorkNo))
	if code == "" {
		code = strings.ToUpper(strings.TrimSpace(product.ProductID))
	}
	if code == "" {
		return 0, fmt.Errorf("empty product code")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() {
		_ = tx.Rollback()
	}()
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, title_kana, description, release_date, age_rating)
		VALUES (?, 'audio', ?, ?, ?, ?, ?)
		ON CONFLICT(primary_code) DO UPDATE SET
			title = excluded.title,
			title_kana = excluded.title_kana,
			description = excluded.description,
			release_date = COALESCE(excluded.release_date, work.release_date),
			age_rating = excluded.age_rating,
			updated_at = CURRENT_TIMESTAMP
	`, code, chooseTitle(product), product.WorkNameKana, chooseDescription(product), nullableText(product.RegistDate), product.AgeCategoryString); err != nil {
		return 0, err
	}
	workID, err := selectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", code)
	if err != nil {
		return 0, err
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return workID, nil
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
		"target_works":  result.TargetWorks,
		"synced_works":  result.SyncedWorks,
		"skipped_works": result.SkippedWorks,
		"failed_works":  result.FailedWorks,
		"failures":      result.Failures,
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

	runID, err := workflow.InsertRun(ctx, tx, definitionID, "metadata_sync", "Sync work metadata", result.Status, s.triggerType, s.triggerReason, map[string]any{}, summary)
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
			"synced_works":  result.SyncedWorks,
			"skipped_works": result.SkippedWorks,
			"failed_works":  result.FailedWorks,
			"failures":      result.Failures,
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

func baseProductCode(product dlsite.Product) string {
	for _, value := range []string{product.TranslationInfo.OriginalWorkNo, product.TranslationInfo.ParentWorkNo} {
		value = strings.ToUpper(strings.TrimSpace(value))
		if dlsiteWorkNoPattern.MatchString(value) {
			return value
		}
	}
	return ""
}

func ensureLogicalWorkSchema(ctx context.Context, tx *sql.Tx) error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS logical_work (
			id INTEGER PRIMARY KEY,
			canonical_work_id INTEGER REFERENCES work(id) ON DELETE SET NULL,
			canonical_code TEXT NOT NULL UNIQUE,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE TABLE IF NOT EXISTS work_edition (
			work_id INTEGER PRIMARY KEY REFERENCES work(id) ON DELETE CASCADE,
			logical_work_id INTEGER NOT NULL REFERENCES logical_work(id) ON DELETE CASCADE,
			provider_id INTEGER REFERENCES metadata_provider(id),
			primary_code TEXT NOT NULL,
			base_code TEXT NOT NULL DEFAULT '',
			metadata_language TEXT NOT NULL DEFAULT '',
			edition_label TEXT NOT NULL DEFAULT '',
			is_canonical INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		)`,
		`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_edition_provider_code
			ON work_edition(provider_id, primary_code)`,
		`CREATE INDEX IF NOT EXISTS idx_work_edition_logical_work
			ON work_edition(logical_work_id, is_canonical DESC, primary_code)`,
	}
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

func upsertDLsiteWorkEdition(ctx context.Context, tx *sql.Tx, providerID int64, workID int64, product dlsite.Product) error {
	currentCode := strings.ToUpper(strings.TrimSpace(product.WorkNo))
	if currentCode == "" {
		currentCode = strings.ToUpper(strings.TrimSpace(product.ProductID))
	}
	if currentCode == "" {
		return nil
	}
	baseCode := baseProductCode(product)
	canonicalCode := currentCode
	if baseCode != "" {
		canonicalCode = baseCode
	}
	canonicalWorkID, _ := selectID(ctx, tx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", canonicalCode)
	var canonical any
	if canonicalWorkID > 0 {
		canonical = canonicalWorkID
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO logical_work (canonical_work_id, canonical_code, updated_at)
		VALUES (?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(canonical_code) DO UPDATE SET
			canonical_work_id = COALESCE(excluded.canonical_work_id, logical_work.canonical_work_id),
			updated_at = CURRENT_TIMESTAMP
	`, canonical, canonicalCode); err != nil {
		return err
	}
	logicalWorkID, err := selectID(ctx, tx, "SELECT id FROM logical_work WHERE canonical_code = ?", canonicalCode)
	if err != nil {
		return err
	}
	language := strings.TrimSpace(product.Language)
	if language == "" {
		language = strings.TrimSpace(product.TranslationInfo.Lang)
	}
	isCanonical := 0
	if strings.EqualFold(currentCode, canonicalCode) {
		isCanonical = 1
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, metadata_language, is_canonical, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id) DO UPDATE SET
			logical_work_id = excluded.logical_work_id,
			provider_id = excluded.provider_id,
			primary_code = excluded.primary_code,
			base_code = excluded.base_code,
			metadata_language = excluded.metadata_language,
			is_canonical = excluded.is_canonical,
			updated_at = CURRENT_TIMESTAMP
	`, workID, logicalWorkID, providerID, currentCode, baseCode, language, isCanonical); err != nil {
		return err
	}
	if isCanonical == 1 {
		if _, err = tx.ExecContext(ctx, "UPDATE logical_work SET canonical_work_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", workID, logicalWorkID); err != nil {
			return err
		}
	}
	return syncKnownProductLanguageEditions(ctx, tx, providerID, logicalWorkID, canonicalCode, product.Raw)
}

func syncKnownProductLanguageEditions(ctx context.Context, tx *sql.Tx, providerID int64, logicalWorkID int64, canonicalCode string, raw json.RawMessage) error {
	var payload struct {
		LanguageEditions []struct {
			WorkNo string `json:"workno"`
			Label  string `json:"label"`
			Lang   string `json:"lang"`
		} `json:"language_editions"`
	}
	if len(raw) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil
	}
	for _, edition := range payload.LanguageEditions {
		code := strings.ToUpper(strings.TrimSpace(edition.WorkNo))
		if !dlsiteWorkNoPattern.MatchString(code) {
			continue
		}
		editionWorkID, err := selectID(ctx, tx, "SELECT id FROM work WHERE UPPER(primary_code) = UPPER(?)", code)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				continue
			}
			return err
		}
		isCanonical := 0
		if strings.EqualFold(code, canonicalCode) {
			isCanonical = 1
		}
		language := strings.TrimSpace(firstNonEmptyText(edition.Label, edition.Lang))
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_edition (work_id, logical_work_id, provider_id, primary_code, base_code, metadata_language, edition_label, is_canonical, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
			ON CONFLICT(work_id) DO UPDATE SET
				logical_work_id = excluded.logical_work_id,
				provider_id = excluded.provider_id,
				primary_code = excluded.primary_code,
				base_code = excluded.base_code,
				metadata_language = CASE
					WHEN excluded.metadata_language <> '' THEN excluded.metadata_language
					ELSE work_edition.metadata_language
				END,
				edition_label = CASE
					WHEN excluded.edition_label <> '' THEN excluded.edition_label
					ELSE work_edition.edition_label
				END,
				is_canonical = excluded.is_canonical,
				updated_at = CURRENT_TIMESTAMP
		`, editionWorkID, logicalWorkID, providerID, code, canonicalCode, language, language, isCanonical); err != nil {
			return err
		}
	}
	return nil
}

func firstNonEmptyText(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
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

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
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
