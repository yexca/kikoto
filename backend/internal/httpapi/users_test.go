package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

type userHandlerFixture struct {
	server *Server
	root   account.User
}

func newUserHandlerFixture(t *testing.T) userHandlerFixture {
	t.Helper()
	server := NewServer(openMigratedTestDB(t), config.Config{})
	if err := server.accountStore.BootstrapRoot(context.Background(), "root", "synthetic-password"); err != nil {
		t.Fatal(err)
	}
	root, err := server.accountStore.LoadByUsername(context.Background(), "root")
	if err != nil {
		t.Fatal(err)
	}
	return userHandlerFixture{server: server, root: root}
}

func userHandlerRequest(method, target, body string, actor account.User) *http.Request {
	request := httptest.NewRequest(method, target, strings.NewReader(body))
	return request.WithContext(context.WithValue(request.Context(), currentUserKey, actor))
}

func TestCreateUserEnforcesPermissionRoleAndPasswordRules(t *testing.T) {
	fixture := newUserHandlerFixture(t)
	tests := []struct {
		name       string
		actor      account.User
		body       string
		wantStatus int
	}{
		{
			name:       "missing permission",
			actor:      account.User{ID: fixture.root.ID, Role: "user", Permissions: []string{"library:read"}},
			body:       `{"username":"synthetic-user","role":"user","password":"synthetic-password"}`,
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "administrator grants super administrator",
			actor:      account.User{ID: fixture.root.ID, Role: "admin", Permissions: []string{"users:manage"}},
			body:       `{"username":"synthetic-user","role":"super_admin","password":"synthetic-password"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "unknown role",
			actor:      fixture.root,
			body:       `{"username":"synthetic-user","role":"owner","password":"synthetic-password"}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "missing password",
			actor:      fixture.root,
			body:       `{"username":"synthetic-user","role":"user","password":"   "}`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "short password",
			actor:      fixture.root,
			body:       `{"username":"synthetic-user","role":"user","password":"short"}`,
			wantStatus: http.StatusBadRequest,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := httptest.NewRecorder()
			fixture.server.createUser(response, userHandlerRequest(http.MethodPost, "/api/users", test.body, test.actor))
			if response.Code != test.wantStatus {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, test.wantStatus, response.Body.String())
			}
		})
	}

	var count int
	if err := fixture.server.db.QueryRow("SELECT COUNT(*) FROM user_account").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("invalid requests created users: count = %d, want 1", count)
	}
}

