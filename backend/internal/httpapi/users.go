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
	for index := range users {
		users[index] = s.withEnvironmentManagement(users[index])
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) withEnvironmentManagement(user account.ManagedUser) account.ManagedUser {
	user.EnvironmentManaged = s.isEnvironmentManagedUsername(user.Username)
	return user
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
	writeJSON(w, http.StatusCreated, s.withEnvironmentManagement(user))
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
	payload, err := decodeUpdateUserPayload(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	updated, err := s.accountStore.PatchManagedUser(r.Context(), userID, account.ManagedUserPatch{
		DisplayName: payload.DisplayName, Role: payload.Role, Password: payload.Password, Enabled: payload.Enabled,
	}, account.ManagedUserPolicy{
		ActorUserID: actor.ID, EnvironmentManagedUsername: s.cfg.EnvironmentManagedUsername(),
	})
	if err != nil {
		writeManagedUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, s.withEnvironmentManagement(updated))
}

type updateUserPayload struct {
	DisplayName *string `json:"displayName"`
	Role        *string `json:"role"`
	Password    *string `json:"password"`
	Enabled     *bool   `json:"enabled"`
}

func decodeUpdateUserPayload(r *http.Request) (updateUserPayload, error) {
	var payload updateUserPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return updateUserPayload{}, errors.New("invalid JSON body")
	}
	return payload, nil
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
	if err := s.accountStore.DeleteManagedUserWithPolicy(r.Context(), userID, account.ManagedUserPolicy{
		ActorUserID: actor.ID, EnvironmentManagedUsername: s.cfg.EnvironmentManagedUsername(),
	}); err != nil {
		writeManagedUserError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func writeManagedUserError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "user not found"})
	case errors.Is(err, account.ErrEnvironmentManaged), errors.Is(err, account.ErrManagedUserForbidden):
		writeJSON(w, http.StatusForbidden, map[string]string{"error": err.Error()})
	case errors.Is(err, account.ErrLastSuperAdmin), errors.Is(err, account.ErrDeleteOwnAccount),
		errors.Is(err, account.ErrPasswordTooShort), errors.Is(err, account.ErrPasswordRequired),
		errors.Is(err, account.ErrPlaceholderPassword), errors.Is(err, account.ErrInvalidUserRole), errors.Is(err, account.ErrGrantSuperAdmin):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
	default:
		writeError(w, err)
	}
}
