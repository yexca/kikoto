package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestDemoReadPathsDoNotPersistOperationalState(t *testing.T) {
	db := openMigratedTestDB(t)
	cacheRoot := t.TempDir()
	server := NewServer(db, config.Config{Mode: config.ModeDemo, CacheRoot: cacheRoot})
	workID := insertDemoSecurityWork(t, db, "RJDEMO100", "Demo work", "general", true)

	if _, err := db.Exec(`INSERT INTO file_source (code, display_name, source_type) VALUES ('demo-source', 'Demo source', 'kikoeru_compatible')`); err != nil {
		t.Fatal(err)
	}
	var sourceID int64
	if err := db.QueryRow(`SELECT id FROM file_source WHERE code = 'demo-source'`).Scan(&sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, api_url) VALUES (?, 'https://demo.invalid/api')`, sourceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'audio', 'Track', 'demo-track')`, workID); err != nil {
		t.Fatal(err)
	}
	var mediaItemID int64
	if err := db.QueryRow(`SELECT id FROM media_item WHERE fingerprint = 'demo-track'`).Scan(&mediaItemID); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cacheRoot, "track.mp3"), []byte("demo audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := db.Exec(`
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'cache', 'track.mp3', 'available')
	`, mediaItemID, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	locationID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/media/"+strconv.FormatInt(locationID, 10)+"/stream", nil)
	request.SetPathValue("id", strconv.FormatInt(locationID, 10))
	response := httptest.NewRecorder()
	server.streamMedia(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("stream status = %d, body = %s", response.Code, response.Body.String())
	}
	var lastChecked sql.NullString
	if err := db.QueryRow(`SELECT last_checked_at FROM media_file_location WHERE id = ?`, locationID).Scan(&lastChecked); err != nil {
		t.Fatal(err)
	}
	if lastChecked.Valid {
		t.Fatalf("demo stream updated last_checked_at to %q", lastChecked.String)
	}

	if err := server.updateSourceHealth(context.Background(), sourceID, "healthy"); err != nil {
		t.Fatal(err)
	}
	var health string
	if err := db.QueryRow(`SELECT health_status, last_checked_at FROM file_source_endpoint WHERE file_source_id = ?`, sourceID).Scan(&health, &lastChecked); err != nil {
		t.Fatal(err)
	}
	if health != "unknown" || lastChecked.Valid {
		t.Fatalf("demo health update persisted status %q at %#v", health, lastChecked)
	}

	if runID, err := server.recordVoiceRemoteSearchWorkflow(context.Background(), 1, "Demo voice", "$va:Demo voice$", nil); err != nil || runID != 0 {
		t.Fatalf("recordVoiceRemoteSearchWorkflow() = %d, %v", runID, err)
	}
	var workflowRuns int
	if err := db.QueryRow(`SELECT COUNT(*) FROM workflow_run`).Scan(&workflowRuns); err != nil {
		t.Fatal(err)
	}
	if workflowRuns != 0 {
		t.Fatalf("demo voice search persisted %d workflow runs", workflowRuns)
	}
}

func TestDemoCircleLookupDoesNotCreatePlaceholder(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeDemo})
	request := httptest.NewRequest(http.MethodGet, "/api/circles/RG123456", nil)
	request.SetPathValue("externalId", "RG123456")
	response := httptest.NewRecorder()

	server.getCircle(response, request)

	if response.Code != http.StatusNotFound {
		t.Fatalf("circle status = %d, body = %s", response.Code, response.Body.String())
	}
	var parties int
	if err := db.QueryRow(`SELECT COUNT(*) FROM party`).Scan(&parties); err != nil {
		t.Fatal(err)
	}
	if parties != 0 {
		t.Fatalf("demo circle lookup created %d parties", parties)
	}
}

func TestDemoCreatorAggregatesExcludeRestrictedWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeDemo})
	if _, err := db.Exec(`INSERT OR IGNORE INTO metadata_provider (code, display_name) VALUES ('dlsite', 'DLsite')`); err != nil {
		t.Fatal(err)
	}
	var providerID int64
	if err := db.QueryRow(`SELECT id FROM metadata_provider WHERE code = 'dlsite'`).Scan(&providerID); err != nil {
		t.Fatal(err)
	}
	eligibleWorkID := insertDemoSecurityWork(t, db, "RJDEMO200", "Eligible work", "general", true)
	restrictedWorkID := insertDemoSecurityWork(t, db, "RJDEMO201", "Restricted work", "adult", false)

	eligiblePartyID := insertDemoSecurityParty(t, db, providerID, "RG200001", "Eligible circle", eligibleWorkID)
	insertDemoSecurityParty(t, db, providerID, "RG200002", "Restricted circle", restrictedWorkID)
	if _, err := db.Exec(`INSERT INTO person (display_name) VALUES ('Eligible voice'), ('Restricted voice')`); err != nil {
		t.Fatal(err)
	}
	var eligiblePersonID, restrictedPersonID int64
	if err := db.QueryRow(`SELECT id FROM person WHERE display_name = 'Eligible voice'`).Scan(&eligiblePersonID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT id FROM person WHERE display_name = 'Restricted voice'`).Scan(&restrictedPersonID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work_credit (work_id, person_id, role, provider_id) VALUES (?, ?, 'voice_actor', ?), (?, ?, 'voice_actor', ?)
	`, eligibleWorkID, eligiblePersonID, providerID, restrictedWorkID, restrictedPersonID, providerID); err != nil {
		t.Fatal(err)
	}

	circles, err := server.loadCircleSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(circles) != 1 || circles[0].ID != eligiblePartyID || circles[0].LatestWork == nil || circles[0].LatestWork.PrimaryCode != "RJDEMO200" {
		t.Fatalf("demo circles = %#v", circles)
	}
	voices, err := server.loadVoiceSummaries(context.Background(), 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(voices) != 1 || voices[0].PersonID != eligiblePersonID || voices[0].KnownWorks != 1 || voices[0].LatestWork == nil || voices[0].LatestWork.PrimaryCode != "RJDEMO200" {
		t.Fatalf("demo voices = %#v", voices)
	}
}

func insertDemoSecurityWork(t *testing.T, db *sql.DB, code string, title string, ageRating string, permanentlyFree bool) int64 {
	t.Helper()
	result, err := db.Exec(`
		INSERT INTO work (primary_code, title, age_rating, is_permanently_free)
		VALUES (?, ?, ?, ?)
	`, code, title, ageRating, permanentlyFree)
	if err != nil {
		t.Fatal(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func insertDemoSecurityParty(t *testing.T, db *sql.DB, providerID int64, externalID string, name string, workID int64) int64 {
	t.Helper()
	result, err := db.Exec(`INSERT INTO party (party_type, display_name) VALUES ('circle', ?)`, name)
	if err != nil {
		t.Fatal(err)
	}
	partyID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
		VALUES (?, ?, 'maker_id', ?, 1)
	`, partyID, providerID, externalID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO work_party (work_id, party_id, role, provider_id) VALUES (?, ?, 'circle', ?)`, workID, partyID, providerID); err != nil {
		t.Fatal(err)
	}
	return partyID
}
