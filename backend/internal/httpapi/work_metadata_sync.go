package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type workMetadataSyncPayload struct {
	WorkID      int64  `json:"workId"`
	PrimaryCode string `json:"primaryCode"`
	FamilyCode  string `json:"familyCode"`
	SourceID    int64  `json:"sourceId,omitempty"`
}

type workMetadataSyncRunResult struct {
	RunID        int64  `json:"runId"`
	JobID        int64  `json:"jobId"`
	WorkID       int64  `json:"workId"`
	PrimaryCode  string `json:"primaryCode"`
	Status       string `json:"status"`
	Deduplicated bool   `json:"deduplicated"`
}

func (s *Server) createWorkMetadataSyncRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	var options struct {
		SourceID *int64 `json:"sourceId"`
	}
	if r.Body != nil {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&options); err != nil && !errors.Is(err, io.EOF) {
			writeAPIError(w, http.StatusBadRequest, "invalid_metadata_source", "invalid metadata refresh options", false)
			return
		}
		var extra any
		if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
			writeAPIError(w, http.StatusBadRequest, "invalid_metadata_source", "invalid metadata refresh options", false)
			return
		}
	}
	var sourceID int64
	if options.SourceID != nil {
		sourceID = *options.SourceID
		if sourceID <= 0 {
			writeAPIError(w, http.StatusBadRequest, "invalid_metadata_source", "invalid metadata source", false)
			return
		}
	}
	result, err := s.enqueueWorkMetadataSyncForSource(r.Context(), workID, false, sourceID)
	if err != nil {
		if errors.Is(err, errMetadataSourceUnavailable) {
			writeAPIError(w, http.StatusBadRequest, "metadata_source_unavailable", "metadata source is unavailable", false)
			return
		}
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	status := http.StatusAccepted
	if result.RunID == 0 && result.Status == "unavailable" {
		status = http.StatusOK
	}
	writeJSON(w, status, result)
}

func (s *Server) enqueueWorkMetadataSync(ctx context.Context, workID int64) (workMetadataSyncRunResult, error) {
	return s.enqueueWorkMetadataSyncWithOptions(ctx, workID, false)
}

func (s *Server) enqueueWorkMetadataSyncWithOptions(ctx context.Context, workID int64, recheckUnavailable bool) (workMetadataSyncRunResult, error) {
	return s.enqueueWorkMetadataSyncForSource(ctx, workID, recheckUnavailable, 0)
}

func (s *Server) enqueueWorkMetadataSyncForSource(ctx context.Context, workID int64, recheckUnavailable bool, sourceID int64) (workMetadataSyncRunResult, error) {
	s.metadataSyncMu.Lock()
	defer s.metadataSyncMu.Unlock()
	var selectedSource remoteSourceForUse
	if sourceID != 0 {
		var err error
		selectedSource, err = s.loadMetadataRefreshSource(ctx, sourceID)
		if err != nil {
			return workMetadataSyncRunResult{}, err
		}
	}

	var payload workMetadataSyncPayload
	var providerUnavailable bool
	err := s.db.QueryRowContext(ctx, `
		SELECT work.id, work.primary_code,
			COALESCE(NULLIF(logical.canonical_code, ''), work.primary_code),
			EXISTS (
				SELECT 1
				FROM work_metadata_provider_state AS provider_state
				INNER JOIN metadata_provider AS provider ON provider.id = provider_state.provider_id
				WHERE provider_state.work_id = work.id
					AND provider.code = 'dlsite'
					AND provider_state.status = 'not_found'
			)
		FROM work
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		LEFT JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE work.id = ?
	`, workID).Scan(&payload.WorkID, &payload.PrimaryCode, &payload.FamilyCode, &providerUnavailable)
	if err != nil {
		return workMetadataSyncRunResult{}, err
	}
	payload.PrimaryCode = strings.ToUpper(strings.TrimSpace(payload.PrimaryCode))
	payload.FamilyCode = strings.ToUpper(strings.TrimSpace(payload.FamilyCode))
	payload.SourceID = sourceID
	if sourceID == 0 && providerUnavailable && !recheckUnavailable {
		return workMetadataSyncRunResult{
			WorkID: payload.WorkID, PrimaryCode: payload.PrimaryCode, Status: "unavailable",
		}, nil
	}
	if existing, ok, err := s.activeWorkMetadataSync(ctx, payload); err != nil {
		return workMetadataSyncRunResult{}, err
	} else if ok {
		return existing, nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return workMetadataSyncRunResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	definition := map[string]any{"nodes": []map[string]string{
		{"id": "select", "type": "select_works"},
		{"id": "sync", "type": "sync_metadata"},
	}}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, "metadata_family_sync", "Refresh work metadata", "Refresh one work and its bounded language-edition family.", definition)
	if err != nil {
		return workMetadataSyncRunResult{}, err
	}
	displayName := fmt.Sprintf("Refresh metadata for %s", payload.PrimaryCode)
	if sourceID != 0 {
		displayName += " from " + selectedSource.DisplayName
	}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, "metadata_family_sync", displayName, "queued", "manual", "work_detail", payload, map[string]any{"work_id": workID, "family_code": payload.FamilyCode})
	if err != nil {
		return workMetadataSyncRunResult{}, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "select", NodeType: "select_works", DisplayName: "Select work family", Position: 1, Status: "succeeded",
		Input: map[string]any{"work_id": workID}, Output: payload,
	}); err != nil {
		return workMetadataSyncRunResult{}, err
	}
	syncNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "sync", NodeType: "sync_metadata", DisplayName: "Refresh family metadata", Position: 2, Status: "queued", Input: payload,
	})
	if err != nil {
		return workMetadataSyncRunResult{}, err
	}
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: syncNodeID, WorkerType: "metadata_family_sync", Status: "queued", Priority: workflow.JobPriorityUserInitiated, ResourceKey: "metadata:provider", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued", "familyCode": payload.FamilyCode}, Recoverable: true, MaxRetries: 3, ProgressTotal: 1,
	})
	if err != nil {
		return workMetadataSyncRunResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return workMetadataSyncRunResult{}, err
	}
	return workMetadataSyncRunResult{RunID: runID, JobID: jobID, WorkID: workID, PrimaryCode: payload.PrimaryCode, Status: "queued"}, nil
}

