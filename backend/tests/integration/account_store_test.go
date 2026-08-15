package integration_test

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
)

func TestStoreManagesIdentityAndSessions(t *testing.T) {
	db := openMigratedTestDB(t, "account.db")
	store := account.NewStore(db)
	ctx := context.Background()
	if err := store.BootstrapRoot(ctx, "root", "root-password"); err != nil {
		t.Fatal(err)
	}
	root, err := store.LoadByUsername(ctx, "root")
	if err != nil {
		t.Fatal(err)
	}
	if root.Role != "super_admin" || len(root.Permissions) == 0 {
		t.Fatalf("root = %#v", root)
	}
	var markedCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM favorite_list WHERE user_id = ? AND kind = 'marked'", root.ID).Scan(&markedCount); err != nil {
		t.Fatal(err)
	}
	if markedCount != 1 {
		t.Fatalf("root marked list count = %d, want 1", markedCount)
	}
	if _, err := store.Authenticate(ctx, "root", "wrong-password", time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("wrong password error = %v, want sql.ErrNoRows", err)
	}
	session, err := store.Authenticate(ctx, "root", "root-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if user, err := store.UserForSession(ctx, session.ID, time.Now()); err != nil || user.ID != root.ID {
		t.Fatalf("UserForSession() = %#v, %v", user, err)
	}
	if err := store.DeleteSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted session error = %v, want sql.ErrNoRows", err)
	}
}

