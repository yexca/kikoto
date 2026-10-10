package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/config"
)

// A reported position is as large as the list it comes from, so an impression
// deep in a large library is recorded like one on the first page.
func TestRecommendationEventsAcceptDeepListPositions(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-user', 'Example User', 'admin')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workID := insertRecommendationWork(t, db, "RJ00000010", "Example Work")
	user := account.User{ID: userID, Username: "synthetic-user", Role: "admin", Permissions: account.PermissionsForRole("admin")}
	record := func(rank int) int {
		body := fmt.Sprintf(`{"events":[{"workId":%d,"eventType":"impression","contextId":"library:seed-3","rank":%d,"score":12}]}`, workID, rank)
		request := httptest.NewRequest(http.MethodPost, "/api/recommendation-events", strings.NewReader(body))
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, user))
		response := httptest.NewRecorder()
		server.recordRecommendationEvents(response, request)
		return response.Code
	}

	for _, rank := range []int{1, 10000, 10001, 250048} {
		if status := record(rank); status != http.StatusCreated {
			t.Fatalf("rank %d = %d, want 201", rank, status)
		}
	}
	if status := record(-1); status != http.StatusBadRequest {
		t.Fatalf("negative rank = %d, want 400", status)
	}
	var recorded int
	if err := db.QueryRow("SELECT COUNT(*) FROM recommendation_event WHERE rank > 10000").Scan(&recorded); err != nil || recorded != 2 {
		t.Fatalf("deep-position events recorded = %d, %v; want 2", recorded, err)
	}
}
