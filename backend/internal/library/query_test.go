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

	for _, fragment := range []string{"user_work_state.updated_at", "user_media_progress", "favorite_list_item", "matching_sort_value DESC"} {
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
