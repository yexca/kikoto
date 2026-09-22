package httpapi

import (
	"context"
	"database/sql"
	"fmt"
)

func workflowNodeIDsByNodeID(ctx context.Context, db *sql.DB, runID int64) (map[string]int64, error) {
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

func updateWorkflowJobProgress(ctx context.Context, db *sql.DB, jobID int64, current int, total int) error {
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

func finishWorkflowRunSimple(ctx context.Context, db *sql.DB, runID int64, nodeID int64, jobID int64, status string, errorMessage string, current int, total int, summary remoteWorkSaveSummary) error {
	output := mustJSON(map[string]any{"plan": summary, "error": errorMessage})
	if _, err := db.ExecContext(ctx, "UPDATE workflow_node_run SET status = ?, output_json = json_patch(COALESCE(NULLIF(output_json, ''), '{}'), ?), error_message = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, errorMessage, nodeID); err != nil {
		return err
	}
	if _, err := db.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = ?,
			progress_current = ?,
			progress_total = ?,
			error_message = ?,
			locked_by = '',
			locked_at = NULL,
			heartbeat_at = NULL,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, status, current, total, errorMessage, jobID); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, "UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?", status, output, runID)
	return err
}