func (s *Server) activeWorkMetadataSync(ctx context.Context, payload workMetadataSyncPayload) (workMetadataSyncRunResult, bool, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT run.id, run.input_json, COALESCE(job.id, 0), run.status
		FROM workflow_run AS run
		LEFT JOIN workflow_job AS job ON job.workflow_run_id = run.id AND job.worker_type = 'metadata_family_sync'
		WHERE run.workflow_code = 'metadata_family_sync' AND run.status IN ('queued', 'running')
		ORDER BY run.id DESC
	`)
	if err != nil {
		return workMetadataSyncRunResult{}, false, err
	}
	defer rows.Close()
	for rows.Next() {
		var runID, jobID int64
		var inputJSON, status string
		if err := rows.Scan(&runID, &inputJSON, &jobID, &status); err != nil {
			return workMetadataSyncRunResult{}, false, err
		}
		var active workMetadataSyncPayload
		if json.Unmarshal([]byte(inputJSON), &active) != nil || !strings.EqualFold(active.FamilyCode, payload.FamilyCode) || active.SourceID != payload.SourceID || (payload.SourceID != 0 && active.WorkID != payload.WorkID) {
			continue
		}
		return workMetadataSyncRunResult{
			RunID: runID, JobID: jobID, WorkID: payload.WorkID, PrimaryCode: payload.PrimaryCode,
			Status: status, Deduplicated: true,
		}, true, nil
	}
	return workMetadataSyncRunResult{}, false, rows.Err()
}

func (s *Server) executeWorkMetadataSyncJob(ctx context.Context, job workflowJobRecord) error {
	var payload workMetadataSyncPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if payload.SourceID != 0 {
		return s.executeRemoteWorkMetadataSyncJob(ctx, job, payload)
	}
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing", map[string]any{"familyCode": payload.FamilyCode}, 0, 1)
	family, err := s.syncWorkMetadataFamily(ctx, payload.PrimaryCode)
	if err != nil {
		if family.RequestedUnavailable {
			// Only an explicit DLsite "not found" reaches the opt-in remote
			// fallback; timeouts, rate limits and other retryable failures
			// return above without contacting any remote source.
			fallback, fallbackErr := s.runRemoteMetadataFallback(ctx, payload.WorkID, payload.PrimaryCode)
			if fallbackErr != nil {
				if ctx.Err() != nil {
					_ = s.failClaimedWorkflowJob(ctx, job, fallbackErr.Error())
					return fallbackErr
				}
				slog.Warn("remote metadata fallback failed", "work_id", payload.WorkID, "error", fallbackErr)
				fallback.Status = remoteFallbackFailed
			}
			if finishErr := s.finishUnavailableWorkMetadataSyncJob(ctx, job, payload, family, err.Error(), fallback); finishErr != nil {
				_ = s.failClaimedWorkflowJob(ctx, job, finishErr.Error())
				return finishErr
			}
			return nil
		}
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	status := "succeeded"
	level := "info"
	if len(family.Failures) > 0 {
		status = "partial"
		level = "warn"
	}
	summary := map[string]any{
		"work_id": payload.WorkID, "primary_code": payload.PrimaryCode, "canonical_code": family.CanonicalCode,
		"synced_codes": family.SyncedCodes, "skipped_codes": family.SkippedCodes, "failures": family.Failures,
	}
	if err := s.finishWorkMetadataSyncJob(ctx, job, status, level, summary, len(family.SyncedCodes)); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	return nil
}

func (s *Server) finishUnavailableWorkMetadataSyncJob(ctx context.Context, job workflowJobRecord, payload workMetadataSyncPayload, family metasync.DLsiteFamilySyncResult, message string, fallback remoteMetadataFallbackResult) error {
	if fallback.Status == "" {
		fallback.Status = remoteFallbackDisabled
	}
	if fallback.Attempts == nil {
		fallback.Attempts = []remoteMetadataFallbackAttempt{}
	}
	summary := map[string]any{
		"work_id": payload.WorkID, "primary_code": payload.PrimaryCode, "canonical_code": family.CanonicalCode,
		"synced_codes": family.SyncedCodes, "skipped_codes": family.SkippedCodes, "failures": family.Failures,
		"requested_unavailable": true, "remote_fallback": fallback,
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'succeeded', output_json = ?, error_message = '', finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(summary), job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'succeeded', progress_current = 1, progress_total = 1,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, mustJSON(map[string]any{"phase": "unavailable", "detail": summary, "progressCurrent": 1, "progressTotal": 1}), job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?
	`, mustJSON(summary), job.RunID); err != nil {
		return err
	}
	eventDetail := map[string]any{
		"work_id": payload.WorkID, "code": payload.PrimaryCode, "provider": "dlsite",
		"reason": "dlsite_not_found", "message": message,
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: "info", Type: "metadata.product_unavailable",
		Message: "DLsite did not return the requested product; future refreshes will skip it", Detail: eventDetail,
	}); err != nil {
		return err
	}
	if fallback.Status != remoteFallbackDisabled && fallback.Status != remoteFallbackSkipped {
		level, text := "info", "Remote sources were asked for the work's metadata"
		switch fallback.Status {
		case remoteFallbackFilled:
			text = "A remote source filled the metadata DLsite does not have"
		case remoteFallbackFailed:
			level, text = "warn", "Remote metadata fallback could not reach every selected source"
		}
		if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
			NodeRunID: job.NodeRunID, JobID: job.ID, Level: level, Type: "metadata.remote_fallback",
			Message: text, Detail: map[string]any{"work_id": payload.WorkID, "code": payload.PrimaryCode, "fallback": fallback},
		}); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) finishWorkMetadataSyncJob(ctx context.Context, job workflowJobRecord, status string, level string, summary map[string]any, syncedCodes int) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, status, mustJSON(summary), job.NodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_job SET status = 'succeeded', progress_current = 1, progress_total = 1,
		locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, mustJSON(map[string]any{"phase": "completed", "detail": summary, "progressCurrent": 1, "progressTotal": 1}), job.ID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, status, mustJSON(summary), job.RunID); err != nil {
		return err
	}
	eventType, message := "metadata.family_synced", fmt.Sprintf("Refreshed metadata for %d family editions", syncedCodes)
	if sourceCode, ok := summary["source_code"].(string); ok {
		eventType, message = "metadata.source_refreshed", "Requested fresh work metadata from "+sourceCode
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: level, Type: eventType,
		Message: message, Detail: summary,
	}); err != nil {
		return err
	}
	return tx.Commit()
}

