package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

type manualOverrideFixture struct {
	db         *sql.DB
	server     *Server
	userID     int64
	workID     int64
	partyID    int64
	seriesID   int64
	personID   int64
	providerID int64
}

func newManualOverrideFixture(t *testing.T, cfg config.Config) manualOverrideFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	fixture := manualOverrideFixture{db: db, server: NewServer(db, cfg)}
	fixtures := []struct {
		name  string
		query string
	}{
		{name: "user", query: `INSERT INTO user_account (username, display_name, role) VALUES ('manual-test-user', 'Example User', 'user')`},
		{name: "work", query: `INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Example Work')`},
		{name: "party", query: `INSERT INTO party (party_type, display_name) VALUES ('circle', 'Example Circle')`},
		{name: "person", query: `INSERT INTO person (display_name, sort_name) VALUES ('Example Voice', 'Example Voice')`},
	}
	for _, fixtureRow := range fixtures {
		name, query := fixtureRow.name, fixtureRow.query
		if _, err := db.Exec(query); err != nil {
			t.Fatalf("insert %s fixture: %v", name, err)
		}
	}
	ids := []struct {
		label  string
		query  string
		target *int64
	}{
		{label: "user", query: "SELECT id FROM user_account WHERE username = 'manual-test-user'", target: &fixture.userID},
		{label: "work", query: "SELECT id FROM work WHERE primary_code = 'RJ00000000'", target: &fixture.workID},
		{label: "party", query: "SELECT id FROM party WHERE display_name = 'Example Circle'", target: &fixture.partyID},
		{label: "person", query: "SELECT id FROM person WHERE display_name = 'Example Voice'", target: &fixture.personID},
	}
	for _, id := range ids {
		if err := db.QueryRow(id.query).Scan(id.target); err != nil {
			t.Fatalf("load %s fixture id: %v", id.label, err)
		}
	}
	if err := db.QueryRow("SELECT id FROM metadata_provider WHERE code = 'dlsite'").Scan(&fixture.providerID); err != nil {
		t.Fatalf("load metadata provider: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO party_external_id (party_id, provider_id, id_type, external_id, is_primary)
		VALUES (?, ?, 'maker_id', 'RG00000000', 1)
	`, fixture.partyID, fixture.providerID); err != nil {
		t.Fatalf("insert circle identity: %v", err)
	}
	result, err := db.Exec(`
		INSERT INTO party_series (party_id, provider_id, title_id, name)
		VALUES (?, ?, 'SRI0000000000', 'Example Series')
	`, fixture.partyID, fixture.providerID)
	if err != nil {
		t.Fatalf("insert series: %v", err)
	}
	fixture.seriesID, err = result.LastInsertId()
	if err != nil {
		t.Fatalf("load series id: %v", err)
	}
	return fixture
}

func manualOverrideActor(t *testing.T, fixture manualOverrideFixture) account.User {
	t.Helper()
	return account.User{ID: fixture.userID, Permissions: []string{"library:write"}}
}

func updateManualOverridesRequest(t *testing.T, fixture manualOverrideFixture, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(
		http.MethodPatch,
		"/api/works/"+strconv.FormatInt(fixture.workID, 10)+"/manual-overrides",
		strings.NewReader(body),
	)
	request.SetPathValue("id", strconv.FormatInt(fixture.workID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, manualOverrideActor(t, fixture)))
	response := httptest.NewRecorder()
	fixture.server.updateWorkManualOverrides(response, request)
	return response
}

func TestUpdateWorkManualOverridesPersistsNormalizedValuesAndRelations(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{})
	response := updateManualOverridesRequest(t, fixture, `{
		"title": "  Example Override  ",
		"circle": {"name": "  Example Circle Override ", "externalId": "rg00000000"},
		"series": {"name": " Example Series Override ", "titleId": " SRI0000000000 ", "circleExternalId": "rg00000000"},
		"voiceActors": [
			{"name": " Example Voice ", "personId": `+strconv.FormatInt(fixture.personID, 10)+`},
			{"name": "Example Voice", "personId": `+strconv.FormatInt(fixture.personID, 10)+`},
			{"name": " Example Unresolved Voice ", "personId": -4}
		]
	}`)
	if response.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", response.Code, response.Body.String())
	}
	var got workManualOverrides
	if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Title == nil || *got.Title != "Example Override" {
		t.Fatalf("title override = %#v", got.Title)
	}
	if got.Circle == nil || got.Circle.Name != "Example Circle Override" || got.Circle.ExternalID != "RG00000000" {
		t.Fatalf("circle override = %#v", got.Circle)
	}
	if got.Series == nil || got.Series.Name != "Example Series Override" || got.Series.TitleID != "SRI0000000000" || got.Series.CircleExternalID != "RG00000000" {
		t.Fatalf("series override = %#v", got.Series)
	}
	if len(got.VoiceActors) != 2 || got.VoiceActors[0].Name != "Example Voice" || got.VoiceActors[1].PersonID != 0 {
		t.Fatalf("voice actor overrides = %#v", got.VoiceActors)
	}

	var overrideCount int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM work_manual_override WHERE work_id = ?", fixture.workID).Scan(&overrideCount); err != nil {
		t.Fatal(err)
	}
	if overrideCount != 4 {
		t.Fatalf("override count = %d, want 4", overrideCount)
	}
	var partySource string
	if err := fixture.db.QueryRow(`
		SELECT source FROM work_party WHERE work_id = ? AND party_id = ? AND role = 'circle'
	`, fixture.workID, fixture.partyID).Scan(&partySource); err != nil {
		t.Fatal(err)
	}
	if partySource != "manual_override" {
		t.Fatalf("circle relation source = %q", partySource)
	}
	var creditCount int
	if err := fixture.db.QueryRow(`
		SELECT COUNT(*) FROM work_credit WHERE work_id = ? AND person_id = ? AND role = 'voice_actor' AND source = 'manual_override'
	`, fixture.workID, fixture.personID).Scan(&creditCount); err != nil {
		t.Fatal(err)
	}
	if creditCount != 1 {
		t.Fatalf("voice relation count = %d, want 1", creditCount)
	}
	var seriesCode string
	if err := fixture.db.QueryRow("SELECT primary_code FROM party_series_work WHERE series_id = ?", fixture.seriesID).Scan(&seriesCode); err != nil {
		t.Fatal(err)
	}
	if seriesCode != "RJ00000000" {
		t.Fatalf("series work code = %q", seriesCode)
	}
}

func TestDeleteWorkManualOverrideRemovesCanonicalRelations(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{})
	if response := updateManualOverridesRequest(t, fixture, `{
		"circle": {"name": "Example Circle", "externalId": "RG00000000"},
		"voiceActors": [{"name": "Example Voice", "personId": `+strconv.FormatInt(fixture.personID, 10)+`}]
	}`); response.Code != http.StatusOK {
		t.Fatalf("setup update status = %d, body = %s", response.Code, response.Body.String())
	}
	for field, expectedOverride := range map[string]string{"voiceactors": "voice_actors", "circle": "circle"} {
		request := httptest.NewRequest(
			http.MethodDelete,
			"/api/works/"+strconv.FormatInt(fixture.workID, 10)+"/manual-overrides/"+field,
			nil,
		)
		request.SetPathValue("id", strconv.FormatInt(fixture.workID, 10))
		request.SetPathValue("field", field)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, manualOverrideActor(t, fixture)))
		response := httptest.NewRecorder()
		fixture.server.deleteWorkManualOverride(response, request)
		var result struct {
			Deleted int `json:"deleted"`
		}
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || result.Deleted != 1 {
			t.Fatalf("delete %s status = %d, body = %s", field, response.Code, response.Body.String())
		}
		var count int
		if err := fixture.db.QueryRow("SELECT COUNT(*) FROM work_manual_override WHERE work_id = ? AND field_name = ?", fixture.workID, expectedOverride).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s override remains", expectedOverride)
		}
	}
	var partyRelations, voiceRelations int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM work_party WHERE work_id = ? AND source = 'manual_override'", fixture.workID).Scan(&partyRelations); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM work_credit WHERE work_id = ? AND source = 'manual_override'", fixture.workID).Scan(&voiceRelations); err != nil {
		t.Fatal(err)
	}
	if partyRelations != 0 || voiceRelations != 0 {
		t.Fatalf("manual relations remain: party=%d voice=%d", partyRelations, voiceRelations)
	}
}

func TestManualOverrideHandlersEnforcePermissionsAndWorkExistence(t *testing.T) {
	fixture := newManualOverrideFixture(t, config.Config{})
	workPath := "/api/works/" + strconv.FormatInt(fixture.workID, 10) + "/manual-overrides"

	readRequest := httptest.NewRequest(http.MethodGet, workPath, nil)
	readRequest.SetPathValue("id", strconv.FormatInt(fixture.workID, 10))
	readRequest = readRequest.WithContext(context.WithValue(readRequest.Context(), currentUserKey, account.User{
		ID: fixture.userID, Permissions: []string{"library:read"},
	}))
	readResponse := httptest.NewRecorder()
	fixture.server.getWorkManualOverrides(readResponse, readRequest)
	var emptyOverrides map[string]any
	if err := json.NewDecoder(readResponse.Body).Decode(&emptyOverrides); err != nil {
		t.Fatal(err)
	}
	if readResponse.Code != http.StatusOK || len(emptyOverrides) != 0 {
		t.Fatalf("read status = %d, body = %s", readResponse.Code, readResponse.Body.String())
	}

	writeRequest := httptest.NewRequest(http.MethodPatch, workPath, strings.NewReader(`{"title":"Denied"}`))
	writeRequest.SetPathValue("id", strconv.FormatInt(fixture.workID, 10))
	writeRequest = writeRequest.WithContext(context.WithValue(writeRequest.Context(), currentUserKey, account.User{
		ID: fixture.userID, Permissions: []string{"library:read"},
	}))
	writeResponse := httptest.NewRecorder()
	fixture.server.updateWorkManualOverrides(writeResponse, writeRequest)
	if writeResponse.Code != http.StatusForbidden {
		t.Fatalf("read-only update status = %d, body = %s", writeResponse.Code, writeResponse.Body.String())
	}

	missingRequest := httptest.NewRequest(http.MethodGet, "/api/works/999/manual-overrides", nil)
	missingRequest.SetPathValue("id", "999")
	missingRequest = missingRequest.WithContext(context.WithValue(missingRequest.Context(), currentUserKey, account.User{
		ID: fixture.userID, Permissions: []string{"library:read"},
	}))
	missingResponse := httptest.NewRecorder()
	fixture.server.getWorkManualOverrides(missingResponse, missingRequest)
	if missingResponse.Code != http.StatusNotFound {
		t.Fatalf("missing work status = %d, body = %s", missingResponse.Code, missingResponse.Body.String())
	}

	invalidDelete := httptest.NewRequest(http.MethodDelete, workPath+"/unknown", nil)
	invalidDelete.SetPathValue("id", strconv.FormatInt(fixture.workID, 10))
	invalidDelete.SetPathValue("field", "unknown")
	invalidDelete = invalidDelete.WithContext(context.WithValue(invalidDelete.Context(), currentUserKey, manualOverrideActor(t, fixture)))
	invalidDeleteResponse := httptest.NewRecorder()
	fixture.server.deleteWorkManualOverride(invalidDeleteResponse, invalidDelete)
	if invalidDeleteResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid delete status = %d, body = %s", invalidDeleteResponse.Code, invalidDeleteResponse.Body.String())
	}
}

func TestSetWorkCoverOverrideCopiesOnlyAvailableLocalImage(t *testing.T) {
	dataRoot := t.TempDir()
	cacheRoot := t.TempDir()
	fixture := newManualOverrideFixture(t, config.Config{DataRoot: dataRoot, CacheRoot: cacheRoot})
	if err := os.MkdirAll(filepath.Join(dataRoot, "RJ00000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	imagePath := filepath.Join(dataRoot, "RJ00000000", "cover.jpg")
	if err := os.WriteFile(imagePath, []byte("synthetic cover bytes"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('local-test', 'Example Local', 'local_folder')"); err != nil {
		t.Fatal(err)
	}
	var sourceID int64
	if err := fixture.db.QueryRow("SELECT id FROM file_source WHERE code = 'local-test'").Scan(&sourceID); err != nil {
		t.Fatal(err)
	}
	imageResult, err := fixture.db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'image', 'Example Cover', 'example-cover')", fixture.workID)
	if err != nil {
		t.Fatal(err)
	}
	imageItemID, err := imageResult.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	imageLocationResult, err := fixture.db.Exec(`
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'local', 'RJ00000000/cover.jpg', 'available')
	`, imageItemID, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	imageLocationID, err := imageLocationResult.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	response := setManualCoverRequest(t, fixture, imageLocationID)
	if response.Code != http.StatusOK {
		t.Fatalf("cover update status = %d, body = %s", response.Code, response.Body.String())
	}
	var got workManualOverrides
	if err := json.NewDecoder(response.Body).Decode(&got); err != nil {
		t.Fatal(err)
	}
	if got.Cover == nil || got.Cover.OriginalPath != "RJ00000000/cover.jpg" || got.Cover.URL == "" {
		t.Fatalf("cover override = %#v", got.Cover)
	}
	asset, err := os.ReadFile(filepath.Join(cacheRoot, "manual", got.Cover.AssetPath))
	if err != nil {
		t.Fatal(err)
	}
	if string(asset) != "synthetic cover bytes" {
		t.Fatalf("cached cover = %q", asset)
	}

	audioResult, err := fixture.db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'audio', 'Example Audio', 'example-audio')", fixture.workID)
	if err != nil {
		t.Fatal(err)
	}
	audioItemID, err := audioResult.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	audioLocationResult, err := fixture.db.Exec(`
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'local', 'RJ00000000/audio.mp3', 'available')
	`, audioItemID, sourceID)
	if err != nil {
		t.Fatal(err)
	}
	invalidResponse := setManualCoverRequest(t, fixture, mustLastInsertID(t, audioLocationResult))
	if invalidResponse.Code != http.StatusBadRequest || !strings.Contains(invalidResponse.Body.String(), "not an image") {
		t.Fatalf("audio cover status = %d, body = %s", invalidResponse.Code, invalidResponse.Body.String())
	}
}

func setManualCoverRequest(t *testing.T, fixture manualOverrideFixture, locationID int64) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(
		http.MethodPost,
		"/api/works/"+strconv.FormatInt(fixture.workID, 10)+"/cover-override",
		strings.NewReader(`{"locationId":`+strconv.FormatInt(locationID, 10)+`}`),
	)
	request.SetPathValue("id", strconv.FormatInt(fixture.workID, 10))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, manualOverrideActor(t, fixture)))
	response := httptest.NewRecorder()
	fixture.server.setWorkCoverOverride(response, request)
	return response
}

func mustLastInsertID(t *testing.T, result sql.Result) int64 {
	t.Helper()
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	return id
}
