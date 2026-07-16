package workflow

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

type Store struct {
	db *sql.DB
}

func (s *Store) RequeueExpiredJobs(ctx context.Context, leaseTimeout time.Duration) (int64, error) {
	if leaseTimeout <= 0 {
		leaseTimeout = 30 * time.Second
	}
	cutoff := time.Now().UTC().Add(-leaseTimeout).Format("2006-01-02 15:04:05")
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, workflow_run_id, COALESCE(workflow_node_run_id, 0), locked_by
		FROM workflow_job
		WHERE status = 'running' AND recoverable = 1 AND resume_count < max_retries
			AND COALESCE(heartbeat_at, locked_at, created_at) < ?
		ORDER BY id ASC
	`, cutoff)
	if err != nil {
		return 0, err
	}
	type expiredJob struct {
		id, runID, nodeRunID int64
		lockedBy             string
	}
	jobs := []expiredJob{}
	for rows.Next() {
		var job expiredJob
		if err := rows.Scan(&job.id, &job.runID, &job.nodeRunID, &job.lockedBy); err != nil {
			rows.Close()
			return 0, err
		}
		jobs = append(jobs, job)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if len(jobs) == 0 {
		return 0, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	requeued := int64(0)
	for _, job := range jobs {
		result, err := tx.ExecContext(ctx, `
			UPDATE workflow_job
			SET status = 'queued', locked_by = '', locked_at = NULL, heartbeat_at = NULL,
				resume_count = resume_count + 1, available_at = CURRENT_TIMESTAMP,
				error_message = '', updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running' AND locked_by = ?
		`, job.id, job.lockedBy)
		if err != nil {
			return 0, err
		}
		affected, err := result.RowsAffected()
		if err != nil || affected == 0 {
			continue
		}
		if job.nodeRunID > 0 {
			if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = 'queued', error_message = '', finished_at = NULL WHERE id = ? AND status = 'running'`, job.nodeRunID); err != nil {
				return 0, err
			}
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = 'queued', finished_at = NULL WHERE id = ?`, job.runID); err != nil {
			return 0, err
		}
		if err := InsertEvent(ctx, tx, job.runID, EventSpec{
			NodeRunID: job.nodeRunID, JobID: job.id, Level: "warn", Type: "job.lease_expired",
			Message: "Expired job lease requeued from its checkpoint", Detail: map[string]any{"previous_lock": job.lockedBy},
		}); err != nil {
			return 0, err
		}
		requeued++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return requeued, nil
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

type ListRunsOptions struct {
	Page         int
	PageSize     int
	View         string
	Status       string
	WorkflowCode string
	Query        string
	ViewerUserID int64
	CanViewAll   bool
}

func (s *Store) ListRuns(ctx context.Context, options ListRunsOptions) (RunsPage, error) {
	if options.Page < 1 {
		options.Page = 1
	}
	if options.PageSize < 1 || options.PageSize > 100 {
		options.PageSize = 25
	}
	conditions := []string{"1 = 1"}
	args := []any{}
	switch options.View {
	case "running":
		conditions = append(conditions, "run.status IN ('queued', 'running')")
	case "failed":
		conditions = append(conditions, "run.status = 'failed'")
	case "review":
		conditions = append(conditions, `(
			EXISTS (SELECT 1 FROM workflow_candidate WHERE workflow_candidate.workflow_run_id = run.id AND workflow_candidate.status NOT IN ('accepted', 'rejected', 'ignored', 'resolved'))
			OR ((run.status IN ('partial', 'skipped') OR EXISTS (SELECT 1 FROM workflow_node_run WHERE workflow_node_run.workflow_run_id = run.id AND workflow_node_run.status IN ('partial', 'skipped')))
				AND NOT EXISTS (SELECT 1 FROM workflow_run_review WHERE workflow_run_review.workflow_run_id = run.id AND workflow_run_review.status = 'reviewed'))
		)`)
	case "completed", "history", "logs":
		conditions = append(conditions, "run.status NOT IN ('queued', 'running')")
	}
	if options.Status != "" && options.Status != "all" {
		conditions = append(conditions, "run.status = ?")
		args = append(args, options.Status)
	}
	if options.WorkflowCode != "" && options.WorkflowCode != "all" {
		conditions = append(conditions, "run.workflow_code = ?")
		args = append(args, options.WorkflowCode)
	}
	if query := strings.ToLower(strings.TrimSpace(options.Query)); query != "" {
		conditions = append(conditions, "(LOWER(run.workflow_code) LIKE ? OR LOWER(run.display_name) LIKE ? OR LOWER(run.trigger_reason) LIKE ?)")
		like := "%" + query + "%"
		args = append(args, like, like, like)
	}
	conditions, args = appendRunVisibility(conditions, args, options.ViewerUserID, options.CanViewAll)
	whereSQL := strings.Join(conditions, " AND ")
	var total int64
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_run AS run WHERE "+whereSQL, args...).Scan(&total); err != nil {
		return RunsPage{}, err
	}
	queryArgs := append([]any{}, args...)
	queryArgs = append(queryArgs, options.PageSize, (options.Page-1)*options.PageSize)
	rows, err := s.db.QueryContext(ctx, runSelectSQL()+` FROM workflow_run AS run WHERE `+whereSQL+` ORDER BY run.created_at DESC, run.id DESC LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return RunsPage{}, err
	}
	runs, err := scanRuns(rows)
	if err != nil {
		return RunsPage{}, err
	}
	return RunsPage{Runs: runs, Page: options.Page, PageSize: options.PageSize, Total: total}, nil
}