// createDLsiteSyncRun queues metadata sync for existing works. An empty body
// selects every work with missing or stale metadata.
func (s *Server) createDLsiteSyncRun(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	var options metadataSyncOptions
	if r.Body != nil {
		if err := json.NewDecoder(r.Body).Decode(&options); err != nil && !errors.Is(err, io.EOF) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
	}
	options, err := s.validateMetadataSyncOptions(r.Context(), options)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	result, err := s.enqueueScopedDLsiteMetadataSync(r.Context(), "manual", "manual", 0, options)
	if err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) newDLsiteMetadataSyncer(ctx context.Context) *metasync.DLsiteSyncer {
	return metasync.NewDLsiteSyncer(s.db, s.dlsiteClient).
		WithCoordinator(s.metadataCoordinator).
		WithProductURLBuilder(s.dlsiteEndpoints.ProductURL).
		WithCacheRoot(s.cfg.CacheRoot).
		WithMetadataPriority(s.instanceMetadataLanguages(ctx)).
		WithLanguages(dlsiteLanguageFallbacksForLanguages(s.instanceMetadataLanguages(ctx))).
		WithRequestPacing(
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_request_delay_base_seconds", 0.5)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_rate_limit_backoff_seconds", 30)),
			durationFromSettingSeconds(s.settingFloatContext(ctx, "remote_max_backoff_seconds", 300)),
		)
}

func durationFromSettingSeconds(value float64) time.Duration {
	if value <= 0 {
		return 0
	}
	return time.Duration(value * float64(time.Second))
}

func dlsiteLanguageFallbacksForLanguages(_ []string) []string {
	// Discovery is transport policy, not display policy. Always probe the
	// supported DLsite locales in a stable order so changing the UI priority
	// cannot change which response becomes the family-discovery seed.
	result := append([]string(nil), dlsite.SupportedMetadataLanguages...)
	result = append(result, "")
	return result
}