func TestUserHandlersManageLifecycleAndProtectSuperAdministrators(t *testing.T) {
	fixture := newUserHandlerFixture(t)
	createResponse := httptest.NewRecorder()
	fixture.server.createUser(createResponse, userHandlerRequest(
		http.MethodPost,
		"/api/users",
		`{"username":" synthetic-user ","displayName":" ","role":"user","password":"synthetic-password"}`,
		fixture.root,
	))
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createResponse.Code, createResponse.Body.String())
	}
	var created account.ManagedUser
	if err := json.NewDecoder(createResponse.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if created.Username != "synthetic-user" || created.DisplayName != "synthetic-user" || created.Role != "user" || !created.Enabled {
		t.Fatalf("created user = %#v", created)
	}

	duplicateResponse := httptest.NewRecorder()
	fixture.server.createUser(duplicateResponse, userHandlerRequest(
		http.MethodPost,
		"/api/users",
		`{"username":"synthetic-user","role":"user","password":"synthetic-password"}`,
		fixture.root,
	))
	if duplicateResponse.Code != http.StatusConflict {
		t.Fatalf("duplicate status = %d, body = %s", duplicateResponse.Code, duplicateResponse.Body.String())
	}

	listResponse := httptest.NewRecorder()
	fixture.server.listUsers(listResponse, userHandlerRequest(http.MethodGet, "/api/users", "", fixture.root))
	var users []account.ManagedUser
	if err := json.NewDecoder(listResponse.Body).Decode(&users); err != nil {
		t.Fatal(err)
	}
	if listResponse.Code != http.StatusOK || len(users) != 2 {
		t.Fatalf("list status = %d, users = %#v", listResponse.Code, users)
	}

	shortPasswordResponse := httptest.NewRecorder()
	shortPasswordRequest := userHandlerRequest(http.MethodPatch, "/api/users/"+strconv.FormatInt(created.ID, 10), `{"password":"short"}`, fixture.root)
	shortPasswordRequest.SetPathValue("id", strconv.FormatInt(created.ID, 10))
	fixture.server.updateUser(shortPasswordResponse, shortPasswordRequest)
	if shortPasswordResponse.Code != http.StatusBadRequest {
		t.Fatalf("short password update status = %d, body = %s", shortPasswordResponse.Code, shortPasswordResponse.Body.String())
	}

	updateResponse := httptest.NewRecorder()
	updateRequest := userHandlerRequest(http.MethodPatch, "/api/users/"+strconv.FormatInt(created.ID, 10), `{"displayName":" ","role":"admin","enabled":false}`, fixture.root)
	updateRequest.SetPathValue("id", strconv.FormatInt(created.ID, 10))
	fixture.server.updateUser(updateResponse, updateRequest)
	if updateResponse.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", updateResponse.Code, updateResponse.Body.String())
	}
	var updated account.ManagedUser
	if err := json.NewDecoder(updateResponse.Body).Decode(&updated); err != nil {
		t.Fatal(err)
	}
	if updated.DisplayName != "synthetic-user" || updated.Role != "admin" || updated.Enabled {
		t.Fatalf("updated user = %#v", updated)
	}

	lastSuperResponse := httptest.NewRecorder()
	lastSuperRequest := userHandlerRequest(http.MethodPatch, "/api/users/"+strconv.FormatInt(fixture.root.ID, 10), `{"enabled":false}`, fixture.root)
	lastSuperRequest.SetPathValue("id", strconv.FormatInt(fixture.root.ID, 10))
	fixture.server.updateUser(lastSuperResponse, lastSuperRequest)
	if lastSuperResponse.Code != http.StatusForbidden {
		t.Fatalf("environment-managed root disable status = %d, body = %s", lastSuperResponse.Code, lastSuperResponse.Body.String())
	}

	adminActor := account.User{ID: created.ID, Role: "admin", Permissions: []string{"users:manage"}}
	adminDeleteResponse := httptest.NewRecorder()
	adminDeleteRequest := userHandlerRequest(http.MethodDelete, "/api/users/"+strconv.FormatInt(fixture.root.ID, 10), "", adminActor)
	adminDeleteRequest.SetPathValue("id", strconv.FormatInt(fixture.root.ID, 10))
	fixture.server.deleteUser(adminDeleteResponse, adminDeleteRequest)
	if adminDeleteResponse.Code != http.StatusForbidden {
		t.Fatalf("administrator delete-super status = %d, body = %s", adminDeleteResponse.Code, adminDeleteResponse.Body.String())
	}

	selfDeleteResponse := httptest.NewRecorder()
	selfDeleteRequest := userHandlerRequest(http.MethodDelete, "/api/users/"+strconv.FormatInt(fixture.root.ID, 10), "", fixture.root)
	selfDeleteRequest.SetPathValue("id", strconv.FormatInt(fixture.root.ID, 10))
	fixture.server.deleteUser(selfDeleteResponse, selfDeleteRequest)
	if selfDeleteResponse.Code != http.StatusBadRequest {
		t.Fatalf("self-delete status = %d, body = %s", selfDeleteResponse.Code, selfDeleteResponse.Body.String())
	}

	deleteResponse := httptest.NewRecorder()
	deleteRequest := userHandlerRequest(http.MethodDelete, "/api/users/"+strconv.FormatInt(created.ID, 10), "", fixture.root)
	deleteRequest.SetPathValue("id", strconv.FormatInt(created.ID, 10))
	fixture.server.deleteUser(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusOK {
		t.Fatalf("delete status = %d, body = %s", deleteResponse.Code, deleteResponse.Body.String())
	}
	if _, err := fixture.server.accountStore.LoadManagedUser(context.Background(), created.ID); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("deleted user lookup error = %v, want sql.ErrNoRows", err)
	}
}

