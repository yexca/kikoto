package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

const (
	folderEditRemoteAudio = "synthetic translated audio"
	folderEditVTTPath     = "Translated/Track1.Translated name.mp3.vtt"
	folderEditAudioPath   = "Translated/Track1.Translated name.mp3"
	// An inert origin stands for any destination outside the source.
	folderEditForeignURL = "https://elsewhere.example.invalid/media/audio.mp3"
)

func serveFolderEditMedia(w http.ResponseWriter, r *http.Request) {
	switch r.URL.Path {
	case "/media/1.vtt":
		_, _ = w.Write([]byte(lyricsFetchVTT))
	case "/media/audio.mp3":
		_, _ = w.Write([]byte(folderEditRemoteAudio))
	case "/media/redirect":
		http.Redirect(w, r, folderEditForeignURL, http.StatusFound)
	default:
		http.NotFound(w, r)
	}
}

// folderEditFixture is the lyrics fixture's library: a scanned local origin
// edition, a sibling edition RJ00000002 of its family, an unrelated work
// RJ00000003, and a remote source that lists files for both.
type folderEditFixture struct {
	lyricsFetchFixture
	originalLocationID int64
	originalPath       string
}

func newFolderEditFixture(t *testing.T, handler http.HandlerFunc) folderEditFixture {
	t.Helper()
	return folderEditFixtureFor(t, newLyricsFetchFixture(t, handler, lyricsFetchVTTURL))
}

func folderEditFixtureFor(t *testing.T, library lyricsFetchFixture) folderEditFixture {
	t.Helper()
	fixture := folderEditFixture{lyricsFetchFixture: library}
	if err := fixture.db.QueryRow(`
		SELECT location.id, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.location_type = 'local'
	`, fixture.workID).Scan(&fixture.originalLocationID, &fixture.originalPath); err != nil {
		t.Fatal(err)
	}
	return fixture
}

// addSiblingFolder gives the sibling edition a scanned local folder holding
// the named files and returns the folder's id.
func (fixture folderEditFixture) addSiblingFolder(t *testing.T, files map[string]string) int64 {
	t.Helper()
	for name, content := range files {
		path := filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002", filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	executeLocalScanForTest(t, fixture.server)
	var folderID int64
	if err := fixture.db.QueryRow("SELECT id FROM work_folder_location WHERE work_id = 902").Scan(&folderID); err != nil {
		t.Fatal(err)
	}
	return folderID
}

func (fixture folderEditFixture) request(t *testing.T, handler http.HandlerFunc, body map[string]any, permissions ...string) *httptest.ResponseRecorder {
	t.Helper()
	if len(permissions) == 0 {
		permissions = []string{"downloads:manage", "remote:fetch"}
	}
	payload := map[string]any{"folderId": fixture.folderID}
	for key, value := range body {
		payload[key] = value
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatal(err)
	}
	workID := jsonNumber(fixture.workID)
	request := httptest.NewRequest(http.MethodPost, "/api/works/"+workID+"/folder-edit", strings.NewReader(string(encoded)))
	request.SetPathValue("id", workID)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 0, Permissions: permissions}))
	response := httptest.NewRecorder()
	handler(response, request)
	return response
}

func (fixture folderEditFixture) plan(t *testing.T, body map[string]any) workFolderEditPlan {
	t.Helper()
	response := fixture.request(t, fixture.server.planWorkFolderEdit, body)
	if response.Code != http.StatusOK {
		t.Fatalf("plan status = %d, body = %s", response.Code, response.Body.String())
	}
	var plan workFolderEditPlan
	if err := json.Unmarshal(response.Body.Bytes(), &plan); err != nil {
		t.Fatal(err)
	}
	return plan
}

