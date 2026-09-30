package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

var kikoeruImportUser = account.User{ID: 1, Permissions: []string{"favorites:write", "tags:write", "playback:use"}}

// syntheticKikoeruServer answers the account endpoints a closed-source fork
// exposes: login, reviews, and playlists.
func syntheticKikoeruServer(t *testing.T, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	first := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	second := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path == "/api/auth/me" {
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["password"] != "synthetic-password" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = fmt.Fprint(w, `{"error":"synthetic upstream detail"}`)
				return
			}
			_, _ = fmt.Fprint(w, `{"token":"synthetic-token"}`)
			return
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-token" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch r.URL.Path {
		case "/api/review":
			_, _ = fmt.Fprintf(w, `{"works":[{"id":0,"source_id":%q,"progress":"listened","userRating":5,"review_text":"Example note"},{"id":1,"source_id":%q,"progress":"marked","userRating":null,"review_text":null}],"pagination":{"currentPage":1,"pageSize":100,"totalCount":2}}`, first, second)
		case "/api/playlist/get-playlists":
			_, _ = fmt.Fprint(w, `{"playlists":[{"id":"liked","name":"__SYS_PLAYLIST_LIKED","works_count":1}],"pagination":{"page":1,"pageSize":100,"totalCount":1}}`)
		case "/api/playlist/get-playlist-works":
			_, _ = fmt.Fprintf(w, `{"works":[{"id":1,"source_id":%q}],"pagination":{"page":1,"pageSize":100,"totalCount":1}}`, second)
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func postKikoeruAccount(s *Server, user account.User, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, "/api/user-data/kikoeru/account", strings.NewReader(body))
	r = r.WithContext(context.WithValue(r.Context(), currentUserKey, user))
	response := httptest.NewRecorder()
	s.importKikoeruAccount(response, r)
	return response
}

func TestKikoeruAccountImportFromConfiguredSource(t *testing.T) {
	db := openMigratedTestDB(t)
	var hits atomic.Int32
	upstream := syntheticKikoeruServer(t, &hits)
	sourceID := insertSyntheticRemoteSource(t, db, "example_remote_a")
	if _, err := db.Exec(`INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (?, ?, ?)`, sourceID, upstream.URL, upstream.URL); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db, config.Config{})

	response := postKikoeruAccount(s, kikoeruImportUser, fmt.Sprintf(`{"sourceId":%d,"auth":{"mode":"password","name":"synthetic-user","password":"synthetic-password"},"playlistNames":{"liked":"Example Liked"}}`, sourceID))
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "kikoeru_risk_not_acknowledged") || hits.Load() != 0 {
		t.Fatalf("unacknowledged credentials = %d %s, upstream hits %d", response.Code, response.Body.String(), hits.Load())
	}

	response = postKikoeruAccount(s, kikoeruImportUser, fmt.Sprintf(`{"sourceId":%d,"auth":{"mode":"password","name":"synthetic-user","password":"synthetic-password"},"acknowledgedRisk":true,"playlistNames":{"liked":"Example Liked"}}`, sourceID))
	if response.Code != http.StatusOK {
		t.Fatalf("import = %d %s", response.Code, response.Body.String())
	}
	var result kikoeruImportResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if !result.PlaylistsSupported || result.Summary.Works != 2 || len(result.Data.Playlists) != 1 || result.Data.Playlists[0].Name != "Example Liked" {
		t.Fatalf("result = %+v", result)
	}
	if work := result.Data.Works[0]; work.ListeningStatus != "finished" || work.Rating == nil || *work.Rating != 5 || work.Note != "Example note" {
		t.Fatalf("first work = %+v", work)
	}
	if strings.Contains(response.Body.String(), "synthetic-token") || response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("response leaked the token or is cacheable: %s", response.Body.String())
	}

	response = postKikoeruAccount(s, kikoeruImportUser, fmt.Sprintf(`{"sourceId":%d,"auth":{"mode":"password","name":"synthetic-user","password":"wrong"},"acknowledgedRisk":true}`, sourceID))
	if response.Code != http.StatusUnprocessableEntity || !strings.Contains(response.Body.String(), "kikoeru_unauthorized") ||
		strings.Contains(response.Body.String(), "synthetic upstream detail") || strings.Contains(response.Body.String(), upstream.URL) {
		t.Fatalf("rejected sign-in = %d %s", response.Code, response.Body.String())
	}
}

