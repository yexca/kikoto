package httpapi

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// Demo's Translation page shows a sample of every stage, counted the way the
// stored views are.
func TestDemoTranslationSamplesCoverEveryView(t *testing.T) {
	works := []demoTranslationWork{
		{id: 1, code: "RJ00000001", title: "Example One", tag: "Example tag"},
		{id: 2, code: "RJ00000002", title: "Example Two"},
		{id: 3, code: "RJ00000003", title: "Example Three"},
	}
	samples := buildDemoTranslationSamples(works, time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC))

	counts := samples.counts()
	if counts["active"] != 1 || counts["queued"] != 1 || counts["review"] != 3 || counts["attention"] != 3 {
		t.Fatalf("counts = %v, want one active and one queued run, 3 to review, 3 stopped", counts)
	}
	stages := map[string]string{}
	for _, language := range samples.active[0].Languages {
		stages[language.Language] = language.Stage
	}
	if stages["en-us"] != "translating" || stages["zh-cn"] != "queued" {
		t.Fatalf("active run stages = %v", stages)
	}
	if run := samples.queued[0]; run.WorkCode != "RJ00000002" || run.CanCancel || run.Languages[0].Stage != "queued" {
		t.Fatalf("queued run = %+v", run)
	}
	for _, item := range samples.itemsFor([]string{"history"}, 0, nil) {
		if item.State != "accepted" || item.WorkID != 3 {
			t.Fatalf("history item = %+v", item)
		}
	}
	if items := samples.itemsFor([]string{"review", "attention"}, 0, []int64{2}); len(items) != 3 {
		t.Fatalf("work 2 review and attention items = %d, want its 3 stopped items", len(items))
	}
	for _, item := range samples.items {
		if item.Result != "" && !strings.HasPrefix(item.Result, "Sample") {
			t.Fatalf("item result %q does not read as a sample", item.Result)
		}
	}

	// Fewer admitted works leave their samples out rather than inventing works.
	if empty := buildDemoTranslationSamples(nil, time.Now()); len(empty.items) != 0 || len(empty.active) != 0 {
		t.Fatalf("samples without works = %+v", empty)
	}
}

func TestDemoTranslationPageListsSamplesOverAdmittedWorks(t *testing.T) {
	s := newDemoAdmissionServer(t)
	get := func(path string, into any) {
		t.Helper()
		response := httptest.NewRecorder()
		s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), into) != nil {
			t.Fatalf("GET %s = %d %s", path, response.Code, response.Body.String())
		}
	}
	var runs struct {
		Runs   []translationRunResponse `json:"runs"`
		Counts map[string]int           `json:"counts"`
	}
	get("/api/translation/runs?view=active", &runs)
	if len(runs.Runs) != 1 || runs.Runs[0].WorkCode != "RJ00000001" || runs.Counts["queued"] != 1 {
		t.Fatalf("active runs = %+v", runs)
	}
	var items struct {
		Items []translationItemResponse `json:"items"`
	}
	get("/api/translation/items?view=attention&workId=2", &items)
	if len(items.Items) != 3 {
		t.Fatalf("work 2 attention items = %+v", items.Items)
	}
	for _, item := range items.Items {
		if item.WorkCode != "RJ00000002" {
			t.Fatalf("attention item of another work: %+v", item)
		}
	}

	// Reviewing stays refused.
	response := httptest.NewRecorder()
	s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/translation/items/accept", strings.NewReader(`{"ids":[900001]}`)))
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), `"code":"demo_read_only"`) {
		t.Fatalf("accept = %d %s, want demo_read_only", response.Code, response.Body.String())
	}
}
