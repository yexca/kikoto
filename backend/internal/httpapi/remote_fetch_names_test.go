package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/testfixture"
	"github.com/yexca/kikoto/backend/internal/workflow"
)

// newRemoteTreeFetchServer serves one remote work whose file tree is tracks and
// whose every file downloads as its own URL path.
func newRemoteTreeFetchServer(t *testing.T, tracks []kikoeru.Track) (*Server, *sql.DB, string) {
	t.Helper()
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/workInfo/"+code:
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(kikoeru.Work{ID: 1, SourceID: code, Title: "Example Work"})
		case r.URL.Path == "/api/tracks/1":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(tracks)
		case strings.HasPrefix(r.URL.Path, "/media/"):
			_, _ = w.Write([]byte(r.URL.Path))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(upstream.Close)
	db := openMigratedTestDB(t)
	metadataReviewExec(t, db, `INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`)
	server := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir(), LocalScanDepth: 2})
	metadataReviewExec(t, db, `INSERT INTO file_source (id, code, display_name, source_type) VALUES (7, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible')`)
	metadataReviewExec(t, db, `INSERT INTO file_source_endpoint (file_source_id, api_url, base_url) VALUES (7, ?, ?)`, upstream.URL, upstream.URL)
	return server, db, code
}

func remoteTreeFile(title string, download string) kikoeru.Track {
	return kikoeru.Track{Type: "audio", Title: title, MediaDownloadURL: download, Size: int64(len(download))}
}

// Two names that differ only by letter case are one file on a case-insensitive
// filesystem. The plan must hand the pair to the user as a target conflict
// instead of fetching both and keeping whichever was written last.
func TestRemoteFetchPlanTreatsCaseOnlyNamesAsOneTarget(t *testing.T) {
	server, _, code := newRemoteTreeFetchServer(t, []kikoeru.Track{
		remoteTreeFile("Track.mp3", "/media/upper"),
		remoteTreeFile("track.mp3", "/media/lower-case"),
		remoteTreeFile("other.mp3", "/media/other"),
	})
	ctx := context.Background()

	plan, err := server.buildRemoteWorkSavePlan(ctx, 7, code, nil, nil, "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Items) != 3 || plan.Summary.Conflict != 1 {
		t.Fatalf("plan = %d items, %d conflicts; want 3 items and 1 conflict", len(plan.Items), plan.Summary.Conflict)
	}
	second := plan.Items[1]
	if second.Path != "track.mp3" || second.Action != "conflict" || second.Status != "duplicate_target" || !second.TargetConflict {
		t.Fatalf("case-only duplicate = %+v, want a duplicate-target conflict", second)
	}
	if _, err := server.prepareRemoteWorkSaveEnqueue(ctx, 7, code, nil, nil, "", "", nil, 0, 0, workflow.JobPriorityUserInitiated); !errors.As(err, &remoteWorkSaveConflictError{}) {
		t.Fatalf("enqueue with an unresolved case-only pair = %v, want a plan conflict", err)
	}

	resolved, err := server.buildRemoteWorkSavePlan(ctx, 7, code, nil, nil, "", []remoteFetchFileDecision{{ItemKey: second.ItemKey, Resolution: "keep_both"}})
	if err != nil {
		t.Fatal(err)
	}
	keys := map[string]bool{}
	for _, item := range resolved.Items {
		keys[fetchTargetKey(item.TargetPath)] = true
	}
	if resolved.Summary.Conflict != 0 || len(keys) != 3 {
		t.Fatalf("keep-both plan = %d conflicts, %d distinct targets; want 0 and 3", resolved.Summary.Conflict, len(keys))
	}
}