// apply queues the edit and returns its job, ready to execute. An edit that
// merges folders and names no review is applied with the review of a merge
// check run now.
func (fixture folderEditFixture) apply(t *testing.T, body map[string]any) workflowJobRecord {
	t.Helper()
	if _, merges := body["mergeFolderIds"]; merges {
		if _, reviewed := body["mergeReview"]; !reviewed {
			check := fixture.mergeCheck(t, body)
			if !check.Complete || check.Review == "" {
				t.Fatalf("merge check = %+v", check)
			}
			reviewedBody := map[string]any{"mergeReview": check.Review}
			for key, value := range body {
				reviewedBody[key] = value
			}
			body = reviewedBody
		}
	}
	response := fixture.request(t, fixture.server.applyWorkFolderEdit, body)
	if response.Code != http.StatusAccepted {
		t.Fatalf("apply status = %d, body = %s", response.Code, response.Body.String())
	}
	var result workFolderEditResult
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	var job workflowJobRecord
	if err := fixture.db.QueryRow(`SELECT id, workflow_run_id, workflow_node_run_id, worker_type, payload_json, checkpoint_json,
		'', resume_count, retry_count, max_retries FROM workflow_job WHERE id = ?`, result.JobID).Scan(
		&job.ID, &job.RunID, &job.NodeRunID, &job.WorkerType, &job.PayloadJSON, &job.CheckpointJSON,
		&job.LockedBy, &job.ResumeCount, &job.RetryCount, &job.MaxRetries,
	); err != nil {
		t.Fatal(err)
	}
	if job.WorkerType != workFolderEditWorkerType {
		t.Fatalf("worker type = %q", job.WorkerType)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET status = 'running' WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_run SET status = 'running' WHERE id = ?", job.RunID); err != nil {
		t.Fatal(err)
	}
	return job
}

func (fixture folderEditFixture) runStatus(t *testing.T, runID int64) string {
	t.Helper()
	var status string
	if err := fixture.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", runID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	return status
}

func (fixture folderEditFixture) queuedRuns(t *testing.T) int {
	t.Helper()
	var count int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE workflow_code = ?", workFolderEditWorkflowCode).Scan(&count); err != nil {
		t.Fatal(err)
	}
	return count
}

func (fixture folderEditFixture) assertNoEditStaging(t *testing.T) {
	t.Helper()
	entries, err := os.ReadDir(filepath.Join(fixture.dataRoot, fixture.pool, ".kikoto-staging"))
	if err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if len(entries) > 0 {
		t.Fatalf("staging entry %q was left behind", entries[0].Name())
	}
}

func (fixture folderEditFixture) targetFile(name string) string {
	return filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), filepath.FromSlash(name))
}

func remoteAddition(code string, path string) map[string]any {
	return map[string]any{"kind": "remote", "sourceId": 7, "remoteCode": code, "path": path}
}

func localAddition(folderID int64, path string) map[string]any {
	return map[string]any{"kind": "local", "folderId": folderID, "path": path}
}

func TestWorkFolderEditAddsFamilyFilesAndRemovesUnselected(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{folderEditVTTPath: lyricsFetchVTT})
	body := map[string]any{
		"additions": []any{
			localAddition(siblingFolderID, folderEditVTTPath),
			remoteAddition("RJ00000002", folderEditAudioPath),
		},
		"removeLocationIds": []int64{fixture.originalLocationID},
	}

	plan := fixture.plan(t, body)
	if plan.Summary.Add != 2 || plan.Summary.Copy != 1 || plan.Summary.Download != 1 || plan.Summary.Remove != 1 || plan.Summary.Conflict != 0 {
		t.Fatalf("plan summary = %+v", plan.Summary)
	}
	for _, item := range plan.Items {
		if item.SourcePath != "" {
			t.Fatalf("plan exposes a download address for %s", item.ItemKey)
		}
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("a preview made %d upstream requests", fixture.requests.Load())
	}

	job := fixture.apply(t, body)
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if status := fixture.runStatus(t, job.RunID); status != "succeeded" {
		t.Fatalf("run status = %q", status)
	}
	for name, want := range map[string]string{folderEditVTTPath: lyricsFetchVTT, folderEditAudioPath: folderEditRemoteAudio} {
		if content, err := os.ReadFile(fixture.targetFile(name)); err != nil || string(content) != want {
			t.Fatalf("%s = %q, %v", name, content, err)
		}
		var available int
		if err := fixture.db.QueryRow(`
			SELECT COUNT(*) FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available' AND location.path = ?
		`, fixture.workID, fixture.root+"/"+name).Scan(&available); err != nil || available != 1 {
			t.Fatalf("%s is indexed %d times for the edited work, %v", name, available, err)
		}
	}
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, "RJ00000002", filepath.FromSlash(folderEditVTTPath))); err != nil {
		t.Fatalf("the source folder lost its file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.originalPath))); !os.IsNotExist(err) {
		t.Fatalf("the removed file is still there: %v", err)
	}
	var availability string
	if err := fixture.db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", fixture.originalLocationID).Scan(&availability); err != nil || availability != "unavailable" {
		t.Fatalf("removed location availability = %q, %v", availability, err)
	}
	var remoteEditionFolders int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM work_folder_location WHERE work_id = 902").Scan(&remoteEditionFolders); err != nil || remoteEditionFolders != 1 {
		t.Fatalf("the sibling edition has %d folders, %v", remoteEditionFolders, err)
	}
	fixture.assertNoEditStaging(t)

	// A job that stopped after its last step and before its result resumes
	// from its checkpoint without changing the folder again.
	if err := fixture.db.QueryRow("SELECT checkpoint_json FROM workflow_job WHERE id = ?", job.ID).Scan(&job.CheckpointJSON); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_run SET status = 'running' WHERE id = ?", job.RunID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatalf("resumed job: %v", err)
	}
	if status := fixture.runStatus(t, job.RunID); status != "succeeded" {
		t.Fatalf("resumed run status = %q", status)
	}
	if content, err := os.ReadFile(fixture.targetFile(folderEditAudioPath)); err != nil || string(content) != folderEditRemoteAudio {
		t.Fatalf("repeated job changed the published file: %q, %v", content, err)
	}
}

