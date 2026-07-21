package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

type workMetadataSyncPayload struct {
	WorkID      int64  `json:"workId"`
	PrimaryCode string `json:"primaryCode"`
	FamilyCode  string `json:"familyCode"`
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
	result, err := s.enqueueWorkMetadataSync(r.Context(), workID)
	if err != nil {
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
	s.metadataSyncMu.Lock()
	defer s.metadataSyncMu.Unlock()

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
	if providerUnavailable {
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
		NodeRunID: syncNodeID, WorkerType: "metadata_family_sync", Status: "queued", Payload: payload,
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
		if json.Unmarshal([]byte(inputJSON), &active) != nil || !strings.EqualFold(active.FamilyCode, payload.FamilyCode) {
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
	_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "syncing", map[string]any{"familyCode": payload.FamilyCode}, 0, 1)
	family, err := s.syncWorkMetadataFamily(ctx, payload.PrimaryCode)
	if err != nil {
		if family.RequestedUnavailable {
			if finishErr := s.finishUnavailableWorkMetadataSyncJob(ctx, job, payload, family, err.Error()); finishErr != nil {
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

func (s *Server) finishUnavailableWorkMetadataSyncJob(ctx context.Context, job workflowJobRecord, payload workMetadataSyncPayload, family metasync.DLsiteFamilySyncResult, message string) error {
	summary := map[string]any{
		"work_id": payload.WorkID, "primary_code": payload.PrimaryCode, "canonical_code": family.CanonicalCode,
		"synced_codes": family.SyncedCodes, "skipped_codes": family.SkippedCodes, "failures": family.Failures,
		"requested_unavailable": true,
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
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: job.NodeRunID, JobID: job.ID, Level: level, Type: "metadata.family_synced",
		Message: fmt.Sprintf("Refreshed metadata for %d family editions", syncedCodes), Detail: summary,
	}); err != nil {
		return err
	}
	return tx.Commit()
}
