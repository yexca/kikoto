package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

const (
	databaseBackupWorkflowCode = "database_backup"
	databaseBackupWorkerType   = "database_backup"
	databaseBackupDisplayName  = "Back up database"

	// databaseBackupPeriod is the age after which the coordinator queues the
	// next automatic backup. Manual backups count as recent backups.
	databaseBackupPeriod            = 24 * time.Hour
	databaseBackupCheckInitialDelay = 5 * time.Minute
	databaseBackupCheckPeriod       = time.Hour
	databaseScheduledBackupsKept    = 7
	databaseManualBackupsKept       = 5
)

var errDatabaseBackupUnavailable = errors.New("database backups are not available for this database")

type databaseBackupPayload struct {
	RequestedByUserID int64  `json:"requested_by_user_id,omitempty"`
	Kind              string `json:"kind"`
}

type databaseBackupListResponse struct {
	Available bool                 `json:"available"`
	Backups   []storage.BackupFile `json:"backups"`
}

// listDatabaseBackups reports backup names, kinds, sizes, and times. The
// backup directory itself is deployment detail and is not returned.
func (s *Server) listDatabaseBackups(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "sources:write"); !ok {
		return
	}
	response := databaseBackupListResponse{Available: s.cfg.DatabaseBackupDir != "", Backups: []storage.BackupFile{}}
	if response.Available {
		backups, err := storage.ListBackups(s.cfg.DatabaseBackupDir)
		if err != nil {
			slog.Error("list database backups", "error", err)
			writeError(w, errors.New("database backups could not be listed"))
			return
		}
		response.Backups = backups
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) backUpDatabase(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "sources:write")
	if !ok {
		return
	}
	if s.cfg.DatabaseBackupDir == "" {
		writeAPIError(w, http.StatusConflict, "database_backup_unavailable", errDatabaseBackupUnavailable.Error(), false)
		return
	}
	result, err := s.enqueueDatabaseBackup(r.Context(), storage.BackupKindManual, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, result)
}

// enqueueDatabaseBackup queues one backup job. At most one backup is queued or
// running at a time; a second request returns the active run.
func (s *Server) enqueueDatabaseBackup(ctx context.Context, kind string, actorUserID int64) (databaseOptimizeQueuedResult, error) {
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
	`, databaseBackupWorkflowCode).Scan(&existing.RunID, &existing.Status, &existing.JobID)
	if err == nil {
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return databaseOptimizeQueuedResult{}, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, databaseBackupWorkflowCode, databaseBackupDisplayName,
		"Write a verified copy of the SQLite database beside it and keep a bounded number of recent copies.",
		map[string]any{"nodes": []map[string]string{{"id": "backup", "type": "backup_database", "displayName": "Back up database"}}})
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	triggerType, triggerReason, priority := "manual", "maintenance_database_backup", workflow.JobPriorityUserInitiated
	if kind == storage.BackupKindScheduled {
		triggerType, triggerReason, priority = "schedule", "database_backup_schedule", workflow.JobPriorityBackground
	}
	payload := databaseBackupPayload{RequestedByUserID: actorUserID, Kind: kind}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, databaseBackupWorkflowCode, databaseBackupDisplayName,
		"queued", triggerType, triggerReason, payload, map[string]any{})
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	nodeRunID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: "backup", NodeType: "backup_database", DisplayName: "Back up database", Position: 1, Status: "queued",
	})
	if err != nil {
		return databaseOptimizeQueuedResult{}, err
	}
	// A backup has no checkpoint; an interrupted one leaves only a partial
	// file that the next backup replaces, so it fails and is started again.
	jobID, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: nodeRunID, WorkerType: databaseBackupWorkerType, Status: "queued",
		Priority: priority, ResourceKey: "database:backup", Payload: payload,
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

func (s *Server) executeDatabaseBackupJob(ctx context.Context, job workflowJobRecord) error {
	var payload databaseBackupPayload
	if err := decodeWorkflowJobPayload(job.PayloadJSON, &payload); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if payload.Kind != storage.BackupKindScheduled {
		payload.Kind = storage.BackupKindManual
	}
	if s.cfg.DatabaseBackupDir == "" {
		_ = s.failClaimedWorkflowJob(ctx, job, errDatabaseBackupUnavailable.Error())
		return errDatabaseBackupUnavailable
	}
	name := storage.BackupFileName(payload.Kind, time.Now(), "")
	size, err := storage.BackupInto(ctx, s.db, filepath.Join(s.cfg.DatabaseBackupDir, name))
	if err != nil && shutdownInterrupted(ctx) {
		return err
	}
	if err != nil {
		// The detailed error can name the backup directory; keep it in the
		// server log and record a generic failure in Activity.
		slog.Error("database backup failed", "run_id", job.RunID, "error", err)
		_ = s.failClaimedWorkflowJob(context.WithoutCancel(ctx), job, "database backup failed; see the server log for details")
		return err
	}
	keep := databaseManualBackupsKept
	if payload.Kind == storage.BackupKindScheduled {
		keep = databaseScheduledBackupsKept
	}
	pruned, err := storage.PruneBackups(s.cfg.DatabaseBackupDir, payload.Kind, keep)
	if err != nil {
		slog.Warn("prune database backups", "kind", payload.Kind, "error", err)
	}
	output := mustJSON(map[string]any{"name": name, "kind": payload.Kind, "size_bytes": size, "pruned": pruned})
	return s.finishDatabaseBackupJob(context.WithoutCancel(ctx), job, payload, output)
}

func (s *Server) finishDatabaseBackupJob(ctx context.Context, job workflowJobRecord, payload databaseBackupPayload, output string) error {
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
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if payload.Kind == storage.BackupKindManual && payload.RequestedByUserID > 0 {
		if _, err := tx.ExecContext(ctx, `INSERT INTO audit_log (actor_user_id, action, target_type, target_id, detail_json)
			VALUES ((SELECT id FROM user_account WHERE id = ?), 'database.backup', 'database', '', ?)`,
			payload.RequestedByUserID, output); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// queueDueDatabaseBackup queues an automatic backup when the newest routine
// backup is older than the backup period. Pre-migration snapshots do not count:
// they record the state before an upgrade, not the current database.
func (s *Server) queueDueDatabaseBackup(ctx context.Context, now time.Time) {
	if s.cfg.DatabaseBackupDir == "" || s.cfg.IsDemo() {
		return
	}
	backups, err := storage.ListBackups(s.cfg.DatabaseBackupDir)
	if err != nil {
		slog.Error("list database backups", "error", err)
		return
	}
	for _, backup := range backups {
		if backup.Kind == storage.BackupKindPreMigration {
			continue
		}
		if now.Sub(backup.CreatedAt) < databaseBackupPeriod {
			return
		}
		break
	}
	if _, err := s.enqueueDatabaseBackup(ctx, storage.BackupKindScheduled, 0); err != nil && !errors.Is(err, context.Canceled) {
		slog.Error("queue automatic database backup", "error", err)
	}
}
