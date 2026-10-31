package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func newPoolFolderEditFixture(t *testing.T, handler http.HandlerFunc) folderEditFixture {
	t.Helper()
	return folderEditFixtureFor(t, newPoolLyricsFetchFixture(t, handler, lyricsFetchVTTURL))
}

// assertStagingStayedOnPool checks that the fixture's edits staged on the
// edited folder's pool, never at the data root or on another pool, where
// publishing would cross filesystems.
func (fixture lyricsFetchFixture) assertStagingStayedOnPool(t *testing.T) {
	t.Helper()
	for _, elsewhere := range []string{"", fixture.siblingPool} {
		if _, err := os.Lstat(filepath.Join(fixture.dataRoot, elsewhere, ".kikoto-staging")); !os.IsNotExist(err) {
			t.Fatalf("staging was created outside pool %s, at %q: %v", fixture.pool, elsewhere, err)
		}
	}
	if info, err := os.Stat(filepath.Join(fixture.dataRoot, fixture.pool, ".kikoto-staging")); err != nil || !info.IsDir() {
		t.Fatalf("nothing was staged on pool %s: %v", fixture.pool, err)
	}
}

// takePoolOffline removes a pool's marker, which is how an unmounted pool or
// the wrong disk at its mount point looks to Kikoto.
func (fixture lyricsFetchFixture) takePoolOffline(t *testing.T, pool string) {
	t.Helper()
	if err := os.Remove(filepath.Join(fixture.dataRoot, pool, storagepool.MarkerName)); err != nil {
		t.Fatal(err)
	}
}

func assertAPIErrorCode(t *testing.T, name string, response *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("%s: status = %d, body = %s", name, response.Code, response.Body.String())
	}
	var body struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || body.Code != code {
		t.Fatalf("%s: error code = %q, %v, body = %s", name, body.Code, err, response.Body.String())
	}
}

func TestWorkFolderEditInPoolModeWorksAcrossPools(t *testing.T) {
	fixture := newPoolFolderEditFixture(t, serveFolderEditMedia)
	if !strings.HasPrefix(fixture.root, fixture.pool+"/") {
		t.Fatalf("edited folder %q is not on pool %s", fixture.root, fixture.pool)
	}
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{
		folderEditVTTPath: lyricsFetchVTT,
		"only-here.txt":   "a note no other folder holds",
	})
	before := fixture.withSecondTrack(t)
	body := map[string]any{
		"additions": []any{
			localAddition(siblingFolderID, folderEditVTTPath),
			remoteAddition("RJ00000002", folderEditAudioPath),
		},
		"removeLocationIds": []int64{fixture.originalLocationID},
		"moves":             []any{move(before[folderEditSecondTrack], "Disc 1/Track2.Second name.mp3")},
		"folders":           []string{"Bonus"},
		"mergeFolderIds":    []int64{siblingFolderID},
	}

	plan := fixture.plan(t, body)
	if plan.TransactionPool != fixture.pool {
		t.Fatalf("transaction pool = %q, want the edited folder's pool %s", plan.TransactionPool, fixture.pool)
	}
	if plan.Summary.Add != 2 || plan.Summary.Copy != 1 || plan.Summary.Download != 1 || plan.Summary.Remove != 1 ||
		plan.Summary.Move != 1 || plan.Summary.Folders != 1 || plan.Summary.Merge != 1 || plan.Summary.Conflict != 0 {
		t.Fatalf("plan summary = %+v", plan.Summary)
	}
	check := fixture.mergeCheck(t, body)
	if !check.Complete || len(check.Lost) != 1 || check.Lost[0].Path != fixture.siblingPool+"/RJ00000002/only-here.txt" {
		t.Fatalf("merge check = %+v", check)
	}

	fixture.run(t, body)
	for name, want := range map[string]string{
		folderEditVTTPath:               lyricsFetchVTT,
		folderEditAudioPath:             folderEditRemoteAudio,
		"Disc 1/Track2.Second name.mp3": "second synthetic audio",
	} {
		if content, err := os.ReadFile(fixture.targetFile(name)); err != nil || string(content) != want {
			t.Fatalf("%s = %q, %v", name, content, err)
		}
	}
	if info, err := os.Stat(fixture.targetFile("Bonus")); err != nil || !info.IsDir() {
		t.Fatalf("the new folder is missing: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.originalPath))); !os.IsNotExist(err) {
		t.Fatalf("the removed file is still there: %v", err)
	}
	after := fixture.locations(t)
	for _, name := range []string{folderEditVTTPath, folderEditAudioPath, "Disc 1/Track2.Second name.mp3"} {
		if _, ok := after[name]; !ok {
			t.Fatalf("%s is not indexed in the edited folder: %v", name, after)
		}
	}
	// The merged folder on the other pool is gone; that pool stays online.
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002")); !os.IsNotExist(err) {
		t.Fatalf("the merged folder is still there: %v", err)
	}
	if online, reason := storagepool.Check(fixture.dataRoot, lyricsFetchTestPools[1], lyricsFetchTestPools[1].ID); !online {
		t.Fatalf("the merge took the sibling's pool offline: %s", reason)
	}
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM work_folder_location WHERE id = ?", siblingFolderID).Scan(&state); err != nil || state != "ignored" {
		t.Fatalf("merged folder state = %q, %v", state, err)
	}
	fixture.assertStagingStayedOnPool(t)
}

