package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

func TestEnvironmentRootAccountModeLocksManagedAccount(t *testing.T) {
	configDir := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{
		Mode: config.ModeProduction, DatabasePath: filepath.Join(configDir, "kikoto.db"),
		RootAccountMode: config.RootAccountEnvironment, RootUsername: "configured-root",
		RootPassword: "synthetic-env-password", RootPasswordReset: true,
	})
	if err := server.PrepareAdministrator(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(configDir, initialSetupFileName)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("setup token in environment mode: %v, want none", err)
	}
	handler := server.Routes()
	if state := anonymousAuthState(t, handler); state["setupRequired"] != nil {
		t.Fatalf("anonymous auth state = %#v, want setup closed", state)
	}
	cookie := loginTestSession(t, handler, "configured-root", "synthetic-env-password")

	meRequest := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	meRequest.AddCookie(cookie)
	meResponse := httptest.NewRecorder()
	handler.ServeHTTP(meResponse, meRequest)
	if !strings.Contains(meResponse.Body.String(), `"passwordManagedBy":"environment"`) {
		t.Fatalf("managed account response = %s", meResponse.Body.String())
	}
	ownPassword := httptest.NewRequest(http.MethodPatch, "/api/auth/me", strings.NewReader(`{"currentPassword":"synthetic-env-password","newPassword":"synthetic-new-password"}`))
	ownPassword.AddCookie(cookie)
	ownPasswordResponse := httptest.NewRecorder()
	handler.ServeHTTP(ownPasswordResponse, ownPassword)
	if ownPasswordResponse.Code != http.StatusForbidden {
		t.Fatalf("own password change status = %d, body = %s", ownPasswordResponse.Code, ownPasswordResponse.Body.String())
	}

	root, err := server.accountStore.LoadByUsername(context.Background(), "configured-root")
	if err != nil {
		t.Fatal(err)
	}
	other, err := server.accountStore.CreateManagedUser(context.Background(), account.CreateUserInput{
		Username: "synthetic-super", DisplayName: "synthetic-super", Role: "super_admin", Password: "synthetic-password", Enabled: true, ActorUserID: root.ID,
	})
	if err != nil {
		t.Fatal(err)
	}
	actor := account.User{ID: other.ID, Username: other.Username, Role: "super_admin", Permissions: []string{"users:manage"}}
	rootID := strconv.FormatInt(root.ID, 10)
	for _, body := range []string{`{"password":"synthetic-password-2"}`, `{"role":"admin"}`, `{"enabled":false}`} {
		response := httptest.NewRecorder()
		request := userHandlerRequest(http.MethodPatch, "/api/users/"+rootID, body, actor)
		request.SetPathValue("id", rootID)
		server.updateUser(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("managed account update %s status = %d, body = %s", body, response.Code, response.Body.String())
		}
	}
	deleteResponse := httptest.NewRecorder()
	deleteRequest := userHandlerRequest(http.MethodDelete, "/api/users/"+rootID, "", actor)
	deleteRequest.SetPathValue("id", rootID)
	server.deleteUser(deleteResponse, deleteRequest)
	if deleteResponse.Code != http.StatusForbidden {
		t.Fatalf("managed account delete status = %d, body = %s", deleteResponse.Code, deleteResponse.Body.String())
	}
	listResponse := httptest.NewRecorder()
	server.listUsers(listResponse, userHandlerRequest(http.MethodGet, "/api/users", "", actor))
	var users []account.ManagedUser
	if err := json.NewDecoder(listResponse.Body).Decode(&users); err != nil {
		t.Fatal(err)
	}
	for _, user := range users {
		if user.EnvironmentManaged != (user.Username == "configured-root") {
			t.Fatalf("listed user environmentManaged mismatch: %#v", user)
		}
	}

	// A changed environment value is applied on the next start.
	server.cfg.RootPassword = "synthetic-env-password-2"
	if err := server.PrepareAdministrator(context.Background()); err != nil {
		t.Fatal(err)
	}
	staleRequest := httptest.NewRequest(http.MethodGet, "/api/auth/me", nil)
	staleRequest.AddCookie(cookie)
	staleResponse := httptest.NewRecorder()
	handler.ServeHTTP(staleResponse, staleRequest)
	if strings.Contains(staleResponse.Body.String(), `"authenticated":true`) {
		t.Fatalf("session survived an environment password change: %s", staleResponse.Body.String())
	}
	loginTestSession(t, handler, "configured-root", "synthetic-env-password-2")
}
