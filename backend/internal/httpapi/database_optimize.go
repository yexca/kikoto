package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	databaseOptimizeWorkflowCode = "database_optimize"
	databaseOptimizeWorkerType   = "database_optimize"
	databaseOptimizeDisplayName  = "Optimize database"
)

// databaseOptimizeResult is the audit_log detail recorded after compaction.
type databaseOptimizeResult struct {
	BeforeBytes int64 `json:"beforeBytes"`
	AfterBytes  int64 `json:"afterBytes"`
}

type databaseOptimizePayload struct {
	RequestedByUserID int64 `json:"requested_by_user_id"`
}

type databaseOptimizeQueuedResult struct {
	RunID  int64  `json:"runId"`
	JobID  int64  `json:"jobId"`
	Status string `json:"status"`
	// Existing reports that an already queued or running optimization was
	// returned instead of queueing a second one.
	Existing bool `json:"existing"`
}

// optimizeDatabase queues VACUUM as a durable workflow job. Compaction holds
// the SQLite write lock for its whole duration, so it runs on the single
// workflow executor rather than inside the HTTP request, and at most one
// optimization is queued or running at a time.
func (s *Server) optimizeDatabase(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	result, err := s.enqueueDatabaseOptimize(r.Context(), user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

func (s *Server) enqueueDatabaseOptimize(ctx context.Context, actorUserID int64) (databaseOptimizeQueuedResult, error) {
	// Write transactions begin immediately, so the active-run check and the
	// insert below are serialized against a concurrent request.
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	existing := databaseOptimizeQueuedResult{Existing: true}
	err = tx.QueryRowContext(ctx, `
		SELECT run.id, run.status, COALESCE((
			SELECT job.id FROM workflow_job AS job WHERE job.workflow_run_id = run.id ORDER BY job.id DESC LIMIT 1
		), 0)
		FROM workflow_run AS run
		WHERE run.workflow_code = ? AND run.status IN ('queued', 'running')
		ORDER BY run.id DESC
		LIMIT 1
	`, databaseOptimizeWorkflowCode).Scan(&existing.RunID, &existing.Status, &existing.JobID)
	if err == nil {
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return databaseOptimizeQueuedResult{}, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, databaseOptimizeWorkflowCode, databaseOptimizeDisplayName,
		"Compact the SQLite database, refresh query planner statistics, and truncate the write-ahead log.",
		map[string]any{"nodes": []map[string]string{{"id": "optimize", "type": "optimize_database", "displayName": "Compact database"}}})
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	payload := databaseOptimizePayload{RequestedByUserID: actorUserID}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, databaseOptimizeWorkflowCode, databaseOptimizeDisplayName,
		"queued", "manual", "maintenance_database_optimize", payload, map[string]any{})
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	nodeRunID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "optimize", NodeType: "optimize_database", DisplayName: "Compact database", Position: 1, Status: "queued",
	})
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	// The job is not lease-recoverable: VACUUM blocks heartbeat writes, so an
	// expired lease would not mean the executor stopped. An interrupted
	// optimization fails at restart and can simply be started again.
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: nodeRunID, WorkerType: databaseOptimizeWorkerType, Status: "queued",
		Priority: workflow.JobPriorityUserInitiated, ResourceKey: "database:optimize", Payload: payload,
		Checkpoint: map[string]any{}, Recoverable: false, MaxRetries: 1, ProgressTotal: 1,
	})
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	return databaseOptimizeQueuedResult{RunID: runID, JobID: jobID, Status: "queued"}, nil
}

func (s *Server) executeDatabaseOptimizeJob(ctx context.Context, job workflowJobRecord) error {
	var payload databaseOptimizePayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	result, err := s.compactDatabase(ctx)
	if err != nil && shutdownInterrupted(ctx) {
		return err
	}
	if err != nil {
		_ = s.failClaimedWorkflowJob(context.WithoutCancel(ctx), job, "database optimization failed: "+err.Error())
		return err
	}
	return s.finishDatabaseOptimizeJob(context.WithoutCancel(ctx), job, payload, result)
}

func (s *Server) compactDatabase(ctx context.Context) (databaseOptimizeResult, error) {
	before, _, err := s.databaseFileUsage(ctx)
	if err != nil {
		return databaseOptimizeResult{}, err
	}
	for _, statement := range []string{"VACUUM", "PRAGMA optimize"} {
		if _, err := s.db.ExecContext(ctx, statement); err != nil {
			return databaseOptimizeResult{}, err
		}
	}
	var busy, logPages, checkpointed int
	_ = s.db.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").Scan(&busy, &logPages, &checkpointed)
	after, _, err := s.databaseFileUsage(ctx)
	if err != nil {
		return databaseOptimizeResult{}, err
	}
	return databaseOptimizeResult{BeforeBytes: before, AfterBytes: after}, nil
}

func (s *Server) finishDatabaseOptimizeJob(ctx context.Context, job workflowJobRecord, payload databaseOptimizePayload, result databaseOptimizeResult) error {
	output := mustJSON(map[string]any{
		"before_bytes": result.BeforeBytes, "after_bytes": result.AfterBytes, "reclaimed_bytes": max(result.BeforeBytes-result.AfterBytes, 0),
	})
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, step := range []struct {
		query string
		args  []any
	}{
		{"UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{output, job.NodeRunID}},
		{`UPDATE workflow_job SET status = 'succeeded', progress_current = progress_total, locked_by = '', locked_at = NULL,
			heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`, []any{job.ID}},
		{"UPDATE workflow_run SET status = 'succeeded', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('queued', 'running')", []any{output, job.RunID}},
		// The file was rewritten even if the run was cancelled after VACUUM
		// returned, so the audit entry is recorded unconditionally.
		{`INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
			VALUES ((SELECT id FROM user_account WHERE id = ?), 'database.optimize', 'database', '', ?)`,
			[]any{payload.RequestedByUserID, mustJSON(result)}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}
