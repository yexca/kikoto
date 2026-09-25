package httpapi

import (
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func postLogin(handler http.Handler, remoteAddr string, username string, password string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/api/auth/login", strings.NewReader(`{"username":"`+username+`","password":"`+password+`"}`))
	request.RemoteAddr = remoteAddr
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestLoginLocksRepeatedFailuresForClientAndUsername(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{Mode: config.ModeProduction, RootUsername: "root"})
	createTestAdministrator(t, server, "root", "synthetic-root-password")
	handler := server.Routes()
	const attacker = "203.0.113.10:40000"

	for _, username := range []string{"root", "missing-user"} {
		for attempt := 1; attempt <= loginClientAccountPolicy.MaxFailures; attempt++ {
			if response := postLogin(handler, attacker, username, "synthetic-wrong-password"); response.Code != http.StatusUnauthorized {
				t.Fatalf("%s failure %d status = %d, body = %s", username, attempt, response.Code, response.Body.String())
			}
		}
		// A locked key rejects even the correct password without verifying it,
		// and an unknown username locks exactly like a real one.
		locked := postLogin(handler, attacker, username, "synthetic-root-password")
		if locked.Code != http.StatusTooManyRequests || locked.Header().Get("Retry-After") == "" || !strings.Contains(locked.Body.String(), `"code":"login_rate_limited"`) {
			t.Fatalf("%s locked status = %d, Retry-After = %q, body = %s", username, locked.Code, locked.Header().Get("Retry-After"), locked.Body.String())
		}
	}

	if response := postLogin(handler, "198.51.100.20:40000", "root", "synthetic-root-password"); response.Code != http.StatusOK {
		t.Fatalf("other client login status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestLoginClientKeyTrustsForwardedForOnlyFromConfiguredProxy(t *testing.T) {
	proxy := netip.MustParsePrefix("192.0.2.0/24")
	cases := []struct {
		name       string
		trusted    []netip.Prefix
		remoteAddr string
		forwarded  []string
		want       string
	}{
		{name: "untrusted peer ignores header", remoteAddr: "203.0.113.10:1234", forwarded: []string{"198.51.100.7"}, want: "203.0.113.10"},
		{name: "trusted proxy uses nearest client", trusted: []netip.Prefix{proxy}, remoteAddr: "192.0.2.2:1234", forwarded: []string{"203.0.113.9, 198.51.100.7"}, want: "198.51.100.7"},
		{name: "skips chained trusted proxies", trusted: []netip.Prefix{proxy}, remoteAddr: "192.0.2.2:1234", forwarded: []string{"203.0.113.9", "198.51.100.7, 192.0.2.3"}, want: "198.51.100.7"},
		{name: "malformed hop keeps last trusted address", trusted: []netip.Prefix{proxy}, remoteAddr: "192.0.2.2:1234", forwarded: []string{"not-an-address"}, want: "192.0.2.2"},
		{name: "IPv6 clients group by /64", remoteAddr: "[2001:db8:1:2:3:4:5:6]:1234", want: "2001:db8:1:2::/64"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := NewServer(nil, config.Config{TrustedProxies: tc.trusted})
			request := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
			request.RemoteAddr = tc.remoteAddr
			for _, value := range tc.forwarded {
				request.Header.Add("X-Forwarded-For", value)
			}
			if got := server.loginClientKey(request); got != tc.want {
				t.Fatalf("loginClientKey() = %q, want %q", got, tc.want)
			}
		})
	}
}