func TestStorePersistsOwnUILocaleAndRejectsInvalidValues(t *testing.T) {
	db := openMigratedTestDB(t, "account-ui-locale.db")
	store := account.NewStore(db)
	ctx := context.Background()
	if err := store.BootstrapRoot(ctx, "root", "root-password"); err != nil {
		t.Fatal(err)
	}
	root, err := store.LoadByUsername(ctx, "root")
	if err != nil {
		t.Fatal(err)
	}
	if root.UILocale != account.UILocaleAuto {
		t.Fatalf("default UI locale = %q, want %q", root.UILocale, account.UILocaleAuto)
	}

	locale := account.UILocaleJapanese
	updated, err := store.UpdateOwnAccount(ctx, account.UpdateOwnAccountInput{
		ID: root.ID, DisplayName: root.DisplayName, UILocale: &locale,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.UILocale != account.UILocaleJapanese {
		t.Fatalf("updated UI locale = %q, want %q", updated.UILocale, account.UILocaleJapanese)
	}

	invalid := "fr"
	if _, err := store.UpdateOwnAccount(ctx, account.UpdateOwnAccountInput{
		ID: root.ID, DisplayName: "Must Roll Back", UILocale: &invalid,
	}); !errors.Is(err, account.ErrInvalidUILocale) {
		t.Fatalf("invalid UI locale error = %v, want ErrInvalidUILocale", err)
	}
	reloaded, err := store.LoadByID(ctx, root.ID)
	if err != nil {
		t.Fatal(err)
	}
	if reloaded.DisplayName != root.DisplayName || reloaded.UILocale != account.UILocaleJapanese {
		t.Fatalf("invalid update persisted partial state: %#v", reloaded)
	}
	var localeAudits int
	if err := db.QueryRow(`SELECT COUNT(*) FROM audit_log WHERE action = 'user.ui_locale_update'`).Scan(&localeAudits); err != nil {
		t.Fatal(err)
	}
	if localeAudits != 1 {
		t.Fatalf("UI locale audit count = %d, want 1", localeAudits)
	}
}

func TestBootstrapRootSynchronizesEnvironmentPasswordAndRevokesSessions(t *testing.T) {
	db := openMigratedTestDB(t, "account-root-password.db")
	store := account.NewStore(db)
	ctx := context.Background()
	if err := store.BootstrapRoot(ctx, "root", "initial-password"); err != nil {
		t.Fatal(err)
	}
	session, err := store.Authenticate(ctx, "root", "initial-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	root, err := store.LoadByUsername(ctx, "root")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOwnAccount(ctx, account.UpdateOwnAccountInput{
		ID: root.ID, DisplayName: root.DisplayName, CurrentPassword: "initial-password",
		NewPassword: "changed-password", CurrentSessionID: session.ID,
	}); err != nil {
		t.Fatal(err)
	}

	if err := store.BootstrapRoot(ctx, "root", "replacement-password"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(ctx, "root", "changed-password", time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("changed database password error = %v, want sql.ErrNoRows", err)
	}
	if _, err := store.Authenticate(ctx, "root", "replacement-password", time.Now()); err != nil {
		t.Fatalf("replacement environment password was not applied: %v", err)
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("environment password synchronization left an old session active: %v", err)
	}
}

func TestBootstrapDemoCreatesPasswordlessRestrictedIdentity(t *testing.T) {
	db := openMigratedTestDB(t, "account-demo.db")
	store := account.NewStore(db)
	ctx := context.Background()

	if err := store.BootstrapDemo(ctx); err != nil {
		t.Fatal(err)
	}
	demo, err := store.LoadByUsername(ctx, account.DemoUsername)
	if err != nil {
		t.Fatal(err)
	}
	permissions := account.DemoPermissions()
	if demo.Role != "user" || strings.Join(permissions, ",") != "library:read,playback:use" {
		t.Fatalf("demo = %#v, permissions = %#v", demo, permissions)
	}
	var credentials int
	if err := db.QueryRow("SELECT COUNT(*) FROM user_password_credential WHERE user_id = ?", demo.ID).Scan(&credentials); err != nil {
		t.Fatal(err)
	}
	if credentials != 0 {
		t.Fatalf("demo credential count = %d, want 0", credentials)
	}
	var markedCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM favorite_list WHERE user_id = ? AND kind = 'marked'", demo.ID).Scan(&markedCount); err != nil {
		t.Fatal(err)
	}
	if markedCount != 1 {
		t.Fatalf("demo marked list count = %d, want 1", markedCount)
	}
	if _, err := store.Authenticate(ctx, account.DemoUsername, "anything", time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("demo authentication error = %v, want sql.ErrNoRows", err)
	}
}

func TestBootstrapDemoRejectsExistingLoginAccount(t *testing.T) {
	db := openMigratedTestDB(t, "account-demo-conflict.db")
	store := account.NewStore(db)
	ctx := context.Background()
	if err := store.BootstrapRoot(ctx, account.DemoUsername, "existing-password"); err != nil {
		t.Fatal(err)
	}

	if err := store.BootstrapDemo(ctx); !errors.Is(err, account.ErrDemoAccountConflict) {
		t.Fatalf("BootstrapDemo() error = %v, want ErrDemoAccountConflict", err)
	}
	if _, err := store.Authenticate(ctx, account.DemoUsername, "existing-password", time.Now()); err != nil {
		t.Fatalf("conflicting account credential was modified: %v", err)
	}
}

func TestStoreManagesUsersAndProtectsLastSuperAdmin(t *testing.T) {
	db := openMigratedTestDB(t, "account-users.db")
	store := account.NewStore(db)
	ctx := context.Background()
	if err := store.BootstrapRoot(ctx, "root", "root-password"); err != nil {
		t.Fatal(err)
	}
	root, _ := store.LoadByUsername(ctx, "root")
	created, err := store.CreateManagedUser(ctx, account.CreateUserInput{
		Username: "listener", DisplayName: "Listener", Role: "user", Password: "listener-password", Enabled: true, ActorUserID: root.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	var markedCount int
	if err := db.QueryRow("SELECT COUNT(*) FROM favorite_list WHERE user_id = ? AND kind = 'marked'", created.ID).Scan(&markedCount); err != nil {
		t.Fatal(err)
	}
	if markedCount != 1 {
		t.Fatalf("created user marked list count = %d, want 1", markedCount)
	}
	if err := store.EnsureAnotherEnabledSuperAdmin(ctx, root.ID); err == nil {
		t.Fatal("EnsureAnotherEnabledSuperAdmin() accepted the last super administrator")
	}
	oldSession, err := store.Authenticate(ctx, created.Username, "listener-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	updated, err := store.UpdateManagedUser(ctx, account.UpdateUserInput{
		ID: created.ID, DisplayName: created.DisplayName, Role: "super_admin", Password: "new-listener-password", Enabled: true, ActorUserID: root.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Role != "super_admin" {
		t.Fatalf("updated role = %q", updated.Role)
	}
	if err := store.EnsureAnotherEnabledSuperAdmin(ctx, root.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Authenticate(ctx, created.Username, "new-listener-password", time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UserForSession(ctx, oldSession.ID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("administrator password reset left old session active: %v", err)
	}
	if err := store.DeleteManagedUser(ctx, root.ID, created.ID); err != nil {
		t.Fatal(err)
	}
	users, err := store.ListManagedUsers(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(users) != 1 || users[0].ID != root.ID {
		t.Fatalf("users = %#v", users)
	}
}
