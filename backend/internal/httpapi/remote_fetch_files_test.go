package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func fetchFilesTestPlan() remoteWorkSavePlan {
	size := func(value int64) *int64 { return &value }
	return remoteWorkSavePlan{
		SaveRoot: "library/RJ00000001",
		Items: []remoteWorkSavePlanItem{
			{ItemKey: "remote:01.mp3", Path: "mp3/01.mp3", TargetPath: "library/RJ00000001/mp3/01.mp3", Kind: "audio", Action: "cache_download", SizeBytes: size(100)},
			{ItemKey: "remote:cover.jpg", Path: "cover.jpg", TargetPath: "library/RJ00000001/cover.jpg", Kind: "image", Action: "exclude", SizeBytes: size(5)},
			{ItemKey: "remote:02.mp3", Path: "mp3/02.mp3", TargetPath: "library/RJ00000001/mp3/02.mp3", Kind: "audio", Action: "cache_download", SizeBytes: size(200)},
			{ItemKey: "remote:03.mp3", Path: "mp3/03.mp3", TargetPath: "library/RJ00000001/mp3/03.mp3", Kind: "audio", Action: "cache_hit", SizeBytes: size(300)},
		},
	}
}

func TestRemoteFetchFileStatesFollowPlanOrder(t *testing.T) {
	position := func(current int, itemKey string, written int64) remoteFetchCacheOutput {
		return remoteFetchCacheOutput{Current: &current, ItemKey: itemKey, ItemBytesCurrent: written}
	}
	tests := []struct {
		name       string
		nodeStatus string
		output     remoteFetchCacheOutput
		states     []string
		bytes      []int64
	}{
		{name: "queued", nodeStatus: "pending", states: []string{"pending", "pending", "pending"}, bytes: []int64{0, 0, 0}},
		{name: "downloading", nodeStatus: "running", output: position(2, "remote:02.mp3", 50), states: []string{"done", "active", "pending"}, bytes: []int64{100, 50, 0}},
		{name: "between files", nodeStatus: "running", output: position(3, "remote:02.mp3", 200), states: []string{"done", "done", "pending"}, bytes: []int64{100, 200, 0}},
		{name: "failed", nodeStatus: "failed", output: position(2, "remote:02.mp3", 50), states: []string{"done", "failed", "pending"}, bytes: []int64{100, 50, 0}},
		{name: "origin review", nodeStatus: "partial", output: position(0, "remote:01.mp3", 0), states: []string{"paused", "pending", "pending"}, bytes: []int64{0, 0, 0}},
		{name: "cancelled", nodeStatus: effectiveFetchCacheStatus("running", "cancelled"), output: position(2, "remote:02.mp3", 10), states: []string{"done", "stopped", "pending"}, bytes: []int64{100, 10, 0}},
		{name: "retry restarted", nodeStatus: "running", output: position(0, "", 0), states: []string{"pending", "pending", "pending"}, bytes: []int64{0, 0, 0}},
		{name: "succeeded", nodeStatus: "succeeded", states: []string{"done", "done", "done"}, bytes: []int64{100, 200, 300}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			files := remoteFetchFileStates(fetchFilesTestPlan(), test.nodeStatus, test.output)
			if len(files) != len(test.states) {
				t.Fatalf("files = %+v", files)
			}
			for index, file := range files {
				if file.State != test.states[index] || file.BytesCurrent != test.bytes[index] {
					t.Fatalf("file %d = %+v, want %s/%d", index, file, test.states[index], test.bytes[index])
				}
			}
		})
	}
}

func TestListWorkflowRunFetchFilesReturnsRelativePaths(t *testing.T) {
	db := openMigratedTestDB(t)
	server := NewServer(db, config.Config{})
	planJSON, err := json.Marshal(fetchFilesTestPlan())
	if err != nil {
		t.Fatal(err)
	}
	statements := []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (88, 'remote-test', 'Remote test source', 'kikoeru'), (89, 'local-test', 'Local test source', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (92, 'RJ00000001', 'Synthetic work')`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'running', 'manual')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (2, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'local_scan', 'Scan', 'succeeded', 'manual')`,
		`INSERT INTO workflow_node_run (id, workflow_run_id, node_id, node_type, display_name, position, status, output_json) VALUES (1, 1, 'cache', 'materialize_cache', 'Cache selected files', 1, 'running', '{"current":0,"item_key":"remote:01.mp3","item_bytes_current":40}')`,
	}
	for _, statement := range statements {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_manifest (workflow_run_id, work_id, remote_source_id, local_source_id, edition_code, target_root, staging_root, plan_json)
		VALUES (1, 92, 88, 89, 'RJ00000001', 'library/RJ00000001', 'staging/RJ00000001', ?)
	`, string(planJSON)); err != nil {
		t.Fatal(err)
	}

	request := func(runID string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodGet, "/api/workflow-runs/"+runID+"/fetch-files", nil)
		request.SetPathValue("id", runID)
		request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"workflows:run"}}))
		response := httptest.NewRecorder()
		server.listWorkflowRunFetchFiles(response, request)
		return response
	}

	response := request("1")
	var body struct {
		RunID int64             `json:"runId"`
		Files []remoteFetchFile `json:"files"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK || body.RunID != 1 {
		t.Fatalf("fetch files = %d %s %v", response.Code, response.Body, err)
	}
	if len(body.Files) != 3 || body.Files[0].Path != "mp3/01.mp3" || body.Files[0].State != "active" || body.Files[0].BytesCurrent != 40 || body.Files[2].Path != "mp3/03.mp3" {
		t.Fatalf("files = %+v", body.Files)
	}
	if strings.Contains(response.Body.String(), "library/") {
		t.Fatalf("response exposes the save root: %s", response.Body)
	}
	if response := request("2"); response.Code != http.StatusNotFound {
		t.Fatalf("non-Fetch run = %d %s", response.Code, response.Body)
	}
}
