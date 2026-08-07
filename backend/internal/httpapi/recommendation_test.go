package httpapi

import (
	"context"
	"database/sql"
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
)

func TestWorkRecommendationScoreUsesPositiveTagHistory(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	user, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('score-user', 'Score User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := user.LastInsertId()
	liked, _ := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999201', 'Liked')")
	candidate, _ := db.Exec("INSERT INTO work (primary_code, title) VALUES ('RJ09999202', 'Candidate')")
	likedID, _ := liked.LastInsertId()
	candidateID, _ := candidate.LastInsertId()
	tag, err := db.Exec("INSERT INTO tag (namespace, normalized_name, display_name) VALUES ('dlsite', 'sleep', 'Sleep')")
	if err != nil {
		t.Fatal(err)
	}
	tagID, _ := tag.LastInsertId()
	if _, err := db.Exec("INSERT INTO user_work_state (user_id, work_id, listening_status) VALUES (?, ?, 'relisten')", userID, likedID); err != nil {
		t.Fatal(err)
	}
	for _, workID := range []int64{likedID, candidateID} {
		if _, err := db.Exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'test')", workID, tagID); err != nil {
			t.Fatal(err)
		}
	}
	score, err := server.workRecommendationScore(context.Background(), userID, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	if score != 40 {
		t.Fatalf("score = %d, want 40", score)
	}
}

