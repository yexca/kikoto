package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRemoteRecommendationsScoreTransientWorksWithoutFetchingOrMaterializing(t *testing.T) {
	requests := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer upstream.Close()
	s := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	metadataReviewExec(t, s.db, "UPDATE file_source SET code = 'example_remote_a', display_name = 'Example Remote A' WHERE id = 7")
	userID := metadataReviewExec(t, s.db, "INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-user', 'Example User', 'user')")
	likedID := metadataReviewExec(t, s.db, "INSERT INTO work (primary_code, title) VALUES (?, 'Example Work 1')", testfixture.WorkCode(testfixture.PrefixRJ, 1))
	knownCode := testfixture.WorkCode(testfixture.PrefixRJ, 2)
	knownID := metadataReviewExec(t, s.db, "INSERT INTO work (primary_code, title) VALUES (?, 'Example Work 2')", knownCode)
	metadataReviewExec(t, s.db, "INSERT INTO user_work_state (user_id, work_id, listening_status) VALUES (?, ?, 'relisten')", userID, likedID)
	voiceID := metadataReviewExec(t, s.db, "INSERT INTO person (display_name) VALUES ('Example Voice')")
	circleID := metadataReviewExec(t, s.db, "INSERT INTO party (display_name) VALUES ('Example Circle')")
	for _, workID := range []int64{likedID, knownID} {
		metadataReviewExec(t, s.db, "INSERT INTO work_credit (work_id, person_id, role, source) VALUES (?, ?, 'voice_actor', 'test')", workID, voiceID)
		metadataReviewExec(t, s.db, "INSERT INTO work_party (work_id, party_id, role, source) VALUES (?, ?, 'circle', 'test')", workID, circleID)
	}
	user := currentUser{ID: userID, Role: "user", Permissions: []string{"library:read"}}
	publishRecommendationTestCatalog(t, s)
	candidates := []library.RecommendationCandidate{
		{PrimaryCode: knownCode, WorkID: &knownID},
		{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 3), VoiceActors: []string{"Example Voice", "Example Voice"}, Circle: "Example Circle"},
	}
	request := func(candidates []library.RecommendationCandidate, session string, authenticated bool) *httptest.ResponseRecorder {
		t.Helper()
		payload, err := json.Marshal(remoteRecommendationRequest{SessionID: session, Works: candidates})
		if err != nil {
			t.Fatal(err)
		}
		r := httptest.NewRequest(http.MethodPost, "/api/remote-sources/7/recommendations", strings.NewReader(string(payload)))
		r.SetPathValue("id", "7")
		if authenticated {
			r = r.WithContext(context.WithValue(r.Context(), currentUserKey, user))
		}
		response := httptest.NewRecorder()
		s.scoreRemoteRecommendations(response, r)
		return response
	}
	response := request(candidates, "synthetic-session", true)
	if response.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", response.Code, response.Body.String())
	}
	var result struct {
		Scores []remoteRecommendationScore `json:"scores"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Scores) != 2 || result.Scores[0].Score != 60 || result.Scores[1].Score != 60 {
		t.Fatalf("scores=%+v", result.Scores)
	}
	metadataReviewExec(t, s.db, "UPDATE user_work_state SET listening_status = 'finished' WHERE user_id = ?", userID)
	if frozen := request(candidates, "synthetic-session", true); frozen.Body.String() != response.Body.String() {
		t.Fatalf("session changed: %s", frozen.Body.String())
	}
	if fresh := request(candidates, "synthetic-session-new", true); strings.Contains(fresh.Body.String(), `"score":60`) {
		t.Fatalf("new session retained old evidence: %s", fresh.Body.String())
	}
	var count int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM work").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 || requests != 0 {
		t.Fatalf("works=%d upstream requests=%d", count, requests)
	}
	if unauthorized := request(candidates, "synthetic-session", false); unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("anonymous status=%d", unauthorized.Code)
	}
	if invalid := request(candidates, "invalid/session", true); invalid.Code != http.StatusBadRequest {
		t.Fatalf("invalid session status=%d", invalid.Code)
	}
	if invalid := request([]library.RecommendationCandidate{{PrimaryCode: testfixture.WorkCode(testfixture.PrefixRJ, 3), WorkID: &knownID}}, "synthetic-session", true); invalid.Code != http.StatusBadRequest {
		t.Fatalf("mismatched work identity status=%d", invalid.Code)
	}
	if invalid := request(make([]library.RecommendationCandidate, 101), "synthetic-session", true); invalid.Code != http.StatusBadRequest {
		t.Fatalf("oversized page status=%d", invalid.Code)
	}
	if invalid := request([]library.RecommendationCandidate{{PrimaryCode: "RJ00000000", Tags: []string{strings.Repeat("x", 513)}}}, "synthetic-session", true); invalid.Code != http.StatusBadRequest {
		t.Fatalf("oversized name status=%d", invalid.Code)
	}
}

func TestRemoteRecommendationBadgesSurvivePostFiltering(t *testing.T) {
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"works": []map[string]any{{"id": 1, "source_id": code, "title": "Example Work"}}, "pagination": map[string]int{"totalCount": 1}})
	}))
	defer upstream.Close()
	s := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	for _, query := range []string{"", "$-mytag:Example excluded$"} {
		r := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works?recommendBadges=true&q="+url.QueryEscape(query), nil)
		r.SetPathValue("id", "7")
		response := httptest.NewRecorder()
		s.listRemoteSourceWorks(response, r)
		var result remoteWorksResponse
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || len(result.Works) != 1 || result.Works[0].RecommendScore != 35 {
			t.Fatalf("query=%q body=%s", query, response.Body.String())
		}
	}
}

func TestRemoteBrowseOptionalRecommendationFailurePreservesCardsAndHealth(t *testing.T) {
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"works": []map[string]any{{"id": 1, "source_id": code, "title": "Example Work"}}, "pagination": map[string]int{"totalCount": 1}})
	}))
	defer upstream.Close()
	s := newRemoteTextPreviewServer(t, upstream.URL, upstream.URL+"/media/track.wav")
	userID := metadataReviewExec(t, s.db, "INSERT INTO user_account (username, display_name, role) VALUES ('remote-badges-user', 'Example User', 'user')")
	for _, query := range []string{"", "$-mytag:Example excluded$"} {
		r := httptest.NewRequest(http.MethodGet, "/api/remote-sources/7/works?recommendBadges=true&q="+url.QueryEscape(query), nil)
		r.SetPathValue("id", "7")
		r = r.WithContext(context.WithValue(r.Context(), currentUserKey, currentUser{ID: userID}))
		response := httptest.NewRecorder()
		s.listRemoteSourceWorks(response, r)
		var result remoteWorksResponse
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusOK || result.Status != "ok" || result.Error != nil || result.Total != 1 || len(result.Works) != 1 || !result.RecommendationUnavailable {
			t.Fatalf("query=%q status=%d body=%s", query, response.Code, response.Body.String())
		}
	}
}
