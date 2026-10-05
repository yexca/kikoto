package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// Genre name learning fills the shared tag dictionary for preferred languages
// in the background, so a Japanese-only work can show its tags in a preferred
// language. It is a single-flight system workflow whose progress, results and
// failures appear in Activity.
const (
	genreNameWorkflowCode    = "metadata_genre_names"
	genreNameDisplayName     = "Learn tag names"
	genreNameDescription     = "Learn DLsite genre names in the preferred metadata languages, one request per set of unnamed genres."
	genreNameWorkerType      = "metadata_genre_names"
	genreNamePlanNodeID      = "plan"
	genreNamePlanNodeType    = "plan_genre_names"
	genreNamePlanDisplayName = "Find unnamed tags"
	genreNameLearnNodeID     = "learn"
	genreNameLearnNodeType   = "learn_genre_names"
	genreNameLearnName       = "Learn tag names"
	genreNameCheckpointEvery = time.Second
)

var genreNameNodes = []map[string]string{
	{"id": genreNamePlanNodeID, "type": genreNamePlanNodeType, "displayName": genreNamePlanDisplayName},
	{"id": genreNameLearnNodeID, "type": genreNameLearnNodeType, "displayName": genreNameLearnName},
}

type genreNamePayload struct {
	Reason string `json:"reason"`
}

// enqueueGenreNameLearning queues one learning run when a preferred language
// still has learnable genre names, or returns the run already queued or
// running. Callers treat failures as best effort: learning is optional.
func (s *Server) enqueueGenreNameLearning(ctx context.Context, reason string) (int64, error) {
	if s.cfg.IsDemo() {
		return 0, nil
	}
	languages := metasync.GenreNameLearningLanguages(s.preferredMetadataLanguages(ctx))
	if len(languages) == 0 {
		return 0, nil
	}
	pending, err := metasync.PendingGenreNames(ctx, s.db, languages)
	if err != nil || pending == 0 {
		return 0, err
	}
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var existing int64
	err = tx.QueryRowContext(ctx, `SELECT id FROM workflow_run
		WHERE workflow_code = ? AND status IN ('queued', 'running') ORDER BY id DESC LIMIT 1`, genreNameWorkflowCode).Scan(&existing)
	if err == nil {
		return existing, tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	definitionID, err := workflow.EnsureDefinition(ctx, tx, genreNameWorkflowCode, genreNameDisplayName, genreNameDescription,
		map[string]any{"nodes": genreNameNodes})
	if err != nil {
		return 0, err
	}
	payload := genreNamePayload{Reason: reason}
	runID, err := workflow.InsertRun(ctx, tx, definitionID, genreNameWorkflowCode, genreNameDisplayName,
		"queued", "automatic", reason, payload, map[string]any{"pending": pending})
	if err != nil {
		return 0, err
	}
	planNodeID, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: genreNamePlanNodeID, NodeType: genreNamePlanNodeType, DisplayName: genreNamePlanDisplayName,
		Position: 1, Status: "queued", Input: payload,
	})
	if err != nil {
		return 0, err
	}
	if _, err := workflow.InsertNodeRun(ctx, tx, runID, workflow.NodeRunSpec{
		NodeID: genreNameLearnNodeID, NodeType: genreNameLearnNodeType, DisplayName: genreNameLearnName,
		Position: 2, Status: "queued",
	}); err != nil {
		return 0, err
	}
	if _, err := workflow.InsertJob(ctx, tx, runID, workflow.JobSpec{
		NodeRunID: planNodeID, WorkerType: genreNameWorkerType, Status: "queued",
		Priority: workflow.JobPriorityBackground, ResourceKey: "metadata:provider", Payload: payload,
		Checkpoint: map[string]any{"phase": "queued"}, Recoverable: true, MaxRetries: 3, ProgressTotal: pending,
	}); err != nil {
		return 0, err
	}
	return runID, tx.Commit()
}

