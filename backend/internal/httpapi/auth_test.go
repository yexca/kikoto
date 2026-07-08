package httpapi

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
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
	if passwordHashNeedsUpgrade(hash) {
		t.Fatal("passwordHashNeedsUpgrade() marked argon2id hash for upgrade")
	}
}

func TestLegacySHA256PasswordVerifiesAndNeedsUpgrade(t *testing.T) {
	hash := legacyPasswordHashForTest("legacy-password")
	if !verifyPassword("legacy-password", hash) {
		t.Fatal("verifyPassword() rejected a legacy sha256 password")
	}
	if verifyPassword("wrong-password", hash) {
		t.Fatal("verifyPassword() accepted a wrong legacy sha256 password")
	}
	if !passwordHashNeedsUpgrade(hash) {
		t.Fatal("passwordHashNeedsUpgrade() did not mark legacy hash for upgrade")
	}
}

func TestLoginUpgradesLegacyPasswordHash(t *testing.T) {
	db := openMigratedTestDB(t)

	server := NewServer(db, config.Config{})
	hash := legacyPasswordHashForTest("legacy-password")
	if _, err := db.Exec(`
		INSERT INTO user_account (username, display_name, role, enabled)
		VALUES ('legacy', 'Legacy', 'user', 1)
	`); err != nil {
		t.Fatalf("insert user: %v", err)
	}
	var userID int64
	if err := db.QueryRow("SELECT id FROM user_account WHERE username = 'legacy'").Scan(&userID); err != nil {
		t.Fatalf("select user id: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO user_password_credential (user_id, password_hash)
		VALUES (?, ?)
	`, userID, hash); err != nil {
		t.Fatalf("insert password credential: %v", err)
	}

	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", bytes.NewBufferString(`{"username":"legacy","password":"legacy-password"}`))
	recorder := httptest.NewRecorder()
	server.login(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("login status = %d, body = %s", recorder.Code, recorder.Body.String())
	}
	var upgraded string
	if err := db.QueryRow("SELECT password_hash FROM user_password_credential WHERE user_id = ?", userID).Scan(&upgraded); err != nil {
		t.Fatalf("select upgraded hash: %v", err)
	}
	if !strings.HasPrefix(upgraded, "argon2id$") {
		t.Fatalf("upgraded hash = %q, want argon2id format", upgraded)
	}
	if !verifyPassword("legacy-password", upgraded) {
		t.Fatal("upgraded hash does not verify the original password")
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

func legacyPasswordHashForTest(password string) string {
	salt := []byte("legacy-test-salt")
	return "sha256:" + hex.EncodeToString(salt) + ":" + hex.EncodeToString(passwordHashSum(password, salt))
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
