package dlsite

import (
	"context"
	"net/http"
	"net/http/httptest"
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
