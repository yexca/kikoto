package httpapi

import (
	"context"
	"net"
	"net/url"
	"testing"

	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

type syntheticPublicResolver struct{}

func (syntheticPublicResolver) LookupIPAddr(context.Context, string) ([]net.IPAddr, error) {
	return []net.IPAddr{{IP: testfixture.PublicIPv4()}}, nil
}

func useSyntheticMetadataDNS(t *testing.T, server *Server) {
	t.Helper()
	server.metadataTransport.policyFor = func(proxy *url.URL) (*outbound.Policy, error) {
		return outbound.NewPolicy([]outbound.Destination{{URL: server.dlsiteEndpoints.WorkURL("RJ00000001")}}, outbound.Options{
			Proxy: proxy, Resolver: syntheticPublicResolver{},
		})
	}
	t.Cleanup(server.metadataHTTPClient.CloseIdleConnections)
}