func TestKikoeruAccountImportGatesPrivateManualAddresses(t *testing.T) {
	db := openMigratedTestDB(t)
	var hits atomic.Int32
	// The test server listens on loopback, a private address.
	upstream := syntheticKikoeruServer(t, &hits)
	s := NewServer(db, config.Config{})
	body := fmt.Sprintf(`{"url":%q,"auth":{"mode":"token","token":"Bearer synthetic-token"},"acknowledgedRisk":true}`, upstream.URL+"/")

	response := postKikoeruAccount(s, kikoeruImportUser, body)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "kikoeru_destination_not_allowed") || hits.Load() != 0 {
		t.Fatalf("private manual address = %d %s, upstream hits %d", response.Code, response.Body.String(), hits.Load())
	}
	admin := account.User{ID: 1, Permissions: append([]string{"sources:write"}, kikoeruImportUser.Permissions...)}
	if response = postKikoeruAccount(s, admin, body); response.Code != http.StatusOK {
		t.Fatalf("administrator private address = %d %s", response.Code, response.Body.String())
	}
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, 'true')`, kikoeruImportPrivateAddressesSetting); err != nil {
		t.Fatal(err)
	}
	if response = postKikoeruAccount(s, kikoeruImportUser, body); response.Code != http.StatusOK {
		t.Fatalf("allowed private address = %d %s", response.Code, response.Body.String())
	}
	for _, invalid := range []string{
		fmt.Sprintf(`{"url":%q,"auth":{"mode":"none"},"acknowledgedRisk":true}`, (&url.URL{Scheme: "https", User: url.UserPassword("synthetic-user", "synthetic-password"), Host: "source.example.invalid"}).String()),
		`{"url":"ftp://source.example.invalid","auth":{"mode":"none"},"acknowledgedRisk":true}`,
		`{"url":"https://source.example.invalid/?next=elsewhere","auth":{"mode":"none"},"acknowledgedRisk":true}`,
		`{"url":"https://source.example.invalid","sourceId":1,"auth":{"mode":"none"},"acknowledgedRisk":true}`,
		`{"url":"https://source.example.invalid","auth":{"mode":"token","token":"synthetic token"},"acknowledgedRisk":true}`,
		`{"url":"https://source.example.invalid","auth":{"mode":"none"}}`,
	} {
		if response = postKikoeruAccount(s, kikoeruImportUser, invalid); response.Code != http.StatusBadRequest {
			t.Fatalf("%s = %d %s", invalid, response.Code, response.Body.String())
		}
	}
}

func postKikoeruDatabase(t *testing.T, s *Server, fields map[string]string, file []byte) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for name, value := range fields {
		_ = writer.WriteField(name, value)
	}
	if file != nil {
		part, _ := writer.CreateFormFile("file", "kikoeru.sqlite3")
		_, _ = part.Write(file)
	}
	_ = writer.Close()
	r := httptest.NewRequest(http.MethodPost, kikoeruDatabaseImportPath, &body)
	r.Header.Set("Content-Type", writer.FormDataContentType())
	r = r.WithContext(context.WithValue(r.Context(), currentUserKey, kikoeruImportUser))
	response := httptest.NewRecorder()
	s.importKikoeruDatabase(response, r)
	return response
}

func TestKikoeruDatabaseImportReadsOneAccountAndRemovesTheUpload(t *testing.T) {
	temp := t.TempDir()
	t.Setenv("TMPDIR", temp)
	t.Setenv("TMP", temp)
	t.Setenv("TEMP", temp)
	path := filepath.Join(t.TempDir(), "kikoeru.sqlite3")
	source, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE t_user (name TEXT PRIMARY KEY, password TEXT NOT NULL)`,
		`CREATE TABLE t_review (user_name TEXT NOT NULL, work_id BIGINT NOT NULL, rating INTEGER, review_text TEXT, progress TEXT)`,
		`INSERT INTO t_user VALUES ('synthetic-user','synthetic-password'),('other-user','synthetic-password')`,
		`INSERT INTO t_review VALUES ('synthetic-user',0,4,'Example note','replay'),('other-user',1,1,NULL,'listened')`,
	} {
		if _, err := source.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	_ = source.Close()
	database, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	s := NewServer(nil, config.Config{})

	if response := postKikoeruDatabase(t, s, map[string]string{"userName": "synthetic-user"}, database); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "kikoeru_risk_not_acknowledged") {
		t.Fatalf("unacknowledged upload = %d %s", response.Code, response.Body.String())
	}
	response := postKikoeruDatabase(t, s, map[string]string{"userName": "synthetic-user", "acknowledgedRisk": "true"}, database)
	if response.Code != http.StatusOK {
		t.Fatalf("database import = %d %s", response.Code, response.Body.String())
	}
	var result kikoeruImportResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Data.Works) != 1 || result.Data.Works[0].PrimaryCode != "RJ000000" || result.Data.Works[0].ListeningStatus != "relisten" || result.PlaylistsSupported {
		t.Fatalf("result = %+v", result)
	}
	if response := postKikoeruDatabase(t, s, map[string]string{"userName": "missing-user", "acknowledgedRisk": "true"}, database); response.Code != http.StatusNotFound || !strings.Contains(response.Body.String(), "kikoeru_user_not_found") {
		t.Fatalf("missing user = %d %s", response.Code, response.Body.String())
	}
	if response := postKikoeruDatabase(t, s, map[string]string{"userName": "synthetic-user", "acknowledgedRisk": "true"}, []byte("not a database")); response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "kikoeru_database_invalid") {
		t.Fatalf("invalid database = %d %s", response.Code, response.Body.String())
	}
	entries, err := os.ReadDir(temp)
	if err != nil || len(entries) != 0 {
		t.Fatalf("uploads left behind: %v, %v", entries, err)
	}
}

func TestKikoeruDatabaseRouteHasItsOwnBodyBudget(t *testing.T) {
	handler := limitRequestBody(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusNoContent) }), maxJSONRequestBytes)
	for path, want := range map[string]int{kikoeruDatabaseImportPath: http.StatusNoContent, "/api/user-data/kikoeru/account": http.StatusRequestEntityTooLarge} {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(""))
		r.ContentLength = 20 << 20
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, r)
		if response.Code != want {
			t.Fatalf("%s with a 20 MiB body = %d, want %d", path, response.Code, want)
		}
	}
	r := httptest.NewRequest(http.MethodPost, kikoeruDatabaseImportPath, strings.NewReader(""))
	r.ContentLength = maxKikoeruDatabaseBytes + (1 << 20)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, r)
	if response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized database upload = %d", response.Code)
	}
}
