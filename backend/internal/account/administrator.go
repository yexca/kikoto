package account

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
)

// A production instance has no administrator until the operator claims it
// with the one-time setup token. An operator who is locked out recovers
// through the host instead of the network: the reset command inside the
// container, or the one-shot environment reset applied at startup.

const (
	DefaultAdministratorUsername = "root"
	MinPasswordLength            = 8

	RecoverySourceCommand     = "command"
	RecoverySourceEnvironment = "environment"

	initialAdministratorSettingKey = "initial_administrator_user_id"
	environmentRecoverySettingKey  = "environment_password_recovery"
)

var (
	ErrSetupComplete       = errors.New("initial setup is already complete")
	ErrUsernameRequired    = errors.New("username is required")
	ErrReservedUsername    = errors.New("username is reserved")
	ErrPasswordRequired    = errors.New("password is required")
	ErrPasswordTooShort    = errors.New("password must be at least 8 characters")
	ErrPlaceholderPassword = errors.New("password must not be a documentation placeholder")
	// ErrRecoveryAccountNotFound keeps a mistyped username from creating a new
	// super administrator; only the default username is created when missing.
	ErrRecoveryAccountNotFound = errors.New("account does not exist; only root is created when missing")
)

// RecoveryTargetRequiredError reports that no initial administrator is
// recorded, so a recovery must name its account instead of guessing one.
type RecoveryTargetRequiredError struct {
	SuperAdministrators []string
}

func (e *RecoveryTargetRequiredError) Error() string {
	message := "no initial administrator is recorded; name the account to reset, or name root to create it when missing"
	if len(e.SuperAdministrators) > 0 {
		message += " (super administrators: " + strings.Join(e.SuperAdministrators, ", ") + ")"
	}
	return message
}

// placeholderPasswords are values that have appeared in published examples.
// Accepting one would let a copied example become a working credential.
var placeholderPasswords = []string{"change-me", "replace-with-a-long-random-password"}

// ValidateNewPassword applies the policy for every newly set password.
func ValidateNewPassword(password string) error {
	if strings.TrimSpace(password) == "" {
		return ErrPasswordRequired
	}
	if len(password) < MinPasswordLength {
		return ErrPasswordTooShort
	}
	for _, placeholder := range placeholderPasswords {
		if strings.EqualFold(strings.TrimSpace(password), placeholder) {
			return ErrPlaceholderPassword
		}
	}
	return nil
}

func validateAdministratorUsername(username string) error {
	if username == "" {
		return ErrUsernameRequired
	}
	if username == DemoUsername {
		return ErrReservedUsername
	}
	return nil
}

type RecoveryResult struct {
	UserID   int64
	Username string
	Created  bool
}

type rowQueryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// InitialSetupRequired reports whether no enabled super administrator can sign
// in with a password yet.
func (s *Store) InitialSetupRequired(ctx context.Context) (bool, error) {
	return initialSetupRequired(ctx, s.db)
}

func initialSetupRequired(ctx context.Context, queryer rowQueryer) (bool, error) {
	var exists bool
	err := queryer.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM user_account AS account
			INNER JOIN user_password_credential AS credential ON credential.user_id = account.id
			WHERE account.role = 'super_admin' AND account.enabled = 1
		)
	`).Scan(&exists)
	return !exists, err
}

// CreateInitialAdministrator creates the first super administrator. It fails
// with ErrSetupComplete once any enabled super administrator has a password, so
// a second setup request cannot claim the instance. A passwordless account with
// the same username, such as the development identity, is claimed in place.
func (s *Store) CreateInitialAdministrator(ctx context.Context, username string, password string) (User, error) {
	username = strings.TrimSpace(username)
	if err := validateAdministratorUsername(username); err != nil {
		return User{}, err
	}
	if err := ValidateNewPassword(password); err != nil {
		return User{}, err
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return User{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer func() { _ = tx.Rollback() }()
	required, err := initialSetupRequired(ctx, tx)
	if err != nil {
		return User{}, err
	}
	if !required {
		return User{}, ErrSetupComplete
	}
	var existingCredentials int
	if err := tx.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM user_account AS account
		INNER JOIN user_password_credential AS credential ON credential.user_id = account.id
		WHERE account.username = ?
	`, username).Scan(&existingCredentials); err != nil {
		return User{}, err
	}
	if existingCredentials != 0 {
		return User{}, ErrUsernameExists
	}
	userID, _, err := ensureAdministratorAccount(ctx, tx, username)
	if err != nil {
		return User{}, err
	}
	if err := replaceCredential(ctx, tx, userID, passwordHash); err != nil {
		return User{}, err
	}
	if err := upsertAccountSetting(ctx, tx, initialAdministratorSettingKey, userID); err != nil {
		return User{}, err
	}
	if err := insertAuditLogDetail(ctx, tx, userID, "user.initial_setup", userID, nil); err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	return s.LoadByID(ctx, userID)
}

