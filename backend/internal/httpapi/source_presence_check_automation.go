package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// A remote source's automatic library work checks are configured on the
// source: one set of options, at most one startup check, and at most one
// interval check. They are stored as source presence check triggers that name
// the source in their config, and saved together in one transaction.

const sourcePresenceCheckStartupScheduleJSON = `{"type":"startup"}`

// sourcePresenceCheckSettingsRequest replaces a source's options and its
// startup and interval checks.
type sourcePresenceCheckSettingsRequest struct {
	Options *sourcePresenceCheckOptions `json:"options"`
	Startup *struct {
		Enabled bool `json:"enabled"`
	} `json:"startup"`
	Schedule *struct {
		Enabled         bool `json:"enabled"`
		IntervalMinutes int  `json:"intervalMinutes"`
	} `json:"schedule"`
}

func (s *Server) updateSourcePresenceCheck(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermissions(w, r, "workflows:run", "sources:write"); !ok {
		return
	}
	sourceID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid file source id", false)
		return
	}
	var request sourcePresenceCheckSettingsRequest
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil && !errors.Is(err, io.EOF) {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid source presence check settings", false)
		return
	}
	if request.Options == nil || request.Startup == nil || request.Schedule == nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "options, startup, and schedule are required", false)
		return
	}
	options := *request.Options
	if options.SourceID != 0 && options.SourceID != sourceID {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "options name another source", false)
		return
	}
	options.SourceID = sourceID
	options, err = normalizeSourcePresenceCheckOptions(options)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
		return
	}
	interval := request.Schedule.IntervalMinutes
	if interval < minimumWorkflowIntervalMinutes || interval > maximumWorkflowIntervalMinutes {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", fmt.Sprintf("intervalMinutes must be between %d and %d", minimumWorkflowIntervalMinutes, maximumWorkflowIntervalMinutes), false)
		return
	}
	source, err := s.loadRemoteSourceForUse(r.Context(), sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "not_found", "file source not found", false)
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if !isKikoeruSourceType(source.SourceType) {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "source type does not support work checks", false)
		return
	}
	// Switching a check on needs a source that can run it; saving options or
	// switching checks off does not, so a paused check stays manageable.
	if request.Startup.Enabled || request.Schedule.Enabled {
		var inputErr sourcePresenceCheckInputError
		if _, err := s.sourcePresenceCheckSource(r.Context(), sourceID); errors.As(err, &inputErr) {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", inputErr.Error(), false)
			return
		} else if err != nil {
			writeError(w, err)
			return
		}
	}
	startup := sourcePresenceCheckAutomatic{Enabled: request.Startup.Enabled}
	schedule := sourcePresenceCheckAutomatic{Enabled: request.Schedule.Enabled, IntervalMinutes: interval}
	if err := s.saveSourcePresenceCheckTriggers(r.Context(), options, startup, schedule, time.Now().UTC()); err != nil {
		writeError(w, err)
		return
	}
	check, err := s.loadSourcePresenceCheck(r.Context(), sourceID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, check)
}

// saveSourcePresenceCheckTriggers stores a source's options and its startup
// and interval checks in one transaction. Each kind keeps its oldest trigger
// and removes any later duplicate; a kind switched off with no trigger stores
// nothing. An interval check that stays on with the same interval keeps its
// next run.
func (s *Server) saveSourcePresenceCheckTriggers(
	ctx context.Context,
	options sourcePresenceCheckOptions,
	startup sourcePresenceCheckAutomatic,
	schedule sourcePresenceCheckAutomatic,
	now time.Time,
) error {
	tx, err := beginTxWithDatabaseBusyRetry(ctx, s.db)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	definitionID, err := workflow.EnsureDefinition(ctx, tx, sourcePresenceCheckWorkflowCode, sourcePresenceCheckDisplayName,
		sourcePresenceCheckDescription, map[string]any{"nodes": sourcePresenceCheckNodes})
	if err != nil {
		return err
	}
	triggers, err := loadSourcePresenceCheckTriggers(ctx, tx, options.SourceID)
	if err != nil {
		return err
	}
	configJSON := mustJSON(options)
	for _, kind := range []struct {
		triggerType string
		want        sourcePresenceCheckAutomatic
	}{{"startup", startup}, {"schedule", schedule}} {
		var kept *sourcePresenceCheckTrigger
		for index := range triggers {
			if triggers[index].TriggerType != kind.triggerType {
				continue
			}
			if kept == nil {
				kept = &triggers[index]
				continue
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM workflow_trigger WHERE id = ?", triggers[index].ID); err != nil {
				return err
			}
		}
		if kept == nil && !kind.want.Enabled {
			continue
		}
		scheduleJSON := sourcePresenceCheckStartupScheduleJSON
		var nextRunAt any
		if kind.triggerType == "schedule" {
			scheduleJSON = mustJSON(workflowIntervalSchedule{IntervalMinutes: kind.want.IntervalMinutes})
			if kind.want.Enabled {
				if kept != nil && kept.Enabled && kept.NextRunAt.Valid && sameJSONDocument(kept.ScheduleJSON, scheduleJSON) {
					nextRunAt = kept.NextRunAt.String
				} else {
					nextRunAt = formatWorkflowTimestamp(now.Add(time.Duration(kind.want.IntervalMinutes) * time.Minute))
				}
			}
		}
		if kept == nil {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json, next_run_at)
				VALUES (?, ?, ?, 1, ?, ?, ?)
			`, definitionID, kind.triggerType, sourcePresenceCheckDisplayName, scheduleJSON, configJSON, nextRunAt); err != nil {
				return err
			}
			continue
		}
		if _, err := tx.ExecContext(ctx, `
			UPDATE workflow_trigger
			SET enabled = ?, schedule_json = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP,
				-- A check switched on again or given other options no longer
				-- reports why it was paused or how its old options failed.
				last_error_message = CASE WHEN enabled = ? AND config_json = ? THEN last_error_message ELSE '' END,
				config_json = ?
			WHERE id = ?
		`, kind.want.Enabled, scheduleJSON, nextRunAt, kind.want.Enabled, configJSON, configJSON, kept.ID); err != nil {
			return err
		}
	}
	return tx.Commit()
}
