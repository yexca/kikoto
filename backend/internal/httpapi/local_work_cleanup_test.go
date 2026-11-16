package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

const localWorkCleanupSourceID = 40

type localWorkCleanupFixture struct {
	t        *testing.T
	db       *sqlutil.DB
	dataRoot string
	server   *Server
}

func newLocalWorkCleanupFixture(t *testing.T) *localWorkCleanupFixture {
	t.Helper()
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	if _, err := db.Exec(`
		INSERT INTO user_account (id, username, display_name, role) VALUES
			(1, 'synthetic-admin', 'Synthetic admin', 'admin'),
			(2, 'synthetic-listener', 'Synthetic listener', 'user')`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO file_source (id, code, display_name, source_type) VALUES (?, 'cleanup-local', 'Cleanup local', 'local_folder')`, localWorkCleanupSourceID); err != nil {
		t.Fatal(err)
	}
	return &localWorkCleanupFixture{
		t: t, db: db, dataRoot: dataRoot,
		server: NewServer(db, config.Config{DataRoot: dataRoot, CacheRoot: t.TempDir()}),
	}
}

func (f *localWorkCleanupFixture) exec(query string, args ...any) {
	f.t.Helper()
	if _, err := f.db.Exec(query, args...); err != nil {
		f.t.Fatal(err)
	}
}

// addLocalWork indexes one work folder named after code holding one file of
// size bytes, written to disk.
func (f *localWorkCleanupFixture) addLocalWork(id int64, code string, size int64) {
	f.t.Helper()
	f.exec("INSERT INTO work (id, primary_code, title) VALUES (?, ?, ?)", id, code, "Example Work "+code)
	f.addFolder(id, code, size)
}

func (f *localWorkCleanupFixture) addFolder(workID int64, root string, size int64) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Join(f.dataRoot, root), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.dataRoot, root, "track.mp3"), []byte(strings.Repeat("a", int(size))), 0o644); err != nil {
		f.t.Fatal(err)
	}
	f.exec(`INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary)
		VALUES (?, ?, ?, ?, 'external', 'active', 1)`, workID, workID, localWorkCleanupSourceID, root)
	f.exec(`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability)
		VALUES (?, ?, 'local', ?, 'available')`, workID, localWorkCleanupSourceID, root)
	if err := f.server.indexLocalMediaForWork(context.Background(), workID, localWorkCleanupSourceID, root); err != nil {
		f.t.Fatal(err)
	}
}

// itemID is the media item the index made for a work's track.
func (f *localWorkCleanupFixture) itemID(workID int64) int64 {
	f.t.Helper()
	var id int64
	if err := f.db.QueryRow("SELECT id FROM media_item WHERE work_id = ? ORDER BY id LIMIT 1", workID).Scan(&id); err != nil {
		f.t.Fatal(err)
	}
	return id
}

func (f *localWorkCleanupFixture) rate(userID, workID int64, rating any, status string) {
	f.t.Helper()
	f.exec("INSERT INTO user_work_state (user_id, work_id, listening_status, rating) VALUES (?, ?, ?, ?)", userID, workID, status, rating)
}

func (f *localWorkCleanupFixture) list(query string) localWorkCleanupListResponse {
	f.t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/api/maintenance/local-works/cleanup?"+query, nil)
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{ID: 1, Permissions: []string{"downloads:manage"}}))
	response := httptest.NewRecorder()
	f.server.listLocalWorkCleanup(response, request)
	if response.Code != http.StatusOK {
		f.t.Fatalf("list status = %d: %s", response.Code, response.Body.String())
	}
	var result localWorkCleanupListResponse
	if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
		f.t.Fatal(err)
	}
	return result
}

func (f *localWorkCleanupFixture) confirmed(query string) []localWorkCleanupConfirmedWork {
	f.t.Helper()
	works := []localWorkCleanupConfirmedWork{}
	for _, candidate := range f.list(query).Works {
		work := localWorkCleanupConfirmedWork{WorkID: candidate.WorkID}
		for _, folder := range candidate.Folders {
			work.Folders = append(work.Folders, localWorkCleanupConfirmedFolder{ID: folder.ID, Path: folder.Path})
		}
		works = append(works, work)
	}
	return works
}

func (f *localWorkCleanupFixture) count(query string, args ...any) int {
	f.t.Helper()
	var count int
	if err := f.db.QueryRow(query, args...).Scan(&count); err != nil {
		f.t.Fatal(err)
	}
	return count
}

func TestLocalWorkCleanupListsFamiliesByAdministratorRatingAndSize(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(401, "RJ00000001", 10)
	f.addLocalWork(402, "RJ00000002", 30)
	f.addLocalWork(403, "RJ00000003", 20)
	f.addLocalWork(404, "RJ00000004", 40)
	// RJ00000005 is a translated edition of RJ00000003 with its own folder.
	f.addLocalWork(405, "RJ00000005", 5)
	f.exec("INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (41, 403, 'RJ00000003')")
	f.exec(`INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
		(403, 41, 'RJ00000003', 'RJ00000003', 1), (405, 41, 'RJ00000005', 'RJ00000003', 0)`)
	f.rate(1, 401, 1, "finished")
	f.rate(1, 402, 2, "none")
	f.rate(1, 403, 1, "none")
	f.rate(1, 405, 4, "listening")
	// Another account's rating does not decide the selection.
	f.rate(2, 404, 1, "finished")

	result := f.list("maxRating=2")
	codes := []string{}
	for _, work := range result.Works {
		codes = append(codes, work.PrimaryCode)
	}
	if strings.Join(codes, ",") != "RJ00000002,RJ00000001" || result.Total != 2 {
		t.Fatalf("rated at most 2 = %v total %d", codes, result.Total)
	}

	result = f.list("maxRating=5&unrated=true")
	if result.Total != 4 || result.Works[0].PrimaryCode != "RJ00000004" || result.Works[0].Rating != nil {
		t.Fatalf("all works = %#v", result.Works)
	}
	family := result.Works[2]
	if family.PrimaryCode != "RJ00000003" || family.SizeBytes != 25 || len(family.Folders) != 2 ||
		family.Rating == nil || *family.Rating != 4 || family.ListeningStatus != "listening" {
		t.Fatalf("edition family = %#v, want one canonical row with both folders and the highest rating", family)
	}
}

func TestLocalWorkCleanupRequestGuards(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(411, "RJ00000011", 10)
	f.rate(1, 411, 4, "finished")
	works := f.confirmed("maxRating=5")

	_, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{
		Works: works, ClearRating: true, Forget: true, ConfirmHighRated: true,
	})
	var requestErr *requestError
	if !errors.As(err, &requestErr) || requestErr.status != http.StatusBadRequest {
		t.Fatalf("forget without clearing the Quick mark = %v, want a bad request", err)
	}

	_, err = f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: works})
	if !errors.As(err, &requestErr) || requestErr.code != localWorkCleanupHighRatingCode {
		t.Fatalf("unconfirmed high rating = %v, want %s", err, localWorkCleanupHighRatingCode)
	}

	changed := []localWorkCleanupConfirmedWork{{WorkID: 411, Folders: []localWorkCleanupConfirmedFolder{{ID: 411, Path: "RJ00000099"}}}}
	_, err = f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: changed, ConfirmHighRated: true})
	var conflict mediaCleanupTargetConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("changed folder = %v, want a target conflict", err)
	}
	if f.count("SELECT COUNT(*) FROM workflow_run") != 0 {
		t.Fatal("a refused request queued a run")
	}
}

func TestLocalWorkCleanupRefusesAnOfflineLibrary(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(421, "RJ00000021", 10)
	works := f.confirmed("unrated=true")
	// An unmounted data root leaves nothing at its path.
	if err := os.RemoveAll(f.dataRoot); err != nil {
		t.Fatal(err)
	}
	if listed := f.list("unrated=true"); len(listed.Works) != 1 || !listed.Works[0].Offline {
		t.Fatalf("unmounted data root listing = %#v, want the work marked offline", listed.Works)
	}
	_, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: works})
	var conflict mediaCleanupTargetConflictError
	if !errors.As(err, &conflict) {
		t.Fatalf("offline cleanup = %v, want a target conflict", err)
	}
}

func TestLocalWorkCleanupDeletesFilesAndClearsOnlyTheAdministratorsState(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(431, "RJ00000031", 10)
	f.addLocalWork(432, "RJ00000032", 10)
	f.rate(1, 431, 1, "finished")
	f.rate(1, 432, 2, "paused")
	f.rate(2, 431, 5, "relisten")

	queued, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{
		Works: f.confirmed("maxRating=2"), ClearRating: true, ClearMark: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if queued.Works != 2 {
		t.Fatalf("queued = %#v, want two works", queued)
	}
	// The requester can cancel and retry the run without sources:write.
	if count := f.count("SELECT COUNT(*) FROM workflow_run WHERE id = ? AND json_extract(input_json, '$.requested_by_user_id') = 1", queued.RunID); count != 1 {
		t.Fatal("the run does not name its requester")
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{"RJ00000031", "RJ00000032"} {
		if _, err := os.Stat(filepath.Join(f.dataRoot, root)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists: %v", root, err)
		}
	}
	if count := f.count("SELECT COUNT(*) FROM work WHERE id IN (431, 432)"); count != 2 {
		t.Fatalf("works = %d, want both kept", count)
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE user_id = 1 AND (rating IS NOT NULL OR listening_status <> 'none')"); count != 0 {
		t.Fatalf("administrator state rows left = %d", count)
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE user_id = 2 AND work_id = 431 AND rating = 5 AND listening_status = 'relisten'"); count != 1 {
		t.Fatal("another account's rating and mark changed")
	}
	var summary string
	if err := f.db.QueryRow("SELECT summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, `"cleared_ratings":2`) || !strings.Contains(summary, `"cleared_marks":2`) {
		t.Fatalf("summary = %s", summary)
	}
}

func TestLocalWorkCleanupForgetsFamiliesForEveryAccountUnlessASourceRemains(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(441, "RJ00000041", 10)
	f.addLocalWork(442, "RJ00000042", 10)
	f.addLocalWork(443, "RJ00000043", 10)
	f.exec("INSERT INTO logical_work (id, canonical_work_id, canonical_code) VALUES (44, 441, 'RJ00000041')")
	f.exec(`INSERT INTO work_edition (work_id, logical_work_id, primary_code, base_code, is_canonical) VALUES
		(441, 44, 'RJ00000041', 'RJ00000041', 1), (442, 44, 'RJ00000042', 'RJ00000041', 0)`)
	cacheRoot := f.server.cfg.CacheRoot
	if err := os.WriteFile(filepath.Join(cacheRoot, "cached.mp3"), []byte("cache"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (4410, ?, ?, 'cache', 'cached.mp3', 'available')`, f.itemID(441), localWorkCleanupSourceID)
	// RJ00000043 is still on a remote source, so forgetting keeps it.
	f.exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, availability)
		VALUES (4430, ?, ?, 'remote_stream', 'remote/track.mp3', 'available')`, f.itemID(443), localWorkCleanupSourceID)
	f.rate(1, 441, 1, "finished")
	f.rate(1, 443, 3, "finished")
	f.rate(2, 442, 5, "listening")
	f.rate(2, 443, 5, "listening")

	works := f.confirmed("maxRating=3")
	if len(works) != 2 {
		t.Fatalf("candidates = %#v, want the family and RJ00000043", works)
	}
	queued, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{
		Works: works, ClearRating: true, ClearMark: true, Forget: true, ConfirmHighRated: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(cacheRoot, "cached.mp3")); !os.IsNotExist(err) {
		t.Fatalf("cached copy of a forgotten work still exists: %v", err)
	}
	if count := f.count("SELECT COUNT(*) FROM work WHERE id IN (441, 442)"); count != 0 {
		t.Fatalf("forgotten family works left = %d", count)
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE work_id IN (441, 442)"); count != 0 {
		t.Fatal("personal state of a forgotten work survived")
	}
	if count := f.count("SELECT COUNT(*) FROM work WHERE id = 443"); count != 1 {
		t.Fatal("a work another source still provides was forgotten")
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE user_id = 1 AND work_id = 443 AND rating IS NULL AND listening_status = 'none'"); count != 1 {
		t.Fatal("the administrator's state of a retained work was not cleared")
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE user_id = 2 AND work_id = 443 AND rating = 5"); count != 1 {
		t.Fatal("another account's state of a retained work changed")
	}
	var status string
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "partial" {
		t.Fatalf("run status = %q, want partial for the retained work", status)
	}
}

func TestLocalWorkCleanupFinishesOtherWorksAndRetriesTheOneThatFailed(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(451, "RJ00000051", 20)
	f.addLocalWork(452, "RJ00000052", 10)
	f.rate(1, 451, 1, "finished")
	f.rate(1, 452, 1, "finished")
	works := f.confirmed("maxRating=1")
	// A recycle bin can hold the user's files, so the library skips it
	// without deleting it, and the larger work's folder cannot be removed.
	blocker := filepath.Join(f.dataRoot, "RJ00000051", "#recycle")
	if err := os.MkdirAll(blocker, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(blocker, "kept.mp3"), []byte("kept"), 0o644); err != nil {
		t.Fatal(err)
	}
	queued, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{
		Works: works, ClearRating: true, ClearMark: true, Forget: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	_ = f.server.runNextQueuedWorkflowJob(context.Background())
	if count := f.count("SELECT COUNT(*) FROM work WHERE id = 452"); count != 0 {
		t.Fatal("the work after the failed one was not cleaned")
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE user_id = 1 AND work_id = 451 AND rating = 1 AND listening_status = 'finished'"); count != 1 {
		t.Fatal("state was cleared although the folder could not be deleted")
	}
	if count := f.count("SELECT COUNT(*) FROM work_folder_location WHERE id = 451 AND state = 'active' AND cleanup_run_id IS NULL"); count != 1 {
		t.Fatal("the folder that could not be deleted was not returned to its work")
	}
	var status string
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "failed" {
		t.Fatalf("run status = %q, want failed so it can be retried", status)
	}

	if err := os.RemoveAll(blocker); err != nil {
		t.Fatal(err)
	}
	if err := f.server.retryFailedWorkflowJob(context.Background(), queued.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	if count := f.count("SELECT COUNT(*) FROM work WHERE id = 451"); count != 0 {
		t.Fatal("the retried work was not forgotten")
	}
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" {
		t.Fatalf("retried run status = %q, want succeeded", status)
	}
}

func TestLocalWorkCleanupRemovesSystemSidecarsWithTheFolder(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(471, "RJ00000071", 10)
	root := filepath.Join(f.dataRoot, "RJ00000071")
	for _, name := range []string{"Thumbs.db", ".DS_Store", "._track.mp3", filepath.Join("@eaDir", "track.mp3", "SYNOFILE_THUMB_M.jpg")} {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte("sidecar"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: f.confirmed("unrated=true")}); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("folder with sidecars still exists: %v", err)
	}
}

func TestLocalWorkCleanupListsOnlyDemoWorksInDemo(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(481, "RJ00000081", 10)
	f.addLocalWork(482, "RJ00000082", 10)
	f.exec("UPDATE work SET is_permanently_free = 1, age_rating = 'general' WHERE id = 481")
	f.exec("UPDATE work SET is_permanently_free = 0, age_rating = 'adult' WHERE id = 482")
	f.server.cfg.Mode = config.ModeDemo
	result := f.list("unrated=true")
	if len(result.Works) != 1 || result.Works[0].PrimaryCode != "RJ00000081" {
		t.Fatalf("Demo listing = %#v, want only the admitted work", result.Works)
	}
}

func TestLocalWorkCleanupLeavesAFolderAddedAfterConfirmation(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(491, "RJ00000091", 10)
	if _, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: f.confirmed("unrated=true")}); err != nil {
		t.Fatal(err)
	}
	// A scan finds the work in a second folder while the cleanup waits to run.
	extra := filepath.Join(f.dataRoot, "Extra", "RJ00000091")
	if err := os.MkdirAll(extra, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(extra, "copy.mp3"), []byte("copy"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.exec(`INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary)
		VALUES (4911, 491, ?, 'Extra/RJ00000091', 'external', 'active', 0)`, localWorkCleanupSourceID)
	if err := f.server.indexLocalMediaForWork(context.Background(), 491, localWorkCleanupSourceID, "Extra/RJ00000091"); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.dataRoot, "RJ00000091")); !os.IsNotExist(err) {
		t.Fatalf("confirmed folder still exists: %v", err)
	}
	if _, err := os.Stat(filepath.Join(extra, "copy.mp3")); err != nil {
		t.Fatalf("a file in the unconfirmed folder was deleted: %v", err)
	}
	if count := f.count("SELECT COUNT(*) FROM work_folder_location WHERE id = 4911 AND state = 'active'"); count != 1 {
		t.Fatal("the unconfirmed folder is no longer active")
	}
}

func TestLocalWorkCleanupIsRefusedInDemo(t *testing.T) {
	server := NewServer(nil, config.Config{Mode: config.ModeDemo})
	request := httptest.NewRequest(http.MethodPost, "/api/maintenance/local-works/cleanup", strings.NewReader(`{"works":[]}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"system:admin"},
	}))
	response := httptest.NewRecorder()
	server.demoReadOnlyMiddleware(http.HandlerFunc(server.cleanupLocalWorks)).ServeHTTP(response, request)
	if response.Code != http.StatusForbidden || !strings.Contains(response.Body.String(), "demo_read_only") {
		t.Fatalf("Demo cleanup = %d %s, want 403 demo_read_only", response.Code, response.Body.String())
	}
}

