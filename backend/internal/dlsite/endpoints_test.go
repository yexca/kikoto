package dlsite

import (
	"net/url"
	"testing"
)

func TestDefaultEndpointsBuildPublicLinks(t *testing.T) {
	endpoints := DefaultEndpoints()
	tests := []struct {
		name string
		url  string
		path string
	}{
		{name: "RJ work", url: endpoints.WorkURL(" rj00000000 "), path: "/maniax/work/=/product_id/RJ00000000.html"},
		{name: "VJ work", url: endpoints.WorkURL("VJ00000001"), path: "/pro/work/=/product_id/VJ00000001.html"},
		{name: "product site", url: endpoints.ProductURL(Product{WorkNo: "RJ00000002", SiteID: "pro"}), path: "/pro/work/=/product_id/RJ00000002.html"},
		{name: "maker", url: endpoints.MakerURL("VG00000003"), path: "/pro/circle/profile/=/maker_id/VG00000003.html"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			parsed, err := url.Parse(test.url)
			if err != nil {
				t.Fatal(err)
			}
			if parsed.Hostname() != "www.dlsite.com" || parsed.Path != test.path {
				t.Fatalf("URL = %q, want host/path %q%s", test.url, "www.dlsite.com", test.path)
			}
		})
	}
}

func TestEndpointsResolveRootRelativeLinksAgainstWebOrigin(t *testing.T) {
	parsed, err := url.Parse(DefaultEndpoints().ResolveURL("/maniax/fsr/=/title_id/SRI0000000000"))
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Hostname() != "www.dlsite.com" || parsed.Path != "/maniax/fsr/=/title_id/SRI0000000000" {
		t.Fatalf("resolved URL = %q", parsed.String())
	}
}
