package httpapi

import (
	"context"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

func newScheduledDispatchServer(t *testing.T) (*Server, *sqlutil.DB) {
	t.Helper()
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), LocalScanDepth: 2})
	if err := server.ensureSystemWorkflowDefinitions(context.Background()); err != nil {
		t.Fatal(err)
	}
	return server, db
}

func insertScheduledDispatchTrigger(t *testing.T, db *sqlutil.DB, workflowCode, configJSON, nextRunAt string) int64 {
	t.Helper()
	result, err := db.Exec(`INSERT INTO workflow_trigger (workflow_definition_id, trigger_type, display_name, enabled, schedule_json, config_json, next_run_at)
		VALUES ((SELECT id FROM workflow_definition WHERE code = ?), 'schedule', 'Example schedule', 1, '{"intervalMinutes":60}', ?, ?)`,
		workflowCode, configJSON, nextRunAt)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	return id
}

type scheduledDispatchTriggerState struct {
	enabled   bool
	nextRunAt string
	lastError string
	runs      int
}

func loadScheduledDispatchTrigger(t *testing.T, db *sqlutil.DB, triggerID int64) scheduledDispatchTriggerState {
	t.Helper()
	var state scheduledDispatchTriggerState
	if err := db.QueryRow(`SELECT enabled, COALESCE(next_run_at, ''), last_error_message,
		(SELECT COUNT(*) FROM workflow_run WHERE trigger_id = workflow_trigger.id)
		FROM workflow_trigger WHERE id = ?`, triggerID).Scan(&state.enabled, &state.nextRunAt, &state.lastError, &state.runs); err != nil {
		t.Fatal(err)
	}
	return state
}

// waitForTrackedDispatches stops the server's background work, which waits
// for the dispatches it started.
func waitForTrackedDispatches(t *testing.T, server *Server) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
}

// The dispatcher picks the earliest due trigger. One that fails before its
// next run moves waits the retry delay with its reason, and the next due
// trigger still dispatches.
func TestScheduledDispatchBacksOffAFailingTriggerAndDispatchesOthers(t *testing.T) {
	server, db := newScheduledDispatchServer(t)
	ctx := context.Background()
	failing := insertScheduledDispatchTrigger(t, db, sourcePresenceCheckWorkflowCode, "not json", "2000-01-01 00:00:00")
	healthy := insertScheduledDispatchTrigger(t, db, "local_library_scan", `{"scanMode":"full"}`, "2000-01-01 00:01:00")

	if err := server.dispatchDueScheduledWorkflowTrigger(ctx); err == nil {
		t.Fatal("the failing trigger dispatched")
	}
	now := time.Now().UTC()
	state := loadScheduledDispatchTrigger(t, db, failing)
	if !state.enabled || state.nextRunAt <= formatWorkflowTimestamp(now) ||
		state.nextRunAt > formatWorkflowTimestamp(now.Add(workflowTriggerDispatchRetryDelay+time.Minute)) ||
		state.lastError != workflowTriggerDispatchFailedMessage {
		t.Fatalf("failing trigger = %+v, want it enabled and retried after the delay", state)
	}

	if err := server.dispatchDueScheduledWorkflowTrigger(ctx); err != nil {
		t.Fatal(err)
	}
	waitForTrackedDispatches(t, server)
	if state := loadScheduledDispatchTrigger(t, db, healthy); state.runs != 1 || state.nextRunAt <= formatWorkflowTimestamp(now) {
		t.Fatalf("healthy trigger behind the failing one = %+v, want one run and a later next run", state)
	}
}

// A claimed occurrence whose run is never queued is not lost: a stop leaves it
// due for the next start, and a failed enqueue retries it after the retry
// delay rather than a whole interval later.
func TestScheduledOccurrenceSurvivesAnUnqueuedRun(t *testing.T) {
	t.Run("stop before the run is queued", func(t *testing.T) {
		server, db := newScheduledDispatchServer(t)
		trigger := insertScheduledDispatchTrigger(t, db, "local_library_scan", `{"scanMode":"full"}`, "2000-01-01 00:00:00")
		waitForTrackedDispatches(t, server)

		if err := server.dispatchDueScheduledWorkflowTrigger(context.Background()); err != nil {
			t.Fatal(err)
		}
		if state := loadScheduledDispatchTrigger(t, db, trigger); state.runs != 0 || state.nextRunAt != "2000-01-01 00:00:00" {
			t.Fatalf("trigger after a refused dispatch = %+v, want its occurrence still due", state)
		}
	})
	t.Run("failed enqueue", func(t *testing.T) {
		server, db := newScheduledDispatchServer(t)
		trigger := insertScheduledDispatchTrigger(t, db, "local_library_scan", `{"scanMode":"example"}`, "2000-01-01 00:00:00")

		if err := server.dispatchDueScheduledWorkflowTrigger(context.Background()); err != nil {
			t.Fatal(err)
		}
		waitForTrackedDispatches(t, server)
		now := time.Now().UTC()
		state := loadScheduledDispatchTrigger(t, db, trigger)
		if state.runs != 0 || state.nextRunAt <= formatWorkflowTimestamp(now.Add(-time.Minute)) ||
			state.nextRunAt > formatWorkflowTimestamp(now.Add(workflowTriggerDispatchRetryDelay+time.Minute)) {
			t.Fatalf("trigger after a failed enqueue = %+v, want a retry after the delay", state)
		}
	})
}
