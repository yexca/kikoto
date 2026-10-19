package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

const folderEditSecondTrack = "mp3/Track2.Second name.mp3"

// withSecondTrack puts a second audio file in the edited folder and returns
// the locations of both tracks by path below the folder.
func (fixture folderEditFixture) withSecondTrack(t *testing.T) map[string]int64 {
	t.Helper()
	if err := os.WriteFile(fixture.targetFile(folderEditSecondTrack), []byte("second synthetic audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	fixture.reindex(t)
	return fixture.locations(t)
}

func (fixture folderEditFixture) reindex(t *testing.T) {
	t.Helper()
	var fileSourceID int64
	if err := fixture.db.QueryRow("SELECT file_source_id FROM work_folder_location WHERE id = ?", fixture.folderID).Scan(&fileSourceID); err != nil {
		t.Fatal(err)
	}
	if err := fixture.server.indexLocalMediaForWork(context.Background(), fixture.workID, fileSourceID, fixture.root); err != nil {
		t.Fatal(err)
	}
}

// locations maps the edited folder's available files, by path below it, to
// their locations.
func (fixture folderEditFixture) locations(t *testing.T) map[string]int64 {
	t.Helper()
	rows, err := fixture.db.Query(`
		SELECT location.id, location.path FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
	`, fixture.workID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = rows.Close() }()
	found := map[string]int64{}
	for rows.Next() {
		var id int64
		var path string
		if err := rows.Scan(&id, &path); err != nil {
			t.Fatal(err)
		}
		found[filepath.ToSlash(path)[len(fixture.root)+1:]] = id
	}
	return found
}

func (fixture folderEditFixture) mediaItemOf(t *testing.T, locationID int64) int64 {
	t.Helper()
	var id int64
	if err := fixture.db.QueryRow("SELECT media_item_id FROM media_file_location WHERE id = ?", locationID).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

func (fixture folderEditFixture) run(t *testing.T, body map[string]any) {
	t.Helper()
	job := fixture.apply(t, body)
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err != nil {
		t.Fatal(err)
	}
	if status := fixture.runStatus(t, job.RunID); status != "succeeded" {
		t.Fatalf("run status = %q", status)
	}
	fixture.assertNoEditStaging(t)
}

func move(locationID int64, path string) map[string]any {
	return map[string]any{"locationId": locationID, "path": path}
}

func TestWorkFolderEditMovesFilesAndKeepsTheirMediaItems(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	movedItem := fixture.mediaItemOf(t, before[originalName])
	body := map[string]any{
		"moves":   []any{move(before[originalName], "Disc 1/Track1.Original name.mp3")},
		"folders": []string{"Bonus"},
	}
	plan := fixture.plan(t, body)
	if plan.Summary.Move != 1 || plan.Summary.Folders != 1 || len(plan.Moves) != 1 {
		t.Fatalf("plan summary = %+v, moves = %+v", plan.Summary, plan.Moves)
	}

	fixture.run(t, body)
	after := fixture.locations(t)
	moved, ok := after["Disc 1/Track1.Original name.mp3"]
	if !ok {
		t.Fatalf("the moved file is not indexed at its new path: %v", after)
	}
	if got := fixture.mediaItemOf(t, moved); got != movedItem {
		t.Fatalf("the moved file has media item %d, want %d", got, movedItem)
	}
	if content, err := os.ReadFile(fixture.targetFile("Disc 1/Track1.Original name.mp3")); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("moved file = %q, %v", content, err)
	}
	if info, err := os.Stat(fixture.targetFile("Bonus")); err != nil || !info.IsDir() {
		t.Fatalf("the new folder is missing: %v", err)
	}
	// The folder still holds the second track, so it stays.
	if _, err := os.Stat(fixture.targetFile("mp3")); err != nil {
		t.Fatalf("a folder that still holds a file was removed: %v", err)
	}

	fixture.run(t, map[string]any{"moves": []any{move(after[folderEditSecondTrack], "Disc 1/Track2.Second name.mp3")}})
	if _, err := os.Stat(fixture.targetFile("mp3")); !os.IsNotExist(err) {
		t.Fatalf("the folder the edit emptied is still there: %v", err)
	}
}

func TestWorkFolderEditLetsFilesTradePlaces(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	firstItem := fixture.mediaItemOf(t, before[originalName])
	secondItem := fixture.mediaItemOf(t, before[folderEditSecondTrack])

	fixture.run(t, map[string]any{"moves": []any{
		move(before[originalName], folderEditSecondTrack),
		move(before[folderEditSecondTrack], originalName),
	}})
	if content, err := os.ReadFile(fixture.targetFile(folderEditSecondTrack)); err != nil || string(content) != "synthetic audio" {
		t.Fatalf("%s = %q, %v", folderEditSecondTrack, content, err)
	}
	after := fixture.locations(t)
	if got := fixture.mediaItemOf(t, after[folderEditSecondTrack]); got != firstItem {
		t.Fatalf("the first track's item did not follow it: %d, want %d", got, firstItem)
	}
	if got := fixture.mediaItemOf(t, after[originalName]); got != secondItem {
		t.Fatalf("the second track's item did not follow it: %d, want %d", got, secondItem)
	}
}

func TestWorkFolderEditRejectsLayoutsThatCollide(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	before := fixture.withSecondTrack(t)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	for name, body := range map[string]map[string]any{
		"onto a staying file":   {"moves": []any{move(before[originalName], folderEditSecondTrack)}},
		"into the lyrics":       {"moves": []any{move(before[originalName], "lyrics_kikoto/jpn/a.mp3")}},
		"folder at a file path": {"folders": []string{folderEditSecondTrack}},
		"below a file":          {"moves": []any{move(before[originalName], folderEditSecondTrack+"/a.mp3")}},
		"moved and removed": {
			"moves":             []any{move(before[originalName], "Disc 1/a.mp3")},
			"removeLocationIds": []int64{before[originalName]},
		},
	} {
		response := fixture.request(t, fixture.server.planWorkFolderEdit, body)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("%s: plan status = %d, body = %s", name, response.Code, response.Body.String())
		}
	}
}

func TestWorkFolderEditPlacesAnAddedFileAtItsTargetPath(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{folderEditVTTPath: lyricsFetchVTT})
	addition := localAddition(siblingFolderID, folderEditVTTPath)
	addition["targetPath"] = "Extras/notes.vtt"
	body := map[string]any{"additions": []any{addition}}
	plan := fixture.plan(t, body)
	if len(plan.Items) != 1 || plan.Items[0].TargetPath != fixture.root+"/Extras/notes.vtt" {
		t.Fatalf("plan items = %+v", plan.Items)
	}
	fixture.run(t, body)
	if content, err := os.ReadFile(fixture.targetFile("Extras/notes.vtt")); err != nil || string(content) != lyricsFetchVTT {
		t.Fatalf("placed file = %q, %v", content, err)
	}
}