func TestLocalWorkCleanupRetryOfForgettingNeedsSourcesWrite(t *testing.T) {
	forget := workflowJobRecord{WorkerType: "media_location_cleanup", PayloadJSON: mustJSON(mediaCleanupJobPayload{Mode: mediaCleanupForgetWork})}
	if permissions := workflowJobRetryPermissions(forget); strings.Join(permissions, ",") != "downloads:manage,sources:write" {
		t.Fatalf("forget retry permissions = %v", permissions)
	}
	files := workflowJobRecord{WorkerType: "media_location_cleanup", PayloadJSON: mustJSON(mediaCleanupJobPayload{Mode: mediaCleanupFilesOnly})}
	if permissions := workflowJobRetryPermissions(files); strings.Join(permissions, ",") != "downloads:manage" {
		t.Fatalf("file retry permissions = %v", permissions)
	}
}

func TestLocalWorkCleanupIndexesFilesNobodyOpenedBeforeDeleting(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(461, "RJ00000061", 10)
	// A file added after the folder was indexed, and a folder never indexed.
	if err := os.WriteFile(filepath.Join(f.dataRoot, "RJ00000061", "added.mp3"), []byte("added"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.exec("INSERT INTO work (id, primary_code, title) VALUES (462, 'RJ00000062', 'Example Work RJ00000062')")
	if err := os.MkdirAll(filepath.Join(f.dataRoot, "RJ00000062", "disc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.dataRoot, "RJ00000062", "disc", "track.mp3"), []byte("track"), 0o644); err != nil {
		t.Fatal(err)
	}
	f.exec(`INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary)
		VALUES (462, 462, ?, 'RJ00000062', 'external', 'active', 1)`, localWorkCleanupSourceID)
	f.exec(`INSERT INTO work_source_presence (work_id, file_source_id, presence_type, source_url, availability)
		VALUES (462, ?, 'local', 'RJ00000062', 'available')`, localWorkCleanupSourceID)

	if _, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: f.confirmed("unrated=true")}); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{"RJ00000061", "RJ00000062"} {
		if _, err := os.Stat(filepath.Join(f.dataRoot, root)); !os.IsNotExist(err) {
			t.Fatalf("%s still exists: %v", root, err)
		}
	}
}

func TestLocalWorkCleanupForgetRequiresSourcesWrite(t *testing.T) {
	server := NewServer(nil, config.Config{})
	request := httptest.NewRequest(http.MethodPost, "/api/maintenance/local-works/cleanup", strings.NewReader(`{"forget":true,"works":[]}`))
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, currentUser{
		ID: 1, Permissions: []string{"downloads:manage"},
	}))
	response := httptest.NewRecorder()
	server.cleanupLocalWorks(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusForbidden)
	}
}
