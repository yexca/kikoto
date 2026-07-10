package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestListWorksPageClosesOuterRowsBeforeEnrichment(t *testing.T) {
	db := openMigratedTestDB(t)
	workResult, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999997', 'Single connection work')")
	if err != nil {
		t.Fatal(err)
	}
	workID, _ := workResult.LastInsertId()
	logicalResult, err := db.Exec("INSERT INTO logical_work (canonical_work_id, canonical_code) VALUES (?, 'RJ09999997')", workID)
	if err != nil {
		t.Fatal(err)
	}
	logicalWorkID, _ := logicalResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical)
		VALUES (?, ?, 'RJ09999997', 'RJ09999997', 1)
	`, workID, logicalWorkID); err != nil {
		t.Fatal(err)
	}
	sourceResult, err := db.Exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('test-local', 'Test local', 'local')")
	if err != nil {
		t.Fatal(err)
	}
	sourceID, _ := sourceResult.LastInsertId()
	mediaResult, err := db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'audio', 'Track 1', 'single-connection-track')", workID)
	if err != nil {
		t.Fatal(err)
	}
	mediaItemID, _ := mediaResult.LastInsertId()
	if _, err := db.Exec(`
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'local', 'RJ09999997/track.wav', 'available')
	`, mediaItemID, sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability)
		VALUES (?, ?, 'local', 'available')
	`, workID, sourceID); err != nil {
		t.Fatal(err)
	}

	// A single connection makes any query issued while the outer list cursor is
	// still open fail or wait for its context. The list path must fully scan and
	// close that cursor before enriching individual summaries.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	server := NewServer(db, config.Config{})
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request := httptest.NewRequest(http.MethodGet, "/api/works?page=1&pageSize=10&scope=local&status=all&sort=recent&direction=desc", nil).WithContext(ctx)
	recorder := httptest.NewRecorder()

	server.listWorks(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("list works status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var response struct {
		Works []libraryWorkSummary `json:"works"`
		Total int                  `json:"total"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Total != 1 || len(response.Works) != 1 {
		t.Fatalf("list works response = total %d, rows %d; want 1, 1", response.Total, len(response.Works))
	}
	if response.Works[0].ID != workID || response.Works[0].AvailableLocations != 1 {
		t.Fatalf("unexpected work summary: %#v", response.Works[0])
	}
}
