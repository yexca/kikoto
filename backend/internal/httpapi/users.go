package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
)

type userResponse struct {
	ID          int64  `json:"id"`
	Username    string `json:"username"`
	DisplayName string `json:"displayName"`
	Role        string `json:"role"`
	Enabled     bool   `json:"enabled"`
	CreatedAt   string `json:"createdAt"`
	UpdatedAt   string `json:"updatedAt"`
}

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "users:manage"); !ok {
		return
	}

	rows, err := s.db.QueryContext(r.Context(), `
		SELECT id, username, display_name, role, enabled, created_at, updated_at
		FROM user_account
		ORDER BY
			CASE role
				WHEN 'super_admin' THEN 1
				WHEN 'admin' THEN 2
				ELSE 3
			END,
			username ASC
	`)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()

	users := []userResponse{}
	for rows.Next() {
		var user userResponse
		if err := rows.Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role, &user.Enabled, &user.CreatedAt, &user.UpdatedAt); err != nil {
			writeError(w, err)
			return
		}
		users = append(users, user)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}

	writeJSON(w, http.StatusOK, users)
}

func (s *Server) createUser(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "users:manage")
	if !ok {
		return
	}

	var payload struct {
		Username    string `json:"username"`
		DisplayName string `json:"displayName"`
		Role        string `json:"role"`
		Password    string `json:"password"`
		Enabled     *bool  `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}

	username := strings.TrimSpace(payload.Username)
	displayName := strings.TrimSpace(payload.DisplayName)
	role := strings.TrimSpace(payload.Role)
	if displayName == "" {
		displayName = username
	}
	if err := validateUserWrite(actor, role, payload.Password, true); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if username == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "username is required"})
		return
	}

	enabled := true
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	passwordHash, err := hashPassword(payload.Password)
	if err != nil {
		writeError(w, err)
		return
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() {
		_ = tx.Rollback()
	}()

	userID, err := insertAndID(r.Context(), tx, `
		INSERT INTO user_account (username, display_name, role, enabled)
		VALUES (?, ?, ?, ?)
	`, username, displayName, role, enabled)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "username already exists"})
		return
	}

	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO user_password_credential (user_id, password_hash)
		VALUES (?, ?)
	`, userID, passwordHash); err != nil {
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO favorite_list (user_id, name, sort_order)
		VALUES (?, 'Favorites', 0)
	`, userID); err != nil {
		writeError(w, err)
		return
	}
	if err := insertAuditLog(r.Context(), tx, actor.ID, "user.create", "user", userID); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}

	user, err := s.loadUserResponse(r.Context(), userID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (s *Server) updateUser(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "users:manage")
	if !ok {
		return
	}
	userID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid user id"})
		return
	}

	current, err := s.loadUserResponse(r.Context(), userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
			return
		}
		writeError(w, err)
		return
	}
	if actor.Role != "super_admin" && current.Role == "super_admin" {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "only super administrators can modify super administrator accounts"})
		return
	}

	var payload struct {
		DisplayName *string `json:"displayName"`
		Role        *string `json:"role"`
		Password    *string `json:"password"`
		Enabled     *bool   `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}

	displayName := current.DisplayName
	if payload.DisplayName != nil {
		displayName = strings.TrimSpace(*payload.DisplayName)
		if displayName == "" {
			displayName = current.Username
		}
	}
	role := current.Role
	if payload.Role != nil {
		role = strings.TrimSpace(*payload.Role)
	}
	password := ""
	if payload.Password != nil {
		password = *payload.Password
	}
	if err := validateUserWrite(actor, role, password, false); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if payload.Enabled != nil && !*payload.Enabled && current.Role == "super_admin" {
		if err := s.ensureAnotherEnabledSuperAdmin(r.Context(), userID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	if current.Role == "super_admin" && role != "super_admin" {
		if err := s.ensureAnotherEnabledSuperAdmin(r.Context(), userID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	enabled := current.Enabled
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() {
		_ = tx.Rollback()
	}()

	if _, err := tx.ExecContext(r.Context(), `
		UPDATE user_account
		SET display_name = ?,
			role = ?,
			enabled = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE id = ?
	`, displayName, role, enabled, userID); err != nil {
		writeError(w, err)
		return
	}
	if password != "" {
		passwordHash, err := hashPassword(password)
		if err != nil {
			writeError(w, err)
			return
		}
		if _, err := tx.ExecContext(r.Context(), `
			UPDATE user_password_credential
			SET password_hash = ?,
				updated_at = CURRENT_TIMESTAMP
			WHERE user_id = ?
		`, passwordHash, userID); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := insertAuditLog(r.Context(), tx, actor.ID, "user.update", "user", userID); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}

	updated, err := s.loadUserResponse(r.Context(), userID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *Server) deleteUser(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "users:manage")
	if !ok {
		return
	}
	userID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid user id"})
		return
	}
	if actor.ID == userID {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "you cannot delete your own account"})
		return
	}

	target, err := s.loadUserResponse(r.Context(), userID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
			return
		}
		writeError(w, err)
		return
	}
	if target.Role == "super_admin" {
		if actor.Role != "super_admin" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only super administrators can delete super administrator accounts"})
			return
		}
		if err := s.ensureAnotherEnabledSuperAdmin(r.Context(), userID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}

	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() {
		_ = tx.Rollback()
	}()
	if _, err := tx.ExecContext(r.Context(), "DELETE FROM user_account WHERE id = ?", userID); err != nil {
		writeError(w, err)
		return
	}
	if err := insertAuditLog(r.Context(), tx, actor.ID, "user.delete", "user", userID); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) loadUserResponse(ctx context.Context, id int64) (userResponse, error) {
	var user userResponse
	err := s.db.QueryRowContext(ctx, `
		SELECT id, username, display_name, role, enabled, created_at, updated_at
		FROM user_account
		WHERE id = ?
	`, id).Scan(&user.ID, &user.Username, &user.DisplayName, &user.Role, &user.Enabled, &user.CreatedAt, &user.UpdatedAt)
	return user, err
}

func (s *Server) ensureAnotherEnabledSuperAdmin(ctx context.Context, userID int64) error {
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM user_account
		WHERE role = 'super_admin'
			AND enabled = 1
			AND id != ?
	`, userID).Scan(&count); err != nil {
		return err
	}
	if count == 0 {
		return errors.New("at least one enabled super administrator is required")
	}
	return nil
}

func validateUserWrite(actor currentUser, role string, password string, passwordRequired bool) error {
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

func insertAuditLog(ctx context.Context, tx *sql.Tx, actorUserID int64, action string, targetType string, targetID int64) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO audit_log (actor_user_id, action, target_type, target_id)
		VALUES (?, ?, ?, ?)
	`, actorUserID, action, targetType, fmt.Sprintf("%d", targetID))
	return err
}
