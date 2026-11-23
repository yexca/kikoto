package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"github.com/yexca/kikoto/backend/internal/storagepool"
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

	result := f.list("rating=2")
	codes := []string{}
	for _, work := range result.Works {
		codes = append(codes, work.PrimaryCode)
	}
	if strings.Join(codes, ",") != "RJ00000002,RJ00000001" || result.Total != 2 {
		t.Fatalf("rated at most 2 = %v total %d", codes, result.Total)
	}

	result = f.list("rating=any")
	if result.Total != 4 || result.Works[0].PrimaryCode != "RJ00000004" || result.Works[0].Rating != nil {
		t.Fatalf("all works = %#v", result.Works)
	}
	family := result.Works[2]
	if family.PrimaryCode != "RJ00000003" || family.SizeBytes != 25 || len(family.Folders) != 2 ||
		family.Rating == nil || *family.Rating != 4 || family.ListeningStatus != "listening" {
		t.Fatalf("edition family = %#v, want one canonical row with both folders and the highest rating", family)
	}
}

func localWorkCleanupCodes(result localWorkCleanupListResponse) string {
	codes := []string{}
	for _, work := range result.Works {
		codes = append(codes, work.PrimaryCode)
	}
	return strings.Join(codes, ",")
}

func TestLocalWorkCleanupSearchFiltersOrdersAndKeepsAtMostItsLimit(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(421, "RJ00000021", 50)
	f.addLocalWork(422, "RJ00000022", 40)
	f.addLocalWork(423, "RJ00000023", 30)
	f.addLocalWork(424, "RJ00000024", 20)
	f.addLocalWork(425, "RJ00000025", 10)
	f.rate(1, 421, 1, "finished")
	f.rate(1, 423, 2, "listening")
	f.rate(1, 424, 1, "none")
	f.rate(1, 425, 2, "want_to_listen")
	const all = "rating=any"

	for _, check := range []struct{ query, want string }{
		{all + "&listening=settled", "RJ00000021,RJ00000022,RJ00000024"},
		{all + "&listening=finished", "RJ00000021"},
		{all + "&listening=none", "RJ00000022,RJ00000024"},
		{all + "&minBytes=35", "RJ00000021,RJ00000022"},
		// Lowest rating first, larger first within a rating, unrated last.
		{all + "&sort=rating", "RJ00000021,RJ00000024,RJ00000023,RJ00000025,RJ00000022"},
		{all + "&sort=rating&direction=desc", "RJ00000023,RJ00000025,RJ00000021,RJ00000024,RJ00000022"},
		{all + "&sort=size&direction=asc", "RJ00000025,RJ00000024,RJ00000023,RJ00000022,RJ00000021"},
		{"rating=unrated", "RJ00000022"},
		{"rating=1", "RJ00000021,RJ00000024"},
	} {
		if got := localWorkCleanupCodes(f.list(check.query)); got != check.want {
			t.Errorf("%s = %s, want %s", check.query, got, check.want)
		}
	}

	// The search keeps its three largest works and pages through them, each
	// with its cached cover.
	writeCachedTestCover(t, f.server.cfg.CacheRoot, "RJ00000023")
	page := f.list(all + "&limit=3&pageSize=2&page=2")
	if got := localWorkCleanupCodes(page); got != "RJ00000023" || page.Total != 3 || page.Matched != 5 || page.Limit != 3 {
		t.Fatalf("second page of three = %s total %d matched %d limit %d", got, page.Total, page.Matched, page.Limit)
	}
	if cover := page.Works[0].CoverURL; !strings.HasPrefix(cover, "/api/assets/covers/") {
		t.Fatalf("cover of RJ00000023 = %q, want its cached cover", cover)
	}
	if len(page.Pools) != 0 {
		t.Fatalf("standard library pools = %#v, want none", page.Pools)
	}
}

