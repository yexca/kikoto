package proxyconfig

import (
	"errors"
	"reflect"
	"strings"
	"testing"
)

func proxyIDs(proxies []Proxy) []string {
	ids := make([]string, 0, len(proxies))
	for _, proxy := range proxies {
		ids = append(ids, proxy.ID)
	}
	return ids
}

func TestNormalizeCanonicalizesProxiesAndRoutes(t *testing.T) {
	config, err := Normalize(Config{
		Proxies: []Proxy{
			{ID: "first", Kind: KindHost, Scheme: "SOCKS5", Host: "ignored.example.test", Port: 1080, Password: "synthetic-orphan"},
			{Kind: KindCustom, Scheme: "http", Host: " Proxy.Example.test ", Port: 8080, Username: "synthetic-user", Password: "synthetic-password"},
			{ID: "third", Kind: KindCustom, Scheme: "https", Host: "2001:db8::10", Port: 443},
		},
		Routes: Routes{
			DLsite: Route{Enabled: true, ProxyIDs: []string{"third", "missing", "FIRST"}},
			Remote: Route{Enabled: false},
			Sources: map[int64]SourceRoute{
				7: {Mode: SourceDirect, ProxyIDs: []string{"first"}},
				8: {Mode: SourceInherit},
				9: {Mode: SourceProxy, ProxyIDs: []string{"third"}},
			},
		},
	}, func(id int64) bool { return id != 9 })
	if err != nil {
		t.Fatal(err)
	}
	first, second, third := config.Proxies[0], config.Proxies[1], config.Proxies[2]
	if first.Scheme != "socks5" || first.Host != "" || first.Password != "" {
		t.Fatalf("host proxy = %+v, want canonical scheme without address or orphan password", first)
	}
	if second.ID == "" || second.Host != "proxy.example.test" || second.Password != "synthetic-password" {
		t.Fatalf("custom proxy = %+v, want assigned id, canonical host, and kept password", second)
	}
	if third.Host != "2001:db8::10" {
		t.Fatalf("IPv6 proxy host = %q", third.Host)
	}
	if got := config.Routes.DLsite.ProxyIDs; !reflect.DeepEqual(got, []string{"first", "third"}) {
		t.Fatalf("DLsite selection = %v, want existing proxies in priority order", got)
	}
	if got := config.Routes.Sources; len(got) != 1 || got[7].Mode != SourceDirect || len(got[7].ProxyIDs) != 0 {
		t.Fatalf("source overrides = %+v, want only the known direct override", got)
	}
}

func TestNormalizeRejectsInvalidInputWithoutEchoingCredentials(t *testing.T) {
	valid := Proxy{ID: "one", Kind: KindCustom, Scheme: "http", Host: "192.0.2.10", Port: 8080}
	cases := map[string]Config{
		"scheme":        {Proxies: []Proxy{{Kind: KindCustom, Scheme: "ftp", Host: "192.0.2.10", Port: 21}}},
		"port":          {Proxies: []Proxy{{Kind: KindHost, Scheme: "http", Port: 0}}},
		"kind":          {Proxies: []Proxy{{Kind: "lan", Scheme: "http", Host: "192.0.2.10", Port: 8080}}},
		"missing host":  {Proxies: []Proxy{{Kind: KindCustom, Scheme: "http", Port: 8080}}},
		"host with url": {Proxies: []Proxy{{Kind: KindCustom, Scheme: "http", Host: "synthetic-user:synthetic-password@192.0.2.10", Port: 8080}}},
		"host path":     {Proxies: []Proxy{{Kind: KindCustom, Scheme: "http", Host: "192.0.2.10/path", Port: 8080}}},
		"id":            {Proxies: []Proxy{{ID: "Bad ID", Kind: KindHost, Scheme: "http", Port: 8080}}},
		"duplicate id":  {Proxies: []Proxy{valid, valid}},
		"control":       {Proxies: []Proxy{{Kind: KindHost, Scheme: "http", Port: 8080, Username: "synthetic\nuser"}}},
		"route":         {Routes: Routes{Other: Route{Enabled: true}}},
		"source mode":   {Proxies: []Proxy{valid}, Routes: Routes{Sources: map[int64]SourceRoute{1: {Mode: "sometimes"}}}},
		"source proxy":  {Routes: Routes{Sources: map[int64]SourceRoute{1: {Mode: SourceProxy}}}},
		"source id":     {Proxies: []Proxy{valid}, Routes: Routes{Sources: map[int64]SourceRoute{0: {Mode: SourceDirect}}}},
		"too many": {Proxies: func() []Proxy {
			proxies := make([]Proxy, MaxProxies+1)
			for index := range proxies {
				proxies[index] = Proxy{Kind: KindHost, Scheme: "http", Port: 8000 + index}
			}
			return proxies
		}()},
	}
	for name, config := range cases {
		_, err := Normalize(config, nil)
		var invalidErr *InvalidError
		if !errors.As(err, &invalidErr) {
			t.Fatalf("%s: error = %v, want InvalidError", name, err)
		}
		if strings.Contains(err.Error(), "synthetic-password") {
			t.Fatalf("%s: error echoed credentials: %v", name, err)
		}
	}
}

