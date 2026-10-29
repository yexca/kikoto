package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
	"time"
)

type rankingPullCheckpoint struct {
	Detail struct {
		ListIDs []int64 `json:"listIds"`
	} `json:"detail"`
	ScheduleSettled int `json:"rankingScheduleSettled"`
}

// dueRankingListsWhere selects a target's requests and automatic pulls due
// when its executor starts. Requests made after that claim belong to its next
// run, including requests within the same timestamp second.
func dueRankingListsWhere(payload rankingJobPayload, now time.Time) (string, []any) {
	where := `list.enabled = 1 AND list.provider = ?
		AND (list.pull_requested_at IS NOT NULL OR (list.final_at IS NULL AND list.next_pull_at IS NOT NULL AND list.next_pull_at <= ?))`
	args := []any{payload.Provider, formatWorkflowTimestamp(now)}
	if payload.Provider == rankingProviderRemote {
		where += " AND list.file_source_id = ?"
		args = append(args, payload.SourceID)
	}
	return where, args
}

func rankingListsByID(ctx context.Context, reader rankingListReader, ids []int64) ([]rankingList, error) {
	if len(ids) == 0 {
		return []rankingList{}, nil
	}
	args := make([]any, len(ids))
	for index, id := range ids {
		args[index] = id
	}
	return loadRankingListsFrom(ctx, reader, 0, "list.id IN ("+sqlPlaceholders(len(ids))+")", args...)
}

// interruptedRankingPullAt reserves the list's next automatic opportunity
// before outbound work. Cancelling the current pull does not replay it at
// once, including a final annual pull whose due date is already past.
func interruptedRankingPullAt(list rankingList, now time.Time) *time.Time {
	next := nextRankingPullAt(list, now)
	if next != nil && !next.After(now) {
		at := now.Add(time.Duration(list.RefreshIntervalMinutes) * time.Minute)
		next = &at
	}
	return next
}

