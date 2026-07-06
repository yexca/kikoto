package metasync

import (
	"context"
	"database/sql"
	"encoding/json"
	"testing"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	_ "modernc.org/sqlite"
)

type fakeDLsiteClient struct {
	products map[string]dlsite.Product
}

func (f fakeDLsiteClient) FetchProduct(_ context.Context, workno string) (dlsite.Product, error) {
	return f.products[workno], nil
}

func (f fakeDLsiteClient) DownloadCover(_ context.Context, _ dlsite.Product, _ string) (string, error) {
	return "", nil
}

func TestSyncAllUpdatesWorkAndStoresSnapshot(t *testing.T) {
	db := openTestDB(t)
	raw := json.RawMessage(`{"workno":"RJ0123456","product_name":"DLsite title"}`)
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{
		products: map[string]dlsite.Product{
			"RJ0123456": {
				WorkNo:            "RJ0123456",
				SiteID:            "maniax",
				ProductName:       "DLsite title",
				WorkNameKana:      "ディーエルサイト",
				IntroShort:        "Short intro",
				RegistDate:        "2024-01-02",
				AgeCategoryString: "adult",
				Raw:               raw,
			},
		},
	})

	result, err := syncer.SyncAll(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.Status != "succeeded" || result.SyncedWorks != 1 {
		t.Fatalf("result = %+v", result)
	}

	var title string
	var snapshotCount int
	if err := db.QueryRow("SELECT title FROM work WHERE primary_code = 'RJ0123456'").Scan(&title); err != nil {
		t.Fatal(err)
	}
	if title != "DLsite title" {
		t.Fatalf("title = %q", title)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM metadata_snapshot").Scan(&snapshotCount); err != nil {
		t.Fatal(err)
	}
	if snapshotCount != 1 {
		t.Fatalf("snapshotCount = %d", snapshotCount)
	}
}

func openTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})

	schema := []string{
		`CREATE TABLE metadata_provider (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE work (id INTEGER PRIMARY KEY, primary_code TEXT NOT NULL UNIQUE, work_type TEXT NOT NULL DEFAULT 'audio', title TEXT NOT NULL, title_kana TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '', release_date TEXT, age_rating TEXT NOT NULL DEFAULT '', cover_asset_id INTEGER, duration_seconds INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE work_external_id (id INTEGER PRIMARY KEY, work_id INTEGER NOT NULL REFERENCES work(id) ON DELETE CASCADE, provider_id INTEGER NOT NULL REFERENCES metadata_provider(id), id_type TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL DEFAULT '', is_primary INTEGER NOT NULL DEFAULT 0, UNIQUE(provider_id, id_type, external_id))`,
		`CREATE TABLE metadata_snapshot (id INTEGER PRIMARY KEY, work_id INTEGER REFERENCES work(id) ON DELETE SET NULL, provider_id INTEGER NOT NULL REFERENCES metadata_provider(id), external_id TEXT NOT NULL, snapshot_json TEXT NOT NULL, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_definition (id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', definition_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_trigger (id INTEGER PRIMARY KEY, workflow_definition_id INTEGER NOT NULL REFERENCES workflow_definition(id) ON DELETE CASCADE, trigger_type TEXT NOT NULL, display_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, schedule_json TEXT NOT NULL DEFAULT '{}', config_json TEXT NOT NULL DEFAULT '{}', next_run_at TEXT, last_run_at TEXT, last_success_at TEXT, last_error_message TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_run (id INTEGER PRIMARY KEY, workflow_definition_id INTEGER REFERENCES workflow_definition(id) ON DELETE SET NULL, trigger_id INTEGER REFERENCES workflow_trigger(id) ON DELETE SET NULL, workflow_code TEXT NOT NULL, display_name TEXT NOT NULL, status TEXT NOT NULL, trigger_type TEXT NOT NULL, trigger_reason TEXT NOT NULL DEFAULT '', input_json TEXT NOT NULL DEFAULT '{}', summary_json TEXT NOT NULL DEFAULT '{}', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_node_run (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, node_id TEXT NOT NULL, node_type TEXT NOT NULL, display_name TEXT NOT NULL, position INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, input_json TEXT NOT NULL DEFAULT '{}', output_json TEXT NOT NULL DEFAULT '{}', error_message TEXT NOT NULL DEFAULT '', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_job (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL, worker_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT '', progress_current INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_candidate (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL, candidate_type TEXT NOT NULL, external_key TEXT NOT NULL DEFAULT '', status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', decision_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_event (id INTEGER PRIMARY KEY, workflow_run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, workflow_node_run_id INTEGER REFERENCES workflow_node_run(id) ON DELETE SET NULL, workflow_job_id INTEGER REFERENCES workflow_job(id) ON DELETE SET NULL, level TEXT NOT NULL DEFAULT 'info', event_type TEXT NOT NULL, message TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`INSERT INTO work (primary_code, title) VALUES ('RJ0123456', 'Local title')`,
	}
	for _, statement := range schema {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return db
}
