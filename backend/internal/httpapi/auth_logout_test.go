package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestLogoutRevokesAllPresentedCredentialsOrReportsFailure(t *testing.T) {
	for _, scenario := range []string{"bearer", "cookie", "mixed", "same", "failure", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			db := openMigratedTestDB(t)
			s := NewServer(db, config.Config{})
			if _, err := db.Exec(`INSERT INTO user_account(id,username,role) VALUES (1,'synthetic-user-a','user'),(2,'synthetic-user-b','user')`); err != nil {
				t.Fatal(err)
			}
			tokens := []string{"synthetic-bearer", "synthetic-cookie"}
			for index, token := range tokens {
				digest := sha256.Sum256([]byte(token))
				if _, err := db.Exec("INSERT INTO user_session(id,user_id,expires_at) VALUES (?,?,'2030-01-01 00:00:00')", hex.EncodeToString(digest[:]), index+1); err != nil {
					t.Fatal(err)
				}
			}
			if scenario == "failure" {
				if _, err := db.Exec(`CREATE TRIGGER fail_revoke BEFORE DELETE ON user_session WHEN OLD.user_id = 2 BEGIN SELECT RAISE(ABORT,'synthetic protected diagnostic'); END`); err != nil {
					t.Fatal(err)
				}
			}
			request := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
			if scenario != "cookie" {
				request.Header.Set("Authorization", "Bearer "+tokens[0])
			}
			if scenario != "bearer" {
				cookie := tokens[1]
				if scenario == "same" {
					cookie = tokens[0]
				}
				request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: cookie})
			}
			if scenario == "cancelled" {
				ctx, cancel := context.WithCancel(request.Context())
				cancel()
				request = request.WithContext(ctx)
			}
			response := httptest.NewRecorder()
			s.logout(response, request)
			cookies := response.Result().Cookies()
			if len(cookies) != 1 || cookies[0].Value != "" || cookies[0].MaxAge != -1 {
				t.Fatalf("client cookie was not cleared: %+v", cookies)
			}
			failed := scenario == "failure" || scenario == "cancelled"
			if failed {
				if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "session_revocation_failed") || strings.Contains(response.Body.String(), "synthetic protected diagnostic") || strings.Contains(response.Body.String(), `"ok":true`) {
					t.Fatalf("revocation failure = %d %s", response.Code, response.Body.String())
				}
			} else if response.Code != http.StatusOK {
				t.Fatalf("logout = %d %s", response.Code, response.Body.String())
			}
			for index, token := range tokens {
				_, err := s.accountStore.UserForSession(context.Background(), token, time.Now())
				wantValid := failed || (index == 0 && scenario == "cookie") || (index == 1 && (scenario == "bearer" || scenario == "same"))
				if wantValid && err != nil || !wantValid && !errors.Is(err, sql.ErrNoRows) {
					t.Fatalf("credential %d valid=%t, error=%v", index, wantValid, err)
				}
			}
		})
	}
}

func TestLogoutStillClearsCookieWhenAuthenticationLookupCannotRun(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	request.AddCookie(&http.Cookie{Name: sessionCookieName, Value: "synthetic-cookie"})
	response := httptest.NewRecorder()
	s.Routes().ServeHTTP(response, request)
	if response.Code != http.StatusServiceUnavailable || !strings.Contains(response.Body.String(), "session_revocation_failed") {
		t.Fatalf("logout = %d %s", response.Code, response.Body.String())
	}
	if cookies := response.Result().Cookies(); len(cookies) != 1 || cookies[0].MaxAge != -1 {
		t.Fatalf("client cookie cleanup was blocked by authentication: %+v", cookies)
	}
}
