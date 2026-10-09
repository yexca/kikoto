package httpapi

import (
	"testing"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestDemoSnapshotVisibilityUsesCardIdentityRules(t *testing.T) {
	db := openMigratedTestDB(t)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	workID := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Example Edition')", code)
	snapshotID := metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) VALUES (?,2,?,'{}')", workID, code)
	tests := []struct {
		name, raw, summary, want string
		summaryVersion           int
	}{
		{name: "no identity", raw: `{}`, want: ""},
		{name: "base code", raw: `{"workno":"RJ00000001","base_code":"RJ00000000"}`, want: "RJ00000000"},
		{name: "product envelope", raw: `{"product":{"workno":"RJ00000001","base_code":"rj00000000"},"base_code":"RJ00000002"}`, want: "RJ00000000"},
		{name: "original workno", raw: `{"original_workno":"RJ00000000"}`, want: "RJ00000000"},
		{name: "original work number", raw: `{"original_work_number":"RJ00000000"}`, want: "RJ00000000"},
		{name: "base workno", raw: `{"base_workno":"RJ00000000"}`, want: "RJ00000000"},
		{name: "translation original priority", raw: `{"translation_info":{"original_workno":"RJ00000000","parent_workno":"RJ00000002"},"original_workno":"RJ00000003","base_code":"RJ00000004"}`, want: "RJ00000000"},
		{name: "translation parent priority", raw: `{"translation_info":{"original_workno":" ","parent_workno":"RJ00000000"},"original_workno":"RJ00000002"}`, want: "RJ00000000"},
		{name: "unicode trim", raw: `{"translation_info":{"original_workno":"\u3000\u00a0"},"base_code":"\u3000rj00000000\u0085"}`, want: "RJ00000000"},
		{name: "invalid first value blocks lower fields", raw: `{"original_workno":"not a code","base_code":"RJ00000000"}`, want: ""},
		{name: "invalid first uses language origin", raw: `{"original_workno":"not a code","base_code":"RJ00000002","language_editions":[{"workno":"RJ00000000"}]}`, want: "RJ00000000"},
		{name: "invalid code digits", raw: `{"base_code":"RJ0000000X"}`, want: ""},
		{name: "invalid code prefix", raw: `{"base_code":"XX00000000"}`, want: ""},
		{name: "short code", raw: `{"base_code":"RJ0000"}`, want: ""},
		{name: "long code", raw: `{"base_code":"RJ000000000"}`, want: ""},
		{name: "current suppresses self", raw: `{"workno":"rj00000000","base_code":"RJ00000000"}`, want: ""},
		{name: "product id suppresses self", raw: `{"workno":" ","product_id":"RJ00000000","base_code":"RJ00000000"}`, want: ""},
		{name: "first invalid current does not use product id", raw: `{"workno":"invalid","product_id":"RJ00000000","base_code":"RJ00000000"}`, want: "RJ00000000"},
		{name: "language origin order", raw: `{"workno":"RJ00000001","language_editions":[{"workno":"RJ00000001","display_order":2},{"workno":"RJ00000000","display_order":1}]}`, want: "RJ00000000"},
		{name: "language origin default order", raw: `{"language_editions":[{"workno":"invalid","display_order":1},{"workno":"rj00000000","display_order":0},{"workno":"RJ00000002","display_order":3}]}`, want: "RJ00000000"},
		{name: "language origin equal order keeps first", raw: `{"language_editions":[{"workno":"RJ00000000","display_order":1},{"workno":"RJ00000002","display_order":1}]}`, want: "RJ00000000"},
		{name: "language self origin suppressed", raw: `{"workno":"RJ00000001","language_editions":[{"workno":"RJ00000001"},{"workno":"RJ00000000"}]}`, want: ""},
		{name: "malformed identity type", raw: `{"original_workno":12,"base_code":"RJ00000000"}`, want: ""},
		{name: "malformed edition type", raw: `{"base_code":"RJ00000000","language_editions":[{"workno":12}]}`, want: ""},
		{name: "malformed raw json", raw: `not JSON`, want: ""},
		{name: "null product suppresses envelope fields", raw: `{"product":null,"base_code":"RJ00000000"}`, want: ""},
		{name: "current summary wins", raw: `{"base_code":"RJ00000002"}`, summary: `{"v":1,"baseCode":"RJ00000000"}`, summaryVersion: library.SnapshotCardSummaryVersion, want: "RJ00000000"},
		{name: "current summary without base wins", raw: `{"base_code":"RJ00000000"}`, summary: `{"v":1}`, summaryVersion: library.SnapshotCardSummaryVersion, want: ""},
		{name: "stale summary uses raw", raw: `{"base_code":"RJ00000000"}`, summary: `{"v":0,"baseCode":"RJ00000002"}`, summaryVersion: 0, want: "RJ00000000"},
		{name: "malformed selected summary is neutral", raw: `{"base_code":"RJ00000000"}`, summary: `not JSON`, summaryVersion: library.SnapshotCardSummaryVersion, want: ""},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			metadataReviewExec(t, db, "DELETE FROM metadata_snapshot_card_summary WHERE snapshot_id=?", snapshotID)
			metadataReviewExec(t, db, "UPDATE metadata_snapshot SET snapshot_json=? WHERE id=?", test.raw, snapshotID)
			if test.summary != "" {
				metadataReviewExec(t, db, "INSERT INTO metadata_snapshot_card_summary(snapshot_id,version,summary_json) VALUES (?,?,?)", snapshotID, test.summaryVersion, test.summary)
			}
			var got, summary, raw string
			if err := db.QueryRow("SELECT "+demoSnapshotBaseCodeSQL("work.id")+","+library.LatestSnapshotCardColumnsSQL("work.id", true)+" FROM work WHERE id=?", workID).Scan(&got, &summary, &raw); err != nil {
				t.Fatal(err)
			}
			cardBase := dlsiteCardMetadata(summary, raw).BaseCode
			if got != test.want || got != cardBase {
				t.Fatalf("SQL base %q, card base %q, want %q", got, cardBase, test.want)
			}
		})
	}
}

func TestDemoSnapshotVisibilityUsesLatestDLsiteSnapshot(t *testing.T) {
	db := openMigratedTestDB(t)
	root := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Example Original')", root)
	workID := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Example Edition')", code)
	metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json,fetched_at) VALUES (?,2,?,'{\"base_code\":\"RJ00000000\"}','2024-01-01 00:00:00')", workID, code)
	newest := metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json,fetched_at) VALUES (?,2,?,'{}','2024-01-02 00:00:00')", workID, code)
	// Other providers cannot replace the DLsite identity selected by Library.
	metadataReviewExec(t, db, "INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json,fetched_at) VALUES (?,1,?,'{\"base_code\":\"RJ00000000\"}','2024-01-03 00:00:00')", workID, code)
	check := func(want bool) {
		t.Helper()
		var visible bool
		if err := db.QueryRow("SELECT "+demoLibraryVisibilityPredicateSQL+" FROM work WHERE id=?", workID).Scan(&visible); err != nil {
			t.Fatal(err)
		}
		if visible != want {
			t.Fatalf("latest DLsite membership visible=%v, want %v", visible, want)
		}
	}
	check(true)
	metadataReviewExec(t, db, "UPDATE metadata_snapshot SET snapshot_json='{\"base_code\":\"RJ00000000\"}' WHERE id=?", newest)
	check(false)
}