func appendRunVisibility(conditions []string, args []any, viewerUserID int64, canViewAll bool) ([]string, []any) {
	if canViewAll || viewerUserID <= 0 {
		return conditions, args
	}
	conditions = append(conditions, `(
		(
			NOT EXISTS (
				SELECT 1
				FROM workflow_definition AS private_definition
				WHERE private_definition.id = run.workflow_definition_id
					AND private_definition.scope = 'user'
			)
			AND NOT (run.workflow_definition_id IS NULL AND run.trigger_reason = 'custom_definition')
		)
		OR EXISTS (
			SELECT 1
			FROM workflow_definition AS owned_definition
			WHERE owned_definition.id = run.workflow_definition_id
				AND owned_definition.scope = 'user'
				AND owned_definition.owner_user_id = ?
		)
		OR COALESCE(CAST(json_extract(run.input_json, '$.requested_by_user_id') AS INTEGER), 0) = ?
	)`)
	return conditions, append(args, viewerUserID, viewerUserID)
}

func (s *Store) LoadRun(ctx context.Context, id int64) (RunRecord, error) {
	return loadRunFrom(ctx, s.db, id)
}

func (s *Store) LoadRunTx(ctx context.Context, tx *sql.Tx, id int64) (RunRecord, error) {
	return loadRunFrom(ctx, tx, id)
}

