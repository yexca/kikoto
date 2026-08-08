package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func TestAvailabilityWatchObservationDoesNotMaterializeWorkOrActivity(t *testing.T) {
	remote := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case "/api/search/RJ00000000":
			_ = json.NewEncoder(w).Encode(kikoeru.WorksPage{Works: []kikoeru.Work{{ID: 91, SourceID: "RJ00000000", Title: "Available"}}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer remote.Close()

	db := openMigratedTestDB(t)
	for _, statement := range []string{
		`INSERT INTO user_account (id, username, role) VALUES (1, 'watcher', 'admin')`,
		`INSERT INTO file_source (id, code, display_name, source_type, enabled) VALUES (1, 'example_remote', 'Example Remote', 'kikoeru_compatible', 1)`,
		`INSERT INTO availability_watch (id, owner_user_id, enabled, interval_minutes, action, source_id) VALUES (1, 1, 1, 60, 'monitor', 1)`,
		`INSERT INTO availability_watch_target (id, watch_id, work_code, state, next_check_at) VALUES (1, 1, 'RJ00000000', 'monitoring', CURRENT_TIMESTAMP)`,
		`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, base_url, api_url) VALUES (1, ?, ?)`, remote.URL, remote.URL); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	if err := server.processAvailabilityWatchTick(context.Background()); err != nil {
		t.Fatal(err)
	}

	var state, lastStatus string
	if err := db.QueryRow(`SELECT state, last_status FROM availability_watch_target WHERE id = 1`).Scan(&state, &lastStatus); err != nil {
		t.Fatal(err)
	}
	if state != "ready" || lastStatus != "available" {
		t.Fatalf("target = state %q, status %q", state, lastStatus)
	}
	var works, runs int
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM work), (SELECT COUNT(*) FROM workflow_run)`).Scan(&works, &runs); err != nil {
		t.Fatal(err)
	}
	if works != 0 || runs != 0 {
		t.Fatalf("observation materialized works=%d or activity runs=%d", works, runs)
	}
}
