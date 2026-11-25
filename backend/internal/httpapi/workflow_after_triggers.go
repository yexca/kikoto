package httpapi

import (
	"context"
	"fmt"
	"log/slog"
	"slices"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// Which triggers start each built-in operation on its own. Startup and
// watching belong to the scans, which bring the library up to date with the
// disk; the operations that work on what a scan found follow it with an After
// trigger instead, and every operation takes an interval.
var systemWorkflowTriggerKinds = map[string][]string{
	"local_library_scan":            {"startup", "schedule", "filesystem_event"},
	"metadata_sync":                 {"schedule", workflow.AfterWorkflowTriggerType},
	localMediaIndexWorkflowCode:     {"schedule", workflow.AfterWorkflowTriggerType},
	recordScanWorkflowCode:          {"startup", "schedule"},
	recordProbeWorkflowCode:         {"schedule", workflow.AfterWorkflowTriggerType},
	sourcePresenceCheckWorkflowCode: {"startup", "schedule"},
}

// afterWorkflowUpstreams names the run each operation's After trigger follows.
var afterWorkflowUpstreams = map[string]string{
	"metadata_sync":             "local_library_scan",
	localMediaIndexWorkflowCode: "local_library_scan",
	recordProbeWorkflowCode:     recordScanWorkflowCode,
}

func systemWorkflowTakesTrigger(code, triggerType string) bool {
	return slices.Contains(systemWorkflowTriggerKinds[code], triggerType)
}

type afterWorkflowSchedule struct {
	After string `json:"after"`
}

// validateAfterWorkflowSchedule accepts only the upstream the operation
// follows, so an After trigger cannot chain operations another way.
func validateAfterWorkflowSchedule(code, raw string) error {
	var schedule afterWorkflowSchedule
	if err := decodeStrictJSON(raw, &schedule); err != nil {
		return fmt.Errorf("schedule JSON must name the workflow the trigger follows")
	}
	if want := afterWorkflowUpstreams[code]; want == "" || schedule.After != want {
		return fmt.Errorf("this workflow follows %s", afterWorkflowUpstreams[code])
	}
	return nil
}

// dispatchLocalScanAfterTriggers follows a finished local scan: a metadata
// sync when it added works, and, after a complete scan, the file index when
// folders are left unindexed. An incremental scan indexes every work it
// touches, so it never leaves the index anything.
func (s *Server) dispatchLocalScanAfterTriggers(ctx context.Context, runID int64, newWorkCodes []string, complete bool) {
	ctx = context.WithoutCancel(ctx)
	s.dispatchAfterWorkflowTriggers(ctx, "local_library_scan", runID, func(code string) bool {
		switch code {
		case "metadata_sync":
			return len(newWorkCodes) > 0
		case localMediaIndexWorkflowCode:
			if !complete {
				return false
			}
			targets, err := s.selectLocalMediaIndexTargets(ctx, localMediaIndexModeIncremental)
			if err != nil {
				slog.Error("select folders for the after-scan file index", "run_id", runID, "error", err)
				return false
			}
			return len(targets) > 0
		}
		return false
	})
}

// dispatchRecordScanAfterTriggers follows a finished Record scan with media
// details when it left files newly waiting for theirs.
func (s *Server) dispatchRecordScanAfterTriggers(ctx context.Context, runID int64, newPending int) {
	s.dispatchAfterWorkflowTriggers(ctx, recordScanWorkflowCode, runID, func(code string) bool {
		return code == recordProbeWorkflowCode && newPending > 0
	})
}

// dispatchAfterWorkflowTriggers starts the operations whose enabled After
// trigger follows the upstream run that just finished, each only when follows
// says the run left it work to do. A failure to queue one is recorded on its
// trigger and does not change the upstream run.
func (s *Server) dispatchAfterWorkflowTriggers(ctx context.Context, upstream string, upstreamRunID int64, follows func(code string) bool) {
	if s.cfg.IsDemo() {
		return
	}
	ctx = context.WithoutCancel(ctx)
	triggers, err := s.workflowStore.ListEnabledAfterTriggers(ctx, upstream)
	if err != nil {
		slog.Error("list after workflow triggers", "upstream", upstream, "run_id", upstreamRunID, "error", err)
		return
	}
	for _, trigger := range triggers {
		if afterWorkflowUpstreams[trigger.WorkflowCode] != upstream || !follows(trigger.WorkflowCode) {
			continue
		}
		definition, err := s.loadWorkflowDefinition(ctx, trigger.WorkflowDefinitionID)
		if err != nil {
			slog.Error("load after workflow trigger definition", "trigger_id", trigger.ID, "error", err)
			continue
		}
		s.execBestEffort(ctx, "record after workflow trigger run",
			"UPDATE workflow_trigger SET last_run_at = CURRENT_TIMESTAMP, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", trigger.ID)
		reason := fmt.Sprintf("after_run:%d", upstreamRunID)
		if err := s.executeSystemWorkflowTrigger(ctx, definition, trigger, workflow.AfterWorkflowTriggerType, reason); err != nil {
			slog.Error("dispatch after workflow trigger", "trigger_id", trigger.ID, "upstream_run_id", upstreamRunID, "error", err)
		}
	}
}