// queueGenreNameLearning is the best-effort hook used after metadata changes.
func (s *Server) queueGenreNameLearning(ctx context.Context, reason string) {
	if _, err := s.enqueueGenreNameLearning(ctx, reason); err != nil && ctx.Err() == nil {
		slog.Warn("queue genre name learning failed", "reason", reason, "error", err)
	}
}

// executeGenreNameLearningJob learns names for the languages preferred when
// the job runs. Each answered request is committed as it completes, so a
// retried or resumed job continues from the remaining unnamed genres.
func (s *Server) executeGenreNameLearningJob(ctx context.Context, job workflowJobRecord) error {
	nodeIDs, err := workflowNodeIDsByNodeID(ctx, s.db, job.RunID)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	languages := metasync.GenreNameLearningLanguages(s.preferredMetadataLanguages(ctx))
	pending, err := metasync.PendingGenreNames(ctx, s.db, languages)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	if err := s.startGenreNameLearning(ctx, job, nodeIDs, languages, pending); err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	lastCheckpoint := time.Now()
	report := func(progress metasync.GenreNameLearningResult) {
		if time.Since(lastCheckpoint) < genreNameCheckpointEvery {
			return
		}
		lastCheckpoint = time.Now()
		_ = s.updateWorkflowJobCheckpoint(ctx, job.ID, "learning", map[string]any{
			"requests": progress.Requests, "learnedNames": progress.LearnedNames, "exhausted": progress.Exhausted, "failed": progress.Failed,
		}, min(pending, progress.LearnedNames+progress.Exhausted), pending)
	}
	result, err := s.newDLsiteMetadataSyncer(ctx).LearnGenreNames(ctx, languages, report)
	if err != nil {
		_ = s.failClaimedWorkflowJob(ctx, job, err.Error())
		return err
	}
	status := "succeeded"
	if result.Failed > 0 {
		status = "partial"
	}
	return s.finishGenreNameLearningJob(context.WithoutCancel(ctx), job, nodeIDs[genreNameLearnNodeID], status, pending, result)
}

func (s *Server) startGenreNameLearning(ctx context.Context, job workflowJobRecord, nodeIDs map[string]int64, languages []string, pending int) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	output := mustJSON(map[string]any{"languages": languages, "pending": pending})
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = 'succeeded', output_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{output, nodeIDs[genreNamePlanNodeID]}},
		{`UPDATE workflow_node_run SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP)
			WHERE id = ? AND status = 'queued'`, []any{nodeIDs[genreNameLearnNodeID]}},
		{`UPDATE workflow_job SET progress_current = 0, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, []any{pending, job.ID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) finishGenreNameLearningJob(ctx context.Context, job workflowJobRecord, learnNodeID int64, status string, pending int, result metasync.GenreNameLearningResult) error {
	output := mustJSON(result)
	done := max(0, pending-result.Remaining)
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// Guards keep a run that was cancelled while learning cancelled.
	for _, step := range []struct {
		query string
		args  []any
	}{
		{`UPDATE workflow_node_run SET status = ?, output_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, learnNodeID}},
		{`UPDATE workflow_job SET status = ?, progress_current = ?, progress_total = ?, error_message = ?,
			locked_by = '', locked_at = NULL, heartbeat_at = NULL, checkpoint_json = ?, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status = 'running'`, []any{status, done, pending, strings.Join(result.Failures, "\n"),
			mustJSON(map[string]any{"phase": "completed", "detail": result, "progressCurrent": done, "progressTotal": pending}), job.ID}},
		{`UPDATE workflow_run SET status = ?, summary_json = ?, finished_at = CURRENT_TIMESTAMP
			WHERE id = ? AND status IN ('queued', 'running')`, []any{status, output, job.RunID}},
	} {
		if _, err := tx.ExecContext(ctx, step.query, step.args...); err != nil {
			return err
		}
	}
	if err := workflow.InsertEvent(ctx, tx, job.RunID, workflow.EventSpec{
		NodeRunID: learnNodeID, JobID: job.ID, Level: eventLevelForWorkflowStatus(status),
		Type: "metadata.genre_names_learned", Message: "Tag name learning " + status, Detail: result,
	}); err != nil {
		return err
	}
	return tx.Commit()
}
