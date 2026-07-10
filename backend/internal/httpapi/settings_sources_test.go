package httpapi

import (
	"context"
	"encoding/json"
	"testing"
)

func TestSelectedRemotePathMatches(t *testing.T) {
	tests := []struct {
		name     string
		selected []string
		filePath string
		want     bool
	}{
		{
			name:     "exact file",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "directory prefix",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/mp3/01.mp3",
			want:     true,
		},
		{
			name:     "sibling directory is not selected",
			selected: []string{"honhen/mp3"},
			filePath: "honhen/wav/01.wav",
			want:     false,
		},
		{
			name:     "same basename in other directory is not selected",
			selected: []string{"honhen/mp3/01.mp3"},
			filePath: "bonus/mp3/01.mp3",
			want:     false,
		},
		{
			name:     "cleans path traversal",
			selected: []string{"honhen/../mp3"},
			filePath: "mp3/01.mp3",
			want:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			selected := normalizeSelectedRemotePaths(test.selected)
			got := selectedRemotePathMatches(selected, test.filePath)
			if got != test.want {
				t.Fatalf("selectedRemotePathMatches(%v, %q) = %v, want %v", test.selected, test.filePath, got, test.want)
			}
		})
	}
}

func TestRemoteSourceSortMapping(t *testing.T) {
	tests := []struct {
		input string
		name  string
		order string
	}{
		{input: "recent", name: "recent", order: "create_date"},
		{input: "release", name: "release", order: "release"},
		{input: "rating", name: "rating", order: "rate_average_2dp"},
		{input: "sales", name: "sales", order: "dl_count"},
		{input: "title", name: "recent", order: "create_date"},
	}
	for _, test := range tests {
		name, order := remoteSourceSort(test.input)
		if name != test.name || order != test.order {
			t.Fatalf("remoteSourceSort(%q) = (%q, %q), want (%q, %q)", test.input, name, order, test.name, test.order)
		}
	}
}

func TestRemoteFetchRequestIDValidation(t *testing.T) {
	if !validRemoteFetchRequestID("fetch:12345678") {
		t.Fatal("valid request id was rejected")
	}
	for _, value := range []string{"short", "contains spaces", "../../escape"} {
		if validRemoteFetchRequestID(value) {
			t.Fatalf("invalid request id %q was accepted", value)
		}
	}
}

func TestRemoteFetchRequestResultReturnsExistingRun(t *testing.T) {
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'remote', 'Remote', 'kikoeru_compatible')`); err != nil {
		t.Fatalf("insert source: %v", err)
	}
	runInsert, err := db.Exec(`
		INSERT INTO workflow_run (workflow_code, display_name, status, trigger_type)
		VALUES ('remote_work_fetch', 'Fetch remote work', 'queued', 'manual')
	`)
	if err != nil {
		t.Fatalf("insert run: %v", err)
	}
	runID, err := runInsert.LastInsertId()
	if err != nil {
		t.Fatalf("run id: %v", err)
	}
	want := remoteWorkSaveResult{RunID: runID, WorkID: 9, PrimaryCode: "RJ00000001", Status: "queued", RequestID: "fetch:12345678"}
	raw, err := json.Marshal(want)
	if err != nil {
		t.Fatalf("marshal result: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO remote_fetch_request (request_id, source_id, work_code, workflow_run_id, result_json)
		VALUES ('fetch:12345678', 1, 'RJ00000001', ?, ?)
	`, runID, string(raw)); err != nil {
		t.Fatalf("insert request: %v", err)
	}

	server := &Server{db: db}
	got, found, err := server.remoteFetchRequestResult(context.Background(), "fetch:12345678", 1, "rj00000001")
	if err != nil {
		t.Fatalf("remoteFetchRequestResult() error = %v", err)
	}
	if !found || got.RunID != runID || !got.Deduplicated {
		t.Fatalf("remoteFetchRequestResult() = %+v, found %v", got, found)
	}
}