// SyncEnvironmentAdministrator makes username an enabled super administrator
// whose password is the environment value. A changed value replaces the stored
// credential and revokes the account's sessions; an unchanged value only moves
// a legacy hash to the current parameters. changed reports a replacement.
func (s *Store) SyncEnvironmentAdministrator(ctx context.Context, username string, password string) (changed bool, err error) {
	username = strings.TrimSpace(username)
	if err := validateAdministratorUsername(username); err != nil {
		return false, err
	}
	if err := ValidateNewPassword(password); err != nil {
		return false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer func() { _ = tx.Rollback() }()
	userID, _, err := ensureAdministratorAccount(ctx, tx, username)
	if err != nil {
		return false, err
	}
	if err := recordInitialAdministratorIfMissing(ctx, tx, userID); err != nil {
		return false, err
	}
	var current string
	err = tx.QueryRowContext(ctx, "SELECT password_hash FROM user_password_credential WHERE user_id = ?", userID).Scan(&current)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	matched := err == nil && VerifyPassword(password, current)
	if matched && !passwordNeedsRehash(current) {
		return false, tx.Commit()
	}
	hash, err := HashPassword(password)
	if err != nil {
		return false, err
	}
	if err := replaceCredential(ctx, tx, userID, hash); err != nil {
		return false, err
	}
	if !matched {
		if _, err := tx.ExecContext(ctx, "DELETE FROM user_session WHERE user_id = ?", userID); err != nil {
			return false, err
		}
		if err := insertAuditLogDetail(ctx, tx, 0, "user.environment_sync", userID, nil); err != nil {
			return false, err
		}
	}
	return !matched, tx.Commit()
}

// EnsureDevelopmentAdministrator keeps the identity that development mode
// authenticates every request as. It never sets or changes a password.
func (s *Store) EnsureDevelopmentAdministrator(ctx context.Context, username string) error {
	username = strings.TrimSpace(username)
	if err := validateAdministratorUsername(username); err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, _, err := ensureAdministratorAccount(ctx, tx, username); err != nil {
		return err
	}
	return tx.Commit()
}

// RecoveryUsername resolves the account a host-side recovery targets: the
// explicit username, else the recorded initial administrator while it exists.
// Otherwise it returns a RecoveryTargetRequiredError listing the super
// administrators rather than choosing one.
func (s *Store) RecoveryUsername(ctx context.Context, explicit string) (string, error) {
	if explicit = strings.TrimSpace(explicit); explicit != "" {
		return explicit, nil
	}
	var raw string
	err := s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", initialAdministratorSettingKey).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	if err == nil {
		var username string
		if userID, parseErr := strconv.ParseInt(strings.TrimSpace(raw), 10, 64); parseErr == nil {
			err = s.db.QueryRowContext(ctx, "SELECT username FROM user_account WHERE id = ?", userID).Scan(&username)
			if err == nil {
				return username, nil
			}
			if !errors.Is(err, sql.ErrNoRows) {
				return "", err
			}
		}
	}
	rows, err := s.db.QueryContext(ctx, "SELECT username FROM user_account WHERE role = 'super_admin' ORDER BY username")
	if err != nil {
		return "", err
	}
	defer func() { _ = rows.Close() }()
	target := &RecoveryTargetRequiredError{}
	for rows.Next() {
		var username string
		if err := rows.Scan(&username); err != nil {
			return "", err
		}
		target.SuperAdministrators = append(target.SuperAdministrators, username)
	}
	if err := rows.Err(); err != nil {
		return "", err
	}
	return "", target
}

