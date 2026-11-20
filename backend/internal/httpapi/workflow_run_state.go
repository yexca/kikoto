package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func workflowNodeIDsByNodeID(ctx context.Context, db *sqlutil.DB, runID int64) (map[string]int64, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT node_id, id
		FROM workflow_node_run
		WHERE workflow_run_id = ?
	`, runID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := map[string]int64{}
	for rows.Next() {
		var nodeID string
		var id int64
		if err := rows.Scan(&nodeID, &id); err != nil {
			return nil, err
		}
		result[nodeID] = id
	}
	return result, rows.Err()
}

func (s *Server) ensureWorkflowRunActive(ctx context.Context, runID int64) error {
	var status string
	if err := s.db.QueryRowContext(ctx, "SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&status); err != nil {
		return err
	}
	if status == "queued" || status == "running" {
		return nil
	}
	return fmt.Errorf("workflow run is %s", status)
}

func updateWorkflowJobProgress(ctx context.Context, db *sqlutil.DB, jobID int64, current int, total int) error {
	_, err := db.ExecContext(ctx, `
		UPDATE workflow_job
		SET progress_current = ?,
			progress_total = ?,
			heartbeat_at = CASE WHEN status = 'running' THEN CURRENT_TIMESTAMP ELSE heartbeat_at END,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, current, total, jobID)
	return err
}

func finishWorkflowRunSimple(ctx context.Context, db *sqlutil.DB, runID int64, nodeID int64, jobID int64, status string, errorMessage string, current int, total int, summary remoteWorkSaveSummary) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	output := mustJSON(map[string]any{"plan": summary, "error": errorMessage})
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?, output_json = json_patch(COALESCE(NULLIF(output_json, ''), '{}'), ?), error_message = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status <> 'cancelled'
			AND NOT EXISTS (SELECT 1 FROM workflow_run AS run WHERE run.id = workflow_node_run.workflow_run_id AND run.status = 'cancelled')
	`, status, output, errorMessage, nodeID); err != nil {
		return err
	}
	if err := finishWorkflowRunResultTx(ctx, tx, runID, jobID, status, errorMessage, current, total, output); err != nil {
		return err
	}
	return tx.Commit()
}

// workflowJobResult is the final result a job records for its node, itself,
// and its run.
type workflowJobResult struct {
	RunID, NodeRunID, JobID int64
	Status, ErrorMessage    string
	// JobStatus is the job's own status when it differs from the node and
	// run status, as for a run that finished skipped.
	JobStatus      string
	Current, Total int
	// NodeOutputJSON replaces the node's output; SummaryJSON replaces the
	// run's summary.
	NodeOutputJSON, SummaryJSON string
}

// finishWorkflowJobResult commits a job's node, job, and run result in one
// transaction, so an interrupted write leaves the job running under its lease
// for the runner's settlement path. A run cancelled before the write keeps its
// cancellation.
func finishWorkflowJobResult(ctx context.Context, db *sqlutil.DB, result workflowJobResult) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if err := finishWorkflowNodeRunTx(ctx, tx, result.NodeRunID, result.Status, result.NodeOutputJSON, result.ErrorMessage); err != nil {
		return err
	}
	jobStatus := result.JobStatus
	if jobStatus == "" {
		jobStatus = result.Status
	}
	if err := finishWorkflowJobAndRunTx(ctx, tx, result.RunID, result.JobID, jobStatus, result.Status, result.ErrorMessage, result.Current, result.Total, result.SummaryJSON); err != nil {
		return err
	}
	return tx.Commit()
}

// finishWorkflowNodeRunTx records a node's final status and output. A node
// that was cancelled, or whose run was cancelled, keeps its cancellation.
func finishWorkflowNodeRunTx(ctx context.Context, tx *sql.Tx, nodeRunID int64, status, outputJSON, errorMessage string) error {
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = ?, output_json = ?, error_message = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status <> 'cancelled'
			AND NOT EXISTS (SELECT 1 FROM workflow_run AS run WHERE run.id = workflow_node_run.workflow_run_id AND run.status = 'cancelled')
	`, status, outputJSON, errorMessage, nodeRunID)
	return err
}

// workflowRunCancelledTx reports whether the run was cancelled, so a job's
// late result leaves the run's trigger state as the cancellation left it.
func workflowRunCancelledTx(ctx context.Context, tx *sql.Tx, runID int64) (bool, error) {
	var cancelled bool
	err := tx.QueryRowContext(ctx, "SELECT status = 'cancelled' FROM workflow_run WHERE id = ?", runID).Scan(&cancelled)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	return cancelled, err
}

// updateWorkflowTriggerResultTx records a finished run on its trigger: success
// for a succeeded run and failureMessage otherwise. A cancelled run leaves the
// trigger as the cancellation left it.
func updateWorkflowTriggerResultTx(ctx context.Context, tx *sql.Tx, runID int64, cancelled bool, status, failureMessage string) error {
	switch {
	case cancelled:
		return nil
	case status == "succeeded":
		return updateWorkflowTriggerSuccess(ctx, tx, runID)
	default:
		return updateWorkflowTriggerFailure(ctx, tx, runID, failureMessage)
	}
}

// Keep the job's result and lease release atomic with the owning run. Callers
// include their node and domain state in this same transaction. A run
// cancelled before the result keeps its cancellation, and so does its job.
func finishWorkflowRunResultTx(ctx context.Context, tx *sql.Tx, runID, jobID int64, status, errorMessage string, current, total int, summaryJSON string) error {
	return finishWorkflowJobAndRunTx(ctx, tx, runID, jobID, status, status, errorMessage, current, total, summaryJSON)
}

func finishWorkflowJobAndRunTx(ctx context.Context, tx *sql.Tx, runID, jobID int64, jobStatus, status, errorMessage string, current, total int, summaryJSON string) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?,
			progress_current = ?,
			progress_total = ?,
			error_message = ?,
			locked_by = '',
			locked_at = NULL,
			heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status <> 'cancelled'
			AND NOT EXISTS (SELECT 1 FROM workflow_run AS run WHERE run.id = workflow_job.workflow_run_id AND run.status = 'cancelled')
	`, jobStatus, current, total, errorMessage, jobID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status <> 'cancelled'
	`, status, summaryJSON, runID)
	return err
}
