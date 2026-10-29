package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/library"
)

func TestForYouTemperatureIsSavedPerAccountAndValidated(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO user_account (id, username, role) VALUES (1, 'synthetic-listener', 'user'), (2, 'synthetic-other', 'user')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	as := func(userID int64, request *http.Request) *http.Request {
		return request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: userID, Role: "user", Permissions: account.PermissionsForRole("user")}))
	}
	patch := func(body string) int {
		response := httptest.NewRecorder()
		server.updateUserPreferences(response, as(1, httptest.NewRequest(http.MethodPatch, "/api/auth/me/preferences", strings.NewReader(body))))
		return response.Code
	}
	temperature := func(userID int64) library.ForYouTemperature {
		t.Helper()
		result, err := server.loadUserPreferences(httptest.NewRequest(http.MethodGet, "/api/auth/me/preferences", nil), userID)
		if err != nil {
			t.Fatal(err)
		}
		return result.ForYouTemperature
	}
	if got := temperature(1); got != library.ForYouBalanced {
		t.Fatalf("default temperature = %q", got)
	}
	if code := patch(`{"forYouTemperature":"adventurous"}`); code != http.StatusOK {
		t.Fatalf("patch status = %d", code)
	}
	if code := patch(`{"forYouTemperature":"scorching"}`); code != http.StatusBadRequest {
		t.Fatalf("invalid temperature status = %d", code)
	}
	if got, other := temperature(1), temperature(2); got != library.ForYouAdventurous || other != library.ForYouBalanced {
		t.Fatalf("temperatures = %q, other account %q", got, other)
	}

	for _, body := range []string{`{"columns":["elsewhere"]}`, `{"temperature":"scorching"}`, `{"query":"private"}`} {
		response := httptest.NewRecorder()
		server.drawForYou(response, as(1, httptest.NewRequest(http.MethodPost, "/api/for-you/draw", strings.NewReader(body))))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("draw %s status = %d, body = %s", body, response.Code, response.Body.String())
		}
	}
}
