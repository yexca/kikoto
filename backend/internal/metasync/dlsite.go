package metasync

import (
	"context"
	"database/sql"
	"fmt"
	"regexp"
	"strings"
	"time"

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

type DLsiteClientWithLocale interface {
	FetchProductWithLocale(ctx context.Context, workno string, locale string) (dlsite.Product, error)
}

type DLsiteSyncer struct {
	coordinator      *Coordinator
	db               *sql.DB
	client           DLsiteClient
	cacheRoot        string
	languages        []string
	requestDelay     time.Duration
	backoff          time.Duration
	maxBackoff       time.Duration
	metadataPriority []string
	triggerType      string
	triggerReason    string
	triggerID        int64
	productURL       func(dlsite.Product) string
	// Purchase bonus detection; see WithPurchaseBonusLinking.
	purchaseBonusAutoLink bool
	purchaseBonusRecheck  bool
	unavailableHandler    func(context.Context, int64, string) (bool, error)
}

// WithUnavailableHandler composes an optional fallback for explicitly missing
// DLsite products. Retryable provider failures never reach this handler.
func (s *DLsiteSyncer) WithUnavailableHandler(handler func(context.Context, int64, string) (bool, error)) *DLsiteSyncer {
	s.unavailableHandler = handler
	return s
}

type DLsiteSyncResult struct {
	RunID            int64                   `json:"runId"`
	JobID            int64                   `json:"jobId"`
	Deduplicated     bool                    `json:"deduplicated,omitempty"`
	Status           string                  `json:"status"`
	TargetWorks      int                     `json:"targetWorks"`
	SyncedWorks      int                     `json:"syncedWorks"`
	SkippedWorks     int                     `json:"skippedWorks"`
	FailedWorks      int                     `json:"failedWorks"`
	UnavailableWorks int                     `json:"unavailableWorks"`
	ReviewCandidates []DLsiteReviewCandidate `json:"reviewCandidates"`
	Failures         []string                `json:"failures"`
}

type DLsiteReviewCandidate struct {
	WorkID  int64  `json:"workId"`
	Code    string `json:"code"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type syncTargetResult struct {
	err         error
	synced      bool
	unavailable bool
	failures    []string
}

func NewDLsiteSyncer(db *sql.DB, client DLsiteClient) *DLsiteSyncer {
	return &DLsiteSyncer{
		coordinator: NewCoordinator(),
		db:          db, client: client, triggerType: "manual", triggerReason: "manual",
		productURL: dlsite.DefaultEndpoints().ProductURL,
	}
}

// WithProductURLBuilder supplies the public product URL recorded alongside
// provider metadata. It is a presentation link, not a remote file source.
func (s *DLsiteSyncer) WithProductURLBuilder(builder func(dlsite.Product) string) *DLsiteSyncer {
	if builder != nil {
		s.productURL = builder
	}
	return s
}

func (s *DLsiteSyncer) WithCacheRoot(cacheRoot string) *DLsiteSyncer {
	s.cacheRoot = cacheRoot
	return s
}

func (s *DLsiteSyncer) WithLanguages(languages []string) *DLsiteSyncer {
	s.languages = normalizeLanguages(languages)
	return s
}

// WithMetadataPriority controls the local projection only. It never changes
// which language editions are discovered; each edition is requested using its
// own mapped locale when the provider exposes one.
func (s *DLsiteSyncer) WithMetadataPriority(languages []string) *DLsiteSyncer {
	s.metadataPriority = dlsite.NormalizeMetadataPriority(languages)
	return s
}

func (s *DLsiteSyncer) projectionPriority() []string {
	if len(s.metadataPriority) == 0 {
		return []string{dlsite.OriginMetadataLanguage}
	}
	return s.metadataPriority
}

func (s *DLsiteSyncer) WithRequestPacing(requestDelay time.Duration, backoff time.Duration, maxBackoff time.Duration) *DLsiteSyncer {
	if requestDelay < 0 {
		requestDelay = 0
	}
	if backoff < 0 {
		backoff = 0
	}
	if maxBackoff < 0 {
		maxBackoff = 0
	}
	s.requestDelay = requestDelay
	s.backoff = backoff
	s.maxBackoff = maxBackoff
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

func (s *DLsiteSyncer) WithTriggerID(triggerID int64) *DLsiteSyncer {
	if triggerID > 0 {
		s.triggerID = triggerID
	}
	return s
}

// FetchProduct fetches one product using the syncer's language, pacing, and
// retry policy without writing anything to the database.
func (s *DLsiteSyncer) FetchProduct(ctx context.Context, workno string) (dlsite.Product, error) {
	return fetchVerifiedProduct(ctx, strings.ToUpper(strings.TrimSpace(workno)), s.fetchProduct)
}

// SyncProductOnly stores exactly the supplied product. Unlike SyncProduct, it
// does not fetch related editions or download a cover, which makes it suitable
// for callers that have already applied their own admission policy.
// The supplied product must come from an exact request for its returned code.
func (s *DLsiteSyncer) SyncProductOnly(ctx context.Context, product dlsite.Product) (int64, error) {
	release, err := s.coordinator.acquireProduct(ctx, dlsiteProductCode(product))
	if err != nil {
		return 0, err
	}
	defer release()
	ctx, err = s.beginAttempt(ctx)
	if err != nil {
		return 0, err
	}
	workID, err := s.ensureWorkForProduct(ctx, product)
	if err != nil {
		return 0, err
	}
	if err := s.applyProduct(ctx, workID, product); err != nil {
		return 0, err
	}
	return workID, nil
}

// SyncProductOnlyWithCover stores one supplied product and refreshes its
// provider cover when the caller explicitly accepted that cover in a preview.
func (s *DLsiteSyncer) SyncProductOnlyWithCover(ctx context.Context, product dlsite.Product) (int64, error) {
	workID, err := s.SyncProductOnly(ctx, product)
	if err != nil || s.cacheRoot == "" {
		return workID, err
	}
	_, coverErr := s.downloadCover(ctx, product)
	return workID, coverErr
}

func (s *DLsiteSyncer) SyncAll(ctx context.Context) (DLsiteSyncResult, error) {
	result, err := s.SyncAllWithoutWorkflow(ctx)
	if err != nil {
		return DLsiteSyncResult{}, err
	}
	runID, jobID, err := s.recordWorkflow(ctx, result)
	if err != nil {
		return DLsiteSyncResult{}, err
	}
	result.RunID = runID
	result.JobID = jobID
	return result, nil
}

// SyncAllWithoutWorkflow applies the same metadata synchronization without
// creating another run. The queued metadata worker owns the persisted run.
func (s *DLsiteSyncer) SyncAllWithoutWorkflow(ctx context.Context) (DLsiteSyncResult, error) {
	return s.SyncScopeWithoutWorkflow(ctx, DLsiteSyncScope{})
}

// SyncScopeWithoutWorkflow synchronizes the existing works selected by scope.
func (s *DLsiteSyncer) SyncScopeWithoutWorkflow(ctx context.Context, scope DLsiteSyncScope) (DLsiteSyncResult, error) {
	targets, scopedWorks, err := s.loadTargets(ctx, scope)
	if err != nil {
		return DLsiteSyncResult{}, err
	}
	totalWorks := scopedWorks
	if scope.WorkIDs == nil {
		totalWorks, err = s.countSyncableWorks(ctx)
		if err != nil {
			return DLsiteSyncResult{}, err
		}
	}

	result := DLsiteSyncResult{
		Status:           "succeeded",
		TargetWorks:      len(targets),
		SkippedWorks:     maxInt(0, totalWorks-len(targets)),
		ReviewCandidates: []DLsiteReviewCandidate{},
		Failures:         []string{},
	}

	for _, target := range targets {
		if err := ctx.Err(); err != nil {
			return result, err
		}
		targetResult := s.syncTarget(ctx, target)
		if targetResult.synced {
			result.SyncedWorks++
		}
		if targetResult.unavailable {
			result.UnavailableWorks++
		}
		result.Failures = append(result.Failures, targetResult.failures...)
		if targetResult.err != nil {
			result.Status = "failed"
			result.FailedWorks = len(result.Failures)
			return result, targetResult.err
		}
	}

	result.FailedWorks = len(result.Failures)
	result.Status = syncResultStatus(result)

	return result, nil
}

func (s *DLsiteSyncer) syncTarget(ctx context.Context, target workTarget) syncTargetResult {
	family, err := s.SyncFamily(ctx, target.PrimaryCode)
	if err != nil {
		if dlsite.IsTimeout(err) || ctx.Err() != nil {
			return syncTargetResult{err: err, failures: []string{fmt.Sprintf("%s: %s", target.PrimaryCode, err.Error())}}
		}
		if family.RequestedUnavailable {
			if s.unavailableHandler != nil {
				filled, fallbackErr := s.unavailableHandler(ctx, target.ID, target.PrimaryCode)
				if ctx.Err() != nil {
					return syncTargetResult{err: ctx.Err()}
				}
				if fallbackErr != nil {
					return syncTargetResult{unavailable: true, failures: []string{target.PrimaryCode + ": remote metadata fallback failed"}}
				}
				return syncTargetResult{synced: filled, unavailable: true}
			}
			return syncTargetResult{unavailable: true}
		}
		return syncTargetResult{failures: []string{fmt.Sprintf("%s: %s", target.PrimaryCode, err.Error())}}
	}
	return syncTargetResult{synced: len(family.SyncedCodes) > 0, failures: family.Failures}
}

func syncResultStatus(result DLsiteSyncResult) string {
	if result.FailedWorks == 0 {
		return "succeeded"
	}
	if result.SyncedWorks == 0 && result.TargetWorks > 0 {
		return "failed"
	}
	return "partial"
}

func (s *DLsiteSyncer) SyncProduct(ctx context.Context, product dlsite.Product) (int64, error) {
	workID, err := s.SyncProductOnly(ctx, product)
	if err != nil {
		return 0, err
	}
	if s.cacheRoot != "" && isCanonicalProduct(product) {
		_, _ = s.downloadCover(ctx, product)
	}
	originProduct, _, originFetched, err := s.syncOriginProduct(ctx, product)
	if err != nil {
		return 0, fmt.Errorf("sync origin metadata: %w", err)
	}
	if originFetched && s.cacheRoot != "" {
		_, _ = s.downloadCover(ctx, originProduct)
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
		"target_works":      result.TargetWorks,
		"synced_works":      result.SyncedWorks,
		"skipped_works":     result.SkippedWorks,
		"failed_works":      result.FailedWorks,
		"unavailable_works": result.UnavailableWorks,
		"review_works":      len(result.ReviewCandidates),
		"review_candidates": result.ReviewCandidates,
		"failures":          result.Failures,
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
	if s.triggerID > 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE workflow_run SET trigger_id = ? WHERE id = ?", s.triggerID, runID); err != nil {
			return 0, 0, err
		}
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
			"synced_works":      result.SyncedWorks,
			"skipped_works":     result.SkippedWorks,
			"failed_works":      result.FailedWorks,
			"unavailable_works": result.UnavailableWorks,
			"review_works":      len(result.ReviewCandidates),
			"review_candidates": result.ReviewCandidates,
			"failures":          result.Failures,
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

	for _, candidate := range result.ReviewCandidates {
		payload := map[string]any{
			"work_id":  candidate.WorkID,
			"code":     candidate.Code,
			"provider": "dlsite",
			"reason":   candidate.Reason,
			"message":  candidate.Message,
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO workflow_candidate (workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json)
			VALUES (?, ?, 'dlsite_unavailable_work', ?, 'pending', ?)
		`, runID, syncNodeID, candidate.Code, mustJSON(payload)); err != nil {
			return 0, 0, err
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, 0, err
	}
	return runID, jobID, nil
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
	includeDefault := false
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" {
			includeDefault = true
			continue
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	if includeDefault {
		result = append(result, "")
	}
	return result
}

func maxInt(a int, b int) int {
	if a > b {
		return a
	}
	return b
}
