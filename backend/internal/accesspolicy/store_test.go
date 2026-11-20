package accesspolicy

import (
	"context"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
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

func openAccessPolicyTestDB(t *testing.T) *sqlutil.DB {
	t.Helper()
	return storagetest.Open(t)
}

// Anonymous remote-source browsing is its own setting, off by default, and
// changing it is persisted and audited apart from anonymous access.
func TestStoreKeepsAnonymousRemoteBrowsingApart(t *testing.T) {
	db := openAccessPolicyTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, display_name, role) VALUES (1, 'root', 'Root', 'super_admin')`); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	if err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	if store.Current().AnonymousRemoteBrowsingEnabled {
		t.Fatal("anonymous remote browsing defaulted to enabled")
	}
	policy, err := store.UpdateRemoteBrowsing(context.Background(), 1, true)
	if err != nil || !policy.AnonymousRemoteBrowsingEnabled || policy.AnonymousAccessEnabled {
		t.Fatalf("policy = %#v, %v", policy, err)
	}
	reloaded := NewStore(db)
	if err := reloaded.Load(context.Background()); err != nil || !reloaded.Current().AnonymousRemoteBrowsingEnabled {
		t.Fatalf("reloaded policy = %#v, %v", reloaded.Current(), err)
	}
	var audits int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action = 'access_policy.anonymous_remote_browsing_update'`).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("audit rows = %d, %v", audits, err)
	}
	// Turning anonymous access off turns remote browsing off with it, so
	// turning anonymous access on again does not bring remote browsing back.
	if _, err := store.Update(context.Background(), 1, true); err != nil {
		t.Fatal(err)
	}
	if policy, err := store.Update(context.Background(), 1, false); err != nil || policy.AnonymousRemoteBrowsingEnabled {
		t.Fatalf("policy after turning anonymous access off = %#v, %v", policy, err)
	}
	if policy, err := store.Update(context.Background(), 1, true); err != nil || policy.AnonymousRemoteBrowsingEnabled {
		t.Fatalf("policy after turning anonymous access on again = %#v, %v", policy, err)
	}
}

// A change that sets both settings applies both or neither.
func TestStoreUpdatesBothSettingsTogether(t *testing.T) {
	db := openAccessPolicyTestDB(t)
	store := NewStore(db)
	if err := store.Load(context.Background()); err != nil {
		t.Fatal(err)
	}
	enabled := true
	// No account 9 exists, so the audit row fails after the first setting.
	if _, err := store.UpdatePolicy(context.Background(), 9, PolicyUpdate{AnonymousAccessEnabled: &enabled, AnonymousRemoteBrowsingEnabled: &enabled}); err == nil {
		t.Fatal("an update with a failing audit row succeeded")
	}
	var stored int
	if err := db.QueryRow(`SELECT COUNT(*) FROM app_setting WHERE key IN (?, ?)`, anonymousAccessSettingKey, anonymousRemoteBrowsingSettingKey).Scan(&stored); err != nil || stored != 0 {
		t.Fatalf("settings stored by a failed update = %d, %v", stored, err)
	}
	if store.Current().AnonymousAccessEnabled || store.Current().AnonymousRemoteBrowsingEnabled {
		t.Fatal("a failed update changed the cached policy")
	}
}