func TestWorkFolderEditInPoolModeRefusesAnOfflinePool(t *testing.T) {
	fixture := newPoolFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{folderEditVTTPath: lyricsFetchVTT})
	body := map[string]any{
		"additions":         []any{localAddition(siblingFolderID, folderEditVTTPath)},
		"removeLocationIds": []int64{fixture.originalLocationID},
	}
	// The edit is queued while the pool is online and runs after it went away.
	job := fixture.apply(t, body)
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	fixture.takePoolOffline(t, fixture.pool)

	for name, handler := range map[string]http.HandlerFunc{"plan": fixture.server.planWorkFolderEdit, "apply": fixture.server.applyWorkFolderEdit} {
		response := fixture.request(t, handler, body)
		assertAPIErrorCode(t, name, response, http.StatusConflict, "storage_pool_offline")
		if strings.Contains(response.Body.String(), fixture.dataRoot) {
			t.Fatalf("%s: the response reveals a local path: %s", name, response.Body.String())
		}
	}
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the edit ran on an offline pool")
	}
	if status := fixture.runStatus(t, job.RunID); status != "failed" {
		t.Fatalf("run status = %q", status)
	}
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.originalPath))); err != nil {
		t.Fatalf("an edit of an offline pool removed a file: %v", err)
	}
	if _, err := os.Stat(fixture.targetFile(folderEditVTTPath)); !os.IsNotExist(err) {
		t.Fatalf("an edit of an offline pool wrote into the folder: %v", err)
	}
	var availability string
	if err := fixture.db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", fixture.originalLocationID).Scan(&availability); err != nil || availability != "available" {
		t.Fatalf("location availability = %q, %v", availability, err)
	}
	for _, root := range []string{"", fixture.pool} {
		if entries, _ := os.ReadDir(filepath.Join(fixture.dataRoot, root, ".kikoto-staging")); len(entries) > 0 {
			t.Fatalf("an edit of an offline pool staged %q", entries[0].Name())
		}
	}
}

func TestWorkFolderEditInPoolModeKeepsAFolderOnAnOfflinePool(t *testing.T) {
	fixture := newPoolFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"kept.txt": "a file of the other pool"})
	body := map[string]any{"mergeFolderIds": []int64{siblingFolderID}}
	job := fixture.apply(t, body)
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	fixture.takePoolOffline(t, fixture.siblingPool)

	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the edit merged away a folder of an offline pool")
	}
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002", "kept.txt")); err != nil {
		t.Fatalf("a file of an offline pool was deleted: %v", err)
	}
	assertAPIErrorCode(t, "plan", fixture.request(t, fixture.server.planWorkFolderEdit, body), http.StatusConflict, "storage_pool_offline")
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM work_folder_location WHERE id = ?", siblingFolderID).Scan(&state); err != nil || state != "active" {
		t.Fatalf("folder on the offline pool state = %q, %v", state, err)
	}
}

