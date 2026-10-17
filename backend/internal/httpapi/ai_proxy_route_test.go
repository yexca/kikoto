package httpapi

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/asr"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/llm"
)

// countingServer answers every request and counts it, standing in for a
// forward proxy or a same-machine service.
func countingServer(t *testing.T, hits *atomic.Int32) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	t.Cleanup(server.Close)
	return server
}

func serverPort(t *testing.T, server *httptest.Server) int {
	t.Helper()
	_, port, err := net.SplitHostPort(server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	number, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	return number
}

func TestLLMAndASRFollowTheirOwnProxyRouteAndSameMachineServicesConnectDirectly(t *testing.T) {
	var proxied, direct atomic.Int32
	proxy := countingServer(t, &proxied)
	local := countingServer(t, &direct)
	server := NewServer(openMigratedTestDB(t), config.Config{})
	// The counting proxy refuses the CONNECT a proxied request opens with, so
	// only where each request arrived is checked.
	send := func(client *http.Client, base string) {
		if response, err := client.Get(base + "/v1/models"); err == nil {
			_ = response.Body.Close()
		}
	}
	remoteLLM := llm.Provider{PresetID: "custom-openai", BaseURL: "http://192.0.2.10"}
	remoteASR := asr.Provider{PresetID: "local", Scope: asr.ScopeOtherMachine, BaseURL: "http://192.0.2.11"}
	localLLM := llm.Provider{PresetID: "kikoto-helper", Scope: llm.ScopeLocalMachine, Port: serverPort(t, local)}
	localASR := asr.Provider{PresetID: "kikoto-helper", Scope: asr.ScopeLocalMachine, Port: serverPort(t, local)}

	// The update check's route does not carry LLM or ASR requests.
	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t,
		[]map[string]any{customProxy("lan", proxy.URL)}, map[string]any{"other": routeTo()},
	)))
	if route, err := server.aiProxyRoute(context.Background(), false); err != nil || len(route.proxies) != 0 {
		t.Fatalf("LLM and ASR route with only the other route on = %d proxies, error %v; want direct", len(route.proxies), err)
	}

	decodeProxySettings(t, patchSettingsAsSourceWriter(t, server, proxySettingsBody(t,
		[]map[string]any{customProxy("lan", proxy.URL)}, map[string]any{"ai": routeTo(), "other": routeTo()},
	)))
	llmClient, closeLLM, err := server.llmClient(context.Background(), remoteLLM, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer closeLLM()
	send(llmClient.HTTP, remoteLLM.Endpoint(server.cfg.HostProxyAddress()))
	asrClient, closeASR, err := server.asrClient(context.Background(), remoteASR, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer closeASR()
	send(asrClient.HTTP, remoteASR.Endpoint(server.cfg.HostProxyAddress()))
	if proxied.Load() != 2 {
		t.Fatalf("proxy received %d requests, want the LLM and the ASR request", proxied.Load())
	}

	// A service on this server's machine is reachable only from here, so the
	// enabled route never applies to it.
	localLLMClient, closeLocalLLM, err := server.llmClient(context.Background(), localLLM, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer closeLocalLLM()
	send(localLLMClient.HTTP, localLLM.Endpoint(server.cfg.HostProxyAddress()))
	localASRClient, closeLocalASR, err := server.asrClient(context.Background(), localASR, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer closeLocalASR()
	send(localASRClient.HTTP, localASR.Endpoint(server.cfg.HostProxyAddress()))
	if direct.Load() != 2 || proxied.Load() != 2 {
		t.Fatalf("same-machine requests reached the service %d times and the proxy %d more times, want 2 and 0", direct.Load(), proxied.Load()-2)
	}
}
