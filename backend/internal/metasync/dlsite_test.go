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
	raw := json.RawMessage(`{"workno":"RJ01569979","product_name":"DLsite title"}`)
	syncer := NewDLsiteSyncer(db, fakeDLsiteClient{
		products: map[string]dlsite.Product{
			"RJ01569979": {
				WorkNo:            "RJ01569979",
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
	if err := db.QueryRow("SELECT title FROM work WHERE primary_code = 'RJ01569979'").Scan(&title); err != nil {
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
		`CREATE TABLE workflow_run (id INTEGER PRIMARY KEY, template_code TEXT NOT NULL, status TEXT NOT NULL, trigger_reason TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}', summary_json TEXT NOT NULL DEFAULT '{}', started_at TEXT, finished_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`CREATE TABLE workflow_job (id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES workflow_run(id) ON DELETE CASCADE, node_code TEXT NOT NULL, worker_type TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', retry_count INTEGER NOT NULL DEFAULT 0, error_message TEXT NOT NULL DEFAULT '', progress_current INTEGER NOT NULL DEFAULT 0, progress_total INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`,
		`INSERT INTO work (primary_code, title) VALUES ('RJ01569979', 'Local title')`,
	}
	for _, statement := range schema {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	return db
}