func (s *Store) LoadRunDetail(ctx context.Context, id int64) (RunDetail, error) {
	run, err := s.LoadRun(ctx, id)
	if err != nil {
		return RunDetail{}, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, node_id, node_type, display_name, position, status, input_json, output_json,
			error_message, COALESCE(started_at, ''), COALESCE(finished_at, ''), created_at
		FROM workflow_node_run WHERE workflow_run_id = ? ORDER BY position ASC, id ASC
	`, id)
	if err != nil {
		return RunDetail{}, err
	}
	defer rows.Close()
	detail := RunDetail{RunRecord: run, NodeRuns: []NodeRunRecord{}, GraphJSON: "{}"}
	for rows.Next() {
		var node NodeRunRecord
		if err := rows.Scan(&node.ID, &node.NodeID, &node.NodeType, &node.DisplayName, &node.Position, &node.Status, &node.InputJSON, &node.OutputJSON, &node.ErrorMessage, &node.StartedAt, &node.FinishedAt, &node.CreatedAt); err != nil {
			return RunDetail{}, err
		}
		detail.NodeRuns = append(detail.NodeRuns, node)
	}
	return detail, rows.Err()
}

func (s *Store) ListEvents(ctx context.Context, runID int64) ([]EventRecord, error) {
	return s.ListEventsAfter(ctx, runID, 0)
}

func (s *Store) ListEventsAfter(ctx context.Context, runID int64, afterID int64) ([]EventRecord, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, workflow_run_id, workflow_node_run_id, workflow_job_id, level, event_type, message, detail_json, created_at FROM workflow_event WHERE workflow_run_id = ? AND id > ? ORDER BY id ASC`, runID, afterID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []EventRecord{}
	for rows.Next() {
		var item EventRecord
		var nodeRunID, jobID sql.NullInt64
		if err := rows.Scan(&item.ID, &item.RunID, &nodeRunID, &jobID, &item.Level, &item.EventType, &item.Message, &item.DetailJSON, &item.CreatedAt); err != nil {
			return nil, err
		}
		item.NodeRunID, item.JobID = nullableInt64(nodeRunID), nullableInt64(jobID)
		events = append(events, item)
	}
	return events, rows.Err()
}

func (s *Store) ListCandidates(ctx context.Context, runID int64) ([]CandidateRecord, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, workflow_run_id, workflow_node_run_id, candidate_type, external_key, status, payload_json, decision_json, created_at, updated_at
		FROM workflow_candidate WHERE workflow_run_id = ? ORDER BY updated_at DESC, id DESC
	`, runID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	candidates := []CandidateRecord{}
	for rows.Next() {
		var item CandidateRecord
		var nodeRunID sql.NullInt64
		if err := rows.Scan(&item.ID, &item.RunID, &nodeRunID, &item.Type, &item.ExternalKey, &item.Status, &item.PayloadJSON, &item.DecisionJSON, &item.CreatedAt, &item.UpdatedAt); err != nil {
			return nil, err
		}
		item.NodeRunID = nullableInt64(nodeRunID)
		candidates = append(candidates, item)
	}
	return candidates, rows.Err()
}

func (s *Store) ListDefinitions(ctx context.Context) ([]DefinitionRecord, error) {
	rows, err := s.db.QueryContext(ctx, definitionSelectSQL()+" ORDER BY definition.display_name ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	definitions := []DefinitionRecord{}
	for rows.Next() {
		item, err := scanDefinition(rows)
		if err != nil {
			return nil, err
		}
		definitions = append(definitions, item)
	}
	return definitions, rows.Err()
}

func (s *Store) LoadDefinition(ctx context.Context, id int64) (DefinitionRecord, error) {
	return scanDefinition(s.db.QueryRowContext(ctx, definitionSelectSQL()+" WHERE definition.id = ?", id))
}

func (s *Store) ListTriggers(ctx context.Context) ([]TriggerRecord, error) {
	rows, err := s.db.QueryContext(ctx, triggerSelectSQL()+" ORDER BY trigger.enabled DESC, trigger.display_name ASC")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	triggers := []TriggerRecord{}
	for rows.Next() {
		item, err := scanTrigger(rows)
		if err != nil {
			return nil, err
		}
		triggers = append(triggers, item)
	}
	return triggers, rows.Err()
}

func (s *Store) LoadTrigger(ctx context.Context, id int64) (TriggerRecord, error) {
	return scanTrigger(s.db.QueryRowContext(ctx, triggerSelectSQL()+" WHERE trigger.id = ?", id))
}

func (s *Store) RecordEvent(ctx context.Context, runID int64, level string, eventType string, message string, detail any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := InsertEvent(ctx, tx, runID, EventSpec{Level: level, Type: eventType, Message: message, Detail: detail}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) MarkStaleRuns(ctx context.Context, reason string) (int64, error) {
	return s.markStaleRuns(ctx, reason, 0, true)
}

func (s *Store) MarkStaleRunsVisibleTo(ctx context.Context, reason string, viewerUserID int64, canViewAll bool) (int64, error) {
	return s.markStaleRuns(ctx, reason, viewerUserID, canViewAll)
}

func (s *Store) markStaleRuns(ctx context.Context, reason string, viewerUserID int64, canViewAll bool) (int64, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	conditions, args := appendRunVisibility([]string{"run.status IN ('queued', 'running')"}, nil, viewerUserID, canViewAll)
	rows, err := tx.QueryContext(ctx, `SELECT run.id, run.display_name, run.status FROM workflow_run AS run WHERE `+strings.Join(conditions, " AND ")+` ORDER BY run.created_at ASC, run.id ASC`, args...)
	if err != nil {
		return 0, err
	}
	type staleRun struct {
		id          int64
		displayName string
		status      string
	}
	staleRuns := []staleRun{}
	for rows.Next() {
		var run staleRun
		if err := rows.Scan(&run.id, &run.displayName, &run.status); err != nil {
			rows.Close()
			return 0, err
		}
		staleRuns = append(staleRuns, run)
	}
	if err := rows.Close(); err != nil {
		return 0, err
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	recovered := int64(0)
	for _, run := range staleRuns {
		var activeJobs, recoverableJobs int
		if err := tx.QueryRowContext(ctx, `
			SELECT COUNT(*), COALESCE(SUM(CASE WHEN recoverable = 1 AND resume_count < max_retries THEN 1 ELSE 0 END), 0)
			FROM workflow_job
			WHERE workflow_run_id = ? AND status IN ('queued', 'running')
		`, run.id).Scan(&activeJobs, &recoverableJobs); err != nil {
			return 0, err
		}
		if activeJobs > 0 && activeJobs == recoverableJobs {
			if _, err := tx.ExecContext(ctx, `
				UPDATE workflow_job
				SET status = 'queued', locked_by = '', locked_at = NULL, heartbeat_at = NULL,
					resume_count = resume_count + CASE WHEN status = 'running' THEN 1 ELSE 0 END,
					available_at = CURRENT_TIMESTAMP, error_message = '', updated_at = CURRENT_TIMESTAMP
				WHERE workflow_run_id = ? AND status IN ('queued', 'running')
			`, run.id); err != nil {
				return 0, err
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE workflow_node_run
				SET status = 'queued', error_message = '', finished_at = NULL
				WHERE workflow_run_id = ? AND status IN ('queued', 'running')
			`, run.id); err != nil {
				return 0, err
			}
			if _, err := tx.ExecContext(ctx, `
				UPDATE workflow_run
				SET status = 'queued', finished_at = NULL,
					summary_json = json_set(COALESCE(NULLIF(summary_json, ''), '{}'), '$.recovered', true, '$.recovery_reason', ?)
				WHERE id = ?
			`, reason, run.id); err != nil {
				return 0, err
			}
			if err := InsertEvent(ctx, tx, run.id, EventSpec{
				Level: "warn", Type: "run.requeued_after_restart", Message: "Interrupted run requeued from its last checkpoint",
				Detail: map[string]any{"previous_status": run.status, "reason": reason},
			}); err != nil {
				return 0, err
			}
			recovered++
			continue
		}
		summary, err := marshal(map[string]any{"error": reason, "recovered_stale": true})
		if err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_node_run SET status = 'failed', error_message = CASE WHEN error_message <> '' THEN error_message ELSE ? END, finished_at = CURRENT_TIMESTAMP WHERE workflow_run_id = ? AND status IN ('queued', 'running')`, reason, run.id); err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_job SET status = 'failed', error_message = CASE WHEN error_message <> '' THEN error_message ELSE ? END, updated_at = CURRENT_TIMESTAMP WHERE workflow_run_id = ? AND status IN ('queued', 'running')`, reason, run.id); err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE workflow_run SET status = 'failed', summary_json = ?, finished_at = CURRENT_TIMESTAMP WHERE id = ?`, summary, run.id); err != nil {
			return 0, err
		}
		if err := InsertEvent(ctx, tx, run.id, EventSpec{
			Level: "warn", Type: "run.recovered_stale", Message: "Stale run marked failed",
			Detail: map[string]any{"previous_status": run.status, "reason": reason},
		}); err != nil {
			return 0, err
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return recovered, nil
}

type rowScanner interface {
	Scan(...any) error
}

type runQuerier interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func loadRunFrom(ctx context.Context, db runQuerier, id int64) (RunRecord, error) {
	return scanRun(db.QueryRowContext(ctx, runSelectSQL()+" FROM workflow_run AS run WHERE run.id = ?", id))
}

func scanRuns(rows *sql.Rows) ([]RunRecord, error) {
	defer rows.Close()
	runs := []RunRecord{}
	for rows.Next() {
		item, err := scanRun(rows)
		if err != nil {
			return nil, err
		}
		runs = append(runs, item)
	}
	return runs, rows.Err()
}

func scanRun(row rowScanner) (RunRecord, error) {
	var item RunRecord
	var definitionID, triggerID, reviewedByUserID sql.NullInt64
	err := row.Scan(
		&item.ID, &item.WorkflowCode, &item.DisplayName, &item.Status, &item.TriggerType, &item.TriggerReason,
		&item.CreatedAt, &item.StartedAt, &item.FinishedAt, &item.SummaryJSON,
		&item.NodeRunCount, &item.CompletedNodeRuns, &item.FailedNodeRuns, &item.SkippedNodeRuns,
		&item.JobCount, &item.CompletedJobs, &item.FailedJobs, &item.SkippedJobs,
		&item.CandidateCount, &item.PendingCandidates, &item.AcceptedCandidates, &item.RejectedCandidates,
		&item.ReviewedAt, &reviewedByUserID, &definitionID, &triggerID,
	)
	item.ReviewedByUserID, item.DefinitionID, item.TriggerID = nullableInt64(reviewedByUserID), nullableInt64(definitionID), nullableInt64(triggerID)
	return item, err
}

func scanDefinition(row rowScanner) (DefinitionRecord, error) {
	var item DefinitionRecord
	var ownerUserID sql.NullInt64
	err := row.Scan(&item.ID, &item.Code, &item.DisplayName, &item.Description, &item.DefinitionJSON, &item.Scope, &item.Editable, &ownerUserID, &item.TriggerCount, &item.CreatedAt, &item.UpdatedAt)
	item.OwnerUserID = nullableInt64(ownerUserID)
	return item, err
}

func scanTrigger(row rowScanner) (TriggerRecord, error) {
	var item TriggerRecord
	var nextRunAt, lastRunAt, lastSuccessAt sql.NullString
	err := row.Scan(&item.ID, &item.WorkflowDefinitionID, &item.WorkflowCode, &item.DisplayName, &item.TriggerType, &item.Enabled, &item.ScheduleJSON, &item.ConfigJSON, &nextRunAt, &lastRunAt, &lastSuccessAt, &item.LastErrorMessage, &item.CreatedAt, &item.UpdatedAt)
	item.NextRunAt, item.LastRunAt, item.LastSuccessAt = nullableString(nextRunAt), nullableString(lastRunAt), nullableString(lastSuccessAt)
	return item, err
}

func definitionSelectSQL() string {
	return `SELECT definition.id, definition.code, definition.display_name, definition.description, definition.definition_json, definition.scope, definition.editable, definition.owner_user_id, (SELECT COUNT(*) FROM workflow_trigger WHERE workflow_trigger.workflow_definition_id = definition.id), definition.created_at, definition.updated_at FROM workflow_definition AS definition`
}

func triggerSelectSQL() string {
	return `SELECT trigger.id, trigger.workflow_definition_id, definition.code, trigger.display_name, trigger.trigger_type, trigger.enabled, trigger.schedule_json, trigger.config_json, trigger.next_run_at, trigger.last_run_at, trigger.last_success_at, trigger.last_error_message, trigger.created_at, trigger.updated_at FROM workflow_trigger AS trigger INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id`
}

func runSelectSQL() string {
	return `SELECT run.id, run.workflow_code, run.display_name, run.status, run.trigger_type, run.trigger_reason, run.created_at, COALESCE(run.started_at, ''), COALESCE(run.finished_at, ''), run.summary_json,
		(SELECT COUNT(*) FROM workflow_node_run WHERE workflow_node_run.workflow_run_id = run.id),
		(SELECT COUNT(*) FROM workflow_node_run WHERE workflow_node_run.workflow_run_id = run.id AND workflow_node_run.status = 'succeeded'),
		(SELECT COUNT(*) FROM workflow_node_run WHERE workflow_node_run.workflow_run_id = run.id AND workflow_node_run.status = 'failed'),
		(SELECT COUNT(*) FROM workflow_node_run WHERE workflow_node_run.workflow_run_id = run.id AND workflow_node_run.status = 'skipped'),
		(SELECT COUNT(*) FROM workflow_job WHERE workflow_job.workflow_run_id = run.id),
		(SELECT COUNT(*) FROM workflow_job WHERE workflow_job.workflow_run_id = run.id AND workflow_job.status = 'succeeded'),
		(SELECT COUNT(*) FROM workflow_job WHERE workflow_job.workflow_run_id = run.id AND workflow_job.status = 'failed'),
		(SELECT COUNT(*) FROM workflow_job WHERE workflow_job.workflow_run_id = run.id AND workflow_job.status = 'skipped'),
		(SELECT COUNT(*) FROM workflow_candidate WHERE workflow_candidate.workflow_run_id = run.id),
		(SELECT COUNT(*) FROM workflow_candidate WHERE workflow_candidate.workflow_run_id = run.id AND workflow_candidate.status NOT IN ('accepted', 'rejected', 'ignored', 'resolved')),
		(SELECT COUNT(*) FROM workflow_candidate WHERE workflow_candidate.workflow_run_id = run.id AND workflow_candidate.status = 'accepted'),
		(SELECT COUNT(*) FROM workflow_candidate WHERE workflow_candidate.workflow_run_id = run.id AND workflow_candidate.status = 'rejected'),
		COALESCE((SELECT review.reviewed_at FROM workflow_run_review AS review WHERE review.workflow_run_id = run.id AND review.status = 'reviewed' ORDER BY review.reviewed_at DESC, review.id DESC LIMIT 1), ''),
		(SELECT review.user_id FROM workflow_run_review AS review WHERE review.workflow_run_id = run.id AND review.status = 'reviewed' ORDER BY review.reviewed_at DESC, review.id DESC LIMIT 1),
		run.workflow_definition_id, run.trigger_id`
}

func nullableInt64(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func nullableString(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}
