package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

const remoteOriginBlockedCandidateType = "remote_origin_blocked"

type remoteOriginReviewError struct {
	Origin string
}

func (err remoteOriginReviewError) Error() string {
	return remoteOriginReviewMessage(err.Origin)
}

func remoteOriginReviewMessage(origin string) string {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return "Remote download requires source outbound policy review"
	}
	return "Remote download origin is not allowed by the source policy: " + origin
}

func (s *Server) pauseRemoteFetchForOriginReview(
	ctx context.Context,
	runID int64,
	nodeRunID int64,
	jobID int64,
	manifestID int64,
	source remoteSourceForUse,
	origin string,
	current int,
	total int,
	summary remoteWorkSaveSummary,
) error {
	origin = strings.TrimSpace(origin)
	message := remoteOriginReviewMessage(origin)
	payload := mustJSON(map[string]any{
		"origin":    origin,
		"source_id": source.ID,
		"reason":    "origin_not_allowed",
	})
	runSummary := mustJSON(map[string]any{
		"plan":            summary,
		"error":           message,
		"review_required": true,
		"blocked_origin":  origin,
		"source_id":       source.ID,
	})

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	var candidateID int64
	err = tx.QueryRowContext(ctx, `
		SELECT id
		FROM workflow_candidate
		WHERE workflow_run_id = ?
			AND candidate_type = ?
			AND external_key = ?
			AND status = 'pending'
		ORDER BY id DESC
		LIMIT 1
	`, runID, remoteOriginBlockedCandidateType, origin).Scan(&candidateID)
	if errors.Is(err, sql.ErrNoRows) {
		candidateID, err = insertAndID(ctx, tx, `
			INSERT INTO workflow_candidate (
				workflow_run_id, workflow_node_run_id, candidate_type,
				external_key, status, payload_json
			)
			VALUES (?, ?, ?, ?, 'pending', ?)
		`, runID, nullablePositiveInt64(nodeRunID), remoteOriginBlockedCandidateType, origin, payload)
	} else if err == nil {
		_, err = tx.ExecContext(ctx, `
			UPDATE workflow_candidate
			SET workflow_node_run_id = ?, payload_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, nullablePositiveInt64(nodeRunID), payload, candidateID)
	}
	if err != nil {
		return err
	}

	if manifestID > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE remote_fetch_manifest
			SET error_message = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ?
		`, message, manifestID); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_job
		SET status = 'failed', progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, current, total, message, jobID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_node_run
		SET status = 'partial',
			output_json = json_patch(COALESCE(NULLIF(output_json, ''), '{}'), ?),
			error_message = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, runSummary, message, nodeRunID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE workflow_run
		SET status = 'partial', summary_json = ?, finished_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, runSummary, runID); err != nil {
		return err
	}
	if err := workflow.InsertEvent(ctx, tx, runID, workflow.EventSpec{
		NodeRunID: nodeRunID,
		JobID:     jobID,
		Level:     "warn",
		Type:      "remote.origin_blocked",
		Message:   "Remote download requires source policy review",
		Detail: map[string]any{
			"candidate_id": candidateID,
			"origin":       origin,
			"source_id":    source.ID,
		},
	}); err != nil {
		return err
	}
	return tx.Commit()
}
