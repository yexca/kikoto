package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestPasswordHashUsesArgon2idAndVerifies(t *testing.T) {
	hash, err := hashPassword("correct horse battery staple")
	if err != nil {
		t.Fatalf("hashPassword() error = %v", err)
	}
	if !strings.HasPrefix(hash, "argon2id$") {
		t.Fatalf("hashPassword() = %q, want argon2id format", hash)
	}
	if !verifyPassword("correct horse battery staple", hash) {
		t.Fatal("verifyPassword() rejected the correct password")
	}
	if verifyPassword("wrong password", hash) {
		t.Fatal("verifyPassword() accepted the wrong password")
	}
}

func TestSessionCookieSecureFromConfig(t *testing.T) {
	server := NewServer(nil, config.Config{SessionCookieSecure: true})
	request := httptest.NewRequest(http.MethodGet, "http://example.test/", nil)
	recorder := httptest.NewRecorder()

	server.setSessionCookie(request, recorder, &http.Cookie{Name: sessionCookieName, Value: "session", Path: "/"})

	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookie count = %d, want 1", len(cookies))
	}
	if !cookies[0].Secure {
		t.Fatal("session cookie is not secure when configured")
	}
}

func TestSessionCookieSecureForHTTPSRequest(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodGet, "https://example.test/", nil)
	recorder := httptest.NewRecorder()

	server.setSessionCookie(request, recorder, &http.Cookie{Name: sessionCookieName, Value: "session", Path: "/"})

	cookies := recorder.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("cookie count = %d, want 1", len(cookies))
	}
	if !cookies[0].Secure {
		t.Fatal("session cookie is not secure for HTTPS requests")
	}
}

func TestAuthMiddlewareDoesNotTreatDatabaseFailureAsAnonymous(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	called := false
	handler := server.authMiddleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		w.WriteHeader(http.StatusOK)
	}))
	request := httptest.NewRequest(http.MethodPost, "/api/protected", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "session"})
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)

	if called {
		t.Fatal("protected handler was called after an authentication database failure")
	}
	if response.Code == http.StatusUnauthorized || response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500 and never 401", response.Code)
	}
}

func TestDemoRequestsUseRestrictedDemoIdentityAndIgnoreSessions(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeDemo, RootUsername: "root", RootPassword: "root-password"})
	if err := server.BootstrapRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := server.BootstrapDemo(context.Background()); err != nil {
		t.Fatal(err)
	}
	rootSession, err := server.accountStore.Authenticate(context.Background(), "root", "root-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	request.Header.Set("Authorization", "Bearer "+rootSession.ID)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("demo auth status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		Authenticated bool        `json:"authenticated"`
		User          currentUser `json:"user"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Authenticated || payload.User.Username != account.DemoUsername || !payload.User.DemoMode {
		t.Fatalf("demo auth payload = %#v", payload)
	}
	if strings.Join(payload.User.Permissions, ",") != "library:read,playback:use" || payload.User.Role != "user" {
		t.Fatalf("demo user = %#v", payload.User)
	}
}

func TestUpdateCurrentUserChangesAccountManagedProfileAndPasswordAndKeepsCurrentSession(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, RootUsername: "root", RootPassword: "old-password"})
	if err := server.BootstrapRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	createAccountManagedTestUser(t, server, "listener", "listener-password")
	handler := server.Routes()
	currentCookie := loginTestSession(t, handler, "listener", "listener-password")
	otherCookie := loginTestSession(t, handler, "listener", "listener-password")

	request := httptest.NewRequest(http.MethodPatch, "/api/auth/me", strings.NewReader(`{"displayName":"Updated Listener","currentPassword":"listener-password","newPassword":"new-password"}`))
	request.AddCookie(currentCookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("update current user status = %d, body = %s", response.Code, response.Body.String())
	}
	var payload struct {
		Authenticated bool        `json:"authenticated"`
		User          currentUser `json:"user"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if !payload.Authenticated || payload.User.DisplayName != "Updated Listener" || payload.User.PasswordManagedBy != "account" {
		t.Fatalf("update response = %#v", payload)
	}

	var passwordHash string
	if err := db.QueryRow(`SELECT password_hash FROM user_password_credential WHERE user_id = ?`, payload.User.ID).Scan(&passwordHash); err != nil {
		t.Fatal(err)
	}
	if verifyPassword("listener-password", passwordHash) || !verifyPassword("new-password", passwordHash) {
		t.Fatal("password credential was not replaced")
	}
	var currentSessions, otherSessions int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_session WHERE id = ?`, currentCookie.Value).Scan(&currentSessions); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_session WHERE id = ?`, otherCookie.Value).Scan(&otherSessions); err != nil {
		t.Fatal(err)
	}
	if currentSessions != 1 || otherSessions != 0 {
		t.Fatalf("session counts = current %d other %d", currentSessions, otherSessions)
	}

	meRequest := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	meRequest.AddCookie(currentCookie)
	meResponse := httptest.NewRecorder()
	handler.ServeHTTP(meResponse, meRequest)
	if meResponse.Code != http.StatusOK || !strings.Contains(meResponse.Body.String(), "Updated Listener") {
		t.Fatalf("current session after update = %d, body = %s", meResponse.Code, meResponse.Body.String())
	}
	var profileAudits, passwordAudits int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action = 'user.profile_update'`).Scan(&profileAudits); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action = 'user.password_change'`).Scan(&passwordAudits); err != nil {
		t.Fatal(err)
	}
	if profileAudits != 1 || passwordAudits != 1 {
		t.Fatalf("audit counts = profile %d password %d", profileAudits, passwordAudits)
	}
}

