package metasync

import (
	"context"
	"database/sql"
	"errors"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

type syncContextKey int

const (
	syncAttemptKey syncContextKey = iota
	syncRunKey
)

// WithWorkflowRun associates shared recovery state with an existing run. It
// does not change that run's result, ownership, or user review records.
func WithWorkflowRun(ctx context.Context, runID int64) context.Context {
	return context.WithValue(ctx, syncRunKey, runID)
}

func attemptID(ctx context.Context) int64 {
	id, _ := ctx.Value(syncAttemptKey).(int64)
	return id
}

func (s *DLsiteSyncer) beginAttempt(ctx context.Context) (context.Context, error) {
	if attemptID(ctx) > 0 {
		return ctx, nil
	}
	result, err := s.db.ExecContext(ctx, "INSERT INTO metadata_sync_attempt DEFAULT VALUES")
	if err != nil {
		return ctx, err
	}
	id, err := result.LastInsertId()
	if err != nil {
		return ctx, err
	}
	ctx = context.WithValue(ctx, syncAttemptKey, id)
	return ctx, s.linkAttemptRun(ctx, id)
}

func (s *DLsiteSyncer) linkAttemptRun(ctx context.Context, id int64) error {
	runID, _ := ctx.Value(syncRunKey).(int64)
	if runID <= 0 || id <= 0 {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `INSERT OR IGNORE INTO metadata_sync_attempt_run (attempt_id, workflow_run_id)
		SELECT ?, id FROM workflow_run WHERE id = ?`, id, runID)
	return err
}

func (s *DLsiteSyncer) recordCodeOutcome(ctx context.Context, code, component string, outcome error) error {
	if ctx.Err() != nil {
		return nil
	}
	workID, found, err := s.workIDForCode(ctx, code)
	if err != nil || !found {
		return err
	}
	ctx, err = s.beginAttempt(ctx)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	providerID, err := ensureMetadataProvider(ctx, tx, "dlsite", "DLsite")
	if err != nil {
		return err
	}
	status := "succeeded"
	if errors.Is(outcome, dlsite.ErrNoProduct) {
		status = "unavailable"
	} else if outcome != nil {
		status = "failed"
	}
	if err := recordSyncOutcome(ctx, tx, workID, providerID, component, status); err != nil {
		return err
	}
	return tx.Commit()
}

// recordSyncOutcome stores only fixed status codes. Detailed errors remain in
// the original protected workflow diagnostics, never in the shared issue list.
func recordSyncOutcome(ctx context.Context, tx *sql.Tx, workID, providerID int64, component, status string) error {
	id := attemptID(ctx)
	if _, err := tx.ExecContext(ctx, `INSERT INTO metadata_sync_attempt_work (attempt_id, work_id, provider_id, component, status)
		VALUES (?, ?, ?, ?, ?) ON CONFLICT(attempt_id, work_id, provider_id, component) DO UPDATE SET status = excluded.status`,
		id, workID, providerID, component, status); err != nil {
		return err
	}
	lastSuccess := int64(0)
	if status == "succeeded" {
		lastSuccess = id
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO work_metadata_sync_state
			(work_id, provider_id, component, attempt_id, last_success_attempt_id, status, failure_count, first_failed_at)
		VALUES (?, ?, ?, ?, ?, ?, CASE WHEN ? = 'succeeded' THEN 0 ELSE 1 END,
			CASE WHEN ? = 'succeeded' THEN NULL ELSE CURRENT_TIMESTAMP END)
		ON CONFLICT(work_id, provider_id, component) DO UPDATE SET
			last_success_attempt_id = MAX(work_metadata_sync_state.last_success_attempt_id, excluded.last_success_attempt_id),
			status = CASE WHEN excluded.attempt_id >= work_metadata_sync_state.attempt_id THEN excluded.status ELSE work_metadata_sync_state.status END,
			failure_count = CASE WHEN excluded.attempt_id < work_metadata_sync_state.attempt_id THEN work_metadata_sync_state.failure_count
				WHEN excluded.status = 'succeeded' THEN 0
				WHEN excluded.attempt_id = work_metadata_sync_state.attempt_id THEN MAX(1, work_metadata_sync_state.failure_count)
				ELSE work_metadata_sync_state.failure_count + 1 END,
			first_failed_at = CASE WHEN excluded.attempt_id < work_metadata_sync_state.attempt_id THEN work_metadata_sync_state.first_failed_at
				WHEN excluded.status = 'succeeded' THEN NULL ELSE COALESCE(work_metadata_sync_state.first_failed_at, CURRENT_TIMESTAMP) END,
			checked_at = CASE WHEN excluded.attempt_id >= work_metadata_sync_state.attempt_id THEN CURRENT_TIMESTAMP ELSE work_metadata_sync_state.checked_at END,
			attempt_id = MAX(work_metadata_sync_state.attempt_id, excluded.attempt_id)
	`, workID, providerID, component, id, lastSuccess, status, status, status)
	if err != nil || component != "metadata" || status == "failed" {
		return err
	}
	providerStatus := "available"
	message := ""
	if status == "unavailable" {
		providerStatus = "not_found"
		message = "Metadata product not found"
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO work_metadata_provider_state (work_id, provider_id, status, message)
		SELECT ?, ?, ?, ? WHERE EXISTS (
			SELECT 1 FROM work_metadata_sync_state WHERE work_id = ? AND provider_id = ? AND component = 'metadata' AND attempt_id = ?)
		ON CONFLICT(work_id, provider_id) DO UPDATE SET status = excluded.status, message = excluded.message, checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`,
		workID, providerID, providerStatus, message, workID, providerID, id)
	return err
}

func newerMetadataWasStored(ctx context.Context, tx *sql.Tx, workID, providerID int64) (bool, error) {
	var newer bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM work_metadata_sync_state
		WHERE work_id = ? AND provider_id = ? AND component = 'metadata' AND last_success_attempt_id > ?)`,
		workID, providerID, attemptID(ctx)).Scan(&newer)
	return newer, err
}