func TestWorkFolderEditPlanResolvesTargetConflicts(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	originalName := strings.TrimPrefix(fixture.originalPath, fixture.root+"/")
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{
		originalName:      "a different translated recording",
		folderEditVTTPath: lyricsFetchVTT,
	})
	conflicting := localAddition(siblingFolderID, originalName)
	itemKey := "local:" + jsonNumber(siblingFolderID) + ":" + originalName

	plan := fixture.plan(t, map[string]any{"additions": []any{conflicting}})
	if plan.Summary.Conflict != 1 || !plan.Items[0].TargetConflict {
		t.Fatalf("a different file at the target is not a conflict: %+v", plan.Items)
	}
	if response := fixture.request(t, fixture.server.applyWorkFolderEdit, map[string]any{"additions": []any{conflicting}}); response.Code != http.StatusConflict {
		t.Fatalf("applying a conflict: status = %d, body = %s", response.Code, response.Body.String())
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("a conflicting edit queued a run")
	}

	keepBoth := fixture.plan(t, map[string]any{
		"additions": []any{conflicting},
		"decisions": []any{map[string]any{"itemKey": itemKey, "resolution": "keep_both"}},
	})
	if keepBoth.Summary.Conflict != 0 || keepBoth.Items[0].TargetPath == fixture.originalPath {
		t.Fatalf("keep both did not choose a free target: %+v", keepBoth.Items[0])
	}

	// Taking the file out of the folder in the same edit frees its name.
	replacing := map[string]any{"additions": []any{conflicting}, "removeLocationIds": []int64{fixture.originalLocationID}}
	if replaced := fixture.plan(t, replacing); replaced.Summary.Conflict != 0 || replaced.Summary.Add != 1 || replaced.Summary.Remove != 1 {
		t.Fatalf("replacing a removed file: %+v", replaced.Summary)
	}
	job := fixture.apply(t, replacing)
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if content, err := os.ReadFile(fixture.targetFile(originalName)); err != nil || string(content) != "a different translated recording" {
		t.Fatalf("replaced file = %q, %v", content, err)
	}

	// The file now in the folder has the sibling's size, so adding it again
	// leaves the folder as it is.
	if again := fixture.plan(t, map[string]any{"additions": []any{conflicting}}); again.Summary.Skip != 1 || again.Summary.Add != 0 {
		t.Fatalf("adding a file that is already there: %+v", again.Summary)
	}
	fixture.assertNoEditStaging(t)
}

