package account

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
	"golang.org/x/crypto/argon2"
)

func openAccountTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "account.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	store := NewStore(db)
	if err := store.BootstrapRoot(context.Background(), "root", "synthetic-root-password"); err != nil {
		t.Fatal(err)
	}
	return store
}

// occupyArgon2idSlots holds every derivation slot until the test ends.
func occupyArgon2idSlots(t *testing.T) {
	t.Helper()
	slots := *argon2idSlots.Load()
	for range cap(slots) {
		slots <- struct{}{}
	}
	t.Cleanup(func() {
		for range cap(slots) {
			<-slots
		}
	})
}

func TestAuthenticateDerivesPasswordForUnknownUsername(t *testing.T) {
	store := openAccountTestStore(t)
	if _, err := store.Authenticate(context.Background(), "missing-user", "any-password", time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("unknown username error = %v, want sql.ErrNoRows", err)
	}

	// With every slot held, an unknown username must wait for a derivation
	// exactly like a known one instead of returning early.
	occupyArgon2idSlots(t)
	for _, username := range []string{"root", "missing-user"} {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		_, err := store.Authenticate(ctx, username, "wrong-password", time.Now())
		cancel()
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("Authenticate(%q) with no free slot error = %v, want the caller deadline", username, err)
		}
	}
}

func TestAuthenticateReportsBusyWhenDerivationSlotsStayOccupied(t *testing.T) {
	store := openAccountTestStore(t)
	previousWait := argon2idSlotWait
	argon2idSlotWait = 20 * time.Millisecond
	t.Cleanup(func() { argon2idSlotWait = previousWait })
	occupyArgon2idSlots(t)

	if _, err := store.Authenticate(context.Background(), "root", "synthetic-root-password", time.Now()); !errors.Is(err, ErrPasswordVerificationBusy) {
		t.Fatalf("Authenticate() error = %v, want ErrPasswordVerificationBusy", err)
	}
}

// legacyArgon2idHash encodes a hash with the previous m=64 MiB, t=3 parameters.
func legacyArgon2idHash(secret string) string {
	salt := []byte("synthetic-salt16")
	key := argon2.IDKey([]byte(secret), salt, 3, 64*1024, 1, passwordKeyLength)
	return fmt.Sprintf("argon2id$v=%d$m=65536,t=3,p=1$%s$%s", argon2.Version,
		base64.RawStdEncoding.EncodeToString(salt), base64.RawStdEncoding.EncodeToString(key))
}

func setRootCredential(t *testing.T, store *Store, encoded string) {
	t.Helper()
	if _, err := store.db.Exec(`UPDATE user_password_credential SET password_hash = ? WHERE user_id = (SELECT id FROM user_account WHERE username = 'root')`, encoded); err != nil {
		t.Fatal(err)
	}
}

func rootCredential(t *testing.T, store *Store) string {
	t.Helper()
	var encoded string
	if err := store.db.QueryRow(`SELECT password_hash FROM user_password_credential WHERE user_id = (SELECT id FROM user_account WHERE username = 'root')`).Scan(&encoded); err != nil {
		t.Fatal(err)
	}
	return encoded
}

func TestAuthenticateUpgradesLegacyHashAfterSuccessfulSignIn(t *testing.T) {
	store := openAccountTestStore(t)
	legacy := legacyArgon2idHash("synthetic-root-password")
	setRootCredential(t, store, legacy)

	if _, err := store.Authenticate(context.Background(), "root", "synthetic-wrong-password", time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("wrong password error = %v, want sql.ErrNoRows", err)
	}
	if rootCredential(t, store) != legacy {
		t.Fatal("a failed sign-in replaced the legacy hash")
	}

	if _, err := store.Authenticate(context.Background(), "root", "synthetic-root-password", time.Now()); err != nil {
		t.Fatalf("legacy hash sign-in error = %v", err)
	}
	upgraded := rootCredential(t, store)
	if passwordNeedsRehash(upgraded) || !VerifyPassword("synthetic-root-password", upgraded) {
		t.Fatalf("stored hash after sign-in = %q, want a current-parameter hash of the same password", upgraded)
	}
}

func TestBootstrapRootUpgradesLegacyHashWithoutRevokingSessions(t *testing.T) {
	store := openAccountTestStore(t)
	session, err := store.Authenticate(context.Background(), "root", "synthetic-root-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	setRootCredential(t, store, legacyArgon2idHash("synthetic-root-password"))

	if err := store.BootstrapRoot(context.Background(), "root", "synthetic-root-password"); err != nil {
		t.Fatal(err)
	}
	if upgraded := rootCredential(t, store); passwordNeedsRehash(upgraded) || !VerifyPassword("synthetic-root-password", upgraded) {
		t.Fatalf("stored hash after bootstrap = %q, want a current-parameter hash of the same password", upgraded)
	}
	if _, err := store.UserForSession(context.Background(), session.ID, time.Now()); err != nil {
		t.Fatalf("root session after hash upgrade error = %v, want it kept", err)
	}
}

func TestSetPasswordCheckConcurrencyBoundsDerivations(t *testing.T) {
	t.Cleanup(func() { SetPasswordCheckConcurrency(DefaultPasswordCheckConcurrency) })
	encoded, err := dummyPasswordHash()
	if err != nil {
		t.Fatal(err)
	}
	verifyWithinDeadline := func() error {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
		defer cancel()
		_, err := verifyPasswordContext(ctx, "synthetic-password", encoded)
		return err
	}

	SetPasswordCheckConcurrency(2)
	slots := *argon2idSlots.Load()
	slots <- struct{}{}
	defer func() { <-slots }()
	if err := verifyWithinDeadline(); err != nil {
		t.Fatalf("derivation with one of two slots free error = %v", err)
	}
	slots <- struct{}{}
	defer func() { <-slots }()
	if err := verifyWithinDeadline(); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("derivation with both slots held error = %v, want the caller deadline", err)
	}

	SetPasswordCheckConcurrency(0)
	if got := cap(*argon2idSlots.Load()); got != 1 {
		t.Fatalf("slots for a non-positive limit = %d, want 1", got)
	}
}