func TestPausedSimilarityNeedsRepeatedEvidence(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID, candidateID, tagID := seedRecommendationUserCandidateAndTag(t, db)
	firstPausedID := insertRecommendationWork(t, db, "RJ09999203", "First shelved")
	linkRecommendationTag(t, db, firstPausedID, tagID)
	setRecommendationState(t, db, userID, firstPausedID, "paused", false)

	breakdown, err := server.libraryStore.RecommendationBreakdown(context.Background(), userID, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Score != 35 || breakdown.Signals.NegativeTagMatches != 0 {
		t.Fatalf("one paused signal breakdown = %+v", breakdown)
	}

	secondPausedID := insertRecommendationWork(t, db, "RJ09999204", "Second shelved")
	linkRecommendationTag(t, db, secondPausedID, tagID)
	setRecommendationState(t, db, userID, secondPausedID, "paused", false)
	breakdown, err = server.libraryStore.RecommendationBreakdown(context.Background(), userID, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Score != 33 || breakdown.Signals.NegativeTagMatches != 1 {
		t.Fatalf("repeated paused signal breakdown = %+v", breakdown)
	}
}

func TestPositiveHistoryBlocksPausedSimilarity(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID, candidateID, tagID := seedRecommendationUserCandidateAndTag(t, db)
	for _, code := range []string{"RJ09999205", "RJ09999206"} {
		workID := insertRecommendationWork(t, db, code, "Shelved")
		linkRecommendationTag(t, db, workID, tagID)
		setRecommendationState(t, db, userID, workID, "paused", false)
	}
	likedID := insertRecommendationWork(t, db, "RJ00000014", "Relisten")
	linkRecommendationTag(t, db, likedID, tagID)
	setRecommendationState(t, db, userID, likedID, "relisten", false)

	breakdown, err := server.libraryStore.RecommendationBreakdown(context.Background(), userID, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Score != 40 || breakdown.Signals.PositiveTagMatches != 1 || breakdown.Signals.NegativeTagMatches != 0 {
		t.Fatalf("positive override breakdown = %+v", breakdown)
	}
}

func TestFinishedHistoryIsNeutralAffinityEvidence(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID, candidateID, tagID := seedRecommendationUserCandidateAndTag(t, db)
	finishedID := insertRecommendationWork(t, db, "RJ00000013", "Finished")
	linkRecommendationTag(t, db, finishedID, tagID)
	setRecommendationState(t, db, userID, finishedID, "finished", false)

	breakdown, err := server.libraryStore.RecommendationBreakdown(context.Background(), userID, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Score != 35 || breakdown.Signals.PositiveTagMatches != 0 || breakdown.Lane != "unmarked" {
		t.Fatalf("finished history breakdown = %+v", breakdown)
	}
}

func TestFavoritePausedHistoryDoesNotPropagateNegativePreference(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID, candidateID, tagID := seedRecommendationUserCandidateAndTag(t, db)
	for _, code := range []string{"RJ09999208", "RJ09999209"} {
		workID := insertRecommendationWork(t, db, code, "Favorite shelved")
		linkRecommendationTag(t, db, workID, tagID)
		setRecommendationState(t, db, userID, workID, "paused", true)
	}

	breakdown, err := server.libraryStore.RecommendationBreakdown(context.Background(), userID, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Signals.NegativeTagMatches != 0 || breakdown.Score != 40 {
		t.Fatalf("favorite paused breakdown = %+v", breakdown)
	}
}

func TestRecommendationListScoreMatchesBreakdown(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID, candidateID, tagID := seedRecommendationUserCandidateAndTag(t, db)
	likedID := insertRecommendationWork(t, db, "RJ09999210", "Liked")
	linkRecommendationTag(t, db, likedID, tagID)
	setRecommendationState(t, db, userID, likedID, "relisten", false)

	breakdown, err := server.libraryStore.RecommendationBreakdown(context.Background(), userID, candidateID)
	if err != nil {
		t.Fatal(err)
	}
	page, err := server.libraryStore.ListPage(context.Background(), library.ListOptions{
		UserID: userID, Page: 1, PageSize: 100, Scope: "all", Status: "all", Sort: "recommend", Direction: "desc", RandomSeed: 71,
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, work := range page.Works {
		if work.ID == candidateID {
			if work.RecommendScore != breakdown.Score {
				t.Fatalf("list score = %d, breakdown score = %d", work.RecommendScore, breakdown.Score)
			}
			return
		}
	}
	t.Fatal("candidate was not returned by recommendation list")
}

func TestRecommendationSeedOrderIsStableAndJitterBounded(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userID, _, _ := seedRecommendationUserCandidateAndTag(t, db)
	highID := insertRecommendationWork(t, db, "RJ09999211", "Favorite candidate")
	setRecommendationState(t, db, userID, highID, "none", true)

	listIDs := func(seed int64) []int64 {
		page, err := server.libraryStore.ListPage(context.Background(), library.ListOptions{
			UserID: userID, Page: 1, PageSize: 100, Scope: "all", Status: "all", Sort: "recommend", Direction: "desc", RandomSeed: seed,
		})
		if err != nil {
			t.Fatal(err)
		}
		ids := make([]int64, len(page.Works))
		for index, work := range page.Works {
			ids[index] = work.ID
		}
		return ids
	}
	first := listIDs(9127)
	second := listIDs(9127)
	if !reflect.DeepEqual(first, second) {
		t.Fatalf("same seed orders differ: %v vs %v", first, second)
	}
	for _, seed := range []int64{1, 2, 999999} {
		ids := listIDs(seed)
		if len(ids) == 0 || ids[0] != highID {
			t.Fatalf("seed %d moved score-45 work behind a score-35 work: %v", seed, ids)
		}
	}
}

func TestRecommendationTelemetryRejectsArbitraryFieldsAndAggregates(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('telemetry-user', 'Telemetry User', 'admin')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workID := insertRecommendationWork(t, db, "RJ09999212", "Telemetry candidate")
	user := account.User{ID: userID, Username: "telemetry-user", Role: "admin", Permissions: account.PermissionsForRole("admin")}

	request := httptest.NewRequest(http.MethodPost, "/api/recommendation-events", strings.NewReader(`{"events":[{"workId":`+jsonInt(workID)+`,"eventType":"impression","contextId":"library:seed-3","seed":3,"rank":1,"score":61}]}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
	response := httptest.NewRecorder()
	server.recordRecommendationEvents(response, request)
	if response.Code != http.StatusCreated {
		t.Fatalf("record status = %d, body = %s", response.Code, response.Body.String())
	}
	var algorithmVersion string
	if err := db.QueryRow("SELECT algorithm_version FROM recommendation_event ORDER BY id DESC LIMIT 1").Scan(&algorithmVersion); err != nil {
		t.Fatal(err)
	}
	if algorithmVersion != library.RecommendationAlgorithmVersion {
		t.Fatalf("recorded algorithm version = %q, want %q", algorithmVersion, library.RecommendationAlgorithmVersion)
	}

	invalid := httptest.NewRequest(http.MethodPost, "/api/recommendation-events", strings.NewReader(`{"events":[{"workId":`+jsonInt(workID)+`,"eventType":"search","contextId":"private query"}]}`))
	invalid = invalid.WithContext(context.WithValue(invalid.Context(), currentUserKey, user))
	invalidResponse := httptest.NewRecorder()
	server.recordRecommendationEvents(invalidResponse, invalid)
	if invalidResponse.Code != http.StatusBadRequest {
		t.Fatalf("invalid event status = %d, body = %s", invalidResponse.Code, invalidResponse.Body.String())
	}

	telemetryRequest := httptest.NewRequest(http.MethodGet, "/api/recommendation-telemetry", nil)
	telemetryRequest = telemetryRequest.WithContext(context.WithValue(telemetryRequest.Context(), currentUserKey, user))
	telemetryResponse := httptest.NewRecorder()
	server.getRecommendationTelemetry(telemetryResponse, telemetryRequest)
	if telemetryResponse.Code != http.StatusOK {
		t.Fatalf("telemetry status = %d, body = %s", telemetryResponse.Code, telemetryResponse.Body.String())
	}
	var summary recommendationTelemetrySummary
	if err := json.Unmarshal(telemetryResponse.Body.Bytes(), &summary); err != nil {
		t.Fatal(err)
	}
	if summary.TotalEvents != 1 || summary.EventCounts["impression"] != 1 || summary.ScoreBuckets["60-79"] != 1 {
		t.Fatalf("telemetry summary = %+v", summary)
	}
}

func seedRecommendationUserCandidateAndTag(t *testing.T, db recommendationTestDB) (int64, int64, int64) {
	t.Helper()
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('recommend-user', 'Recommend User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	candidateID := insertRecommendationWork(t, db, "RJ09999202", "Candidate")
	tagResult, err := db.Exec("INSERT INTO tag (namespace, normalized_name, display_name) VALUES ('dlsite', 'sleep', 'Sleep')")
	if err != nil {
		t.Fatal(err)
	}
	tagID, _ := tagResult.LastInsertId()
	linkRecommendationTag(t, db, candidateID, tagID)
	return userID, candidateID, tagID
}

type recommendationTestDB interface {
	Exec(query string, args ...any) (sql.Result, error)
}

func insertRecommendationWork(t *testing.T, db recommendationTestDB, code string, title string) int64 {
	t.Helper()
	result, err := db.Exec("INSERT INTO work (primary_code, title) VALUES (?, ?)", code, title)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := result.LastInsertId()
	return id
}

func linkRecommendationTag(t *testing.T, db recommendationTestDB, workID int64, tagID int64) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, 'test')", workID, tagID); err != nil {
		t.Fatal(err)
	}
}

func setRecommendationState(t *testing.T, db recommendationTestDB, userID int64, workID int64, status string, favorite bool) {
	t.Helper()
	if _, err := db.Exec("INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (?, ?, ?, ?)", userID, workID, status, favorite); err != nil {
		t.Fatal(err)
	}
}

func jsonInt(value int64) string {
	return strconv.FormatInt(value, 10)
}
