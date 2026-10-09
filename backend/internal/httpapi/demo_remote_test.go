package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// newDemoRemoteFixture admits the first `eligible` local works; the two works
// after them fail Demo admission as adult and paid.
func newDemoRemoteFixture(t *testing.T, eligible int) (*sql.DB, *Server) {
	t.Helper()
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{Mode: config.ModeDemo, DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	ctx := context.Background()
	if err := s.BootstrapDemo(ctx); err != nil {
		t.Fatal(err)
	}
	if err := s.ensureSystemWorkflowDefinitions(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source (code, display_name, source_type)
		VALUES ('example_local', 'Example Local', 'local_folder')`); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < eligible+2; index++ {
		code := testfixture.WorkCode(testfixture.PrefixRJ, index)
		age, free := "general", 1
		if index == eligible {
			age = "adult"
		}
		if index == eligible+1 {
			free = 0
		}
		if _, err := db.Exec(`INSERT INTO work (primary_code, title, age_rating, is_permanently_free)
			VALUES (?, 'Example Work', ?, ?)`, code, age, free); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability)
			VALUES ((SELECT id FROM work WHERE primary_code = ?),
				(SELECT id FROM file_source WHERE code = 'example_local'), 'local', ?, 'available')`, code, code+" Example"); err != nil {
			t.Fatal(err)
		}
	}
	return db, s
}

