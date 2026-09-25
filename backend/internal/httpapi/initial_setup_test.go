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
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func postInitialSetup(handler http.Handler, body string, mobile bool) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/auth/setup", strings.NewReader(body))
	if mobile {
		request.Header.Set(mobileAuthHeader, "1")
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func anonymousAuthState(t *testing.T, handler http.Handler) map[string]any {
	t.Helper()
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/auth/me", nil))
	var state map[string]any
	if err := json.NewDecoder(response.Body).Decode(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func TestInitialSetupRequiresTokenAndClosesAfterFirstAdministrator(t *testing.T) {
	configDir := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{
		Mode: config.ModeProduction, DatabasePath: filepath.Join(configDir, "kikoto.db"),
	})
	if err := server.PrepareAdministrator(context.Background()); err != nil {
		t.Fatal(err)
	}
	tokenPath := filepath.Join(configDir, initialSetupFileName)
	rawToken, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("setup token file: %v", err)
	}
	token := strings.TrimSpace(string(rawToken))
	handler := server.Routes()
	if state := anonymousAuthState(t, handler); state["setupRequired"] != true {
		t.Fatalf("anonymous auth state = %#v, want setupRequired", state)
	}

	for _, test := range []struct {
		body     string
		wantCode string
		status   int
	}{
		{body: `{"setupToken":"wrong-token","username":"synthetic-admin","password":"synthetic-password"}`, wantCode: "invalid_setup_token", status: http.StatusForbidden},
		{body: `{"setupToken":"` + token + `","username":"synthetic-admin","password":"change-me"}`, wantCode: "password_placeholder", status: http.StatusBadRequest},
		{body: `{"setupToken":"` + token + `","username":"__demo__","password":"synthetic-password"}`, wantCode: "username_reserved", status: http.StatusBadRequest},
	} {
		response := postInitialSetup(handler, test.body, false)
		if response.Code != test.status || !strings.Contains(response.Body.String(), `"code":"`+test.wantCode+`"`) {
			t.Fatalf("setup %s status = %d, body = %s", test.wantCode, response.Code, response.Body.String())
		}
	}

	response := postInitialSetup(handler, `{"setupToken":" `+token+` ","username":"synthetic-admin","password":"synthetic-password"}`, true)
	if response.Code != http.StatusCreated {
		t.Fatalf("setup status = %d, body = %s", response.Code, response.Body.String())
	}
	var created struct {
		Authenticated bool        `json:"authenticated"`
		User          currentUser `json:"user"`
		SessionToken  string      `json:"sessionToken"`
	}
	if err := json.NewDecoder(response.Body).Decode(&created); err != nil {
		t.Fatal(err)
	}
	if !created.Authenticated || created.User.Username != "synthetic-admin" || created.User.Role != "super_admin" || created.SessionToken == "" {
		t.Fatalf("setup response = %#v", created)
	}
	if len(response.Result().Cookies()) == 0 {
		t.Fatal("setup did not sign the administrator in")
	}
	if _, err := os.Stat(tokenPath); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("setup token file after setup: %v, want removed", err)
	}
	if state := anonymousAuthState(t, handler); state["setupRequired"] != nil {
		t.Fatalf("anonymous auth state after setup = %#v", state)
	}

	replay := postInitialSetup(handler, `{"setupToken":"`+token+`","username":"second-admin","password":"synthetic-password"}`, false)
	if replay.Code != http.StatusConflict || !strings.Contains(replay.Body.String(), `"code":"setup_complete"`) {
		t.Fatalf("replayed setup status = %d, body = %s", replay.Code, replay.Body.String())
	}
}

func TestInitialSetupClosesWhenAdministratorIsRecoveredFromHost(t *testing.T) {
	configDir := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{
		Mode: config.ModeProduction, DatabasePath: filepath.Join(configDir, "kikoto.db"),
	})
	if err := server.PrepareAdministrator(context.Background()); err != nil {
		t.Fatal(err)
	}
	rawToken, err := os.ReadFile(filepath.Join(configDir, initialSetupFileName))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.accountStore.RecoverAdministrator(context.Background(), "root", "synthetic-password", "command"); err != nil {
		t.Fatal(err)
	}
	handler := server.Routes()
	if state := anonymousAuthState(t, handler); state["setupRequired"] != nil {
		t.Fatalf("anonymous auth state after host recovery = %#v", state)
	}
	response := postInitialSetup(handler, `{"setupToken":"`+strings.TrimSpace(string(rawToken))+`","username":"synthetic-admin","password":"synthetic-password"}`, false)
	if response.Code != http.StatusConflict {
		t.Fatalf("setup after host recovery status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestPrepareAdministratorAppliesEnvironmentResetBeforeSetup(t *testing.T) {
	configDir := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{
		Mode: config.ModeProduction, DatabasePath: filepath.Join(configDir, "kikoto.db"),
		RootUsername: "root", RootPassword: "synthetic-env-password", RootPasswordReset: true,
	})
	if err := server.PrepareAdministrator(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(configDir, initialSetupFileName)); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("setup token after environment reset: %v, want none", err)
	}
	handler := server.Routes()
	if state := anonymousAuthState(t, handler); state["setupRequired"] != nil {
		t.Fatalf("anonymous auth state = %#v, want setup closed", state)
	}
	loginTestSession(t, handler, "root", "synthetic-env-password")

	server.cfg.RootUsername = "synthetic-missing"
	server.cfg.RootPassword = "synthetic-env-password-2"
	if err := server.PrepareAdministrator(context.Background()); err == nil || !strings.Contains(err.Error(), "KIKOTO_ROOT_USERNAME") {
		t.Fatalf("PrepareAdministrator() for a missing account error = %v, want a KIKOTO_ROOT_USERNAME hint", err)
	}

	server.cfg.RootUsername = "root"
	server.cfg.RootPassword = "change-me"
	if err := server.PrepareAdministrator(context.Background()); err == nil {
		t.Fatal("PrepareAdministrator() accepted a placeholder reset password")
	}
}
