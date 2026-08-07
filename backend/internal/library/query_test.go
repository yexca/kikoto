package library

import (
	"reflect"
	"strings"
	"testing"
)

func TestMatchingListSelectSQLBuildsShelfActivityOrder(t *testing.T) {
	query, args := matchingListSelectSQL("1 = 1", MatchingListOptions{
		UserID: 42, Sort: "activity", Direction: "desc",
	})

	for _, fragment := range []string{"user_work_state.updated_at", "user_work_playback_cursor", "favorite_list_item", "matching_sort_value DESC"} {
		if !strings.Contains(query, fragment) {
			t.Fatalf("activity query does not contain %q: %s", fragment, query)
		}
	}
	if !reflect.DeepEqual(args, []any{int64(42), int64(42)}) {
		t.Fatalf("activity args = %#v, want [42 42]", args)
	}
}

func TestMatchingListSelectSQLScopesAddedOrderToSelectedList(t *testing.T) {
	query, args := matchingListSelectSQL("1 = 1", MatchingListOptions{
		UserID: 42, ListID: 7, Sort: "added", Direction: "asc",
	})

	if !strings.Contains(query, "shelf_list.id = ?") || !strings.Contains(query, "matching_sort_value ASC") {
		t.Fatalf("added query = %s", query)
	}
	if !reflect.DeepEqual(args, []any{int64(42), int64(7)}) {
		t.Fatalf("added args = %#v, want [42 7]", args)
	}
}

func TestRecommendationSlotOffsetsKeepIntentFirstAndUnmarkedPrimary(t *testing.T) {
	cycleSize, offsets := recommendationSlotOffsets(DefaultRecommendationConfig())
	if cycleSize != 24 {
		t.Fatalf("recommendation cycle size = %d, want 24", cycleSize)
	}
	wantCounts := map[string]int{
		"none": 12, "listening": 4, "want_to_listen": 4, "relisten": 2, "finished": 2, "paused": 0,
	}
	for status, want := range wantCounts {
		if got := len(offsets[status]); got != want {
			t.Fatalf("%s slots = %d, want %d: %#v", status, got, want, offsets[status])
		}
	}
	if offsets["listening"][0] != 1 || offsets["want_to_listen"][0] != 2 {
		t.Fatalf("leading slots = listening %v, want %v; want positions 1 and 2", offsets["listening"], offsets["want_to_listen"])
	}
	if offsets["relisten"][0] < 5 || offsets["finished"][0] < 9 {
		t.Fatalf("secondary lanes appear too early: relisten %v, finished %v", offsets["relisten"], offsets["finished"])
	}
	if len(offsets["paused"]) != 0 {
		t.Fatalf("default recommendation cycle schedules shelved positions: %v", offsets["paused"])
	}
}