// RecoverAdministrator makes an existing account an enabled super
// administrator with a new password and revokes its sessions. Only the default
// username is created when missing, so an instance without any administrator
// can still be recovered. It is only reachable from the host.
func (s *Store) RecoverAdministrator(ctx context.Context, username string, password string, source string) (RecoveryResult, error) {
	username = strings.TrimSpace(username)
	if err := validateAdministratorUsername(username); err != nil {
		return RecoveryResult{}, err
	}
	if err := ValidateNewPassword(password); err != nil {
		return RecoveryResult{}, err
	}
	passwordHash, err := HashPassword(password)
	if err != nil {
		return RecoveryResult{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RecoveryResult{}, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err := recoverAdministrator(ctx, tx, username, passwordHash, source)
	if err != nil {
		return RecoveryResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return RecoveryResult{}, err
	}
	return result, nil
}

type environmentRecoveryRecord struct {
	Username     string `json:"username"`
	PasswordHash string `json:"passwordHash"`
}

// ApplyEnvironmentRecovery applies the environment reset once per distinct
// username and password. Restarting with the same values leaves the account
// alone, so a password changed in the app after the reset survives a reset
// flag that was left enabled. applied is false when the values were already
// used.
func (s *Store) ApplyEnvironmentRecovery(ctx context.Context, explicitUsername string, password string) (result RecoveryResult, applied bool, err error) {
	if err := ValidateNewPassword(password); err != nil {
		return RecoveryResult{}, false, err
	}
	username, err := s.RecoveryUsername(ctx, explicitUsername)
	if err != nil {
		return RecoveryResult{}, false, err
	}
	if err := validateAdministratorUsername(username); err != nil {
		return RecoveryResult{}, false, err
	}
	var raw string
	err = s.db.QueryRowContext(ctx, "SELECT value_json FROM app_setting WHERE key = ?", environmentRecoverySettingKey).Scan(&raw)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return RecoveryResult{}, false, err
	}
	if err == nil {
		var previous environmentRecoveryRecord
		if json.Unmarshal([]byte(raw), &previous) == nil && previous.Username == username && VerifyPassword(password, previous.PasswordHash) {
			return RecoveryResult{Username: username}, false, nil
		}
	}
	hash, err := HashPassword(password)
	if err != nil {
		return RecoveryResult{}, false, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return RecoveryResult{}, false, err
	}
	defer func() { _ = tx.Rollback() }()
	result, err = recoverAdministrator(ctx, tx, username, hash, RecoverySourceEnvironment)
	if err != nil {
		return RecoveryResult{}, false, err
	}
	if err := upsertAccountSetting(ctx, tx, environmentRecoverySettingKey, environmentRecoveryRecord{Username: username, PasswordHash: hash}); err != nil {
		return RecoveryResult{}, false, err
	}
	if err := tx.Commit(); err != nil {
		return RecoveryResult{}, false, err
	}
	return result, true, nil
}

func recoverAdministrator(ctx context.Context, tx *sql.Tx, username string, passwordHash string, source string) (RecoveryResult, error) {
	if username != DefaultAdministratorUsername {
		var exists bool
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM user_account WHERE username = ?)", username).Scan(&exists); err != nil {
			return RecoveryResult{}, err
		}
		if !exists {
			return RecoveryResult{}, ErrRecoveryAccountNotFound
		}
	}
	userID, created, err := ensureAdministratorAccount(ctx, tx, username)
	if err != nil {
		return RecoveryResult{}, err
	}
	if err := replaceCredential(ctx, tx, userID, passwordHash); err != nil {
		return RecoveryResult{}, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_session WHERE user_id = ?", userID); err != nil {
		return RecoveryResult{}, err
	}
	if err := recordInitialAdministratorIfMissing(ctx, tx, userID); err != nil {
		return RecoveryResult{}, err
	}
	detail := map[string]any{"source": source, "created": created}
	if err := insertAuditLogDetail(ctx, tx, 0, "user.recover", userID, detail); err != nil {
		return RecoveryResult{}, err
	}
	return RecoveryResult{UserID: userID, Username: username, Created: created}, nil
}

// recordInitialAdministratorIfMissing makes userID the default recovery target
// when no existing account is recorded, including after the recorded initial
// administrator was deleted.
func recordInitialAdministratorIfMissing(ctx context.Context, tx *sql.Tx, userID int64) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO app_setting (key, value_json)
		SELECT ?, ?
		WHERE NOT EXISTS (
			SELECT 1
			FROM app_setting AS setting
			INNER JOIN user_account AS account ON CAST(setting.value_json AS INTEGER) = account.id
			WHERE setting.key = ?
		)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
	`, initialAdministratorSettingKey, strconv.FormatInt(userID, 10), initialAdministratorSettingKey)
	return err
}

// ensureAdministratorAccount creates username as an enabled super
// administrator or restores an existing account to that role and state.
func ensureAdministratorAccount(ctx context.Context, tx *sql.Tx, username string) (int64, bool, error) {
	var userID int64
	err := tx.QueryRowContext(ctx, "SELECT id FROM user_account WHERE username = ?", username).Scan(&userID)
	created := errors.Is(err, sql.ErrNoRows)
	switch {
	case created:
		result, insertErr := tx.ExecContext(ctx, `
			INSERT INTO user_account (username, display_name, role, enabled)
			VALUES (?, ?, 'super_admin', 1)
		`, username, username)
		if insertErr != nil {
			return 0, false, insertErr
		}
		if userID, err = result.LastInsertId(); err != nil {
			return 0, false, err
		}
	case err != nil:
		return 0, false, err
	default:
		if _, err := tx.ExecContext(ctx, `
			UPDATE user_account
			SET role = 'super_admin', enabled = 1, updated_at = CURRENT_TIMESTAMP
			WHERE id = ? AND (role <> 'super_admin' OR enabled <> 1)
		`, userID); err != nil {
			return 0, false, err
		}
	}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO favorite_list (user_id, name, sort_order, kind) VALUES (?, '', -1, 'marked')", userID); err != nil {
		return 0, false, err
	}
	return userID, created, nil
}

func replaceCredential(ctx context.Context, tx *sql.Tx, userID int64, passwordHash string) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO user_password_credential (user_id, password_hash)
		VALUES (?, ?)
		ON CONFLICT(user_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = CURRENT_TIMESTAMP
	`, userID, passwordHash)
	return err
}

func upsertAccountSetting(ctx context.Context, tx *sql.Tx, key string, value any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO app_setting (key, value_json)
		VALUES (?, ?)
		ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = CURRENT_TIMESTAMP
	`, key, string(encoded))
	return err
}
