package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/library"
)

// newDemoAdmissionServer bootstraps Demo over works 1 and 2, which are
// admitted and local; 3 is adult, 4 is paid, and 5 has no local files.
func newDemoAdmissionServer(t *testing.T) *Server {
	t.Helper()
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{Mode: config.ModeDemo})
	if err := s.BootstrapDemo(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder');
		INSERT INTO work (id, primary_code, title, age_rating, is_permanently_free) VALUES
			(1, 'RJ00000001', 'Example One', 'general', 1),
			(2, 'RJ00000002', 'Example Two', 'general', 1),
			(3, 'RJ00000003', 'Example Three', 'adult', 1),
			(4, 'RJ00000004', 'Example Four', 'general', 0),
			(5, 'RJ00000005', 'Example Five', 'general', 1);
		INSERT INTO work_source_presence (work_id, file_source_id, presence_type, availability) VALUES
			(1, 1, 'local', 'available'), (2, 1, 'local', 'available'),
			(3, 1, 'local', 'available'), (4, 1, 'local', 'available');
	`); err != nil {
		t.Fatal(err)
	}
	return s
}

// Demo shows For you as a random sample of the admitted local works and
// records no impression, while every other write stays refused.
func TestDemoForYouSamplesAdmittedWorksWithoutRecording(t *testing.T) {
	s := newDemoAdmissionServer(t)
	response := httptest.NewRecorder()
	s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/for-you/draw", strings.NewReader(`{}`)))
	var draw struct {
		AlgorithmVersion string `json:"algorithmVersion"`
		Columns          []struct {
			Column string `json:"column"`
			Items  []struct {
				Work   struct{ ID int64 } `json:"work"`
				Reason struct{ Kind string }
			} `json:"items"`
		} `json:"columns"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &draw) != nil {
		t.Fatalf("Demo draw = %d %s", response.Code, response.Body.String())
	}
	if draw.AlgorithmVersion != demoForYouAlgorithmVersion || len(draw.Columns) != 3 {
		t.Fatalf("Demo draw = %+v", draw)
	}
	for _, column := range draw.Columns {
		if len(column.Items) == 0 {
			t.Fatalf("column %s is empty", column.Column)
		}
		for _, item := range column.Items {
			if item.Work.ID != 1 && item.Work.ID != 2 {
				t.Fatalf("column %s drew work %d outside the admitted local works", column.Column, item.Work.ID)
			}
			if item.Reason.Kind == "" {
				t.Fatalf("column %s gave work %d no reason", column.Column, item.Work.ID)
			}
		}
	}
	var events int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM recommendation_event").Scan(&events); err != nil || events != 0 {
		t.Fatalf("Demo draw recorded %d events, %v", events, err)
	}
	// Saving a temperature is still a write.
	response = httptest.NewRecorder()
	s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPatch, "/api/auth/me/preferences", strings.NewReader(`{"forYouTemperature":"safe"}`)))
	if response.Code != http.StatusForbidden {
		t.Fatalf("PATCH preferences in Demo = %d", response.Code)
	}
}

// A column prefers works no other column shows, and repeats one only when the
// library runs out.
func TestDemoForYouDrawPrefersUnshownWorks(t *testing.T) {
	works := []demoShowcaseWork{{id: 1}, {id: 2}, {id: 3}}
	first := func(int) int { return 0 }
	draw := demoForYouDraw(works, []library.ForYouColumn{library.ForYouTryNew}, []int64{1, 2}, first)
	if len(draw) != 1 || len(draw[0].Picks) != 3 || draw[0].Picks[0].WorkID != 3 {
		t.Fatalf("draw = %+v", draw)
	}
	draw = demoForYouDraw(works, []library.ForYouColumn{library.ForYouMaybeLike, library.ForYouListenAgain}, nil, first)
	if len(draw) != 2 || len(draw[1].Picks) != 3 {
		t.Fatalf("draw = %+v", draw)
	}
	for _, pick := range draw[1].Picks {
		if pick.Reason.Kind != "since_played" || pick.Reason.Days < 7 {
			t.Fatalf("Listen again reason = %+v", pick.Reason)
		}
	}
}

// Demo shows Translate with AI's plan and the sample models, and still refuses
// the request.
func TestDemoShowsTranslationPlanAndSampleModels(t *testing.T) {
	s := newDemoAdmissionServer(t)
	get := func(path string) *httptest.ResponseRecorder {
		response := httptest.NewRecorder()
		s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		return response
	}
	response := get("/api/works/1/ai-translation?languages=en-us")
	var plan translationPlanResponse
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &plan) != nil {
		t.Fatalf("Demo plan = %d %s", response.Code, response.Body.String())
	}
	if !plan.Permissions.Metadata || !plan.Permissions.Files || !plan.Permissions.Lyrics || len(plan.Languages) != 1 {
		t.Fatalf("Demo plan = %+v", plan)
	}
	if response := get("/api/works/3/ai-translation?languages=en-us"); response.Code != http.StatusNotFound {
		t.Fatalf("plan of a restricted work = %d", response.Code)
	}

	response = get("/api/llm/translation-models?workId=1")
	var models []struct {
		ID string `json:"id"`
	}
	if response.Code != http.StatusOK || json.Unmarshal(response.Body.Bytes(), &models) != nil || len(models) == 0 {
		t.Fatalf("Demo models = %d %s", response.Code, response.Body.String())
	}
	for _, model := range models {
		if !strings.HasPrefix(model.ID, "demo-") {
			t.Fatalf("Demo model %q is not a sample", model.ID)
		}
	}

	response = httptest.NewRecorder()
	s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, "/api/works/1/ai-translation", strings.NewReader(`{"languages":["en-us"],"categories":["title"]}`)))
	if response.Code != http.StatusForbidden {
		t.Fatalf("Demo translation request = %d", response.Code)
	}
}

// Demo lists where Manage files could take files from, and refuses the edit.
func TestDemoListsFolderEditSourcesAndRefusesTheEdit(t *testing.T) {
	s := newDemoAdmissionServer(t)
	response := httptest.NewRecorder()
	s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/works/1/folder-edit/sources", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("Demo folder edit sources = %d %s", response.Code, response.Body.String())
	}
	for _, path := range []string{"/api/works/1/folder-edit/plan", "/api/works/1/folder-edit", "/api/works/1/folder-edit/sources/check"} {
		response = httptest.NewRecorder()
		s.Routes().ServeHTTP(response, httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`)))
		if response.Code != http.StatusForbidden {
			t.Fatalf("POST %s in Demo = %d", path, response.Code)
		}
	}
}
