package httpapi

import (
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/account"
)

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
	if s.cfg.IsDemo() {
		users = append(users, demoSampleUsers...)
	}
	writeJSON(w, http.StatusOK, users)
}

// demoSampleUsers fill Demo's Users tab, which otherwise lists only the Demo
// account, with one account of each role and a disabled one. They exist only
// in this list; Demo refuses every change to them.
var demoSampleUsers = []account.ManagedUser{
	{ID: 900001, Username: "example-owner", DisplayName: "Example owner", Role: "super_admin", Enabled: true, CreatedAt: "2026-01-05 09:00:00", UpdatedAt: "2026-01-05 09:00:00"},
	{ID: 900002, Username: "example-admin", DisplayName: "Example administrator", Role: "admin", Enabled: true, CreatedAt: "2026-02-11 18:30:00", UpdatedAt: "2026-03-02 21:15:00"},
	{ID: 900003, Username: "example-listener", DisplayName: "Example listener", Role: "user", Enabled: true, CreatedAt: "2026-04-20 12:00:00", UpdatedAt: "2026-04-20 12:00:00"},
	{ID: 900004, Username: "example-guest", DisplayName: "Example former guest", Role: "user", Enabled: false, CreatedAt: "2026-05-01 08:45:00", UpdatedAt: "2026-06-14 10:10:00"},
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", false)
		return
	}
	username := strings.TrimSpace(payload.Username)
	displayName := strings.TrimSpace(payload.DisplayName)
	role := strings.TrimSpace(payload.Role)
	if displayName == "" {
		displayName = username
	}
	if err := account.ValidateUserWrite(actor, role, payload.Password, true); err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
		return
	}
	if username == "" {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "username is required", false)
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
		writeAPIError(w, http.StatusConflict, "conflict", "username already exists", false)
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid user id", false)
		return
	}
	payload, err := decodeUpdateUserPayload(r)
	if err != nil {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid user id", false)
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
		writeAPIError(w, http.StatusNotFound, "not_found", "user not found", false)
	case errors.Is(err, account.ErrEnvironmentManaged), errors.Is(err, account.ErrManagedUserForbidden):
		writeAPIError(w, http.StatusForbidden, "permission_denied", err.Error(), false)
	case errors.Is(err, account.ErrLastSuperAdmin), errors.Is(err, account.ErrDeleteOwnAccount),
		errors.Is(err, account.ErrPasswordTooShort), errors.Is(err, account.ErrPasswordRequired),
		errors.Is(err, account.ErrPlaceholderPassword), errors.Is(err, account.ErrInvalidUserRole), errors.Is(err, account.ErrGrantSuperAdmin):
		writeAPIError(w, http.StatusBadRequest, "invalid_request", err.Error(), false)
	default:
		writeError(w, err)
	}
}
