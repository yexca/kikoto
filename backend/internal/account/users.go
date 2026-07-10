package account

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

type ManagedUser struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Enabled     bool   `json:"enabled"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

type CreateUserInput struct {
	Username    string
	DisplayName string
	Role        string
	Password    string
	Enabled     bool
	ActorUserID int64
}

type UpdateUserInput struct {
	ID          int64
	DisplayName string
	Role        string
	Password    string
	Enabled     bool
	ActorUserID int64
}

var ErrUsernameExists = errors.New("username already exists")

func (s *Store) ListManagedUsers(ctx context.Context) ([]ManagedUser, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, username, display_name, role, enabled, created_at, updated_at
		FROM user_account
		ORDER BY CASE role WHEN 'super_admin' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END, username ASC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	users := []ManagedUser{}
	for rows.Next() {
		var user ManagedUser
		if err := rows.Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role, &user.Enabled, &user.CreatedAt, &user.UpdatedAt); err != nil {
			return nil, err
		}
		users = append(users, user)
	}
	return users, rows.Err()
}

func (s *Store) LoadManagedUser(ctx context.Context, id int64) (ManagedUser, error) {
	var user ManagedUser
	err := s.db.QueryRowContext(ctx, `SELECT id, username, display_name, role, enabled, created_at, updated_at FROM user_account WHERE id = ?`, id).
		Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role, &user.Enabled, &user.CreatedAt, &user.UpdatedAt)
	return user, err
}

func (s *Store) CreateManagedUser(ctx context.Context, input CreateUserInput) (ManagedUser, error) {
	passwordHash, err := HashPassword(input.Password)
	if err != nil {
		return ManagedUser{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ManagedUser{}, err
	}
	defer tx.Rollback()
	result, err := tx.ExecContext(ctx, `INSERT INTO user_account (username, display_name, role, enabled) VALUES (?, ?, ?, ?)`, input.Username, input.DisplayName, input.Role, input.Enabled)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique constraint failed") {
			return ManagedUser{}, ErrUsernameExists
		}
		return ManagedUser{}, err
	}
	userID, err := result.LastInsertId()
	if err != nil {
		return ManagedUser{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_password_credential (user_id, password_hash) VALUES (?, ?)`, userID, passwordHash); err != nil {
		return ManagedUser{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO favorite_list (user_id, name, sort_order) VALUES (?, 'Favorites', 0)`, userID); err != nil {
		return ManagedUser{}, err
	}
	if err := insertAuditLog(ctx, tx, input.ActorUserID, "user.create", userID); err != nil {
		return ManagedUser{}, err
	}
	if err := tx.Commit(); err != nil {
		return ManagedUser{}, err
	}
	return s.LoadManagedUser(ctx, userID)
}

func (s *Store) UpdateManagedUser(ctx context.Context, input UpdateUserInput) (ManagedUser, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return ManagedUser{}, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `UPDATE user_account SET display_name = ?, role = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, input.DisplayName, input.Role, input.Enabled, input.ID); err != nil {
		return ManagedUser{}, err
	}
	if input.Password != "" {
		passwordHash, err := HashPassword(input.Password)
		if err != nil {
			return ManagedUser{}, err
		}
		if _, err := tx.ExecContext(ctx, `UPDATE user_password_credential SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, passwordHash, input.ID); err != nil {
			return ManagedUser{}, err
		}
	}
	if err := insertAuditLog(ctx, tx, input.ActorUserID, "user.update", input.ID); err != nil {
		return ManagedUser{}, err
	}
	if err := tx.Commit(); err != nil {
		return ManagedUser{}, err
	}
	return s.LoadManagedUser(ctx, input.ID)
}

func (s *Store) DeleteManagedUser(ctx context.Context, actorUserID int64, userID int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_account WHERE id = ?", userID); err != nil {
		return err
	}
	if err := insertAuditLog(ctx, tx, actorUserID, "user.delete", userID); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) EnsureAnotherEnabledSuperAdmin(ctx context.Context, userID int64) error {
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM user_account WHERE role = 'super_admin' AND enabled = 1 AND id != ?`, userID).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return errors.New("at least one enabled super administrator is required")
	}
	return nil
}

func ValidateUserWrite(actor User, role string, password string, passwordRequired bool) error {
	switch role {
	case "super_admin":
		if actor.Role != "super_admin" {
			return errors.New("only super administrators can grant the super administrator role")
		}
	case "admin", "user":
	default:
		return errors.New("role must be super_admin, admin, or user")
	}
	if passwordRequired && strings.TrimSpace(password) == "" {
		return errors.New("password is required")
	}
	if password != "" && len(password) < 8 {
		return errors.New("password must be at least 8 characters")
	}
	return nil
}

func insertAuditLog(ctx context.Context, tx *sql.Tx, actorUserID int64, action string, targetID int64) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO audit_log (actor_user_id, action, target_type, target_id) VALUES (?, ?, 'user', ?)`, actorUserID, action, fmt.Sprintf("%d", targetID))
	return err
}
