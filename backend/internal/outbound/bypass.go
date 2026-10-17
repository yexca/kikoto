package outbound

import (
	"net/netip"
	"strings"
)

// MaxProxyBypassEntries bounds the proxy bypass list.
const MaxProxyBypassEntries = 64

// ProxyBypass lists destinations a proxied policy connects to directly: exact
// hostnames, "*.domain" for every subdomain of a domain, and IP addresses or
// networks. Destination names are resolved here rather than by the proxy, so
// a network also matches a hostname that resolves into it. A bypassed
// destination keeps every address rule of the policy.
type ProxyBypass struct {
	hosts    map[string]bool
	suffixes []string
	prefixes []netip.Prefix
}

// NormalizeProxyBypassEntry returns the canonical form of one bypass entry: a
// hostname, "*.domain" (".domain" is accepted for it), an IP address, or a
// network in CIDR notation.
func NormalizeProxyBypassEntry(value string) (string, error) {
	value = strings.ToLower(strings.TrimSpace(value))
	if strings.HasPrefix(value, ".") {
		value = "*" + value
	}
	if strings.Contains(value, "/") {
		prefix, err := netip.ParsePrefix(value)
		if err != nil {
			return "", violation("proxy bypass network must use CIDR notation, such as 192.168.0.0/16")
		}
		return netip.PrefixFrom(prefix.Addr().Unmap(), prefixBits(prefix)).Masked().String(), nil
	}
	if address, err := netip.ParseAddr(strings.Trim(value, "[]")); err == nil {
		if address.Zone() != "" {
			return "", violation("proxy bypass address must not name an interface zone")
		}
		return address.Unmap().String(), nil
	}
	normalized, err := NormalizeHostPattern(value)
	if err != nil {
		return "", violation("proxy bypass entry must be a hostname, *.domain, IP address, or network")
	}
	return normalized, nil
}

// prefixBits keeps an IPv4-mapped network's length meaningful once unmapped.
func prefixBits(prefix netip.Prefix) int {
	if prefix.Addr().Is4In6() {
		return max(prefix.Bits()-96, 0)
	}
	return prefix.Bits()
}

// NewProxyBypass parses a bypass list. Duplicate entries are ignored.
func NewProxyBypass(entries []string) (ProxyBypass, error) {
	if len(entries) > MaxProxyBypassEntries {
		return ProxyBypass{}, violation("proxy bypass list has too many entries")
	}
	bypass := ProxyBypass{hosts: map[string]bool{}}
	for _, entry := range entries {
		normalized, err := NormalizeProxyBypassEntry(entry)
		if err != nil {
			return ProxyBypass{}, err
		}
		switch {
		case strings.Contains(normalized, "/"):
			bypass.prefixes = append(bypass.prefixes, netip.MustParsePrefix(normalized))
		case strings.HasPrefix(normalized, "*."):
			bypass.suffixes = append(bypass.suffixes, strings.TrimPrefix(normalized, "*"))
		default:
			if address, err := netip.ParseAddr(normalized); err == nil {
				bypass.prefixes = append(bypass.prefixes, netip.PrefixFrom(address, address.BitLen()))
				continue
			}
			bypass.hosts[normalized] = true
		}
	}
	return bypass, nil
}

func (b ProxyBypass) matchesHost(host string) bool {
	host, err := canonicalHost(host)
	if err != nil {
		return false
	}
	if b.hosts[host] {
		return true
	}
	for _, suffix := range b.suffixes {
		if strings.HasSuffix(host, suffix) {
			return true
		}
	}
	return false
}

func (b ProxyBypass) matchesAddress(address netip.Addr) bool {
	address = address.Unmap()
	for _, prefix := range b.prefixes {
		if prefix.Contains(address) {
			return true
		}
	}
	return false
}

// WithProxyBypass returns a copy of a proxied policy that connects to the
// destinations bypass matches directly, under the same address rules.
func (p *Policy) WithProxyBypass(bypass ProxyBypass) *Policy {
	copied := *p
	copied.bypass = bypass
	return &copied
}