func TestResolveAppliesRoutesAndSourceOverrides(t *testing.T) {
	config := Config{
		Proxies: []Proxy{{ID: "a"}, {ID: "b"}, {ID: "c"}},
		Routes: Routes{
			DLsite: Route{Enabled: true, ProxyIDs: []string{"c", "a"}},
			Remote: Route{Enabled: true},
			Other:  Route{Enabled: false, ProxyIDs: []string{"b"}},
			Sources: map[int64]SourceRoute{
				1: {Mode: SourceDirect},
				2: {Mode: SourceProxy, ProxyIDs: []string{"b"}},
				3: {Mode: SourceProxy},
			},
		},
	}
	cases := []struct {
		name     string
		scope    Scope
		sourceID int64
		want     []string
	}{
		{"DLsite selection keeps priority order", ScopeDLsite, 0, []string{"a", "c"}},
		{"remote route uses every proxy", ScopeRemote, 0, []string{"a", "b", "c"}},
		{"source without override inherits", ScopeRemote, 99, []string{"a", "b", "c"}},
		{"direct override", ScopeRemote, 1, []string{}},
		{"proxy override", ScopeRemote, 2, []string{"b"}},
		{"override with every proxy", ScopeRemote, 3, []string{"a", "b", "c"}},
		{"disabled route", ScopeOther, 0, []string{}},
		{"overrides apply only to remote sources", ScopeDLsite, 1, []string{"a", "c"}},
	}
	for _, test := range cases {
		if got := proxyIDs(config.Resolve(test.scope, test.sourceID)); !reflect.DeepEqual(got, test.want) {
			t.Fatalf("%s: Resolve = %v, want %v", test.name, got, test.want)
		}
	}

	config.Routes.Remote.Enabled = false
	if got := proxyIDs(config.Resolve(ScopeRemote, 2)); !reflect.DeepEqual(got, []string{"b"}) {
		t.Fatalf("proxy override with disabled remote route = %v, want [b]", got)
	}
}

func TestProxyURLUsesRuntimeHostAndCredentials(t *testing.T) {
	host := Proxy{Kind: KindHost, Scheme: "socks5h", Port: 1080, Username: "synthetic-user", Password: "synthetic-password"}
	parsed, err := host.URL("host.docker.internal")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != "host.docker.internal:1080" || parsed.User.Username() != "synthetic-user" {
		t.Fatalf("host proxy URL = %s", parsed.Redacted())
	}
	if password, _ := parsed.User.Password(); password != "synthetic-password" {
		t.Fatal("host proxy URL lost its password")
	}

	custom := Proxy{Kind: KindCustom, Scheme: "http", Host: "::1", Port: 3128}
	parsed, err = custom.URL("host.docker.internal")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Host != "[::1]:3128" || parsed.Scheme != "http" {
		t.Fatalf("custom proxy URL = %s", parsed)
	}
}

func TestFromLegacyURLEnablesDLsiteRoute(t *testing.T) {
	config, err := FromLegacyURL(" SOCKS5://192.0.2.10:1080/ ")
	if err != nil {
		t.Fatal(err)
	}
	if len(config.Proxies) != 1 || config.Proxies[0].Scheme != "socks5" || config.Proxies[0].Host != "192.0.2.10" || config.Proxies[0].Port != 1080 {
		t.Fatalf("legacy proxies = %+v", config.Proxies)
	}
	if !config.Routes.DLsite.Enabled || config.Routes.Remote.Enabled || config.Routes.Other.Enabled {
		t.Fatalf("legacy routes = %+v, want only DLsite", config.Routes)
	}
	if _, err := FromLegacyURL("ftp://192.0.2.10:21"); err == nil {
		t.Fatal("unusable legacy proxy was accepted")
	}
	if empty, err := FromLegacyURL(""); err != nil || len(empty.Proxies) != 0 {
		t.Fatalf("empty legacy proxy = %+v, %v", empty, err)
	}
}