func TestEnvironmentManagedRootKeepsRolePasswordAndEnabledState(t *testing.T) {
	fixture := newUserHandlerFixture(t)
	rootID := strconv.FormatInt(fixture.root.ID, 10)
	patchRoot := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		request := userHandlerRequest(http.MethodPatch, "/api/users/"+rootID, body, fixture.root)
		request.SetPathValue("id", rootID)
		fixture.server.updateUser(response, request)
		return response
	}

	for _, body := range []string{
		`{"password":"synthetic-password-2"}`,
		`{"role":"admin"}`,
		`{"enabled":false}`,
	} {
		if response := patchRoot(body); response.Code != http.StatusForbidden {
			t.Fatalf("root update %s status = %d, want 403, body = %s", body, response.Code, response.Body.String())
		}
	}

	response := patchRoot(`{"displayName":"Synthetic Root","role":"super_admin","enabled":true,"password":""}`)
	if response.Code != http.StatusOK {
		t.Fatalf("root display name update status = %d, body = %s", response.Code, response.Body.String())
	}
	var updated account.ManagedUser
	if err := json.NewDecoder(response.Body).Decode(&updated); err != nil {
		t.Fatal(err)
	}
	if updated.DisplayName != "Synthetic Root" || updated.Role != "super_admin" || !updated.Enabled || !updated.EnvironmentManaged {
		t.Fatalf("updated root = %#v", updated)
	}
	if _, err := fixture.server.accountStore.Authenticate(context.Background(), "root", "synthetic-password", time.Now()); err != nil {
		t.Fatalf("root password changed: %v", err)
	}

	createResponse := httptest.NewRecorder()
	fixture.server.createUser(createResponse, userHandlerRequest(
		http.MethodPost,
		"/api/users",
		`{"username":"synthetic-super","role":"super_admin","password":"synthetic-password"}`,
		fixture.root,
	))
	if createResponse.Code != http.StatusCreated {
		t.Fatalf("create status = %d, body = %s", createResponse.Code, createResponse.Body.String())
	}
	var otherSuper account.ManagedUser
	if err := json.NewDecoder(createResponse.Body).Decode(&otherSuper); err != nil {
		t.Fatal(err)
	}
	if otherSuper.EnvironmentManaged {
		t.Fatalf("created user marked environment-managed: %#v", otherSuper)
	}
	superActor := account.User{ID: otherSuper.ID, Username: otherSuper.Username, Role: "super_admin", Permissions: []string{"users:manage"}}
	deleteResponse := httptest.NewRecorder()
	deleteRequest := userHandlerRequest(http.MethodDelete, "/api/users/"+rootID, "", superActor)
	deleteRequest.SetPathValue("id", rootID)
	fixture.server.deleteUser(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusForbidden {
		t.Fatalf("root delete status = %d, want 403, body = %s", deleteResponse.Code, deleteResponse.Body.String())
	}

	listResponse := httptest.NewRecorder()
	fixture.server.listUsers(listResponse, userHandlerRequest(http.MethodGet, "/api/users", "", fixture.root))
	var users []account.ManagedUser
	if err := json.NewDecoder(listResponse.Body).Decode(&users); err != nil {
		t.Fatal(err)
	}
	for _, user := range users {
		if user.EnvironmentManaged != (user.Username == "root") {
			t.Fatalf("listed user environmentManaged mismatch: %#v", user)
		}
	}
}