func (fixture folderEditFixture) mergeCheck(t *testing.T, body map[string]any) workFolderEditMergeCheck {
	t.Helper()
	response := fixture.request(t, fixture.server.checkWorkFolderEditMerge, body)
	if response.Code != http.StatusOK {
		t.Fatalf("merge check status = %d, body = %s", response.Code, response.Body.String())
	}
	var check workFolderEditMergeCheck
	if err := json.Unmarshal(response.Body.Bytes(), &check); err != nil {
		t.Fatal(err)
	}
	return check
}

func TestWorkFolderEditMergeReportsLostFilesAndDeletesTheFolder(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{
		"only-here.txt":  "a note no other folder holds",
		"Same/copy.mp3":  "synthetic audio",
		"selected.txt":   "copied into the edited folder",
		"Empty/.keep.md": "",
	})
	body := map[string]any{
		"additions":      []any{localAddition(siblingFolderID, "selected.txt")},
		"mergeFolderIds": []int64{siblingFolderID},
	}
	plan := fixture.plan(t, body)
	if plan.Summary.Merge != 1 || plan.Summary.MergeFiles != 4 || len(plan.Merges) != 1 || plan.Merges[0].Files != nil {
		t.Fatalf("plan summary = %+v, merges = %+v", plan.Summary, plan.Merges)
	}

	check := fixture.mergeCheck(t, body)
	lost := map[string]bool{}
	for _, file := range check.Lost {
		lost[file.Path] = true
	}
	// The copy of the edited folder's audio and the copied file are kept;
	// the note and the empty file have no copy there.
	if !check.Complete || len(check.Lost) != 2 || !lost["RJ00000002/only-here.txt"] || !lost["RJ00000002/Empty/.keep.md"] {
		t.Fatalf("merge check = %+v", check)
	}

	fixture.run(t, body)
	if _, err := os.Stat(filepath.Join(fixture.dataRoot, "RJ00000002")); !os.IsNotExist(err) {
		t.Fatalf("the merged folder is still there: %v", err)
	}
	if content, err := os.ReadFile(fixture.targetFile("selected.txt")); err != nil || string(content) != "copied into the edited folder" {
		t.Fatalf("copied file = %q, %v", content, err)
	}
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM work_folder_location WHERE id = ?", siblingFolderID).Scan(&state); err != nil || state != "ignored" {
		t.Fatalf("merged folder state = %q, %v", state, err)
	}
	var available int
	if err := fixture.db.QueryRow(`
		SELECT COUNT(*) FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = 902 AND location.availability = 'available'
	`).Scan(&available); err != nil || available != 0 {
		t.Fatalf("the merged edition still has %d available files, %v", available, err)
	}
}

