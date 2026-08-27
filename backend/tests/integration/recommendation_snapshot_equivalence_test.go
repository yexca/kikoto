package integration_test

import (
	"context"
	"fmt"
	"reflect"
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestRecommendationGenerationMatchesLiveScoring(t *testing.T) {
	db := openMigratedTestDB(t, "recommendation-generation-equivalence.db")
	mustExec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Exec(query, args...); err != nil {
			t.Fatalf("fixture query failed: %v\n%s", err, query)
		}
	}

	userResult, err := db.Exec("INSERT INTO user_account (username, display_name, role) VALUES ('synthetic-user', 'Example User', 'user')")
	if err != nil {
		t.Fatal(err)
	}
	userID, _ := userResult.LastInsertId()
	workIDs := make([]int64, 9)
	for index := range workIDs {
		result, insertErr := db.Exec(
			"INSERT INTO work (primary_code, title) VALUES (?, ?)",
			testfixture.WorkCode(testfixture.PrefixRJ, 30+index),
			fmt.Sprintf("Example Work %d", index),
		)
		if insertErr != nil {
			t.Fatal(insertErr)
		}
		workIDs[index], _ = result.LastInsertId()
	}

	for tagID, values := range []struct {
		namespace string
		name      string
	}{
		{namespace: "dlsite", name: "shared-positive"},
		{namespace: "dlsite", name: "shared-negative"},
		{namespace: "dlsite", name: "self-positive"},
		{namespace: "dlsite", name: "favorite-positive"},
		{namespace: "manual", name: "ignored-manual"},
	} {
		mustExec(
			"INSERT INTO tag (id, namespace, normalized_name, display_name) VALUES (?, ?, ?, ?)",
			tagID+1, values.namespace, values.name, "Example Tag "+values.name,
		)
	}
	for index := 0; index < 4; index++ {
		mustExec("INSERT INTO person (id, display_name) VALUES (?, ?)", index+1, fmt.Sprintf("Example Voice %d", index))
		mustExec("INSERT INTO party (id, display_name) VALUES (?, ?)", index+1, fmt.Sprintf("Example Circle %d", index))
	}

	setState := func(workIndex int, status string, favorite int) {
		t.Helper()
		mustExec(
			"INSERT INTO user_work_state (user_id, work_id, listening_status, favorite) VALUES (?, ?, ?, ?)",
			userID, workIDs[workIndex], status, favorite,
		)
	}
	setState(0, "relisten", 0)
	setState(1, "finished", 1)
	setState(2, "paused", 0)
	setState(3, "paused", 0)
	setState(5, "relisten", 0)
	setState(6, "paused", 0)

	linkTag := func(workIndex, tagID int, source string) {
		t.Helper()
		mustExec("INSERT INTO work_tag (work_id, tag_id, source) VALUES (?, ?, ?)", workIDs[workIndex], tagID, source)
	}
	for _, workIndex := range []int{0, 2, 3, 4} {
		linkTag(workIndex, 1, "dlsite")
	}
	linkTag(4, 1, "manual_override")
	for _, workIndex := range []int{2, 3, 4, 6} {
		linkTag(workIndex, 2, "dlsite")
	}
	linkTag(5, 3, "dlsite")
	for _, workIndex := range []int{1, 4} {
		linkTag(workIndex, 4, "dlsite")
	}
	for _, workIndex := range []int{0, 8} {
		linkTag(workIndex, 5, "manual_override")
	}

	linkVoice := func(workIndex, personID int) {
		t.Helper()
		mustExec("INSERT INTO work_credit (work_id, person_id, role, source) VALUES (?, ?, 'voice_actor', 'test')", workIDs[workIndex], personID)
	}
	linkCircle := func(workIndex, partyID int) {
		t.Helper()
		mustExec("INSERT INTO work_party (work_id, party_id, role, source) VALUES (?, ?, 'circle', 'test')", workIDs[workIndex], partyID)
	}
	for _, workIndex := range []int{0, 2, 3, 4} {
		linkVoice(workIndex, 1)
		linkCircle(workIndex, 1)
	}
	for _, workIndex := range []int{2, 3, 4, 6} {
		linkVoice(workIndex, 2)
		linkCircle(workIndex, 2)
	}
	linkVoice(5, 3)
	linkCircle(5, 3)
	for _, workIndex := range []int{1, 4} {
		linkVoice(workIndex, 4)
		linkCircle(workIndex, 4)
	}

	store := library.NewStore(db)
	snapshot, err := store.PrepareRecommendationSession(context.Background(), userID, "equivalence-session")
	if err != nil {
		t.Fatal(err)
	}
	for index, workID := range workIDs {
		live, liveErr := store.RecommendationBreakdownWithConfig(context.Background(), userID, workID, snapshot.Config)
		if liveErr != nil {
			t.Fatalf("live breakdown for work %d failed: %v", index, liveErr)
		}
		stored, storedErr := store.RecommendationSnapshotBreakdown(context.Background(), snapshot, workID)
		if storedErr != nil {
			t.Fatalf("snapshot breakdown for work %d failed: %v", index, storedErr)
		}
		if !reflect.DeepEqual(stored, live) {
			t.Errorf("work %d snapshot breakdown = %#v, want live breakdown %#v", index, stored, live)
		}
	}
}