func TestWorkFolderEditRejectsUnsafeRequestsWithoutWriting(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{folderEditVTTPath: lyricsFetchVTT})
	outside := filepath.Join(fixture.dataRoot, "outside.txt")
	if err := os.WriteFile(outside, []byte("not part of the work"), 0o644); err != nil {
		t.Fatal(err)
	}
	var siblingLocationID int64
	if err := fixture.server.indexLocalMediaForWork(context.Background(), 902, 1, "RJ00000002"); err != nil {
		t.Fatal(err)
	}
	if err := fixture.db.QueryRow(`
		SELECT location.id FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = 902 AND location.location_type = 'local' LIMIT 1
	`).Scan(&siblingLocationID); err != nil {
		t.Fatal(err)
	}
	valid := []any{localAddition(siblingFolderID, folderEditVTTPath)}
	for name, test := range map[string]struct {
		body        map[string]any
		permissions []string
	}{
		"no file permission":               {body: map[string]any{"additions": valid}, permissions: []string{"library:write"}},
		"remote files without remote":      {body: map[string]any{"additions": []any{remoteAddition("RJ00000002", folderEditAudioPath)}}, permissions: []string{"downloads:manage"}},
		"an edition of another work":       {body: map[string]any{"additions": []any{remoteAddition("RJ00000003", folderEditAudioPath)}}},
		"a file the edition does not list": {body: map[string]any{"additions": []any{remoteAddition("RJ00000002", "Translated/missing.mp3")}}},
		"a folder of another edition":      {body: map[string]any{"folderId": siblingFolderID, "additions": valid}},
		"the edited folder as a source":    {body: map[string]any{"additions": []any{localAddition(fixture.folderID, "mp3/Track1.Original name.mp3")}}},
		"a path above the source folder":   {body: map[string]any{"additions": []any{localAddition(siblingFolderID, "../outside.txt")}}},
		"a file that is not there":         {body: map[string]any{"additions": []any{localAddition(siblingFolderID, "Translated/missing.vtt")}}},
		"removing another edition's file":  {body: map[string]any{"removeLocationIds": []int64{siblingLocationID}}},
		"a target outside the folder": {body: map[string]any{"additions": valid, "decisions": []any{map[string]any{
			"itemKey": "local:" + jsonNumber(siblingFolderID) + ":" + folderEditVTTPath, "resolution": "rename", "targetPath": "../../outside.txt",
		}}}},
		"an edit that changes nothing": {body: map[string]any{}},
	} {
		for _, handler := range []http.HandlerFunc{fixture.server.planWorkFolderEdit, fixture.server.applyWorkFolderEdit} {
			response := fixture.request(t, handler, test.body, test.permissions...)
			if name == "an edit that changes nothing" && response.Code == http.StatusOK {
				continue
			}
			if response.Code < 400 || response.Code >= 500 {
				t.Fatalf("%s: status = %d, body = %s", name, response.Code, response.Body.String())
			}
			if strings.Contains(response.Body.String(), fixture.dataRoot) {
				t.Fatalf("%s: the response reveals a local path: %s", name, response.Body.String())
			}
		}
	}
	if fixture.queuedRuns(t) != 0 {
		t.Fatal("a rejected edit queued a run")
	}
	if content, err := os.ReadFile(outside); err != nil || string(content) != "not part of the work" {
		t.Fatalf("a file outside the work changed: %q, %v", content, err)
	}
	if _, err := os.Stat(fixture.targetFile(folderEditVTTPath)); !os.IsNotExist(err) {
		t.Fatalf("a rejected edit wrote into the folder: %v", err)
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("rejected edits made %d upstream requests", fixture.requests.Load())
	}
}

// listRemoteAudio makes the sibling edition's remote tree list its audio file
// at downloadURL, relative to the source when it starts with a slash, with a
// declared size.
func (fixture folderEditFixture) listRemoteAudio(t *testing.T, downloadURL string, size int64) {
	t.Helper()
	ctx := context.Background()
	source, err := fixture.server.currentRemoteCacheSource(ctx, 7)
	if err != nil {
		t.Fatal(err)
	}
	key := remoteWorkCacheKeyForLanguages(source.ID, "RJ00000002", fixture.server.instanceMetadataLanguages(ctx))
	snapshot := fixture.server.remoteWorkTracksCache[key]
	if strings.HasPrefix(downloadURL, "/") {
		downloadURL = strings.TrimSuffix(snapshot.Tracks[0].Children[1].MediaDownloadURL, "/media/audio.mp3") + downloadURL
	}
	snapshot.Tracks = []kikoeru.Track{{Type: "folder", Title: "Translated", Children: []kikoeru.Track{
		{Type: "audio", Title: "Track1.Translated name.mp3", Size: int64Pointer(size), MediaDownloadURL: downloadURL},
	}}}
	snapshot.ExpiresAt = time.Now().Add(time.Minute)
	fixture.server.remoteWorkTracksCache[key] = snapshot
}

