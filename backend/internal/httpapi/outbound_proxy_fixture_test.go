package httpapi

import (
	"context"
	"net"
	"net/url"
	"testing"

	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

type syntheticDocumentationResolver struct{}

func (syntheticDocumentationResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: testfixture.DocumentationIPv4()}}, nil
}

func useSyntheticMetadataDNS(t *testing.T, server *Server) {
	t.Helper()
	server.metadataTransport.policyFor = func(proxy *url.URL) (*outbound.Policy, error) {
		// Only this test policy permits the reserved DNS fixture. Requests are
		// handled by local proxy fixtures; the production metadata policy stays strict.
		return outbound.NewPolicy([]outbound.Destination{{URL: server.dlsiteEndpoints.WorkURL("RJ00000001"), AllowPrivate: true}}, outbound.Options{
			Proxy: proxy, Resolver: syntheticDocumentationResolver{},
		})
	}
	t.Cleanup(server.metadataHTTPClient.CloseIdleConnections)
}
