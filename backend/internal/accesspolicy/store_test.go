package accesspolicy

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func TestStoreDefaultsAnonymousAccessToDisabled(t *testing.T) {
	db := openAccessPolicyTestDB(t)
	store := NewStore(db)

	if err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.Current().AnonymousAccessEnabled {
		t.Fatal("anonymous access defaulted to enabled")
	}
}

func TestStoreUpdatePersistsCachesAndAuditsChanges(t *testing.T) {
	db := openAccessPolicyTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'root', 'Root', 'super_admin')`); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	if err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}

	policy, err := store.Update(context.Background(), 1, true)
	if err != nil {
		t.Fatal(err)
	}
	if !policy.AnonymousAccessEnabled || !store.Current().AnonymousAccessEnabled {
		t.Fatalf("updated policy = %#v, cached policy = %#v", policy, store.Current())
	}
	var raw string
	if err := db.QueryRow(`SELECT value_json FROM app_setting WHERE key = ?`, anonymousAccessSettingKey).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	if raw != "true" {
		t.Fatalf("stored value = %q, want true", raw)
	}
	var auditCount int
	var detail string
	if err := db.QueryRow(`
		SELECT COUNT(*), MAX(detail_json)
		FROM audit_log
		WHERE action = 'access_policy.anonymous_access_update'
	`).Scan(&auditCount, &detail); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 || !strings.Contains(detail, `"previous":false`) || !strings.Contains(detail, `"enabled":true`) {
		t.Fatalf("audit count = %d, detail = %q", auditCount, detail)
	}

	if _, err := store.Update(context.Background(), 1, true); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action = 'access_policy.anonymous_access_update'`).Scan(&auditCount); err != nil {
		t.Fatal(err)
	}
	if auditCount != 1 {
		t.Fatalf("unchanged policy created %d audits, want one", auditCount)
	}

	reloaded := NewStore(db)
	if err := reloaded.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !reloaded.Current().AnonymousAccessEnabled {
		t.Fatal("persisted policy was not loaded by a new store")
	}
}

func TestStoreRejectsMalformedOrUnavailableSettings(t *testing.T) {
	db := openAccessPolicyTestDB(t)
	if _, err := db.Exec(`INSERT INTO app_setting (key, value_json) VALUES (?, '"enabled"')`, anonymousAccessSettingKey); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	if err := store.Load(context.Background()); err == nil || !strings.Contains(err.Error(), "decode anonymous access policy") {
		t.Fatalf("malformed setting error = %v", err)
	}
	if store.Current().AnonymousAccessEnabled {
		t.Fatal("malformed setting enabled anonymous access")
	}

	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	if err := store.Load(context.Background()); err == nil {
		t.Fatal("closed database did not fail access policy load")
	}
	if err := NewStore(nil).Load(context.Background()); err == nil {
		t.Fatal("nil database did not fail access policy load")
	}
}

func openAccessPolicyTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		_ = db.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}
