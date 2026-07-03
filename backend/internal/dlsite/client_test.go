package dlsite

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestFetchProductUsesCandidateSiteAndParsesProduct(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/maniax/api/=/product.json" {
			t.Fatalf("path = %s", r.URL.Path)
		}
		if r.URL.Query().Get("workno") != "RJ01569979" {
			t.Fatalf("workno = %s", r.URL.Query().Get("workno"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"workno":"RJ01569979","product_name":"Example","work_name_kana":"エグザンプル","intro_s":"Short","regist_date":"2024-01-02","age_category_string":"adult"}]`))
	}))
	defer server.Close()

	client := NewClient(server.Client())
	client.baseURL = server.URL

	product, err := client.FetchProduct(context.Background(), "rj01569979")
	if err != nil {
		t.Fatal(err)
	}
	if product.WorkNo != "RJ01569979" {
		t.Fatalf("WorkNo = %s", product.WorkNo)
	}
	if product.ProductName != "Example" {
		t.Fatalf("ProductName = %s", product.ProductName)
	}
	if len(product.Raw) == 0 {
		t.Fatal("expected raw product snapshot")
	}
}