func TestWorkFolderEditFailedDownloadChangesNothing(t *testing.T) {
	size := int64(len(folderEditRemoteAudio))
	for name, test := range map[string]struct {
		downloadURL string
		size        int64
		cancelled   bool
		requests    int32
	}{
		"a body larger than the listing declares": {downloadURL: "/media/audio.mp3", size: size - 4, requests: 1},
		"an address outside the source":           {downloadURL: folderEditForeignURL, size: size},
		"a redirect outside the source":           {downloadURL: "/media/redirect", size: size, requests: 1},
		"a cancelled run":                         {downloadURL: "/media/audio.mp3", size: size, cancelled: true},
	} {
		t.Run(name, func(t *testing.T) {
			fixture := newFolderEditFixture(t, serveFolderEditMedia)
			fixture.listRemoteAudio(t, test.downloadURL, test.size)
			job := fixture.apply(t, map[string]any{
				"additions":         []any{remoteAddition("RJ00000002", folderEditAudioPath)},
				"removeLocationIds": []int64{fixture.originalLocationID},
			})
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			if test.cancelled {
				cancel()
			}
			if err := fixture.server.executeWorkFolderEditJob(ctx, job); err == nil {
				t.Fatal("the edit reported success")
			}
			if status := fixture.runStatus(t, job.RunID); status != "failed" {
				t.Fatalf("run status = %q", status)
			}
			if requests := fixture.requests.Load(); requests != test.requests {
				t.Fatalf("upstream requests = %d, want %d", requests, test.requests)
			}
			if _, err := os.Stat(fixture.targetFile(folderEditAudioPath)); !os.IsNotExist(err) {
				t.Fatalf("a failed download was published: %v", err)
			}
			if _, err := os.Stat(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.originalPath))); err != nil {
				t.Fatalf("a failed edit removed a file: %v", err)
			}
			var availability string
			if err := fixture.db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", fixture.originalLocationID).Scan(&availability); err != nil || availability != "available" {
				t.Fatalf("location availability after a failed edit = %q, %v", availability, err)
			}
			fixture.assertNoEditStaging(t)
		})
	}
}

func TestWorkFolderEditFamilyCheckRecordsEveryEditionsAvailability(t *testing.T) {
	var mu sync.Mutex
	var searched []string
	searchedCodes := func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), searched...)
	}
	fixture := newFolderEditFixture(t, func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/api/health":
			_ = json.NewEncoder(w).Encode("ok")
		case strings.HasPrefix(r.URL.Path, "/api/search/"):
			code := strings.TrimPrefix(r.URL.Path, "/api/search/")
			mu.Lock()
			searched = append(searched, code)
			mu.Unlock()
			page := kikoeru.WorksPage{Works: []kikoeru.Work{}}
			if code == "RJ00000002" {
				page.Works = append(page.Works, kikoeru.Work{ID: 72, SourceID: code, Title: "Example Work 2"})
			}
			_ = json.NewEncoder(w).Encode(page)
		default:
			serveFolderEditMedia(w, r)
		}
	})
	if _, err := fixture.db.Exec(`INSERT INTO app_setting (key, value_json) VALUES ('remote_request_delay_base_seconds', '0'), ('remote_request_delay_random_seconds', '0')`); err != nil {
		t.Fatal(err)
	}
	sourceStatus := func(sources workFolderEditSources, code string) string {
		for _, edition := range sources.Editions {
			if edition.PrimaryCode != code {
				continue
			}
			for _, source := range edition.Sources {
				if source.SourceID == 7 {
					return source.Status
				}
			}
		}
		return ""
	}
	decode := func(response *httptest.ResponseRecorder) workFolderEditSources {
		t.Helper()
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		var sources workFolderEditSources
		if err := json.Unmarshal(response.Body.Bytes(), &sources); err != nil {
			t.Fatal(err)
		}
		return sources
	}

	before := decode(fixture.request(t, fixture.server.listWorkFolderEditSources, nil, "downloads:manage"))
	if status := sourceStatus(before, "RJ00000002"); status == "available" {
		t.Fatalf("sibling edition is available before any check: %q", status)
	}

	if response := fixture.request(t, fixture.server.checkWorkFolderEditSources, nil, "downloads:manage"); response.Code != http.StatusForbidden {
		t.Fatalf("check without remote:track status = %d", response.Code)
	}
	if codes := searchedCodes(); len(codes) != 0 {
		t.Fatalf("a refused check asked the source about %v", codes)
	}

	checked := decode(fixture.request(t, fixture.server.checkWorkFolderEditSources, nil, "downloads:manage", "remote:track"))
	if status := sourceStatus(checked, "RJ00000002"); status != "available" {
		t.Fatalf("sibling edition status = %q, want available", status)
	}
	if status := sourceStatus(checked, "RJ00000001"); status != "not_found" {
		t.Fatalf("origin edition status = %q, want not_found", status)
	}
	for _, code := range searchedCodes() {
		if code == "RJ00000003" {
			t.Fatal("the check asked about a work outside the family")
		}
	}

	// The answers are stored, so the ordinary listing reports them too.
	after := decode(fixture.request(t, fixture.server.listWorkFolderEditSources, nil, "downloads:manage"))
	if status := sourceStatus(after, "RJ00000002"); status != "available" {
		t.Fatalf("stored sibling status = %q, want available", status)
	}
}
