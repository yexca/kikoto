package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestWorkflowEventStreamSendsEventsFromCursorAndTerminalTick(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO workflow_definition (id, code, display_name) VALUES (41, 'synthetic_stream', 'Synthetic stream')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type)
		VALUES (41, 41, 'synthetic_stream', 'Synthetic stream', 'succeeded', 'manual')
	`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO workflow_event (id, workflow_run_id, level, event_type, message, detail_json)
		VALUES (411, 41, 'info', 'synthetic.started', 'started', '{}'),
		       (412, 41, 'info', 'synthetic.finished', 'finished', '{}')
	`); err != nil {
		t.Fatal(err)
	}

	server := NewServer(db, config.Config{})
	actor := account.User{ID: 7, Role: "super_admin", Permissions: account.PermissionsForRole("super_admin")}
	request := httptest.NewRequest(http.MethodGet, "/api/workflow-runs/41/events/stream?afterId=411", nil)
	request.SetPathValue("id", strconv.FormatInt(41, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
	response := httptest.NewRecorder()
	server.streamWorkflowRunEvents(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("stream status = %d, body = %s", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Content-Type"); !strings.HasPrefix(got, "text/event-stream") {
		t.Fatalf("content type = %q", got)
	}
	body := response.Body.String()
	if strings.Contains(body, "id: 411\n") || !strings.Contains(body, "id: 412\n") {
		t.Fatalf("stream body does not honor cursor: %q", body)
	}
	if !strings.Contains(body, "event: workflow\n") || !strings.Contains(body, "event: tick\n") {
		t.Fatalf("stream body is missing workflow/tick events: %q", body)
	}
}

// flushHookRecorder runs onFlush after each flushed write.
type flushHookRecorder struct {
	*httptest.ResponseRecorder
	onFlush func(body string)
}

func (recorder *flushHookRecorder) Flush() {
	recorder.ResponseRecorder.Flush()
	recorder.onFlush(recorder.Body.String())
}

// An event committed together with the run's terminal status while the
// stream writes earlier events is still sent before the stream closes.
func TestWorkflowEventStreamSendsEventsCommittedWithTheTerminalStatus(t *testing.T) {
	db := openMigratedTestDB(t)
	execFetchTestStatements(t, db,
		`INSERT INTO workflow_definition (id, code, display_name) VALUES (42, 'synthetic_stream', 'Synthetic stream')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (42, 42, 'synthetic_stream', 'Synthetic stream', 'running', 'manual')`,
		`INSERT INTO workflow_event (id, workflow_run_id, level, event_type, message, detail_json) VALUES (421, 42, 'info', 'synthetic.started', 'started', '{}')`,
	)
	server := NewServer(db, config.Config{})
	actor := account.User{ID: 7, Role: "super_admin", Permissions: account.PermissionsForRole("super_admin")}
	request := httptest.NewRequest(http.MethodGet, "/api/workflow-runs/42/events/stream", nil)
	request.SetPathValue("id", "42")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request = request.WithContext(context.WithValue(ctx, currentUserKey, actor))
	finished := false
	response := &flushHookRecorder{ResponseRecorder: httptest.NewRecorder()}
	response.onFlush = func(body string) {
		if finished || !strings.Contains(body, "id: 421\n") {
			return
		}
		finished = true
		execFetchTestStatements(t, db,
			`INSERT INTO workflow_event (id, workflow_run_id, level, event_type, message, detail_json) VALUES (422, 42, 'info', 'synthetic.finished', 'finished', '{}')`,
			`UPDATE workflow_run SET status = 'succeeded', finished_at = CURRENT_TIMESTAMP WHERE id = 42`,
		)
	}
	server.streamWorkflowRunEvents(response, request)

	if ctx.Err() != nil {
		t.Fatal("the stream did not close on the terminal status")
	}
	body := response.Body.String()
	if !strings.Contains(body, "id: 422\n") || !strings.Contains(body, `"status":"succeeded"`) {
		t.Fatalf("stream closed without the event committed with the terminal status: %q", body)
	}
}
