package account

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage"
)

func openEmptyAccountTestStore(t *testing.T) *Store {
	t.Helper()
	db, err := storage.Open(filepath.Join(t.TempDir(), "account.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	return NewStore(db)
}

func requireSetupState(t *testing.T, store *Store, want bool) {
	t.Helper()
	required, err := store.InitialSetupRequired(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if required != want {
		t.Fatalf("InitialSetupRequired() = %t, want %t", required, want)
	}
}

func TestCreateInitialAdministratorClaimsOnlyAnUninitializedInstance(t *testing.T) {
	store := openEmptyAccountTestStore(t)
	ctx := context.Background()
	requireSetupState(t, store, true)

	for _, test := range []struct {
		username string
		password string
		want     error
	}{
		{username: " ", password: "synthetic-password", want: ErrUsernameRequired},
		{username: DemoUsername, password: "synthetic-password", want: ErrReservedUsername},
		{username: "synthetic-admin", password: "dummy", want: ErrPasswordTooShort},
		{username: "synthetic-admin", password: "Replace-With-A-Long-Random-Password", want: ErrPlaceholderPassword},
	} {
		if _, err := store.CreateInitialAdministrator(ctx, test.username, test.password); !errors.Is(err, test.want) {
			t.Fatalf("CreateInitialAdministrator(%q) error = %v, want %v", test.username, err, test.want)
		}
	}
	requireSetupState(t, store, true)

	admin, err := store.CreateInitialAdministrator(ctx, " synthetic-admin ", "synthetic-password")
	if err != nil {
		t.Fatal(err)
	}
	if admin.Username != "synthetic-admin" || admin.Role != "super_admin" {
		t.Fatalf("initial administrator = %#v", admin)
	}
	requireSetupState(t, store, false)
	if _, err := store.Authenticate(ctx, "synthetic-admin", "synthetic-password", time.Now()); err != nil {
		t.Fatalf("initial administrator cannot sign in: %v", err)
	}
	if _, err := store.CreateInitialAdministrator(ctx, "second-admin", "synthetic-password"); !errors.Is(err, ErrSetupComplete) {
		t.Fatalf("second setup error = %v, want ErrSetupComplete", err)
	}
	if username, err := store.RecoveryUsername(ctx, ""); err != nil || username != "synthetic-admin" {
		t.Fatalf("RecoveryUsername() = %q, %v, want the initial administrator", username, err)
	}
}

func TestCreateInitialAdministratorClaimsPasswordlessDevelopmentIdentity(t *testing.T) {
	store := openEmptyAccountTestStore(t)
	ctx := context.Background()
	if err := store.EnsureDevelopmentAdministrator(ctx, "root"); err != nil {
		t.Fatal(err)
	}
	development, err := store.LoadByUsername(ctx, "root")
	if err != nil {
		t.Fatal(err)
	}
	requireSetupState(t, store, true)

	claimed, err := store.CreateInitialAdministrator(ctx, "root", "synthetic-password")
	if err != nil {
		t.Fatal(err)
	}
	if claimed.ID != development.ID {
		t.Fatalf("claimed account id = %d, want development identity %d", claimed.ID, development.ID)
	}
}

func TestRecoverAdministratorRestoresAccessAndRevokesSessions(t *testing.T) {
	store := openEmptyAccountTestStore(t)
	ctx := context.Background()
	admin, err := store.CreateInitialAdministrator(ctx, "synthetic-admin", "synthetic-password")
	if err != nil {
		t.Fatal(err)
	}
	session, err := store.Authenticate(ctx, "synthetic-admin", "synthetic-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.db.Exec("UPDATE user_account SET role = 'user', enabled = 0 WHERE id = ?", admin.ID); err != nil {
		t.Fatal(err)
	}

	result, err := store.RecoverAdministrator(ctx, "synthetic-admin", "synthetic-recovered", RecoverySourceCommand)
	if err != nil {
		t.Fatal(err)
	}
	if result.UserID != admin.ID || result.Created {
		t.Fatalf("recovery result = %#v, want the existing administrator", result)
	}
	recovered, err := store.LoadByID(ctx, admin.ID)
	if err != nil || recovered.Role != "super_admin" {
		t.Fatalf("recovered account = %#v, %v, want an enabled super administrator", recovered, err)
	}
	if _, err := store.Authenticate(ctx, "synthetic-admin", "synthetic-password", time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("old password error = %v, want sql.ErrNoRows", err)
	}
	if _, err := store.Authenticate(ctx, "synthetic-admin", "synthetic-recovered", time.Now()); err != nil {
		t.Fatalf("recovered password rejected: %v", err)
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("session after recovery error = %v, want it revoked", err)
	}
	var actor sql.NullInt64
	var detail string
	if err := store.db.QueryRow("SELECT actor_user_id, detail_json FROM audit_log WHERE action = 'user.recover'").Scan(&actor, &detail); err != nil {
		t.Fatal(err)
	}
	if actor.Valid || detail != `{"created":false,"source":"command"}` {
		t.Fatalf("recovery audit = actor %v detail %s", actor, detail)
	}

	if _, err := store.RecoverAdministrator(ctx, "synthetic-missing", "synthetic-password", RecoverySourceCommand); !errors.Is(err, ErrRecoveryAccountNotFound) {
		t.Fatalf("recovery of a missing account error = %v, want ErrRecoveryAccountNotFound", err)
	}
	created, err := store.RecoverAdministrator(ctx, DefaultAdministratorUsername, "synthetic-password", RecoverySourceCommand)
	if err != nil || !created.Created {
		t.Fatalf("recovery of missing root = %#v, %v, want it created", created, err)
	}
}

func TestRecoveryUsernameRequiresExplicitTargetAfterInitialAdministratorIsDeleted(t *testing.T) {
	store := openEmptyAccountTestStore(t)
	ctx := context.Background()
	initial, err := store.CreateInitialAdministrator(ctx, "synthetic-admin", "synthetic-password")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateManagedUser(ctx, CreateUserInput{
		Username: "synthetic-second", DisplayName: "synthetic-second", Role: "super_admin", Password: "synthetic-password", Enabled: true, ActorUserID: initial.ID,
	}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteManagedUser(ctx, 0, initial.ID); err != nil {
		t.Fatal(err)
	}

	_, err = store.RecoveryUsername(ctx, "")
	var target *RecoveryTargetRequiredError
	if !errors.As(err, &target) || len(target.SuperAdministrators) != 1 || target.SuperAdministrators[0] != "synthetic-second" {
		t.Fatalf("RecoveryUsername() error = %v, want the remaining super administrators listed", err)
	}
	if username, err := store.RecoveryUsername(ctx, " synthetic-second "); err != nil || username != "synthetic-second" {
		t.Fatalf("explicit RecoveryUsername() = %q, %v", username, err)
	}
	// Recovering an explicit account makes it the default target again.
	if _, err := store.RecoverAdministrator(ctx, "synthetic-second", "synthetic-recovered", RecoverySourceCommand); err != nil {
		t.Fatal(err)
	}
	if username, err := store.RecoveryUsername(ctx, ""); err != nil || username != "synthetic-second" {
		t.Fatalf("RecoveryUsername() after recovery = %q, %v", username, err)
	}
}

func TestApplyEnvironmentRecoveryAppliesEachValueOnce(t *testing.T) {
	store := openEmptyAccountTestStore(t)
	ctx := context.Background()

	var target *RecoveryTargetRequiredError
	if _, _, err := store.ApplyEnvironmentRecovery(ctx, "", "synthetic-env-password"); !errors.As(err, &target) {
		t.Fatalf("recovery without a target on an empty instance error = %v, want RecoveryTargetRequiredError", err)
	}
	result, applied, err := store.ApplyEnvironmentRecovery(ctx, "root", "synthetic-env-password")
	if err != nil || !applied || !result.Created || result.Username != DefaultAdministratorUsername {
		t.Fatalf("first environment recovery = %#v, applied %t, %v", result, applied, err)
	}
	requireSetupState(t, store, false)

	session, err := store.Authenticate(ctx, "root", "synthetic-env-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.UpdateOwnAccount(ctx, UpdateOwnAccountInput{
		ID: result.UserID, CurrentPassword: "synthetic-env-password", NewPassword: "synthetic-app-password", CurrentSessionID: session.ID,
	}); err != nil {
		t.Fatal(err)
	}

	if _, applied, err := store.ApplyEnvironmentRecovery(ctx, "root", "synthetic-env-password"); err != nil || applied {
		t.Fatalf("repeated environment recovery applied %t, %v, want it skipped", applied, err)
	}
	if _, err := store.Authenticate(ctx, "root", "synthetic-app-password", time.Now()); err != nil {
		t.Fatalf("repeated reset replaced the password changed in the app: %v", err)
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); err != nil {
		t.Fatalf("repeated reset revoked a session: %v", err)
	}

	if _, applied, err := store.ApplyEnvironmentRecovery(ctx, "root", "synthetic-env-password-2"); err != nil || !applied {
		t.Fatalf("changed environment recovery applied %t, %v, want it applied", applied, err)
	}
	if _, err := store.Authenticate(ctx, "root", "synthetic-env-password-2", time.Now()); err != nil {
		t.Fatalf("changed environment password rejected: %v", err)
	}
	if _, _, err := store.ApplyEnvironmentRecovery(ctx, "root", "change-me"); !errors.Is(err, ErrPlaceholderPassword) {
		t.Fatalf("placeholder environment password error = %v, want ErrPlaceholderPassword", err)
	}
}

func TestSyncEnvironmentAdministratorAppliesChangedPasswordOnly(t *testing.T) {
	store := openEmptyAccountTestStore(t)
	ctx := context.Background()
	if changed, err := store.SyncEnvironmentAdministrator(ctx, "root", "synthetic-env-password"); err != nil || !changed {
		t.Fatalf("first sync changed %t, %v, want the account created", changed, err)
	}
	requireSetupState(t, store, false)
	session, err := store.Authenticate(ctx, "root", "synthetic-env-password", time.Now())
	if err != nil {
		t.Fatal(err)
	}

	if changed, err := store.SyncEnvironmentAdministrator(ctx, "root", "synthetic-env-password"); err != nil || changed {
		t.Fatalf("unchanged sync changed %t, %v", changed, err)
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); err != nil {
		t.Fatalf("unchanged sync revoked a session: %v", err)
	}

	if changed, err := store.SyncEnvironmentAdministrator(ctx, "root", "synthetic-env-password-2"); err != nil || !changed {
		t.Fatalf("changed sync changed %t, %v", changed, err)
	}
	if _, err := store.Authenticate(ctx, "root", "synthetic-env-password", time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("old environment password error = %v, want sql.ErrNoRows", err)
	}
	if _, err := store.UserForSession(ctx, session.ID, time.Now()); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("changed sync left an old session active: %v", err)
	}
	if _, err := store.SyncEnvironmentAdministrator(ctx, "root", "replace-with-a-long-random-password"); !errors.Is(err, ErrPlaceholderPassword) {
		t.Fatalf("placeholder environment password error = %v, want ErrPlaceholderPassword", err)
	}
}
