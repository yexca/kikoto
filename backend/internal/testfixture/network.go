package testfixture

import "net"

// PublicIPv4 returns a deterministic public-address classification fixture for
// DNS mocks. Tests must use an injected dialer or a local proxy fixture and must
// never connect to this address. Documentation/reserved ranges cannot represent
// a successful public-policy decision because the transport rejects them.
func PublicIPv4() net.IP {
	return net.IPv4(93, 184, 216, 34)
}
