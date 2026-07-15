package integration_test

import (
	"context"
	"database/sql"
	"errors"
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
	if err := store.EnsureAnotherEnabledSuperAdmin(ctx, root.ID); err == nil {
		t.Fatal("EnsureAnotherEnabledSuperAdmin() accepted the last super administrator")
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
