package testfixture

import "net"

// DocumentationIPv4 returns a deterministic address from the RFC 5737 TEST-NET-1
// range for DNS mocks. Tests must use an injected dialer or a local proxy fixture
// and must never connect to this address. Successful transport tests must explicitly
// allow the configured origin's reserved addresses; public policies must reject it.
func DocumentationIPv4() net.IP {
	return net.IPv4(192, 0, 2, 10)
}
