package main

import (
	"bytes"
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/storage"
)

func migratedCommandTestDatabase(t *testing.T) (string, *account.Store) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "kikoto.db")
	db, err := storage.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db, filepath.Join("..", "..", "migrations")); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KIKOTO_MODE", "production")
	t.Setenv("KIKOTO_DB_PATH", path)
	t.Setenv("KIKOTO_ROOT_USERNAME", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "")
	t.Setenv("KIKOTO_ROOT_PASSWORD_RESET", "")
	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "")
	return path, account.NewStore(db)
}

func TestAdminResetPasswordPrintsGeneratedPasswordForInitialAdministrator(t *testing.T) {
	_, store := migratedCommandTestDatabase(t)
	ctx := context.Background()
	if _, err := store.CreateInitialAdministrator(ctx, "synthetic-admin", "synthetic-password"); err != nil {
		t.Fatal(err)
	}

	var stdout, stderr bytes.Buffer
	if code := runAdminCommand([]string{"reset-password"}, strings.NewReader(""), &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	output := stdout.String()
	if !strings.Contains(output, "Administrator password reset.") || !strings.Contains(output, "Username: synthetic-admin") {
		t.Fatalf("output = %s", output)
	}
	match := regexp.MustCompile(`(?m)^Password: (\S+)$`).FindStringSubmatch(output)
	if match == nil {
		t.Fatalf("output has no generated password: %s", output)
	}
	if _, err := store.Authenticate(ctx, "synthetic-admin", match[1], time.Now()); err != nil {
		t.Fatalf("generated password rejected: %v", err)
	}
}

func TestAdminResetPasswordReadsPasswordFromStdin(t *testing.T) {
	_, store := migratedCommandTestDatabase(t)
	var stdout, stderr bytes.Buffer
	if code := runAdminCommand([]string{"reset-password", "--username", "root", "--password-stdin"}, strings.NewReader("replace-with-a-long-random-password\n"), &stdout, &stderr); code != 1 {
		t.Fatalf("placeholder exit code = %d, want 1", code)
	}

	stdout.Reset()
	stderr.Reset()
	if code := runAdminCommand([]string{"reset-password", "--username", "synthetic-missing", "--password-stdin"}, strings.NewReader("synthetic-stdin-password\n"), &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "does not exist") {
		t.Fatalf("missing account exit code = %d, stderr = %s", code, stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	if code := runAdminCommand([]string{"reset-password", "--password-stdin"}, strings.NewReader("synthetic-stdin-password\n"), &stdout, &stderr); code != 1 || !strings.Contains(stderr.String(), "pass --username") {
		t.Fatalf("missing target exit code = %d, stderr = %s", code, stderr.String())
	}

	stdout.Reset()
	stderr.Reset()
	if code := runAdminCommand([]string{"reset-password", "--username", "root", "--password-stdin"}, strings.NewReader("synthetic-stdin-password\r\n"), &stdout, &stderr); code != 0 {
		t.Fatalf("exit code = %d, stderr = %s", code, stderr.String())
	}
	if !strings.Contains(stdout.String(), "Administrator account created.") || strings.Contains(stdout.String(), "synthetic-stdin-password") {
		t.Fatalf("output = %s", stdout.String())
	}
	if _, err := store.Authenticate(context.Background(), "root", "synthetic-stdin-password", time.Now()); err != nil {
		t.Fatalf("stdin password rejected: %v", err)
	}
}

func TestAdminResetPasswordDoesNotCreateMissingDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "missing", "kikoto.db")
	t.Setenv("KIKOTO_MODE", "production")
	t.Setenv("KIKOTO_DB_PATH", path)
	t.Setenv("KIKOTO_ROOT_PASSWORD_RESET", "")
	var stdout, stderr bytes.Buffer
	if code := runAdminCommand([]string{"reset-password"}, strings.NewReader(""), &stdout, &stderr); code != 1 {
		t.Fatalf("exit code = %d, want 1", code)
	}
	if !strings.Contains(stderr.String(), "start Kikoto once first") {
		t.Fatalf("stderr = %s", stderr.String())
	}
	if _, err := os.Stat(filepath.Dir(path)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("missing database directory stat = %v, want still missing", err)
	}
}

func TestAdminResetPasswordRefusesEnvironmentManagedAccount(t *testing.T) {
	_, store := migratedCommandTestDatabase(t)
	if _, err := store.SyncEnvironmentAdministrator(context.Background(), "root", "synthetic-env-password"); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KIKOTO_ROOT_ACCOUNT_MODE", "environment")
	t.Setenv("KIKOTO_ROOT_PASSWORD", "synthetic-env-password")
	var stdout, stderr bytes.Buffer
	if code := runAdminCommand([]string{"reset-password"}, strings.NewReader(""), &stdout, &stderr); code != 1 {
		t.Fatalf("exit code = %d, want 1; stdout = %s", code, stdout.String())
	}
	if !strings.Contains(stderr.String(), "KIKOTO_ROOT_ACCOUNT_MODE=environment") {
		t.Fatalf("stderr = %s", stderr.String())
	}
	if _, err := store.Authenticate(context.Background(), "root", "synthetic-env-password", time.Now()); err != nil {
		t.Fatalf("refused reset changed the managed password: %v", err)
	}

	root, err := store.LoadByUsername(context.Background(), "root")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.CreateManagedUser(context.Background(), account.CreateUserInput{
		Username: "synthetic-other", DisplayName: "synthetic-other", Role: "super_admin", Password: "synthetic-password", Enabled: true, ActorUserID: root.ID,
	}); err != nil {
		t.Fatal(err)
	}
	stdout.Reset()
	stderr.Reset()
	if code := runAdminCommand([]string{"reset-password", "--username", "synthetic-other"}, strings.NewReader(""), &stdout, &stderr); code != 0 {
		t.Fatalf("other account exit code = %d, stderr = %s", code, stderr.String())
	}
}
