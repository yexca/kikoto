package library

import (
	"context"
	"reflect"
	"testing"
)

// Local presence on an alternate edition belongs to the one visible family;
// missing/local and available/remote rows must not qualify it as local.
func TestLocalScopePreservesFamiliesAndPersonalState(t *testing.T) {
	store, userID := seedPaginationLibrary(t, 6, 0, 0)
	_, err := store.db.Exec(`
		DELETE FROM work_source_presence;
		INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES(1,1,'RJ00000000');
		INSERT INTO work_edition(work_id,logical_work_id,primary_code,is_canonical) VALUES
		 (1,1,'RJ00000000',1),(2,1,'RJ00000001',0);
		INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability) VALUES
		 (2,1,'local','available'),(3,1,'local','available'),
		 (4,1,'source','available'),(5,1,'local','missing'),(6,1,'local','available')`)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		status string
		want   []int64
	}{
		{"", []int64{6, 3, 1}},
		{"none", []int64{1}},
		{"listening", []int64{3}},
	} {
		var got []int64
		for pageNo := 1; pageNo <= len(tc.want); pageNo++ {
			page, err := store.ListPage(context.Background(), ListOptions{UserID: userID, Page: pageNo, PageSize: 1, Scope: "local", Status: tc.status, Sort: "recent", Direction: "desc"})
			if err != nil {
				t.Fatal(err)
			}
			if page.Total != len(tc.want) || len(page.Works) != 1 {
				t.Fatalf("%s page %d: total=%d rows=%d", tc.status, pageNo, page.Total, len(page.Works))
			}
			row := page.Works[0]
			got = append(got, row.ID)
			if row.ID == 1 && (row.ListeningStatus != "none" || row.Favorite) {
				t.Fatalf("canonical personal state changed: %+v", row)
			}
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s: ids=%v want=%v", tc.status, got, tc.want)
		}
	}
	// The canonical work stays local until the last available family presence
	// disappears. A stale location of another scope cannot replace it.
	if _, err := store.db.Exec(`UPDATE work_source_presence SET availability='missing' WHERE work_id=2`); err != nil {
		t.Fatal(err)
	}
	page, err := store.ListPage(context.Background(), ListOptions{UserID: userID, PageSize: 24, Scope: "local", Sort: "recent", Direction: "desc"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 || page.Works[0].ID != 6 || page.Works[1].ID != 3 {
		t.Fatalf("missing alternate stayed local: %+v", page)
	}
}
