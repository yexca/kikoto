package account

import (
	"context"
	"database/sql"
	"errors"
	"testing"
	"time"
)

// A copied database or backup must not contain a usable bearer token.
func TestSessionStoresOnlyTokenDigest(t *testing.T) {
	store := openAccountTestStore(t)
	ctx := context.Background()
	session, err := store.Authenticate(ctx, "root", "synthetic-root-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}

	var storedID string
	if err := store.db.QueryRow("SELECT id FROM user_session WHERE user_id = ?", session.User.ID).Scan(&storedID); err != nil {
		t.Fatal(err)
	}
	if storedID == session.ID || storedID != sessionKey(session.ID) {
		t.Fatalf("stored session id = %q, want the digest of the issued token", storedID)
	}
	if _, err := store.UserForSession(ctx, storedID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("stored digest as bearer error = %v, want sql.ErrNoRows", err)
	}
	if user, err := store.UserForSession(ctx, session.ID, time.Now()); err != nil || user.ID != session.User.ID {
		t.Fatalf("issued token = %#v, %v, want the signed-in user", user, err)
	}

	if err := store.DeleteSession(ctx, session.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("session after sign-out error = %v, want sql.ErrNoRows", err)
	}
}

// Enabling a disabled account again must not revive a token issued before it
// was disabled.
func TestDisablingAnAccountRevokesItsSessions(t *testing.T) {
	store := openAccountTestStore(t)
	ctx := context.Background()
	user, err := store.CreateManagedUser(ctx, CreateUserInput{
		Username: "synthetic-user", DisplayName: "Example User", Role: "user",
		Password: "synthetic-user-password", Enabled: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.Authenticate(ctx, "synthetic-user", "synthetic-user-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	for _, enabled := range []bool{false, true} {
		if _, err := store.UpdateManagedUser(ctx, UpdateUserInput{
			ID: user.ID, DisplayName: user.DisplayName, Role: user.Role, Enabled: enabled,
		}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("session after disable and enable error = %v, want sql.ErrNoRows", err)
	}
	var sessions int
	if err := store.db.QueryRow("SELECT COUNT(*) FROM user_session WHERE user_id = ?", user.ID).Scan(&sessions); err != nil {
		t.Fatal(err)
	}
	if sessions != 0 {
		t.Fatalf("stored sessions = %d, want none", sessions)
	}
}