// Verification refuses to publish when two planned files are one file in the
// staging directory, whatever made them so.
func TestRemoteFetchVerificationRejectsPlannedFilesStoredAsOne(t *testing.T) {
	db := openMigratedTestDB(t)
	dataRoot := filepath.Join(t.TempDir(), "data")
	server := NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: filepath.Join(t.TempDir(), "cache")})
	ctx := context.Background()
	for _, statement := range []string{
		`INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_remote_a', 'Example Remote A', 'kikoeru'), (2, 'example_local', 'Example Local', 'local_folder')`,
		`INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')`,
		`INSERT OR IGNORE INTO workflow_definition (code, display_name) VALUES ('remote_work_fetch', 'Fetch')`,
		`INSERT INTO workflow_run (id, workflow_definition_id, workflow_code, display_name, status, trigger_type) VALUES (1, (SELECT id FROM workflow_definition WHERE code = 'remote_work_fetch'), 'remote_work_fetch', 'Fetch', 'running', 'manual')`,
		`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status) VALUES (1, 1, 'remote_work_fetch', 'running')`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	size := int64(len("payload"))
	item := func(name string) remoteWorkSavePlanItem {
		return remoteWorkSavePlanItem{
			ItemKey: "remote:" + name, Path: name, Kind: "audio", SizeBytes: &size, SourceKind: "remote", Action: "cache_hit",
			CachePath: "media/" + name, TargetPath: "remote/RJ00000000/" + name, OriginalTargetPath: "remote/RJ00000000/" + name,
			Resolution: "auto", RemoteSourceID: 1,
		}
	}
	plan := remoteWorkSavePlan{SourceID: 1, PrimaryCode: "RJ00000000", SaveRoot: "remote/RJ00000000", Items: []remoteWorkSavePlanItem{item("Track.mp3"), item("track.mp3")}}
	plan.Summary = summarizeRemoteSavePlan(plan.Items)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := createRemoteFetchManifest(ctx, tx, 1, 1, "", 1, 1, 2, plan); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	manifest, err := server.loadRemoteFetchManifest(ctx, 1)
	if err != nil {
		t.Fatal(err)
	}
	paths, err := server.remoteFetchPublishPaths(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(paths.stageRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	first, second := filepath.Join(paths.stageRoot, "Track.mp3"), filepath.Join(paths.stageRoot, "track.mp3")
	if err := os.WriteFile(first, []byte("payload"), 0o644); err != nil {
		t.Fatal(err)
	}
	// A case-insensitive filesystem already resolves the second name to the
	// first file. Elsewhere a hard link reproduces "two names, one file".
	if _, err := os.Stat(second); errors.Is(err, fs.ErrNotExist) {
		if err := os.Link(first, second); err != nil {
			t.Skipf("filesystem cannot store two names for one file: %v", err)
		}
	}

	err = server.verifyRemoteFetchItems(ctx, manifest, plan, paths)
	if err == nil || !strings.Contains(err.Error(), "fewer files than planned") {
		t.Fatalf("verification of two planned files stored as one = %v, want a refusal to publish", err)
	}
	var state string
	if scanErr := db.QueryRow(`SELECT state FROM remote_fetch_manifest WHERE id = ?`, manifest.ID).Scan(&state); scanErr != nil || state == "verified" {
		t.Fatalf("manifest state = %q, %v; must not be verified", state, scanErr)
	}
}

// Track titles come from the source and may carry path components. The same
// normalized name is planned, cached, stored, and listed, so such a work
// fetches completely, inside its own folder, with every cached file recorded.
func TestRemoteFetchCompletesWhenTitlesCarryPathComponents(t *testing.T) {
	tracks := []kikoeru.Track{
		remoteTreeFile("../escape.mp3", "/media/escape"),
		remoteTreeFile("/rooted.mp3", "/media/rooted"),
		remoteTreeFile("..", "/media/nameless"),
		{Type: "folder", Title: "../../Disc", Children: []kikoeru.Track{remoteTreeFile(`..\inner.mp3`, "/media/inner")}},
	}
	server, db, code := newRemoteTreeFetchServer(t, tracks)
	ctx := context.Background()

	prep, err := server.prepareRemoteWorkSaveEnqueue(ctx, 7, code, nil, nil, "", "", nil, 0, 0, workflow.JobPriorityUserInitiated)
	if err != nil {
		t.Fatal(err)
	}
	wantPaths := []string{"Disc/inner.mp3", "Track 3", "escape.mp3", "rooted.mp3"}
	planned := []string{}
	for _, item := range prep.plan.Items {
		planned = append(planned, item.Path)
		if !strings.HasPrefix(item.TargetPath, prep.plan.SaveRoot+"/") {
			t.Fatalf("target %q left the Fetch root %q", item.TargetPath, prep.plan.SaveRoot)
		}
	}
	sort.Strings(planned)
	if strings.Join(planned, "|") != strings.Join(wantPaths, "|") {
		t.Fatalf("planned paths = %v, want %v", planned, wantPaths)
	}
	result, err := server.enqueuePreparedRemoteWorkSave(ctx, prep)
	if err != nil {
		t.Fatal(err)
	}

	// The listing a client joins into paths names the same files.
	source, work, cachedTracks, err := server.loadInstanceRemoteWorkTracksCached(ctx, 7, code)
	if err != nil {
		t.Fatal(err)
	}
	detail, err := server.remoteWorkTracksDetail(ctx, source, work, cachedTracks)
	if err != nil {
		t.Fatal(err)
	}
	listed := []string{}
	var walk func(base string, nodes []remoteTrackDetail)
	walk = func(base string, nodes []remoteTrackDetail) {
		for _, node := range nodes {
			path := strings.TrimPrefix(base+"/"+node.Title, "/")
			if len(node.Children) > 0 {
				walk(path, node.Children)
				continue
			}
			listed = append(listed, path)
		}
	}
	walk("", detail.Tracks)
	sort.Strings(listed)
	if strings.Join(listed, "|") != strings.Join(wantPaths, "|") {
		t.Fatalf("listed paths = %v, want %v", listed, wantPaths)
	}

	if err := server.runNextQueuedWorkflowJob(ctx); err != nil {
		t.Fatal(err)
	}
	jobStatus, runStatus, _, errorMessage, _ := loadJobState(t, db, result.JobID)
	if jobStatus != "succeeded" || runStatus != "succeeded" {
		t.Fatalf("job=%s run=%s error=%q", jobStatus, runStatus, errorMessage)
	}
	saveRoot := filepath.Join(server.cfg.DataRoot, filepath.FromSlash(prep.plan.SaveRoot))
	for path, content := range map[string]string{
		"escape.mp3": "/media/escape", "rooted.mp3": "/media/rooted", "Track 3": "/media/nameless", "Disc/inner.mp3": "/media/inner",
	} {
		data, err := os.ReadFile(filepath.Join(saveRoot, filepath.FromSlash(path)))
		if err != nil || string(data) != content {
			t.Fatalf("published %s = %q, %v; want %q", path, data, err, content)
		}
	}
	// Every downloaded file sits inside the work folder: none escaped upward.
	downloaded := 0
	if err := filepath.WalkDir(server.cfg.DataRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		data, err := os.ReadFile(path)
		if err != nil || !strings.HasPrefix(string(data), "/media/") {
			return err
		}
		downloaded++
		relative, _ := filepath.Rel(server.cfg.DataRoot, path)
		if !strings.HasPrefix(filepath.ToSlash(relative), prep.plan.SaveRoot+"/") {
			t.Fatalf("file written outside the work folder: %s", filepath.ToSlash(relative))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if downloaded != len(wantPaths) {
		t.Fatalf("downloaded files under the data root = %d, want %d", downloaded, len(wantPaths))
	}
	// Every file left in the cache is a recorded cache location.
	if err := filepath.WalkDir(server.cfg.CacheRoot, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil || entry.IsDir() {
			return walkErr
		}
		relative, _ := filepath.Rel(server.cfg.CacheRoot, path)
		var recorded int
		if err := db.QueryRow(`SELECT COUNT(*) FROM media_file_location WHERE location_type = 'cache' AND path = ?`, filepath.ToSlash(relative)).Scan(&recorded); err != nil {
			return err
		}
		if recorded == 0 {
			t.Fatalf("cache file without a record: %s", filepath.ToSlash(relative))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

// A Fetch the server refuses outright is the caller's to fix: it is answered
// as a 4xx with a stable code, never as an upstream failure that may be retried.
func TestRemoteFetchEnqueueRejectionsAreClientErrors(t *testing.T) {
	oversized := remoteTreeFile("huge.mp3", "/media/huge")
	oversized.Size = 200 << 30
	server, _, code := newRemoteTreeFetchServer(t, []kikoeru.Track{oversized})
	ctx := context.Background()

	for _, tc := range []struct {
		name       string
		targetRoot string
		status     int
		code       string
	}{
		{"file above the download limit", "", http.StatusUnprocessableEntity, "download_limit_exceeded"},
		{"folder that is not an active folder of the edition", "elsewhere/RJ00000000", http.StatusBadRequest, "invalid_request"},
	} {
		_, err := server.prepareRemoteWorkSaveEnqueue(ctx, 7, code, nil, nil, tc.targetRoot, "", nil, 0, 0, workflow.JobPriorityUserInitiated)
		if err == nil {
			t.Fatalf("%s: enqueue was accepted", tc.name)
		}
		response := httptest.NewRecorder()
		writeUpstreamError(response, err)
		var body errorResponseBody
		if decodeErr := json.Unmarshal(response.Body.Bytes(), &body); decodeErr != nil {
			t.Fatal(decodeErr)
		}
		if response.Code != tc.status || body.Code != tc.code || body.Retryable {
			t.Fatalf("%s: got %d %+v, want %d %s and not retryable", tc.name, response.Code, body, tc.status, tc.code)
		}
	}
}
