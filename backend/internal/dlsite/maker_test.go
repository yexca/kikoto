package dlsite

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func TestMakerCatalogIncrementalReadsPastKnownWorks(t *testing.T) {
	pages := [][]string{
		{"RJ00000001", "RJ00000002"},
		{"RJ00000003", "RJ00000001"},
		{"RJ00000001"},
	}
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if !strings.Contains(r.URL.Path, "/order/release_d") {
			t.Errorf("catalog request does not select release order: %s", r.URL.Path)
		}
		if requests > len(pages) {
			t.Error("incremental catalog read past an entirely known page")
			http.Error(w, "unexpected page", http.StatusBadRequest)
			return
		}
		if requests > 1 && !strings.Contains(r.URL.Path, fmt.Sprintf("/page/%d/", requests)) {
			t.Errorf("catalog page = %s, want page %d", r.URL.Path, requests)
		}
		_, _ = fmt.Fprint(w, `<div id="search_result_list">`)
		for _, code := range pages[requests-1] {
			_, _ = fmt.Fprintf(w, `<a href="/maniax/work/=/product_id/%s.html">Example Work</a>`, code)
		}
		_, _ = fmt.Fprint(w, `</div>`)
	}))
	defer server.Close()

	profile, err := newTestClient(server).FetchMakerCatalog(context.Background(), "RG00001", MakerCatalogOptions{
		Mode: "incremental", MaxPages: 10, KnownWorkCodes: map[string]bool{"RJ00000001": true}, SkipSeries: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if want := []string{"RJ00000002", "RJ00000003"}; !reflect.DeepEqual(profile.WorkCodes, want) {
		t.Fatalf("catalog codes = %v, want %v", profile.WorkCodes, want)
	}
	if requests != 3 || !profile.ReachedEnd {
		t.Fatalf("requests = %d, reached end = %v", requests, profile.ReachedEnd)
	}
}

func TestParseWorkCodesStopsAtTheCatalogElementBoundary(t *testing.T) {
	for _, test := range []struct {
		name      string
		container string
		prefix    string
		want      []string
	}{
		{
			name:      "explicit result list takes precedence",
			container: `<div id="search_result_list" class="catalog">`,
			prefix:    `<div class="n_worklist"><a href="/maniax/work/=/product_id/RJ00000001.html">Example promotion</a></div>`,
			want:      []string{"RJ00000002"},
		},
		{
			name: "single quoted attributes", container: `<div class='catalog' id='search_result_list'>`,
			want: []string{"RJ00000002"},
		},
		{
			name: "work list with multiple classes", container: `<div class="catalog n_worklist grid">`,
			want: []string{"RJ00000002"},
		},
		{name: "missing result list", want: []string{}},
	} {
		t.Run(test.name, func(t *testing.T) {
			raw := test.prefix
			if test.container != "" {
				raw += test.container + `<div><a href="/maniax/work/=/product_id/RJ00000002.html">Example Work</a></div></div>`
			}
			raw += `<section class="recommend_item"><a href="/maniax/work/=/product_id/RJ00000003.html">Example recommendation</a></section>`
			if got := parseWorkCodes(raw); !reflect.DeepEqual(got, test.want) {
				t.Fatalf("catalog codes = %v, want %v", got, test.want)
			}
		})
	}
}
