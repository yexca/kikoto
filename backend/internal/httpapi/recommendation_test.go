package httpapi

import (
	"context"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
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
	if score != 60 {
		t.Fatalf("score = %d, want 60", score)
	}
}
