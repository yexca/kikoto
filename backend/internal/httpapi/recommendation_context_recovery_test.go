package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRecommendationContextExpiryIsDistinctFromInvalidOwnership(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID, candidateID, tagID := seedRecommendationUserCandidateAndTag(t, db)
	likedID := insertRecommendationWork(t, db, testfixture.WorkCode(testfixture.PrefixRJ, 2), "Example Liked Work")
	linkRecommendationTag(t, db, likedID, tagID)
	setRecommendationState(t, db, userID, likedID, "relisten", false)
	publishRecommendationTestCatalog(t, server)
	ctx := context.Background()
	page, err := server.libraryStore.ListPage(ctx, library.ListOptions{UserID: userID, Page: 1, PageSize: 24, Sort: "recommend", Direction: "desc", RandomSeed: 17, RecommendationSessionID: "example-context-expiry"})
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := server.libraryStore.PrepareRecommendationSession(ctx, userID, "example-context-expiry")
	if err != nil {
		t.Fatal(err)
	}
	before, err := server.libraryStore.RecommendationSnapshotBreakdown(ctx, snapshot, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	if before.Score <= snapshot.Config.AffinityBase {
		t.Fatal("fixture lacks personal affinity")
	}
	if _, err := db.Exec(`DELETE FROM recommendation_query_context WHERE id=?`, page.RecommendationContext); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE user_work_state SET listening_status='none' WHERE user_id=? AND work_id=?`, userID, likedID); err != nil {
		t.Fatal(err)
	}
	requestScore := func(principal int64, session, contextID string) *httptest.ResponseRecorder {
		t.Helper()
		url := "/api/works/1/recommendation?recommendationSession=" + session
		if contextID != "" {
			url += "&recommendationContext=" + contextID
		}
		request := httptest.NewRequest(http.MethodGet, url, nil)
		request.SetPathValue("id", strconv.FormatInt(candidateID, 10))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, account.User{ID: principal}))
		response := httptest.NewRecorder()
		server.getWorkRecommendation(response, request)
		return response
	}
	expired := requestScore(userID, "example-context-expiry", page.RecommendationContext)
	if expired.Code != http.StatusGone || !strings.Contains(expired.Body.String(), `"code":"recommendation_context_expired"`) {
		t.Fatalf("expired status=%d body=%s", expired.Code, expired.Body.String())
	}
	recovered := requestScore(userID, "example-context-expiry", "")
	if recovered.Code != http.StatusOK {
		t.Fatalf("fallback status=%d body=%s", recovered.Code, recovered.Body.String())
	}
	var affinity library.RecommendationBreakdown
	if err := json.Unmarshal(recovered.Body.Bytes(), &affinity); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before, affinity) || affinity.Ordering != nil {
		t.Fatal("same-session recovery changed affinity or supplied stale ordering")
	}
	result, err := db.Exec(`INSERT INTO user_account(username,display_name,role) VALUES('synthetic-other-context-user','Example Other User','user')`)
	if err != nil {
		t.Fatal(err)
	}
	otherID, err := result.LastInsertId()
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		userID         int64
		session, token string
	}{
		{otherID, "example-context-expiry", page.RecommendationContext},
		{userID, "example-new-generation", page.RecommendationContext},
		{userID, "example-context-expiry", strings.Repeat("0", 64)},
	} {
		invalid := requestScore(test.userID, test.session, test.token)
		if invalid.Code != http.StatusBadRequest || !strings.Contains(invalid.Body.String(), `"code":"invalid_request"`) {
			t.Fatalf("foreign/tampered status=%d body=%s", invalid.Code, invalid.Body.String())
		}
	}
	var privateKey string
	if err := db.QueryRow(`SELECT json_extract(profile_json,'$.contextSigningKey') FROM recommendation_generation_profile WHERE generation_id=?`, snapshot.GenerationID).Scan(&privateKey); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(recovered.Body.String(), privateKey) || strings.Contains(recovered.Body.String(), "contextSigningKey") {
		t.Fatal("private signing key escaped the API")
	}
}
