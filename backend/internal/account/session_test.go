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
