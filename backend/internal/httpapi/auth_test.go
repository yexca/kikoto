package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

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
