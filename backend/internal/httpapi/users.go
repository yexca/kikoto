package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/account"
)

type userResponse = account.ManagedUser

func (s *Server) listUsers(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "users:manage"); !ok {
		return
	}
	users, err := s.accountStore.ListManagedUsers(r.Context())
	if err != nil {
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
	if err := account.ValidateUserWrite(actor, role, payload.Password, true); err != nil {
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
	user, err := s.accountStore.CreateManagedUser(r.Context(), account.CreateUserInput{
		Username: username, DisplayName: displayName, Role: role, Password: payload.Password,
		Enabled: enabled, ActorUserID: actor.ID,
	})
	if errors.Is(err, account.ErrUsernameExists) {
		writeJSON(w, http.StatusConflict, map[string]string{"error": "username already exists"})
		return
	}
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
	current, err := s.accountStore.LoadManagedUser(r.Context(), userID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}
	if err != nil {
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
	if err := account.ValidateUserWrite(actor, role, password, false); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	enabled := current.Enabled
	if payload.Enabled != nil {
		enabled = *payload.Enabled
	}
	if current.Role == "super_admin" && (!enabled || role != "super_admin") {
		if err := s.accountStore.EnsureAnotherEnabledSuperAdmin(r.Context(), userID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	updated, err := s.accountStore.UpdateManagedUser(r.Context(), account.UpdateUserInput{
		ID: userID, DisplayName: displayName, Role: role, Password: password,
		Enabled: enabled, ActorUserID: actor.ID,
	})
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
	target, err := s.accountStore.LoadManagedUser(r.Context(), userID)
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
		return
	}
	if err != nil {
		writeError(w, err)
		return
	}
	if target.Role == "super_admin" {
		if actor.Role != "super_admin" {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "only super administrators can delete super administrator accounts"})
			return
		}
		if err := s.accountStore.EnsureAnotherEnabledSuperAdmin(r.Context(), userID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	if err := s.accountStore.DeleteManagedUser(r.Context(), actor.ID, userID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