func demoRemotePresenceCodes(t *testing.T, db *sql.DB, presenceType string, availability string) []string {
	t.Helper()
	rows, err := db.Query(`SELECT work.primary_code FROM work_source_presence AS presence
		INNER JOIN work ON work.id = presence.work_id
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE source.code = ? AND presence.presence_type = ? AND presence.availability = ?
		ORDER BY work.primary_code`, demoRemoteSourceCode, presenceType, availability)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	codes := []string{}
	for rows.Next() {
		var code string
		if err := rows.Scan(&code); err != nil {
			t.Fatal(err)
		}
		codes = append(codes, code)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	return codes
}

func TestDemoRemoteSourceReplacesConfiguredSourcesWithRandomLocalCatalog(t *testing.T) {
	db, s := newDemoRemoteFixture(t, 6)
	ctx := context.Background()
	// The Library folds this admitted language edition into its original work.
	edition := testfixture.WorkCode(testfixture.PrefixRJ, 5)
	if _, err := db.Exec(`
		INSERT INTO logical_work (id, canonical_work_id, canonical_code)
		VALUES (1, (SELECT id FROM work WHERE primary_code = 'RJ00000000'), 'RJ00000000');
		INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, metadata_language, edition_label, is_canonical)
		VALUES ((SELECT id FROM work WHERE primary_code = 'RJ00000000'), 1, 'RJ00000000', 'RJ00000000', 'JPN', 'Japanese', 1),
			((SELECT id FROM work WHERE primary_code = 'RJ00000005'), 1, 'RJ00000005', 'RJ00000000', 'ENG', 'English', 0);
	`); err != nil {
		t.Fatal(err)
	}
	// Existing sources that carry real endpoints, beside the disabled showcase source.
	if _, err := db.Exec(`
		INSERT INTO file_source (code, display_name, source_type, enabled) VALUES
			('earlier_remote', 'Earlier Remote', 'kikoeru_compatible', 1),
			('demo_showcase', 'Example Track (Demo)', 'demo_showcase', 0);
		INSERT INTO file_source_endpoint (file_source_id, base_url, api_url)
		VALUES ((SELECT id FROM file_source WHERE code = 'earlier_remote'),
			'https://source.example.invalid', 'https://source.example.invalid');
	`); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedDemoShowcase(ctx); err != nil {
		t.Fatal(err)
	}

	var sources int
	var name, apiURL string
	if err := db.QueryRow(`SELECT COUNT(*) FROM file_source
		WHERE code IN ('earlier_remote', 'demo_showcase') OR source_type = 'kikoeru_compatible'`).Scan(&sources); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT source.display_name, endpoint.api_url FROM file_source AS source
		INNER JOIN file_source_endpoint AS endpoint ON endpoint.file_source_id = source.id
		WHERE source.code = ? AND source.enabled = 1`, demoRemoteSourceCode).Scan(&name, &apiURL); err != nil {
		t.Fatal(err)
	}
	if sources != 1 || name != "Remote Kikoeru" || apiURL != demoRemoteSourceURL {
		t.Fatalf("remote sources = %d, simulated source = %q at %q", sources, name, apiURL)
	}

	eligible := map[string]bool{}
	for index := 0; index < 5; index++ {
		eligible[testfixture.WorkCode(testfixture.PrefixRJ, index)] = true
	}
	available := demoRemotePresenceCodes(t, db, sourcePresenceTypeRemoteSource, "available")
	missing := demoRemotePresenceCodes(t, db, sourcePresenceTypeRemoteSource, "missing")
	tracked := demoRemotePresenceCodes(t, db, "tracked", "available")
	if len(available) != 3 || len(missing) != 2 || len(tracked) != 3 {
		t.Fatalf("catalog = %v, missing = %v, tracked = %v", available, missing, tracked)
	}
	inCatalog := map[string]bool{}
	for _, code := range append(append([]string{}, available...), missing...) {
		if !eligible[code] || code == edition {
			t.Fatalf("ineligible work %s reached the simulated source", code)
		}
		inCatalog[code] = true
	}
	for _, code := range tracked {
		if !inCatalog[code] {
			t.Fatalf("tracked work %s is outside the simulated catalog", code)
		}
	}

	listResponse := httptest.NewRecorder()
	s.Routes().ServeHTTP(listResponse, httptest.NewRequest(http.MethodGet, "/api/works?scope=tracked", nil))
	var trackedPage struct {
		Works []libraryWorkSummary `json:"works"`
		Total int                  `json:"total"`
	}
	if err := json.Unmarshal(listResponse.Body.Bytes(), &trackedPage); err != nil {
		t.Fatalf("tracked library status = %d: %v", listResponse.Code, err)
	}
	if trackedPage.Total != 3 {
		t.Fatalf("tracked library page = %#v", trackedPage)
	}
	for _, work := range trackedPage.Works {
		found := false
		for _, presence := range work.SourcePresence {
			found = found || presence.Type == "tracked" && presence.FileSourceName == "Remote Kikoeru"
		}
		if !found {
			t.Fatalf("work %s lacks the Remote Kikoeru tracked presence", work.PrimaryCode)
		}
	}

	if _, err := db.Exec("UPDATE work SET is_permanently_free = NULL WHERE primary_code = ?", available[0]); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedDemoShowcase(ctx); err != nil {
		t.Fatal(err)
	}
	reseeded := demoRemotePresenceCodes(t, db, sourcePresenceTypeRemoteSource, "available")
	reseeded = append(reseeded, demoRemotePresenceCodes(t, db, sourcePresenceTypeRemoteSource, "missing")...)
	if len(reseeded) != 4 {
		t.Fatalf("reseeded presences = %v, want the four still-eligible works", reseeded)
	}
	for _, code := range reseeded {
		if code == available[0] {
			t.Fatalf("work %s survived eligibility loss", code)
		}
	}
}

func TestDemoRemoteSourceServesCatalogAndLocalMediaInProcess(t *testing.T) {
	db, s := newDemoRemoteFixture(t, 1)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	relativePath := code + " Example/Disc 1/track.wav"
	audio := testWAVBytes()
	absolutePath := filepath.Join(s.cfg.DataRoot, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(absolutePath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(absolutePath, audio, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_item (id, work_id, kind, title)
		VALUES (1, (SELECT id FROM work WHERE primary_code = ?), 'audio', 'track.wav')`, code); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, size_bytes, availability)
		VALUES (1, (SELECT id FROM file_source WHERE code = 'example_local'), 'local', ?, ?, 'available')`, relativePath, len(audio)); err != nil {
		t.Fatal(err)
	}
	if err := s.SeedDemoShowcase(context.Background()); err != nil {
		t.Fatal(err)
	}
	var sourceID int64
	if err := db.QueryRow("SELECT id FROM file_source WHERE code = ?", demoRemoteSourceCode).Scan(&sourceID); err != nil {
		t.Fatal(err)
	}
	base := "/api/remote-sources/" + strconv.FormatInt(sourceID, 10) + "/works"
	get := func(target string, header http.Header) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, target, nil)
		for key, values := range header {
			request.Header[key] = values
		}
		response := httptest.NewRecorder()
		s.Routes().ServeHTTP(response, request)
		return response
	}

	var page remoteWorksResponse
	response := get(base, nil)
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || page.Status != "ok" {
		t.Fatalf("browse status = %d: %s", response.Code, response.Body.String())
	}
	if page.Total != 1 || len(page.Works) != 1 || page.Works[0].RemoteCode != code || page.Works[0].WorkID == nil {
		t.Fatalf("browse page = %#v", page)
	}
	response = get(base+"?q="+url.QueryEscape("no-such-term"), nil)
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || page.Status != "ok" || page.Total != 0 {
		t.Fatalf("filtered browse = %d: %s", response.Code, response.Body.String())
	}

	var tracks remoteWorkTracksDetail
	response = get(base+"/"+code+"/tracks", nil)
	if err := json.Unmarshal(response.Body.Bytes(), &tracks); err != nil {
		t.Fatalf("tracks status = %d: %s", response.Code, response.Body.String())
	}
	if len(tracks.Tracks) != 1 || tracks.Tracks[0].Title != "Disc 1" || len(tracks.Tracks[0].Children) != 1 ||
		tracks.Tracks[0].Children[0].Title != "track.wav" {
		t.Fatalf("simulated directory = %#v", tracks.Tracks)
	}

	mediaURL := base + "/" + code + "/media?profile=audio&path=" + url.QueryEscape("Disc 1/track.wav")
	response = get(mediaURL, http.Header{"Range": {"bytes=0-9"}})
	if response.Code != http.StatusPartialContent || !bytes.Equal(response.Body.Bytes(), audio[:10]) {
		t.Fatalf("ranged media = %d with %d bytes: %s", response.Code, response.Body.Len(), response.Body.String())
	}
	response = get(mediaURL, nil)
	if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), audio) {
		t.Fatalf("media = %d with %d bytes, want %d", response.Code, response.Body.Len(), len(audio))
	}
}

func TestDemoSourceClientsNeverLeaveTheProcess(t *testing.T) {
	_, s := newDemoRemoteFixture(t, 0)
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests++
		_, _ = io.WriteString(w, "OK")
	}))
	defer upstream.Close()
	client := s.sourceHTTPClient(remoteSourceForUse{
		ID: 1, Enabled: true, SourceType: sourceTypeKikoeruCompatible,
		Endpoint: fileSourceEndpoint{BaseURL: upstream.URL, APIURL: upstream.URL},
	}, time.Second)

	for _, target := range []string{upstream.URL + "/api/health", "http://" + demoRemoteSourceHost + "/api/health"} {
		if _, err := client.Get(target); !errors.Is(err, errDemoRemoteHost) {
			t.Fatalf("GET %s error = %v, want the Demo host refusal", target, err)
		}
	}
	if requests != 0 {
		t.Fatalf("configured endpoint received %d requests", requests)
	}
	response, err := client.Get(demoRemoteSourceURL + "/api/health")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK || string(body) != "OK" {
		t.Fatalf("simulated health = %d %q", response.StatusCode, body)
	}
}
