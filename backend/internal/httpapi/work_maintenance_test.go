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
	// Catalog includes the resolved family, keeps one row for its editions,
	// and applies search and pagination to that same complete set.
	if page := read("reason=catalog&q=" + testfixture.WorkCode(testfixture.PrefixRJ, 1)); page.Total != 1 || len(page.Works) != 1 || page.Works[0].NoSource || len(page.Works[0].MetadataIssues) != 0 {
		t.Fatalf("resolved metadata missing from catalog: %+v", page)
	}
	if first, second := read("reason=catalog&page=1"), read("reason=catalog&page=2"); first.Total != 26 || len(first.Works) != 25 || len(second.Works) != 1 {
		t.Fatalf("catalog pagination=%+v / %+v", first, second)
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
 INSERT INTO metadata_sync_attempt_work(attempt_id,work_id,provider_id,component,status) SELECT 1,1,id,'metadata','unavailable' FROM metadata_provider WHERE code='dlsite';
 INSERT INTO work_metadata_provider_state(work_id,provider_id,status) SELECT 2,id,'available' FROM metadata_provider WHERE code='dlsite'`, testfixture.WorkCode(testfixture.PrefixRJ, 1)); err != nil {
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
		{"reason=catalog", []string{"library:read"}, 403, 0, false},
		{"reason=catalog", []string{"metadata:sync"}, 200, 2, true},
		{"reason=catalog", []string{"sources:write"}, 200, 2, false},
		{"reason=catalog&runId=82", []string{"metadata:sync", "sources:write", "workflows:run"}, 200, 1, true},
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

func TestWorkMaintenanceCatalogDemoKeepsEligibilityWithoutPendingIssues(t *testing.T) {
	db := openMigratedTestDB(t)
	seedMetadataIssue(t, db, 0)
	seedMetadataIssue(t, db, 1)
	if _, err := db.Exec(`UPDATE work SET is_permanently_free=1,age_rating='general' WHERE id=1; UPDATE work_metadata_sync_state SET status='succeeded',last_success_attempt_id=1`); err != nil {
		t.Fatal(err)
	}
	s := NewServer(db, config.Config{Mode: config.ModeDemo})
	response := metadataRequest(s.listWorkMaintenance, http.MethodGet, "/api/maintenance/works?reason=catalog", "", "library:read", "playback:use")
	var page struct {
		Works []maintenanceWork `json:"works"`
		Total int               `json:"total"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != 200 || page.Total != 1 || len(page.Works) != 1 || page.Works[0].ID != 1 || len(page.Works[0].MetadataIssues) != 0 {
		t.Fatalf("demo catalog=%d %s %v", response.Code, response.Body, err)
	}
}