func TestUpdateCurrentUserRejectsWrongPasswordWithoutPartialUpdate(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, RootUsername: "root", RootPassword: "old-password"})
	if err := server.BootstrapRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	createAccountManagedTestUser(t, server, "listener", "listener-password")
	handler := server.Routes()
	cookie := loginTestSession(t, handler, "listener", "listener-password")

	request := httptest.NewRequest(http.MethodPatch, "/api/auth/me", strings.NewReader(`{"displayName":"Should Roll Back","currentPassword":"wrong-password","newPassword":"new-password"}`))
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusBadRequest || !strings.Contains(response.Body.String(), "current password is incorrect") {
		t.Fatalf("wrong password status = %d, body = %s", response.Code, response.Body.String())
	}
	var displayName, passwordHash string
	if err := db.QueryRow(`SELECT account.display_name, credential.password_hash FROM user_account AS account INNER JOIN user_password_credential AS credential ON credential.user_id = account.id WHERE account.username = 'listener'`).Scan(&displayName, &passwordHash); err != nil {
		t.Fatal(err)
	}
	if displayName != "listener" || !verifyPassword("listener-password", passwordHash) {
		t.Fatalf("failed update persisted display %q or changed password", displayName)
	}
	var sessionCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM user_session WHERE id = ?`, cookie.Value).Scan(&sessionCount); err != nil {
		t.Fatal(err)
	}
	if sessionCount != 1 {
		t.Fatalf("current session count = %d", sessionCount)
	}
}

func TestUpdateCurrentUserRejectsEnvironmentManagedRootPassword(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, RootUsername: "configured-root", RootPassword: "environment-password"})
	if err := server.BootstrapRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	handler := server.Routes()
	cookie := loginTestSession(t, handler, "configured-root", "environment-password")

	request := httptest.NewRequest(http.MethodPatch, "/api/auth/me", strings.NewReader(`{"displayName":"Should Not Persist","currentPassword":"environment-password","newPassword":"new-password"}`))
	request.AddCookie(cookie)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "KIKOTO_ROOT_PASSWORD") {
		t.Fatalf("root password update status = %d, body = %s", response.Code, response.Body.String())
	}

	meRequest := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	meRequest.AddCookie(cookie)
	meResponse := httptest.NewRecorder()
	handler.ServeHTTP(meResponse, meRequest)
	if meResponse.Code != http.StatusOK || !strings.Contains(meResponse.Body.String(), `"passwordManagedBy":"environment"`) {
		t.Fatalf("root account response = %d, body = %s", meResponse.Code, meResponse.Body.String())
	}
	var displayName string
	if err := db.QueryRow("SELECT display_name FROM user_account WHERE username = 'configured-root'").Scan(&displayName); err != nil {
		t.Fatal(err)
	}
	if displayName != "configured-root" {
		t.Fatalf("rejected root update persisted display name %q", displayName)
	}
}

func createAccountManagedTestUser(t *testing.T, server *Server, username string, password string) {
	t.Helper()
	root, err := server.accountStore.LoadByUsername(context.Background(), server.cfg.RootUsername)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.accountStore.CreateManagedUser(context.Background(), account.CreateUserInput{
		Username: username, DisplayName: username, Role: "user", Password: password, Enabled: true, ActorUserID: root.ID,
	}); err != nil {
		t.Fatal(err)
	}
}

func loginTestSession(t *testing.T, handler http.Handler, username string, password string) *http.Cookie {
	t.Helper()
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", response.Code, response.Body.String())
	}
	for _, cookie := range response.Result().Cookies() {
		if cookie.Name == sessionCookieName {
			return cookie
		}
	}
	t.Fatal("login response did not set a session cookie")
	return nil
}

func TestLocalMediaDeleteBlocksSymlinkAndCreatesReview(t *testing.T) {
	dataRoot := t.TempDir()
	targetPath := filepath.Join(t.TempDir(), "target.mp3")
	if err := os.WriteFile(targetPath, []byte("audio"), 0o644); err != nil {
		t.Fatalf("write target: %v", err)
	}
	if err := os.Symlink(targetPath, filepath.Join(dataRoot, "linked.mp3")); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}

	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	locationID := insertTestLocalMediaLocation(t, db, "linked.mp3")

	_, err := server.runLocalMediaDelete(context.Background(), locationID)
	var symlinkErr symlinkMediaLocationError
	if !errors.As(err, &symlinkErr) {
		t.Fatalf("runLocalMediaDelete() error = %v, want symlinkMediaLocationError", err)
	}
	if symlinkErr.RunID <= 0 || symlinkErr.CandidateID <= 0 {
		t.Fatalf("symlink review ids = run %d candidate %d, want positive ids", symlinkErr.RunID, symlinkErr.CandidateID)
	}
	if _, err := os.Lstat(filepath.Join(dataRoot, "linked.mp3")); err != nil {
		t.Fatalf("symlink was removed: %v", err)
	}
	if _, err := os.Stat(targetPath); err != nil {
		t.Fatalf("symlink target was removed: %v", err)
	}

	var availability string
	if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", locationID).Scan(&availability); err != nil {
		t.Fatalf("select location availability: %v", err)
	}
	if availability != "available" {
		t.Fatalf("availability = %q, want available", availability)
	}

	var candidateType string
	var status string
	if err := db.QueryRow("SELECT candidate_type, status FROM workflow_candidate WHERE id = ?", symlinkErr.CandidateID).Scan(&candidateType, &status); err != nil {
		t.Fatalf("select workflow candidate: %v", err)
	}
	if candidateType != "local_symlink_media_location" || status != "pending" {
		t.Fatalf("candidate = %s/%s, want local_symlink_media_location/pending", candidateType, status)
	}

	_, err = server.runLocalMediaDelete(context.Background(), locationID)
	var duplicateErr symlinkMediaLocationError
	if !errors.As(err, &duplicateErr) {
		t.Fatalf("second runLocalMediaDelete() error = %v, want symlinkMediaLocationError", err)
	}
	if duplicateErr.CandidateID != symlinkErr.CandidateID {
		t.Fatalf("duplicate candidate id = %d, want existing candidate %d", duplicateErr.CandidateID, symlinkErr.CandidateID)
	}
	var candidateCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_candidate WHERE candidate_type = 'local_symlink_media_location'").Scan(&candidateCount); err != nil {
		t.Fatalf("count symlink candidates: %v", err)
	}
	if candidateCount != 1 {
		t.Fatalf("symlink candidate count = %d, want 1", candidateCount)
	}
}

func insertTestLocalMediaLocation(t *testing.T, db *sql.DB, relPath string) int64 {
	t.Helper()
	if _, err := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJTEST001', 'Test Work')"); err != nil {
		t.Fatalf("insert work: %v", err)
	}
	var workID int64
	if err := db.QueryRow("SELECT id FROM work WHERE primary_code = 'RJTEST001'").Scan(&workID); err != nil {
		t.Fatalf("select work id: %v", err)
	}
	if _, err := db.Exec("INSERT INTO file_source (code, display_name, source_type) VALUES ('local-test', 'Local Test', 'local')"); err != nil {
		t.Fatalf("insert file source: %v", err)
	}
	var sourceID int64
	if err := db.QueryRow("SELECT id FROM file_source WHERE code = 'local-test'").Scan(&sourceID); err != nil {
		t.Fatalf("select source id: %v", err)
	}
	if _, err := db.Exec("INSERT INTO media_item (work_id, kind, title, fingerprint) VALUES (?, 'audio', 'Linked file', 'test-linked-file')", workID); err != nil {
		t.Fatalf("insert media item: %v", err)
	}
	var mediaItemID int64
	if err := db.QueryRow("SELECT id FROM media_item WHERE fingerprint = 'test-linked-file'").Scan(&mediaItemID); err != nil {
		t.Fatalf("select media item id: %v", err)
	}
	result, err := db.Exec(`
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'local', ?, 'available')
	`, mediaItemID, sourceID, relPath)
	if err != nil {
		t.Fatalf("insert media file location: %v", err)
	}
	locationID, err := result.LastInsertId()
	if err != nil {
		t.Fatalf("last insert location id: %v", err)
	}
	return locationID
}

func openMigratedTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("storage.Open() error = %v", err)
	}
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		_ = db.Close()
		t.Fatalf("storage.Migrate() error = %v", err)
	}
	t.Cleanup(func() {
		_ = db.Close()
	})
	if err := db.PingContext(context.Background()); err != nil {
		t.Fatalf("db ping: %v", err)
	}
	return db
}
