package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"math"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/auththrottle"
)

// Sign-in failures are throttled on three keys. The client+username key stops
// focused guessing, the client key stops one client spraying many usernames,
// and the looser username key slows a guess distributed across many clients;
// a single client locks on its own keys long before it can trip that shared
// username key and lock the real user out. Unknown usernames are
// charged the same way as known ones, so a lockout reveals nothing about which
// accounts exist.
var (
	loginClientAccountPolicy = auththrottle.Policy{
		MaxFailures: 5, BaseLockout: time.Minute, MaxLockout: 15 * time.Minute,
		ResetAfter: time.Hour, ResetOnSuccess: true,
	}
	loginClientPolicy = auththrottle.Policy{
		MaxFailures: 20, BaseLockout: time.Minute, MaxLockout: 30 * time.Minute,
		ResetAfter: time.Hour,
	}
	loginAccountPolicy = auththrottle.Policy{
		MaxFailures: 50, BaseLockout: time.Minute, MaxLockout: 30 * time.Minute,
		ResetAfter: time.Hour, ResetOnSuccess: true,
	}
)

func loginThrottleKeys(client string, username string) []auththrottle.Key {
	// Hash the username so an arbitrarily long submitted name cannot inflate
	// the limiter's memory.
	sum := sha256.Sum256([]byte(username))
	account := hex.EncodeToString(sum[:16])
	return []auththrottle.Key{
		{Name: "client-account:" + client + "|" + account, Policy: loginClientAccountPolicy},
		{Name: "client:" + client, Policy: loginClientPolicy},
		{Name: "account:" + account, Policy: loginAccountPolicy},
	}
}

func writeLoginRateLimited(w http.ResponseWriter, retryAfter time.Duration) {
	w.Header().Set("Retry-After", strconv.Itoa(max(1, int(math.Ceil(retryAfter.Seconds())))))
	writeAPIError(w, http.StatusTooManyRequests, "login_rate_limited", "too many sign-in attempts; try again later", true)
}

func writeLoginBusy(w http.ResponseWriter) {
	w.Header().Set("Retry-After", "5")
	writeAPIError(w, http.StatusServiceUnavailable, "login_busy", "sign-in is busy; please retry", true)
}

// loginClientKey identifies the client for sign-in throttling. It trusts
// X-Forwarded-For only when the direct peer is a configured trusted proxy, and
// then takes the nearest address that is not itself a trusted proxy. IPv6
// clients are grouped by /64 because one host usually controls the whole
// prefix.
func (s *Server) loginClientKey(r *http.Request) string {
	addr, ok := parseRemoteAddr(r.RemoteAddr)
	if !ok {
		return "unknown"
	}
	if s.isTrustedProxy(addr) {
		hops := forwardedForHops(r.Header.Values("X-Forwarded-For"))
		for i := len(hops) - 1; i >= 0; i-- {
			hop, ok := parseForwardedAddr(hops[i])
			if !ok {
				break
			}
			addr = hop
			if !s.isTrustedProxy(addr) {
				break
			}
		}
	}
	if addr.Is6() {
		return netip.PrefixFrom(addr, 64).Masked().String()
	}
	return addr.String()
}

func (s *Server) isTrustedProxy(addr netip.Addr) bool {
	for _, prefix := range s.cfg.TrustedProxies {
		if prefix.Contains(addr) {
			return true
		}
	}
	return false
}

func parseRemoteAddr(remoteAddr string) (netip.Addr, bool) {
	host, _, err := net.SplitHostPort(remoteAddr)
	if err != nil {
		host = remoteAddr
	}
	return parseForwardedAddr(host)
}

func parseForwardedAddr(value string) (netip.Addr, bool) {
	value = strings.TrimSpace(value)
	if addrPort, err := netip.ParseAddrPort(value); err == nil {
		return addrPort.Addr().Unmap(), true
	}
	addr, err := netip.ParseAddr(strings.Trim(value, "[]"))
	if err != nil {
		return netip.Addr{}, false
	}
	return addr.WithZone("").Unmap(), true
}

func forwardedForHops(values []string) []string {
	hops := []string{}
	for _, value := range values {
		hops = append(hops, strings.Split(value, ",")...)
	}
	return hops
}