// claimRankingPullLists commits the selected lists, consumed requests, and a
// fallback schedule together. The checkpoint survives a process stop after a
// request was consumed; a retry reuses the claim without taking new requests.
func (s *Server) claimRankingPullLists(ctx context.Context, job workflowJobRecord, payload rankingJobPayload, now time.Time) ([]rankingList, error) {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var raw string
	if err := tx.QueryRowContext(ctx, `SELECT job.checkpoint_json FROM workflow_job AS job
		JOIN workflow_run AS run ON run.id = job.workflow_run_id
		WHERE job.id = ? AND job.status = 'running' AND run.status = 'running'`, job.ID).Scan(&raw); err != nil {
		return nil, err
	}
	var checkpoint rankingPullCheckpoint
	if err := json.Unmarshal([]byte(raw), &checkpoint); err != nil {
		return nil, err
	}
	if checkpoint.Detail.ListIDs != nil {
		lists, err := rankingListsByID(ctx, tx, checkpoint.Detail.ListIDs)
		if err != nil {
			return nil, err
		}
		return lists, tx.Commit()
	}
	where, args := dueRankingListsWhere(payload, now)
	lists, err := loadRankingListsFrom(ctx, tx, 0, where, args...)
	if err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(lists))
	total := 0
	for _, list := range lists {
		ids = append(ids, list.ID)
		total += len(list.Variants)
		if _, err := tx.ExecContext(ctx, `UPDATE ranking_list SET pull_requested_at = NULL, next_pull_at = ? WHERE id = ?`,
			formatOptionalWorkflowTimestamp(interruptedRankingPullAt(list, now)), list.ID); err != nil {
			return nil, err
		}
	}
	if _, err := tx.ExecContext(ctx, `UPDATE workflow_job SET checkpoint_json = ?, progress_current = 0, progress_total = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
		mustJSON(map[string]any{"phase": "pull", "detail": map[string]any{"listIds": ids}, "progressCurrent": 0, "progressTotal": total, "rankingScheduleSettled": 0}), total, job.ID); err != nil {
		return nil, err
	}
	return lists, tx.Commit()
}

// cancelRankingPullTx consumes an unstarted run's requests inside the same
// transaction as its cancellation. A started run has already consumed them,
// so any remaining request is retained for the next run.
func (s *Server) cancelRankingPullTx(ctx context.Context, tx *sql.Tx, runID int64) error {
	return s.settleInterruptedRankingPullTx(ctx, tx, runID, time.Now().UTC())
}

func (s *Server) settleInterruptedRankingPullTx(ctx context.Context, tx *sql.Tx, runID int64, now time.Time) error {
	var jobID int64
	var payloadJSON, checkpointJSON string
	err := tx.QueryRowContext(ctx, `SELECT id, payload_json, checkpoint_json FROM workflow_job
		WHERE workflow_run_id = ? AND worker_type = ? ORDER BY id DESC LIMIT 1`, runID, rankingPullWorkerType).
		Scan(&jobID, &payloadJSON, &checkpointJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	var checkpoint rankingPullCheckpoint
	if err := json.Unmarshal([]byte(checkpointJSON), &checkpoint); err != nil {
		return err
	}
	if checkpoint.ScheduleSettled != 0 {
		return nil
	}
	var payload rankingJobPayload
	if err := decodeWorkflowJobPayload(payloadJSON, &payload); err != nil {
		return err
	}
	// Recovery may also encounter earlier terminal runs. Their target's newer
	// run owns its schedule and must not be changed by the older settlement.
	newerQuery := "SELECT EXISTS(SELECT 1 FROM workflow_run WHERE id > ? AND workflow_code = ?"
	args := []any{runID, rankingWorkflowCodeFor(payload.Provider)}
	if payload.Provider == rankingProviderRemote {
		newerQuery += " AND json_valid(input_json) AND CAST(json_extract(input_json, '$.source_id') AS INTEGER) = ?"
		args = append(args, payload.SourceID)
	}
	var newer bool
	if err := tx.QueryRowContext(ctx, newerQuery+")", args...).Scan(&newer); err != nil {
		return err
	}
	if !newer {
		claimed := checkpoint.Detail.ListIDs != nil
		var lists []rankingList
		if claimed {
			lists, err = rankingListsByID(ctx, tx, checkpoint.Detail.ListIDs)
		} else {
			where, args := dueRankingListsWhere(payload, now)
			lists, err = loadRankingListsFrom(ctx, tx, 0, where, args...)
		}
		if err != nil {
			return err
		}
		for _, list := range lists {
			if _, err := tx.ExecContext(ctx, `UPDATE ranking_list
				SET pull_requested_at = CASE WHEN ? THEN NULL ELSE pull_requested_at END, next_pull_at = ? WHERE id = ?`,
				!claimed, formatOptionalWorkflowTimestamp(interruptedRankingPullAt(list, now)), list.ID); err != nil {
				return err
			}
		}
	}
	_, err = tx.ExecContext(ctx, `UPDATE workflow_job
		SET checkpoint_json = json_set(checkpoint_json, '$.rankingScheduleSettled', 1) WHERE id = ?`, jobID)
	return err
}

// unsettledRankingPullsSQL selects terminal pulls whose schedules are not
// settled. Its first two terms are those of the partial index
// idx_workflow_job_ranking_unsettled, so a coordinator tick reads only the
// pulls still queued, running, or awaiting settlement, not the job history.
// The unary plus keeps the status terms from choosing the status indexes,
// which cover every job.
const unsettledRankingPullsSQL = `SELECT workflow_run_id FROM workflow_job
	WHERE worker_type = '` + rankingPullWorkerType + `'
		AND COALESCE(json_extract(checkpoint_json, '$.rankingScheduleSettled'), 0) = 0
		AND (+status IN ('failed', 'cancelled')
			OR (+status IN ('succeeded', 'partial') AND json_extract(checkpoint_json, '$.rankingScheduleSettled') = 0))
	ORDER BY id DESC LIMIT 32`

// reconcileInterruptedRankingSchedules settles a bounded batch of terminal
// pulls whose executor or cancellation did not finish schedule settlement.
// Startup and the coordinator repeat it, so a failed settlement write is
// retried without resending the cancelled or interrupted pull.
func (s *Server) reconcileInterruptedRankingSchedules(ctx context.Context) error {
	rows, err := s.db.QueryContext(ctx, unsettledRankingPullsSQL)
	if err != nil {
		return err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	if err := rows.Close(); err != nil {
		return err
	}
	for _, id := range ids {
		tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
		if err != nil {
			return err
		}
		if err := s.settleInterruptedRankingPullTx(ctx, tx, id, time.Now().UTC()); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	if len(ids) > 0 {
		return s.refreshRankingDispatchers(ctx)
	}
	return nil
}

func (s *Server) reconcileInterruptedRankingSchedulesBestEffort(ctx context.Context) {
	settleCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), workflowJobSettleTimeout)
	defer cancel()
	if err := s.reconcileInterruptedRankingSchedules(settleCtx); err != nil {
		slog.Warn("ranking interrupted schedules could not be settled", "error", err)
	}
}

// updateRankingPullCheckpoint only advances a live executor's progress. A
// cancellation's durable schedule settlement is never replaced by a late
// progress write.
func (s *Server) updateRankingPullCheckpoint(ctx context.Context, job workflowJobRecord, ids []int64, pulled, total int) error {
	checkpoint := mustJSON(map[string]any{"phase": "pull", "detail": map[string]any{"listIds": ids, "pulled": pulled},
		"progressCurrent": pulled, "progressTotal": total, "rankingScheduleSettled": 0})
	_, err := s.db.ExecContext(ctx, `UPDATE workflow_job
		SET checkpoint_json = ?, progress_current = ?, progress_total = ?, heartbeat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND status = 'running'`, checkpoint, pulled, total, job.ID)
	return err
}