func TestLyricsEditInPoolModeStagesOnTheFolderPool(t *testing.T) {
	fixture := newPoolLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	translated := filepath.Join(fixture.dataRoot, fixture.siblingPool, "RJ00000002", "lyrics_kikoto", "zh-hans")
	if err := os.MkdirAll(translated, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(translated, "Track1.vtt"), []byte(lyricsFetchVTT+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	executeLocalScanForTest(t, fixture.server)
	var sourceFolderID int64
	if err := fixture.db.QueryRow("SELECT id FROM work_folder_location WHERE work_id = 902").Scan(&sourceFolderID); err != nil {
		t.Fatal(err)
	}
	edit := map[string]any{
		"additions": []any{
			lyricsEditRemoteAddition("zh-cn"),
			map[string]any{"kind": "local", "folderId": sourceFolderID, "path": "lyrics_kikoto/zh-hans/Track1.vtt", "language": "zh-cn"},
		},
		"assignments": []map[string]any{{"audioMediaItemId": fixture.audioID, "itemKey": lyricsEditRemoteKey}},
	}

	result := fixture.decode(t, fixture.edit(t, edit))
	if result.SaveRoot != fixture.root || result.Downloaded != 1 || result.Copied != 1 || result.Assigned != 1 {
		t.Fatalf("result = %+v", result)
	}
	if content := fixture.content("lyrics_kikoto/zh-hans/" + lyricsEditRemotePath); content != lyricsFetchVTT {
		t.Fatalf("downloaded lyrics = %q", content)
	}
	if content := fixture.content("lyrics_kikoto/zh-hans/Track1.vtt"); content != lyricsFetchVTT+"\n" {
		t.Fatalf("copied lyrics = %q", content)
	}
	want := "zh-cn=remote_fetch:" + fixture.root + "/lyrics_kikoto/zh-hans/" + lyricsEditRemotePath
	if assigned := fixture.assignedLanguages(t); len(assigned) != 1 || assigned[0] != want {
		t.Fatalf("assignments = %v, want [%s]", assigned, want)
	}
	if _, err := os.Stat(filepath.Join(translated, "Track1.vtt")); err != nil {
		t.Fatalf("the source folder on the other pool lost its lyrics: %v", err)
	}
	fixture.assertNoStagingLeft(t)
	fixture.assertStagingStayedOnPool(t)

	fixture.takePoolOffline(t, fixture.pool)
	removal, _ := fixture.location(t, "lyrics_kikoto/zh-hans/Track1.vtt")
	offline := map[string]any{"removeLocationIds": []int64{removal}}
	assertAPIErrorCode(t, "plan", fixture.request(t, "/plan", fixture.server.planWorkLyricsEdit, offline), http.StatusConflict, "storage_pool_offline")
	assertAPIErrorCode(t, "apply", fixture.edit(t, offline), http.StatusConflict, "storage_pool_offline")
	if fixture.content("lyrics_kikoto/zh-hans/Track1.vtt") == "" {
		t.Fatal("a lyrics edit of an offline pool removed a file")
	}
}

func TestTrackLyricsPublishInPoolModeStagesOnTheFolderPool(t *testing.T) {
	fixture := newPoolLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	ctx := context.Background()
	audioPath := fixture.root + "/mp3/Track1.Original name.mp3"

	lyricsPath, _, err := fixture.server.publishTrackLyrics(ctx, 0, fixture.workID, fixture.audioID, fixture.folderID, "zh-cn", audioPath, ".vtt", lyricsFetchVTT, "transcription")
	if err != nil {
		t.Fatal(err)
	}
	if want := fixture.root + "/lyrics_kikoto/zh-hans/mp3/Track1.Original name.vtt"; lyricsPath != want {
		t.Fatalf("lyrics path = %q, want %q", lyricsPath, want)
	}
	if content := fixture.content("lyrics_kikoto/zh-hans/mp3/Track1.Original name.vtt"); content != lyricsFetchVTT {
		t.Fatalf("published lyrics = %q", content)
	}
	if assigned := fixture.assignedLanguages(t); len(assigned) != 1 || assigned[0] != "zh-cn=transcription:"+lyricsPath {
		t.Fatalf("assignments = %v", assigned)
	}
	fixture.assertNoStagingLeft(t)
	fixture.assertStagingStayedOnPool(t)

	fixture.takePoolOffline(t, fixture.pool)
	_, _, err = fixture.server.publishTrackLyrics(ctx, 0, fixture.workID, fixture.audioID, fixture.folderID, "ja", audioPath, ".vtt", lyricsFetchVTT, "transcription")
	var destination libraryStorageError
	if !errors.As(err, &destination) || destination.Code != "storage_pool_offline" {
		t.Fatalf("publishing to an offline pool = %v, want storage_pool_offline", err)
	}
	if folders := fixture.lyricsFolders(t); len(folders) != 1 {
		t.Fatalf("publishing to an offline pool created lyrics folders: %v", folders)
	}
}

func TestTrackLyricsPublishRemovesUncommittedPublication(t *testing.T) {
	fixture := newPoolLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	ctx := context.Background()
	audioPath := fixture.root + "/mp3/Track1.Original name.mp3"

	_, _, err := fixture.server.publishTrackLyricsWith(ctx, 0, fixture.workID, fixture.audioID, fixture.folderID, "zh-cn", audioPath, ".vtt", lyricsFetchVTT, "transcription",
		func(*sql.Tx, string, int64) error { return errors.New("synthetic transaction failure") })
	if err == nil {
		t.Fatal("publication unexpectedly succeeded")
	}
	destination := filepath.Join(fixture.dataRoot, filepath.FromSlash(fixture.root), "lyrics_kikoto", "zh-hans", "mp3", "Track1.Original name.vtt")
	if _, err := os.Stat(destination); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uncommitted lyrics file = %v, want it removed", err)
	}
	var indexed int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path = ?", fixture.root+"/lyrics_kikoto/zh-hans/mp3/Track1.Original name.vtt").Scan(&indexed); err != nil {
		t.Fatal(err)
	}
	if indexed != 0 {
		t.Fatalf("uncommitted lyrics locations = %d, want 0", indexed)
	}
}

