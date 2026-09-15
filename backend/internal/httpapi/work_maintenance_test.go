package httpapi

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

// A translated edition's failures must share its family's source row and
// pagination slot. Clearing metadata must not clear a missing-source reason.
func TestWorkMaintenanceGroupsFamiliesBeforePagination(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	for i := range 27 {
		seedMetadataIssue(t, db, i)
	}
	if _, err := db.Exec(`INSERT INTO logical_work(id,canonical_work_id,canonical_code) SELECT 1,id,primary_code FROM work WHERE id=1;
 INSERT INTO work_edition(work_id,logical_work_id,primary_code,is_canonical) SELECT id,1,primary_code,CASE WHEN id=1 THEN 1 ELSE 0 END FROM work WHERE id IN (1,2);
 INSERT INTO work_metadata_sync_state(work_id,provider_id,component,attempt_id,status,failure_count) SELECT 2,id,'cover',1,'failed',1 FROM metadata_provider WHERE code='dlsite'`); err != nil {
		t.Fatal(err)
	}
	type result struct {
		Works []maintenanceWork `json:"works"`
		Total int               `json:"total"`
	}
	read := func(query string) result {
		t.Helper()
		response := metadataRequest(s.listWorkMaintenance, http.MethodGet, "/api/maintenance/works?"+query, "", "sources:write", "metadata:sync")
		var page result
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != 200 {
			t.Fatalf("list=%d %s %v", response.Code, response.Body, err)
		}
		return page
	}
	first, second := read("page=1"), read("page=2")
	if first.Total != 26 || len(first.Works) != 25 || len(second.Works) != 1 {
		t.Fatalf("pagination=%+v / %+v", first, second)
	}
	seen := map[int64]bool{}
	for _, work := range append(first.Works, second.Works...) {
		if seen[work.ID] {
			t.Fatal("duplicate family")
		}
		seen[work.ID] = true
	}
	family := read("q=" + testfixture.WorkCode(testfixture.PrefixRJ, 1))
	if family.Total != 1 || len(family.Works) != 1 || family.Works[0].ID != 1 || !family.Works[0].NoSource || len(family.Works[0].MetadataIssues) != 2 {
		t.Fatalf("family=%+v", family)
	}
	for _, issue := range family.Works[0].MetadataIssues {
		if issue.WorkID == 2 && len(issue.Issues) != 2 {
			t.Fatalf("edition components=%+v", issue)
		}
	}
	if _, err := db.Exec(`UPDATE work_metadata_sync_state SET status='succeeded',last_success_attempt_id=1 WHERE work_id IN (1,2)`); err != nil {
		t.Fatal(err)
	}
	family = read("q=" + testfixture.WorkCode(testfixture.PrefixRJ, 0))
	if family.Total != 1 || !family.Works[0].NoSource || len(family.Works[0].MetadataIssues) != 0 {
		t.Fatalf("source issue removed with metadata: %+v", family)
	}
	if page := read("reason=metadata&q=" + testfixture.WorkCode(testfixture.PrefixRJ, 0)); page.Total != 0 {
		t.Fatal("resolved family still in metadata filter")
	}
	// A source on any edition resolves the source reason for the whole family.
	if _, err := db.Exec(`INSERT INTO file_source(id,code,display_name,source_type) VALUES (99,'example_local','Example Local','local'); INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability) VALUES (2,99,'local','available')`); err != nil {
		t.Fatal(err)
	}
	if page := read("q=" + testfixture.WorkCode(testfixture.PrefixRJ, 0)); page.Total != 0 {
		t.Fatal("available family remains in attention union")
	}
	// Null canonical pointers still produce one deterministic family row.
	if _, err := db.Exec(`DELETE FROM work_source_presence WHERE work_id=2; UPDATE logical_work SET canonical_work_id=NULL WHERE id=1; UPDATE work_edition SET is_canonical=0 WHERE logical_work_id=1`); err != nil {
		t.Fatal(err)
	}
	if page := read("q=" + testfixture.WorkCode(testfixture.PrefixRJ, 1)); page.Total != 1 {
		t.Fatal("family without canonical was duplicated")
	}
}

func TestWorkMaintenancePermissionsAndRunScope(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	seedMetadataIssue(t, db, 0)
	if _, err := db.Exec(`INSERT INTO work(primary_code,title) VALUES (?, 'Source-only work');
 INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type,trigger_reason,input_json) VALUES (81,'custom','Private workflow','failed','manual','custom_definition','{"requested_by_user_id":2}');
 INSERT INTO workflow_run(id,workflow_code,display_name,status,trigger_type) VALUES (82,'metadata_sync','Example sync','failed','manual');
 INSERT INTO metadata_sync_attempt_run(attempt_id,workflow_run_id) VALUES (1,82);
 INSERT INTO metadata_sync_attempt_work(attempt_id,work_id,provider_id,component,status) SELECT 1,1,id,'metadata','unavailable' FROM metadata_provider WHERE code='dlsite'`, testfixture.WorkCode(testfixture.PrefixRJ, 1)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		query       string
		permissions []string
		status      int
		total       int
		metadata    bool
	}{
		{"", []string{"library:read"}, 403, 0, false},
		{"", []string{"metadata:sync"}, 200, 1, true},
		{"", []string{"sources:write"}, 200, 2, false},
		{"reason=no_source", []string{"metadata:sync"}, 403, 0, false},
		{"reason=metadata", []string{"sources:write"}, 403, 0, false},
		{"runId=81", []string{"metadata:sync", "workflows:run"}, 403, 0, false},
		{"runId=82", []string{"metadata:sync"}, 403, 0, false},
		{"reason=all&runId=82", []string{"metadata:sync", "sources:write", "workflows:run"}, 200, 1, true},
		{"reason=bad", []string{"metadata:sync"}, 400, 0, false},
		{"pageSize=101", []string{"metadata:sync"}, 400, 0, false},
	} {
		response := metadataRequest(s.listWorkMaintenance, http.MethodGet, "/api/maintenance/works?"+tc.query, "", tc.permissions...)
		if response.Code != tc.status {
			t.Fatalf("%+v: %d %s", tc, response.Code, response.Body)
		}
		if tc.status != 200 {
			continue
		}
		var page struct {
			Works []maintenanceWork `json:"works"`
			Total int               `json:"total"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || page.Total != tc.total {
			t.Fatalf("response=%s %v", response.Body, err)
		}
		if strings.Contains(response.Body.String(), "private diagnostic") {
			t.Fatal("private error leaked")
		}
		hasMetadata := false
		for _, work := range page.Works {
			hasMetadata = hasMetadata || len(work.MetadataIssues) > 0
		}
		if hasMetadata != tc.metadata {
			t.Fatalf("metadata visibility=%+v", page)
		}
	}
}

func TestWorkMaintenanceDemoShowsOnlyEligibleWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	seedMetadataIssue(t, db, 0)
	seedMetadataIssue(t, db, 1)
	if _, err := db.Exec(`UPDATE work SET is_permanently_free=1,age_rating='general' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db, config.Config{Mode: config.ModeDemo})
	response := metadataRequest(s.listWorkMaintenance, http.MethodGet, "/api/maintenance/works", "", "library:read", "playback:use")
	var page struct {
		Works []maintenanceWork `json:"works"`
		Total int               `json:"total"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != 200 || page.Total != 1 || len(page.Works) != 1 || page.Works[0].ID != 1 {
		t.Fatalf("demo=%d %s %v", response.Code, response.Body, err)
	}
}
