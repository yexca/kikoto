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

// Sign-in failures lock only keys of the client: its address, or its IPv6
// /64. The client+username key stops focused guessing and the client key
// stops one client spraying many usernames. A username shared by every client
// is never locked, so no one can lock its owner out; its failures only delay
// the next attempts on it, from any client. Unknown usernames are charged
// the same way as known ones, so neither a lockout nor a delay reveals which
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
	loginAccountDelayPolicy = auththrottle.DelayPolicy{
		FreeFailures: 5, BaseDelay: time.Second, MaxDelay: 8 * time.Second, ResetAfter: time.Hour,
	}
)

// loginAccountKey hashes the username so an arbitrarily long submitted name
// cannot inflate the throttle's memory.
func loginAccountKey(username string) string {
	sum := sha256.Sum256([]byte(username))
	return hex.EncodeToString(sum[:16])
}

func loginThrottleKeys(client string, username string) []auththrottle.Key {
	account := loginAccountKey(username)
	return []auththrottle.Key{
		{Name: "client-account:" + client + "|" + account, Policy: loginClientAccountPolicy},
		{Name: "client:" + client, Policy: loginClientPolicy},
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