func TestWorkFolderEditDoesNotIndexAFolderWhosePoolWentOffline(t *testing.T) {
	fixture := newPoolFolderEditFixture(t, serveFolderEditMedia)
	var fileSourceID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE id = ?", fixture.folderID).Scan(&fileSourceID); err != nil {
		t.Fatal(err)
	}
	execution := &workFolderEditExecution{server: fixture.server, payload: workFolderEditJobPayload{
		WorkID: fixture.workID, FileSourceID: fileSourceID, TargetRoot: fixture.root,
	}}
	// The pool is unmounted while the edit runs: its mount point is empty.
	poolRoot := filepath.Join(fixture.dataRoot, fixture.pool)
	if err := os.Rename(poolRoot, poolRoot+" unmounted"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(poolRoot, 0o755); err != nil {
		t.Fatal(err)
	}

	var destination libraryStorageError
	if err := execution.index(context.Background()); !errors.As(err, &destination) || destination.Code != "storage_pool_offline" {
		t.Fatalf("indexing on an offline pool = %v, want storage_pool_offline", err)
	}
	var availability string
	if err := fixture.db.QueryRow("SELECT availability FROM media_file_location WHERE id = ?", fixture.originalLocationID).Scan(&availability); err != nil || availability != "available" {
		t.Fatalf("file on the offline pool = %q, %v; want it kept available", availability, err)
	}
}

func TestWorkFolderEditRefusesALinkedStagingFolder(t *testing.T) {
	fixture := newPoolFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{folderEditVTTPath: lyricsFetchVTT})
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(fixture.dataRoot, fixture.pool, ".kikoto-staging")); err != nil {
		t.Skipf("symlink is not available on this system: %v", err)
	}
	job := fixture.apply(t, map[string]any{"additions": []any{localAddition(siblingFolderID, folderEditVTTPath)}})
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the edit staged its files through a linked staging folder")
	}
	if entries, err := os.ReadDir(outside); err != nil || len(entries) != 0 {
		t.Fatalf("the edit wrote outside the pool: %v, %v", entries, err)
	}
}
