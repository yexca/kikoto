package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"log/slog"
)

// sourceChangeTriggerType marks a source presence check that a source becoming
// usable queued: created enabled, switched on, or pointed at another API.
const sourceChangeTriggerType = "source_change"

// fileSourcePresenceCheck is a remote source's library work check as source
// settings show it: the latest run and the next scheduled one.
type fileSourcePresenceCheck struct {
	LastRun   *fileSourcePresenceCheckRun `json:"lastRun"`
	NextRunAt *string                     `json:"nextRunAt"`
}

type fileSourcePresenceCheckRun struct {
	ID             int64  `json:"id"`
	Status         string `json:"status"`
	At             string `json:"at"`
	CheckedWorks   int    `json:"checkedWorks"`
	AvailableWorks int    `json:"availableWorks"`
}

// attachSourcePresenceChecks adds each checkable remote source's latest check
// and next scheduled check.
func (s *Server) attachSourcePresenceChecks(ctx context.Context, sources []fileSourceSummary) error {
	for index := range sources {
		if !isKikoeruSourceType(sources[index].SourceType) {
			continue
		}
		check, err := s.loadSourcePresenceCheck(ctx, sources[index].ID)
		if err != nil {
			return err
		}
		sources[index].PresenceCheck = &check
	}
	return nil
}

func (s *Server) loadSourcePresenceCheck(ctx context.Context, sourceID int64) (fileSourcePresenceCheck, error) {
	check := fileSourcePresenceCheck{}
	var run fileSourcePresenceCheckRun
	var summaryJSON string
	err := s.db.QueryRowContext(ctx, `
		SELECT id, status, COALESCE(finished_at, started_at, created_at), COALESCE(summary_json, '{}')
		FROM workflow_run
		WHERE workflow_code = ? AND json_extract(input_json, '$.sourceId') = ?
		ORDER BY id DESC
		LIMIT 1
	`, sourcePresenceCheckWorkflowCode, sourceID).Scan(&run.ID, &run.Status, &run.At, &summaryJSON)
	switch {
	case err == nil:
		var summary struct {
			Checked   int `json:"checked_works"`
			Available int `json:"available_works"`
		}
		_ = json.Unmarshal([]byte(summaryJSON), &summary)
		run.CheckedWorks, run.AvailableWorks = summary.Checked, summary.Available
		check.LastRun = &run
	case !errors.Is(err, sql.ErrNoRows):
		return check, err
	}
	var nextRunAt sql.NullString
	if err := s.db.QueryRowContext(ctx, `
		SELECT MIN(trigger.next_run_at)
		FROM workflow_trigger AS trigger
		INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id
		WHERE definition.code = ? AND definition.scope = 'system'
			AND trigger.enabled = 1 AND trigger.trigger_type = 'schedule'
			AND trigger.next_run_at IS NOT NULL
			AND json_extract(trigger.config_json, '$.sourceId') = ?
	`, sourcePresenceCheckWorkflowCode, sourceID).Scan(&nextRunAt); err != nil {
		return check, err
	}
	if nextRunAt.Valid {
		check.NextRunAt = &nextRunAt.String
	}
	return check, nil
}

// deleteSourcePresenceCheckTriggersTx removes the checks scheduled for a
// source that is being deleted; they are configured on that source and would
// have nowhere left to show.
func deleteSourcePresenceCheckTriggersTx(ctx context.Context, tx *sql.Tx, sourceID int64) error {
	_, err := tx.ExecContext(ctx, `
		DELETE FROM workflow_trigger
		WHERE workflow_definition_id IN (
				SELECT id FROM workflow_definition WHERE code = ? AND scope = 'system'
			)
			AND json_extract(config_json, '$.sourceId') = ?
	`, sourcePresenceCheckWorkflowCode, sourceID)
	return err
}

// queueSourceChangePresenceCheck asks a source that just became usable which
// local works without a remote source it has, as a recorded run with the
// default options. A source that cannot answer work checks is skipped.
func (s *Server) queueSourceChangePresenceCheck(ctx context.Context, sourceID int64, reason string) {
	_, err := s.enqueueSourcePresenceCheck(ctx, sourcePresenceCheckOptions{SourceID: sourceID},
		workflowRunTrigger{Type: sourceChangeTriggerType, Reason: reason})
	var inputErr sourcePresenceCheckInputError
	if err != nil && !errors.As(err, &inputErr) {
		slog.Warn("source change presence check could not be queued", "source_id", sourceID, "error", err)
	}
}
