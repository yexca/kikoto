package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

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
	actor := account.User{ID: 7, Permissions: []string{"workflows:run", "system:admin"}}
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