func TestWorkFolderEditMergeKeepsAFolderThatChangedAfterReview(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	siblingFolderID := fixture.addSiblingFolder(t, map[string]string{"reviewed.txt": "reviewed"})
	job := fixture.apply(t, map[string]any{"mergeFolderIds": []int64{siblingFolderID}})
	added := filepath.Join(fixture.dataRoot, "RJ00000002", "added later.txt")
	if err := os.WriteFile(added, []byte("not in the review"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.db.Exec("UPDATE workflow_job SET max_retries = 0 WHERE id = ?", job.ID); err != nil {
		t.Fatal(err)
	}
	job.MaxRetries = 0
	if err := fixture.server.executeWorkFolderEditJob(context.Background(), job); err == nil {
		t.Fatal("the merge deleted a folder that changed after it was reviewed")
	}
	for _, name := range []string{"reviewed.txt", "added later.txt"} {
		if _, err := os.Stat(filepath.Join(fixture.dataRoot, "RJ00000002", name)); err != nil {
			t.Fatalf("%s was deleted: %v", name, err)
		}
	}
	var state string
	if err := fixture.db.QueryRow("SELECT state FROM work_folder_location WHERE id = ?", siblingFolderID).Scan(&state); err != nil || state != "active" {
		t.Fatalf("merged folder state = %q, %v", state, err)
	}
}

func TestWorkFolderEditRefusesToMergeTheEditedFolder(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	response := fixture.request(t, fixture.server.planWorkFolderEdit, map[string]any{"mergeFolderIds": []int64{fixture.folderID}})
	if response.Code != http.StatusBadRequest {
		t.Fatalf("plan status = %d, body = %s", response.Code, response.Body.String())
	}
}

func TestWorkFolderEditMovedFileKeepsItsItemWhenItsOtherCopyIsMergedAway(t *testing.T) {
	fixture := newFolderEditFixture(t, serveFolderEditMedia)
	originalName := filepath.ToSlash(fixture.originalPath)[len(fixture.root)+1:]
	copyPath := filepath.Join(fixture.dataRoot, "RJ00000001 copy", filepath.FromSlash(originalName))
	if err := os.MkdirAll(filepath.Dir(copyPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(copyPath, []byte("synthetic audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	executeLocalScanForTest(t, fixture.server)
	if err := fixture.server.indexAdditionalLocalFolders(context.Background(), fixture.workID, true); err != nil {
		t.Fatal(err)
	}
	var copyFolderID int64
	if err := fixture.db.QueryRow("SELECT id FROM work_folder_location WHERE work_id = ? AND id <> ?", fixture.workID, fixture.folderID).Scan(&copyFolderID); err != nil {
		t.Fatal(err)
	}
	item := fixture.mediaItemOf(t, fixture.originalLocationID)
	var shared int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE media_item_id = ? AND availability = 'available'", item).Scan(&shared); err != nil || shared != 2 {
		t.Fatalf("the copy does not share the item: %d, %v", shared, err)
	}

	fixture.run(t, map[string]any{
		"moves":          []any{move(fixture.originalLocationID, "Disc 1/Track1.Original name.mp3")},
		"mergeFolderIds": []int64{copyFolderID},
	})
	moved, ok := fixture.locations(t)["Disc 1/Track1.Original name.mp3"]
	if !ok {
		t.Fatal("the moved file is not indexed at its new path")
	}
	if got := fixture.mediaItemOf(t, moved); got != item {
		t.Fatalf("the moved file has media item %d, want %d", got, item)
	}
}
