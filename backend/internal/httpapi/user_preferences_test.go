package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestUserPreferencesIsolationAndRecommendationSessions(t *testing.T) {
	db := openMigratedTestDB(t)
	for _, name := range []string{"synthetic-user-a", "synthetic-user-b"} {
		if _, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES (?, ?, 'user')", name, name); err != nil {
			t.Fatal(err)
		}
	}
	var firstID, secondID int64
	if err := db.QueryRow("SELECT id FROM user_account WHERE username = 'synthetic-user-a'").Scan(&firstID); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT id FROM user_account WHERE username = 'synthetic-user-b'").Scan(&secondID); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{})
	if _, err := db.Exec("INSERT INTO app_setting (key, value_json) VALUES ('recommendation_threshold', '64')"); err != nil {
		t.Fatal(err)
	}
	requestFor := func(id int64, body string) *http.Request {
		req := httptest.NewRequest(http.MethodPatch, "/api/auth/me/preferences", strings.NewReader(body))
		return req.WithContext(context.WithValue(req.Context(), currentUserKey, currentUser{ID: id, Role: "user"}))
	}
	first, err := server.loadUserPreferences(requestFor(firstID, ""), firstID)
	if err != nil || first.RecommendationThreshold != 64 {
		t.Fatalf("defaults = %+v, %v", first, err)
	}
	old, err := server.libraryStore.PrepareRecommendationSession(context.Background(), firstID, "old-session")
	if err != nil {
		t.Fatal(err)
	}
	updated := first.RecommendationConfig
	updated.TagWeight = 13
	payload, err := json.Marshal(map[string]any{"recommendationConfig": updated, "recommendationThreshold": 73})
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	server.updateUserPreferences(response, requestFor(firstID, string(payload)))
	if response.Code != http.StatusOK {
		t.Fatalf("save: %d %s", response.Code, response.Body.String())
	}
	response = httptest.NewRecorder()
	server.updateUserPreferences(response, requestFor(firstID, `{"directoryRoutingRules":[]}`))
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	saved, err := server.loadUserPreferences(requestFor(firstID, ""), firstID)
	if err != nil || saved.RecommendationThreshold != 73 || saved.RecommendationConfig != updated || len(saved.DirectoryRoutingRules) != 0 {
		t.Fatalf("partial update: %+v %v", saved, err)
	}
	other, err := server.loadUserPreferences(requestFor(secondID, ""), secondID)
	if err != nil || other.RecommendationThreshold != 64 || other.RecommendationConfig != first.RecommendationConfig || len(other.DirectoryRoutingRules) == 0 {
		t.Fatalf("other user changed: %+v %v", other, err)
	}
	retained, err := server.libraryStore.PrepareRecommendationSession(context.Background(), firstID, "old-session")
	if err != nil || retained != old {
		t.Fatalf("existing session changed: %+v %v", retained, err)
	}
	next, err := server.libraryStore.PrepareRecommendationSession(context.Background(), firstID, "new-session")
	if err != nil || next.Config != updated || next.GenerationID == old.GenerationID {
		t.Fatalf("new session: %+v %v", next, err)
	}
	if got := server.libraryStore.LoadUserRecommendationConfig(context.Background(), secondID); got != first.RecommendationConfig {
		t.Fatal("another user inherited override")
	}
	runtime := httptest.NewRecorder()
	server.getRuntimeSettings(runtime, requestFor(firstID, ""))
	var visible struct {
		RecommendationThreshold int             `json:"recommendationThreshold"`
		DirectoryRoutingRules   []directoryRule `json:"directoryRoutingRules"`
	}
	if err := json.Unmarshal(runtime.Body.Bytes(), &visible); err != nil {
		t.Fatal(err)
	}
	if visible.RecommendationThreshold != 73 || len(visible.DirectoryRoutingRules) != 0 {
		t.Fatalf("runtime preferences: %+v", visible)
	}
	for _, invalid := range []string{`{"userId":2}`, `{"recommendationThreshold":101}`, `{"recommendationConfig":{"unmarkedSlots":0}}`} {
		response = httptest.NewRecorder()
		server.updateUserPreferences(response, requestFor(firstID, invalid))
		if response.Code != http.StatusBadRequest {
			t.Fatalf("invalid update accepted: %s", invalid)
		}
	}
}

func TestUserPreferencesRejectAnonymousAndDemoWrites(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{Mode: config.ModeDemo})
	for _, handler := range []http.HandlerFunc{server.getUserPreferences, server.updateUserPreferences} {
		response := httptest.NewRecorder()
		handler(response, httptest.NewRequest(http.MethodGet, "/api/auth/me/preferences", nil))
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous preferences: %d", response.Code)
		}
	}
	response := httptest.NewRecorder()
	server.demoReadOnlyMiddleware(http.HandlerFunc(server.updateUserPreferences)).ServeHTTP(response, httptest.NewRequest(http.MethodPatch, "/api/auth/me/preferences", strings.NewReader(`{"recommendationThreshold":50}`)))
	if response.Code != http.StatusForbidden {
		t.Fatalf("demo preferences: %d", response.Code)
	}
}
