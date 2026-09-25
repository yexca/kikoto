package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"strings"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storage"
)

const adminUsage = `Usage: kikoto admin reset-password [--username NAME] [--password-stdin]

Resets an administrator password from the host. The account becomes an enabled
super administrator and its sessions are signed out. Without --username the
initial administrator is used; when it no longer exists, --username is
required. Only root is created when missing, so an instance without any
administrator can be recovered with --username root.

A random password is generated and printed unless --password-stdin reads one
line from standard input. With KIKOTO_ROOT_ACCOUNT_MODE=environment the
environment-managed account is refused; change KIKOTO_ROOT_PASSWORD instead.
`

// runAdminCommand handles `kikoto admin ...`. It works on the configured
// database while the server runs; it never migrates or creates a database.
func runAdminCommand(args []string, stdin io.Reader, stdout io.Writer, stderr io.Writer) int {
	if len(args) == 0 || args[0] != "reset-password" {
		_, _ = fmt.Fprint(stderr, adminUsage)
		return 2
	}
	flags := flag.NewFlagSet("kikoto admin reset-password", flag.ContinueOnError)
	flags.SetOutput(stderr)
	flags.Usage = func() { _, _ = fmt.Fprint(stderr, adminUsage) }
	username := flags.String("username", "", "administrator username")
	passwordStdin := flags.Bool("password-stdin", false, "read the new password from standard input")
	if err := flags.Parse(args[1:]); err != nil {
		return 2
	}
	if flags.NArg() != 0 {
		flags.Usage()
		return 2
	}
	cfg, err := config.Load()
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "load configuration:", err)
		return 1
	}
	password, generated, err := resetPasswordInput(*passwordStdin, stdin)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, err)
		return 1
	}
	result, err := resetAdministratorPassword(context.Background(), cfg, *username, password)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "reset administrator password:", err)
		return 1
	}
	var report strings.Builder
	if result.Created {
		report.WriteString("Administrator account created.\n")
	} else {
		report.WriteString("Administrator password reset.\n")
	}
	fmt.Fprintf(&report, "Username: %s\n", result.Username)
	if generated {
		fmt.Fprintf(&report, "Password: %s\n", password)
	}
	report.WriteString("Existing sessions for this account were signed out. Sign in and change the password under Settings.\n")
	if _, err := io.WriteString(stdout, report.String()); err != nil {
		return 1
	}
	return 0
}

func resetPasswordInput(fromStdin bool, stdin io.Reader) (string, bool, error) {
	if !fromStdin {
		raw := make([]byte, 18)
		if _, err := rand.Read(raw); err != nil {
			return "", false, err
		}
		return base64.RawURLEncoding.EncodeToString(raw), true, nil
	}
	line, err := bufio.NewReader(stdin).ReadString('\n')
	if err != nil && !errors.Is(err, io.EOF) {
		return "", false, fmt.Errorf("read password: %w", err)
	}
	password := strings.TrimRight(line, "\r\n")
	if err := account.ValidateNewPassword(password); err != nil {
		return "", false, err
	}
	return password, false, nil
}

func resetAdministratorPassword(ctx context.Context, cfg config.Config, explicitUsername string, password string) (account.RecoveryResult, error) {
	databasePath := strings.TrimSpace(cfg.DatabasePath)
	if databasePath != ":memory:" && !strings.HasPrefix(databasePath, "file:") {
		if _, err := os.Stat(databasePath); errors.Is(err, fs.ErrNotExist) {
			return account.RecoveryResult{}, fmt.Errorf("database %s does not exist; start Kikoto once first", databasePath)
		} else if err != nil {
			return account.RecoveryResult{}, err
		}
	}
	db, err := storage.Open(databasePath)
	if err != nil {
		return account.RecoveryResult{}, err
	}
	defer func() { _ = db.Close() }()
	store := account.NewStore(db)
	if strings.TrimSpace(explicitUsername) == "" {
		explicitUsername = cfg.RootUsername
	}
	username, err := store.RecoveryUsername(ctx, explicitUsername)
	var target *account.RecoveryTargetRequiredError
	if errors.As(err, &target) {
		return account.RecoveryResult{}, fmt.Errorf("%w; pass --username", err)
	}
	if err != nil {
		return account.RecoveryResult{}, err
	}
	if managed := cfg.EnvironmentManagedUsername(); managed != "" && username == managed {
		// The next start would overwrite the reset with the environment value.
		return account.RecoveryResult{}, fmt.Errorf("%s is managed by KIKOTO_ROOT_PASSWORD because KIKOTO_ROOT_ACCOUNT_MODE=environment; change KIKOTO_ROOT_PASSWORD and recreate the service, or pass --username for another account", username)
	}
	return store.RecoverAdministrator(ctx, username, password, account.RecoverySourceCommand)
}