func TestLocalWorkCleanupSearchNarrowsToAStoragePool(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	ctx := context.Background()
	if err := f.server.saveSettingValue(ctx, settingLibraryMode, storagepool.ModePools); err != nil {
		t.Fatal(err)
	}
	pools := []storagepool.Pool{{Path: "disk1", ID: "synthetic-pool-1"}, {Path: "disk2", ID: "synthetic-pool-2"}}
	if err := f.server.saveSettingValue(ctx, settingStoragePools, pools); err != nil {
		t.Fatal(err)
	}
	for _, pool := range pools {
		if err := os.MkdirAll(filepath.Join(f.dataRoot, pool.Path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := storagepool.WriteMarker(filepath.Join(f.dataRoot, pool.Path), pool.ID); err != nil {
			t.Fatal(err)
		}
	}
	f.exec("INSERT INTO work (id, primary_code, title) VALUES (431, 'RJ00000031', 'Example Work RJ00000031'), (432, 'RJ00000032', 'Example Work RJ00000032')")
	f.addFolder(431, "disk1/RJ00000031", 10)
	f.addFolder(432, "disk2/RJ00000032", 20)

	result := f.list("rating=any&pool=disk1")
	if got := localWorkCleanupCodes(result); got != "RJ00000031" {
		t.Fatalf("works on disk1 = %s", got)
	}
	if len(result.Pools) != 2 || result.Pools[0].Path != "disk1" || !result.Pools[0].Online || result.Pools[1].Path != "disk2" {
		t.Fatalf("pools = %#v", result.Pools)
	}
}

func TestLocalWorkCleanupRequestGuards(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(411, "RJ00000011", 10)
	f.rate(1, 411, 4, "finished")
	works := f.confirmed("rating=5")

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
	works := f.confirmed("rating=unrated")
	// An unmounted data root leaves nothing at its path.
	if err := os.RemoveAll(f.dataRoot); err != nil {
		t.Fatal(err)
	}
	if listed := f.list("rating=unrated"); len(listed.Works) != 1 || !listed.Works[0].Offline {
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
		Works: f.confirmed("rating=2"), ClearRating: true, ClearMark: true,
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

	works := f.confirmed("rating=3")
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
	works := f.confirmed("rating=1")
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
	// What would stop the folder is found first, so the work keeps its files.
	if _, err := os.Stat(filepath.Join(f.dataRoot, "RJ00000051", "track.mp3")); err != nil {
		t.Fatalf("a file of the work that failed was deleted: %v", err)
	}
	if count := f.count(`SELECT COUNT(*) FROM media_file_location AS location INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = 451 AND location.availability = 'available'`); count != 1 {
		t.Fatal("the kept file of the work that failed is not available")
	}
	var summary string
	if err := f.db.QueryRow("SELECT summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&summary); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, "#recycle") || !strings.Contains(summary, "nothing was deleted") {
		t.Fatalf("failure summary = %s", summary)
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

// cleanupStaging is where a run moves a folder before deleting it.
func (f *localWorkCleanupFixture) cleanupStaging(runID, folderID int64) string {
	return filepath.Join(f.dataRoot, ".kikoto-staging", strconv.FormatInt(runID, 10), "cleanup", strconv.FormatInt(folderID, 10))
}

// addSecondFolder indexes another folder of a work, holding one file.
func (f *localWorkCleanupFixture) addSecondFolder(folderID, workID int64, root string) {
	f.t.Helper()
	if err := os.MkdirAll(filepath.Join(f.dataRoot, root), 0o755); err != nil {
		f.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(f.dataRoot, root, "copy.mp3"), []byte("copy"), 0o644); err != nil {
		f.t.Fatal(err)
	}
	f.exec(`INSERT INTO work_folder_location (id, work_id, file_source_id, root_path, role, state, is_primary)
		VALUES (?, ?, ?, ?, 'external', 'active', 0)`, folderID, workID, localWorkCleanupSourceID, root)
	if err := f.server.indexLocalMediaForWork(context.Background(), workID, localWorkCleanupSourceID, root); err != nil {
		f.t.Fatal(err)
	}
}

// A work's folders are deleted all or nothing: when one folder cannot be
// moved out of the library, the folders moved before it go back, and the work
// keeps every file, its rating, and its folders for a retry.
func TestLocalWorkCleanupDeletesNoFolderWhenOneCannotBeMoved(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(495, "RJ00000095", 10)
	f.addSecondFolder(4951, 495, "Extra/RJ00000095")
	f.rate(1, 495, 1, "finished")
	works := f.confirmed("rating=1")
	if len(works) != 1 || len(works[0].Folders) != 2 {
		t.Fatalf("candidates = %#v, want one work with two folders", works)
	}
	queued, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{
		Works: works, ClearRating: true, ClearMark: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	// The folder the run moves last cannot be moved, after the first one is.
	var payloadJSON string
	if err := f.db.QueryRow("SELECT payload_json FROM workflow_job WHERE workflow_run_id = ?", queued.RunID).Scan(&payloadJSON); err != nil {
		t.Fatal(err)
	}
	var payload mediaCleanupJobPayload
	if err := json.Unmarshal([]byte(payloadJSON), &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Works) != 1 || len(payload.Works[0].Folders) != 2 {
		t.Fatalf("job works = %#v", payload.Works)
	}
	first, last := payload.Works[0].Folders[0], payload.Works[0].Folders[1]
	taken := f.cleanupStaging(queued.RunID, last.ID)
	if err := os.MkdirAll(taken, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(taken, "other.txt"), []byte("other"), 0o644); err != nil {
		t.Fatal(err)
	}
	_ = f.server.runNextQueuedWorkflowJob(context.Background())

	for _, file := range []string{"RJ00000095/track.mp3", "Extra/RJ00000095/copy.mp3"} {
		if _, err := os.Stat(filepath.Join(f.dataRoot, filepath.FromSlash(file))); err != nil {
			t.Fatalf("%s of the work that could not be cleaned is gone: %v", file, err)
		}
	}
	if _, err := os.Stat(f.cleanupStaging(queued.RunID, first.ID)); !os.IsNotExist(err) {
		t.Fatalf("the folder moved first was not put back: %v", err)
	}
	if count := f.count("SELECT COUNT(*) FROM work_folder_location WHERE work_id = 495 AND state = 'active' AND cleanup_run_id IS NULL"); count != 2 {
		t.Fatalf("active folders = %d, want both returned to the work", count)
	}
	if count := f.count(`SELECT COUNT(*) FROM media_file_location AS location INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = 495 AND location.availability = 'available'`); count != 2 {
		t.Fatalf("available files = %d, want both", count)
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE user_id = 1 AND work_id = 495 AND rating = 1"); count != 1 {
		t.Fatal("the rating was cleared although nothing was deleted")
	}
	var status, summary string
	if err := f.db.QueryRow("SELECT status, summary_json FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status, &summary); err != nil {
		t.Fatal(err)
	}
	if status != "failed" || !strings.Contains(summary, "nothing was deleted") {
		t.Fatalf("run = %s %s, want failed with nothing deleted", status, summary)
	}

	if err := os.RemoveAll(taken); err != nil {
		t.Fatal(err)
	}
	if err := f.server.retryFailedWorkflowJob(context.Background(), queued.RunID); err != nil {
		t.Fatal(err)
	}
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{"RJ00000095", "Extra/RJ00000095", filepath.Join(".kikoto-staging", strconv.FormatInt(queued.RunID, 10))} {
		if _, err := os.Stat(filepath.Join(f.dataRoot, filepath.FromSlash(root))); !os.IsNotExist(err) {
			t.Fatalf("%s still exists after the retry: %v", root, err)
		}
	}
	if count := f.count("SELECT COUNT(*) FROM user_work_state WHERE user_id = 1 AND work_id = 495 AND rating IS NOT NULL"); count != 0 {
		t.Fatal("the retry did not clear the rating")
	}
}

// A folder an interrupted attempt moved out of the library is deleted by the
// next attempt, or returned to its place when the run gives the folder back.
func TestLocalWorkCleanupFinishesOrReturnsAFolderAnInterruptedAttemptMoved(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(496, "RJ00000096", 10)
	f.addLocalWork(497, "RJ00000097", 10)
	queued, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: f.confirmed("rating=unrated")})
	if err != nil {
		t.Fatal(err)
	}
	moveToStaging := func(folderID int64, root string) string {
		t.Helper()
		staged := f.cleanupStaging(queued.RunID, folderID)
		if err := os.MkdirAll(filepath.Dir(staged), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.Rename(filepath.Join(f.dataRoot, root), staged); err != nil {
			t.Fatal(err)
		}
		return staged
	}

	// Giving a claimed folder back to its work brings it back from staging.
	f.exec("UPDATE work_folder_location SET state = 'pending_cleanup', cleanup_run_id = ? WHERE id = 497", queued.RunID)
	moveToStaging(497, "RJ00000097")
	if err := f.server.restoreMediaCleanupFolders(context.Background(), queued.RunID); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.dataRoot, "RJ00000097", "track.mp3")); err != nil {
		t.Fatalf("the returned folder is not back: %v", err)
	}

	// The next attempt deletes the folder an interrupted attempt moved.
	staged := moveToStaging(496, "RJ00000096")
	if err := f.server.runNextQueuedWorkflowJob(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{staged, filepath.Join(f.dataRoot, "RJ00000096"), filepath.Join(f.dataRoot, "RJ00000097")} {
		if _, err := os.Stat(path); !os.IsNotExist(err) {
			t.Fatalf("%s still exists: %v", path, err)
		}
	}
	var status string
	if err := f.db.QueryRow("SELECT status FROM workflow_run WHERE id = ?", queued.RunID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "succeeded" {
		t.Fatalf("run status = %q, want succeeded", status)
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
	if _, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: f.confirmed("rating=unrated")}); err != nil {
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
	result := f.list("rating=unrated")
	if len(result.Works) != 1 || result.Works[0].PrimaryCode != "RJ00000081" {
		t.Fatalf("Demo listing = %#v, want only the admitted work", result.Works)
	}
}

func TestLocalWorkCleanupLeavesAFolderAddedAfterConfirmation(t *testing.T) {
	f := newLocalWorkCleanupFixture(t)
	f.addLocalWork(491, "RJ00000091", 10)
	if _, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: f.confirmed("rating=unrated")}); err != nil {
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

	if _, err := f.server.enqueueLocalWorkCleanup(context.Background(), 1, localWorkCleanupRequest{Works: f.confirmed("rating=unrated")}); err != nil {
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