// Custom works have their own view; the catalog and attention views list only
// catalog works, even for a custom work without an available source.
func TestWorkMaintenanceSeparatesCustomWorks(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	seedMetadataIssue(t, db, 0)
	custom := testfixture.WorkCode(testfixture.PrefixKT, 1)
	if _, err := db.Exec(`INSERT INTO work(primary_code,title) VALUES (?, 'Synthetic custom work')`, custom); err != nil {
		t.Fatal(err)
	}
	read := func(query string) []maintenanceWork {
		t.Helper()
		response := metadataRequest(s.listWorkMaintenance, http.MethodGet, "/api/maintenance/works?"+query, "", "sources:write", "metadata:sync")
		var page struct {
			Works []maintenanceWork `json:"works"`
			Total int               `json:"total"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != 200 || page.Total != len(page.Works) {
			t.Fatalf("%s: %d %s %v", query, response.Code, response.Body, err)
		}
		return page.Works
	}
	for _, reason := range []string{"catalog", "all", "no_source", "metadata"} {
		works := read("reason=" + reason)
		if len(works) != 1 || works[0].PrimaryCode != testfixture.WorkCode(testfixture.PrefixRJ, 0) {
			t.Fatalf("%s lists %+v", reason, works)
		}
	}
	works := read("reason=custom")
	if len(works) != 1 || works[0].PrimaryCode != custom || !works[0].NoSource {
		t.Fatalf("custom lists %+v", works)
	}
	if works := read("reason=custom&q=" + testfixture.WorkCode(testfixture.PrefixRJ, 0)); len(works) != 0 {
		t.Fatalf("custom search lists %+v", works)
	}
}

// A catalog family DLsite was never asked about needs metadata attention until
// any edition has an outcome, and recovery queues its first sync.
func TestWorkMaintenanceListsUnsyncedFamilies(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{CacheRoot: t.TempDir()})
	unsynced, canonical, edition := testfixture.WorkCode(testfixture.PrefixRJ, 0), testfixture.WorkCode(testfixture.PrefixRJ, 1), testfixture.WorkCode(testfixture.PrefixRJ, 2)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO work(id,primary_code,title) VALUES (1,?,'Unsynced work'),(2,?,'Synced family'),(3,?,'Synced edition')`, []any{unsynced, canonical, edition}},
		{`INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES (1,2,?)`, []any{canonical}},
		{`INSERT INTO work_edition(work_id,logical_work_id,primary_code,is_canonical) VALUES (2,1,?,1),(3,1,?,0)`, []any{canonical, edition}},
		{`INSERT INTO metadata_snapshot(work_id,provider_id,external_id,snapshot_json) SELECT 3,id,?,'{}' FROM metadata_provider WHERE code='dlsite'`, []any{edition}},
	} {
		if _, err := db.Exec(statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	read := func(reason string) map[string]maintenanceWork {
		t.Helper()
		response := metadataRequest(s.listWorkMaintenance, http.MethodGet, "/api/maintenance/works?reason="+reason, "", "metadata:sync")
		var page struct {
			Works []maintenanceWork `json:"works"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != http.StatusOK {
			t.Fatalf("%s: %d %s %v", reason, response.Code, response.Body, err)
		}
		works := map[string]maintenanceWork{}
		for _, work := range page.Works {
			works[work.PrimaryCode] = work
		}
		return works
	}
	for _, reason := range []string{"all", "metadata"} {
		works := read(reason)
		if len(works) != 1 || !works[unsynced].MetadataNotSynced || works[unsynced].MetadataSyncing {
			t.Fatalf("%s lists %+v", reason, works)
		}
	}
	if works := read("catalog"); len(works) != 2 || works[canonical].MetadataNotSynced {
		t.Fatalf("catalog lists %+v", works)
	}
	if _, err := db.Exec(`INSERT INTO app_setting(key,value_json) VALUES ('remote_request_delay_base_seconds','0')`); err != nil {
		t.Fatal(err)
	}
	response := metadataRequest(s.retryMetadataIssues, http.MethodPost, "/api/metadata/issues/retry", `{"workIds":[1,2]}`, "metadata:sync")
	if response.Code != http.StatusAccepted || !strings.Contains(response.Body.String(), `"queued":1`) || !strings.Contains(response.Body.String(), `"skipped":1`) {
		t.Fatalf("retry=%d %s", response.Code, response.Body)
	}
	if work := read("metadata")[unsynced]; !work.MetadataNotSynced || !work.MetadataSyncing {
		t.Fatalf("queued sync: %+v", work)
	}
	if _, err := db.Exec(`INSERT INTO work_metadata_provider_state(work_id,provider_id,status) SELECT 1,id,'available' FROM metadata_provider WHERE code='dlsite'`); err != nil {
		t.Fatal(err)
	}
	if works := read("metadata"); len(works) != 0 {
		t.Fatalf("synced family still listed: %+v", works)
	}
}

// Every row ranks its family's best source: a local folder on any edition,
// then any other available source, then none. Only sources:write receives the
// no-source reason, while every viewer sees the tier.
func TestWorkMaintenanceRanksSourceTiers(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	local, edition, remote, none := testfixture.WorkCode(testfixture.PrefixRJ, 0), testfixture.WorkCode(testfixture.PrefixRJ, 1),
		testfixture.WorkCode(testfixture.PrefixRJ, 2), testfixture.WorkCode(testfixture.PrefixRJ, 3)
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO work(id,primary_code,title) VALUES (1,?,'Local family'),(2,?,'Local edition'),(3,?,'Remote work'),(4,?,'Unavailable work')`, []any{local, edition, remote, none}},
		{`INSERT INTO logical_work(id,canonical_work_id,canonical_code) VALUES (1,1,?)`, []any{local}},
		{`INSERT INTO work_edition(work_id,logical_work_id,primary_code,is_canonical) VALUES (1,1,?,1),(2,1,?,0)`, []any{local, edition}},
		{`INSERT INTO file_source(id,code,display_name,source_type) VALUES (91,'example_local','Example Local','local'),(92,'example_remote','Example Remote','kikoeru_compatible')`, nil},
		{`INSERT INTO work_source_presence(work_id,file_source_id,presence_type,availability) VALUES (2,91,'local','available'),(3,92,'source','available'),(4,92,'source','missing')`, nil},
	} {
		if _, err := db.Exec(statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	for _, permissions := range [][]string{{"sources:write"}, {"metadata:sync"}} {
		response := metadataRequest(s.listWorkMaintenance, http.MethodGet, "/api/maintenance/works?reason=catalog", "", permissions...)
		var page struct {
			Works []maintenanceWork `json:"works"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &page); err != nil || response.Code != http.StatusOK {
			t.Fatalf("%v: %d %s %v", permissions, response.Code, response.Body, err)
		}
		tiers, noSource := map[string]string{}, map[string]bool{}
		for _, work := range page.Works {
			tiers[work.PrimaryCode], noSource[work.PrimaryCode] = work.SourceTier, work.NoSource
		}
		if len(tiers) != 3 || tiers[local] != "local" || tiers[remote] != "remote" || tiers[none] != "none" {
			t.Fatalf("%v tiers: %v", permissions, tiers)
		}
		if noSource[none] != (permissions[0] == "sources:write") || noSource[remote] || noSource[local] {
			t.Fatalf("%v no-source: %v", permissions, noSource)
		}
	}
}

// The view counts match the lists each view returns and leave out a view the
// caller may not open.
func TestWorkMaintenanceCountsFollowViewPermissions(t *testing.T) {
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{})
	seedMetadataIssue(t, db, 0)
	if _, err := db.Exec(`INSERT INTO work(primary_code,title) VALUES (?, 'Source-only work'), (?, 'Synthetic custom work');
 INSERT INTO work_metadata_provider_state(work_id,provider_id,status) SELECT 2,id,'available' FROM metadata_provider WHERE code='dlsite'`,
		testfixture.WorkCode(testfixture.PrefixRJ, 1), testfixture.WorkCode(testfixture.PrefixKT, 1)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		permissions []string
		status      int
		want        string
	}{
		{[]string{"library:read"}, 403, ""},
		{[]string{"metadata:sync"}, 200, `{"catalog":2,"all":1,"metadata":1,"custom":1}`},
		{[]string{"sources:write"}, 200, `{"catalog":2,"all":2,"noSource":2,"custom":1}`},
		{[]string{"metadata:sync", "sources:write"}, 200, `{"catalog":2,"all":2,"metadata":1,"noSource":2,"custom":1}`},
	} {
		response := metadataRequest(s.countWorkMaintenance, http.MethodGet, "/api/maintenance/works/counts", "", tc.permissions...)
		if response.Code != tc.status {
			t.Fatalf("%v: %d %s", tc.permissions, response.Code, response.Body)
		}
		if tc.status == 200 && strings.TrimSpace(response.Body.String()) != tc.want {
			t.Fatalf("%v: counts=%s want %s", tc.permissions, response.Body, tc.want)
		}
	}
}
