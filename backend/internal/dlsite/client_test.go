package dlsite

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchProductUsesCandidateSiteAndParsesProduct(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/maniax/api/=/product.json":
			if r.URL.Query().Get("workno") != "RJ0123456" {
				t.Fatalf("workno = %s", r.URL.Query().Get("workno"))
			}
			_, _ = w.Write([]byte(`[{"workno":"RJ0123456","product_name":"Example","work_name_kana":"エグザンプル","intro_s":"Short","regist_date":"2024-01-02","age_category_string":"adult"}]`))
		case "/maniax-touch/product/info/ajax":
			if r.URL.Query().Get("product_id") != "RJ0123456" {
				t.Fatalf("product_id = %s", r.URL.Query().Get("product_id"))
			}
			_, _ = w.Write([]byte(`{"RJ0123456":{"rate_average_2dp":4.89}}`))
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.Client())
	client.baseURL = server.URL

	product, err := client.FetchProduct(context.Background(), "rj0123456")
	if err != nil {
		t.Fatal(err)
	}
	if product.WorkNo != "RJ0123456" {
		t.Fatalf("WorkNo = %s", product.WorkNo)
	}
	if product.ProductName != "Example" {
		t.Fatalf("ProductName = %s", product.ProductName)
	}
	if len(product.Raw) == 0 {
		t.Fatal("expected raw product snapshot")
	}
	if product.RateAverage2DP == nil || *product.RateAverage2DP != 4.89 {
		t.Fatalf("RateAverage2DP = %v", product.RateAverage2DP)
	}
}

func TestFetchProductWithOptionsSendsLanguage(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/maniax/api/=/product.json":
			if r.URL.Query().Get("locale") != "en-us" {
				t.Fatalf("locale = %s", r.URL.Query().Get("locale"))
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"workno":"RJ0123456","product_name":"Localized title"}]`))
		case "/maniax-touch/product/info/ajax":
			_, _ = w.Write([]byte(`{"RJ0123456":{"rate_average_2dp":4.5}}`))
		default:
			t.Fatalf("path = %s", r.URL.Path)
		}
	}))
	defer server.Close()

	client := NewClient(server.Client())
	client.baseURL = server.URL

	product, err := client.FetchProductWithOptions(context.Background(), "RJ0123456", ProductOptions{Languages: []string{"en-us"}})
	if err != nil {
		t.Fatal(err)
	}
	if product.Language != "en-us" {
		t.Fatalf("Language = %s", product.Language)
	}
}

func TestFetchMakerCatalogUsesAllLanguageOptions(t *testing.T) {
	var requestedPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestedPath = r.URL.Path
		if !strings.Contains(requestedPath, "/options[0]/JPN/") {
			t.Fatalf("missing JPN option in %s", requestedPath)
		}
		if !strings.Contains(requestedPath, "/options[2]/CHI_HANS/") {
			t.Fatalf("missing CHI_HANS option in %s", requestedPath)
		}
		if !strings.Contains(requestedPath, "/options[15]/NM") {
			t.Fatalf("missing NM option in %s", requestedPath)
		}
		_, _ = w.Write([]byte(`
			<html>
				<head><title>Example Circle | DLsite</title></head>
				<body>
					<div class="page_total">1 件中 1～1 件目</div>
					<div id="search_result_list">
						<div class="n_worklist">
							<a href="/maniax/work/=/product_id/RJ01234567.html">Work</a>
						</div>
					</div>
				</body>
			</html>
		`))
	}))
	defer server.Close()

	client := NewClient(server.Client())
	client.baseURL = server.URL

	profile, err := client.FetchMakerCatalog(context.Background(), "RG01001551", MakerCatalogOptions{Mode: "incremental"})
	if err != nil {
		t.Fatal(err)
	}
	if len(profile.WorkCodes) != 1 || profile.WorkCodes[0] != "RJ01234567" {
		t.Fatalf("WorkCodes = %#v", profile.WorkCodes)
	}
}

func TestParseWorkCodesPrefersSearchResultList(t *testing.T) {
	raw := `
		<html>
			<body>
				<div id="search_result_list">
					<div class="n_worklist">
						<a href="/maniax/work/=/product_id/RJ01111111.html">Catalog work</a>
					</div>
				</div>
				<div class="recommend">
					<a href="/maniax/work/=/product_id/RJ09999999.html">Recommended work</a>
				</div>
			</body>
		</html>
	`
	codes := parseWorkCodes(raw)
	if len(codes) != 1 || codes[0] != "RJ01111111" {
		t.Fatalf("codes = %#v", codes)
	}
}

func TestMakerProfileURLsIncludeLanguageOptionsForPages(t *testing.T) {
	urls := makerProfileURLs("https://example.test", "maniax", "RG01001551", 2, []string{"JPN", "CHI_HANS", "NM"})
	if len(urls) != 1 {
		t.Fatalf("urls = %#v", urls)
	}
	got := urls[0]
	wantParts := []string{
		"/maniax/circle/profile/=/page/2/maker_id/RG01001551.html",
		"/options[0]/JPN",
		"/options[1]/CHI_HANS",
		"/options[2]/NM",
	}
	for _, part := range wantParts {
		if !strings.Contains(got, part) {
			t.Fatalf("url %q missing %q", got, part)
		}
	}
}
