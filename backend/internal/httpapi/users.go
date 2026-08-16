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
	payload, err := decodeUpdateUserPayload(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	update, err := normalizeUpdateUserInput(current, payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := account.ValidateUserWrite(actor, update.Role, update.Password, false); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if current.Role == "super_admin" && (!update.Enabled || update.Role != "super_admin") {
		if err := s.accountStore.EnsureAnotherEnabledSuperAdmin(r.Context(), userID); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
	}
	updated, err := s.accountStore.UpdateManagedUser(r.Context(), account.UpdateUserInput{
		ID: userID, DisplayName: update.DisplayName, Role: update.Role, Password: update.Password,
		Enabled: update.Enabled, ActorUserID: actor.ID,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

type updateUserPayload struct {
	DisplayName *string `json:"displayName"`
	Role        *string `json:"role"`
	Password    *string `json:"password"`
	Enabled     *bool   `json:"enabled"`
}

type normalizedUpdateUserInput struct {
	DisplayName string
	Role        string
	Password    string
	Enabled     bool
}

func decodeUpdateUserPayload(r *http.Request) (updateUserPayload, error) {
	var payload updateUserPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return updateUserPayload{}, errors.New("invalid JSON body")
	}
	return payload, nil
}

func normalizeUpdateUserInput(current account.ManagedUser, payload updateUserPayload) (normalizedUpdateUserInput, error) {
	input := normalizedUpdateUserInput{DisplayName: current.DisplayName, Role: current.Role, Enabled: current.Enabled}
	if payload.DisplayName != nil {
		input.DisplayName = strings.TrimSpace(*payload.DisplayName)
		if input.DisplayName == "" {
			input.DisplayName = current.Username
		}
	}
	if payload.Role != nil {
		input.Role = strings.TrimSpace(*payload.Role)
	}
	if payload.Password != nil {
		input.Password = *payload.Password
	}
	if payload.Enabled != nil {
		input.Enabled = *payload.Enabled
	}
	return input, nil
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
