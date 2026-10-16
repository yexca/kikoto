package httpapi

import (
	"context"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

func TestLyricsEditDownloadsIntoTheLanguageFolderAndAssigns(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	assignment := []map[string]any{{"audioMediaItemId": fixture.audioID, "itemKey": lyricsEditRemoteKey}}

	result := fixture.decode(t, fixture.edit(t, map[string]any{
		"additions": []any{lyricsEditRemoteAddition("zh-cn")}, "assignments": assignment,
	}))
	// The folder is named after the language and carries no work code, so a
	// scan cannot take it for another work.
	if folders := fixture.lyricsFolders(t); len(folders) != 1 || folders[0] != "zh-hans" {
		t.Fatalf("lyrics folders = %v", folders)
	}
	// Kikoto marks the lyrics folder it creates, and the marker is not a file
	// of the work.
	if !lyricsRootOwned(fixture.absolute("")) {
		t.Fatal("the lyrics folder Kikoto created is not marked as its own")
	}
	var markers int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE path LIKE ?", "%"+localfs.LyricsRootMarkerName).Scan(&markers); err != nil || markers != 0 {
		t.Fatalf("the marker was indexed: %d, %v", markers, err)
	}
	if result.SaveRoot != fixture.root || result.Downloaded != 1 || result.Skipped != 0 || result.Assigned != 1 {
		t.Fatalf("result = %+v", result)
	}
	if content := fixture.content("lyrics_kikoto/zh-hans/" + lyricsEditRemotePath); content != lyricsFetchVTT {
		t.Fatalf("published lyrics = %q", content)
	}
	if fixture.requests.Load() != 1 {
		t.Fatalf("upstream requests = %d, want only the selected lyrics file", fixture.requests.Load())
	}
	want := "zh-cn=remote_fetch:" + fixture.root + "/lyrics_kikoto/zh-hans/" + lyricsEditRemotePath
	if assigned := fixture.assignedLanguages(t); len(assigned) != 1 || assigned[0] != want {
		t.Fatalf("assignments = %v, want [%s]", assigned, want)
	}
	var sibling int
	if err := fixture.db.QueryRow("SELECT COUNT(*) FROM media_item WHERE work_id = 902").Scan(&sibling); err != nil || sibling != 0 {
		t.Fatalf("sibling edition gained media items: %d, %v", sibling, err)
	}

	// The same file declared in another language is kept apart.
	fixture.decode(t, fixture.edit(t, map[string]any{
		"additions": []any{lyricsEditRemoteAddition("")}, "assignments": assignment,
	}))
	if folders := fixture.lyricsFolders(t); len(folders) != 2 || folders[0] != "fallback" {
		t.Fatalf("lyrics folders = %v", folders)
	}
	if assigned := fixture.assignedLanguages(t); len(assigned) != 2 || !strings.HasPrefix(assigned[0], "=remote_fetch:") {
		t.Fatalf("assignments = %v", assigned)
	}
	for name, addition := range map[string]map[string]any{
		"unsupported language": lyricsEditRemoteAddition("tlh"),
		"undeclared language":  {"kind": "remote", "sourceId": 7, "remoteCode": "RJ00000002", "path": lyricsEditRemotePath},
	} {
		if response := fixture.edit(t, map[string]any{"additions": []any{addition}}); response.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", name, response.Code)
		}
	}
	fixture.assertNoStagingLeft(t)
}

func TestLyricsEditResolvesAConflictWithoutDeletingFirst(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	const sidecar = "mp3/Track1.Original name.mp3.vtt"
	const managed = "lyrics_kikoto/ja/" + sidecar
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT, managed: "edited by the user"})
	body := func(decision map[string]any) map[string]any {
		edit := map[string]any{"additions": []any{lyricsEditFolderAddition(sidecar, "ja-jp")}, "folderMode": "move"}
		if decision != nil {
			decision["itemKey"] = "folder:" + sidecar
			edit["decisions"] = []any{decision}
		}
		return edit
	}

	plan := fixture.plan(t, body(nil))
	if plan.Summary.Conflict != 1 || len(plan.Items) != 1 || !plan.Items[0].TargetConflict || plan.Items[0].TargetPath != fixture.root+"/"+managed {
		t.Fatalf("plan = %+v", plan)
	}
	response := fixture.edit(t, body(nil))
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), `"code":"lyrics_edit_conflict"`) {
		t.Fatalf("unresolved conflict = %d %s", response.Code, response.Body.String())
	}
	if fixture.content(managed) != "edited by the user" || fixture.content(sidecar) != lyricsFetchVTT {
		t.Fatal("an unresolved conflict changed the folder")
	}

	// Keeping both gives the incoming file a free name next to the existing one.
	if plan := fixture.plan(t, body(map[string]any{"resolution": "keep_both"})); plan.Summary.Move != 1 || plan.Items[0].TargetPath == fixture.root+"/"+managed {
		t.Fatalf("keep-both plan = %+v", plan.Items)
	}
	for name, target := range map[string]string{
		"outside the folder":    "../outside.vtt",
		"not a lyrics file":     "lyrics_kikoto/ja/renamed.mp3",
		"an absolute path":      "/renamed.vtt",
		"an empty renamed path": " ",
	} {
		if response := fixture.edit(t, body(map[string]any{"resolution": "rename", "targetPath": target})); response.Code != http.StatusBadRequest {
			t.Fatalf("rename %s: status = %d, want 400", name, response.Code)
		}
	}
	// A rename stays in the lyrics folder of the declared language.
	renamed := fixture.plan(t, body(map[string]any{"resolution": "rename", "targetPath": "lyrics_kikoto/en/renamed.vtt"}))
	if renamed.Items[0].TargetPath != fixture.root+"/lyrics_kikoto/ja/renamed.vtt" || renamed.Summary.Move != 1 {
		t.Fatalf("renamed plan = %+v", renamed.Items)
	}

	result := fixture.decode(t, fixture.edit(t, body(map[string]any{"resolution": "replace"})))
	if result.Moved != 1 || fixture.content(managed) != lyricsFetchVTT || fixture.content(sidecar) != "" {
		t.Fatalf("replace result = %+v, managed = %q", result, fixture.content(managed))
	}
	fixture.assertNoStagingLeft(t)
}

func TestLyricsEditMovesFolderFilesAndTheirAssignmentsFollow(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	const sidecar = "mp3/Track1.Original name.mp3.vtt"
	const other = "subtitles/Track1.vtt"
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT, other: "WEBVTT\n\nother\n"})
	_, sidecarItem := fixture.location(t, sidecar)
	// A manager had assigned the sidecar for every language and as Japanese
	// before declaring it.
	for _, language := range []string{"", "ja-jp"} {
		if _, err := fixture.db.Exec(
			"INSERT INTO media_lyrics_assignment (audio_media_item_id, language, lyrics_media_item_id) VALUES (?, ?, ?)",
			fixture.audioID, language, sidecarItem,
		); err != nil {
			t.Fatal(err)
		}
	}

	result := fixture.decode(t, fixture.edit(t, map[string]any{"additions": []any{
		lyricsEditFolderAddition(sidecar, "zh-cn"), lyricsEditFolderAddition(other, "zh-cn"),
	}, "folderMode": "move"}))
	if result.Moved != 2 || fixture.content("lyrics_kikoto/zh-hans/"+sidecar) != lyricsFetchVTT || fixture.content(sidecar) != "" {
		t.Fatalf("result = %+v", result)
	}
	if _, err := os.Stat(fixture.absolute("subtitles")); !os.IsNotExist(err) {
		t.Fatalf("the emptied folder was left behind: %v", err)
	}
	// The assignments follow the file and take its declared language once.
	want := "zh-cn=manual:" + fixture.root + "/lyrics_kikoto/zh-hans/" + sidecar
	if assigned := fixture.assignedLanguages(t); len(assigned) != 1 || assigned[0] != want {
		t.Fatalf("assignments = %v, want [%s]", assigned, want)
	}

	// Declaring a managed file again moves it to the other language's folder.
	fixture.decode(t, fixture.edit(t, map[string]any{"additions": []any{
		lyricsEditFolderAddition("lyrics_kikoto/zh-hans/"+sidecar, "en-us"),
	}}))
	want = "en-us=manual:" + fixture.root + "/lyrics_kikoto/en/" + sidecar
	if assigned := fixture.assignedLanguages(t); len(assigned) != 1 || assigned[0] != want {
		t.Fatalf("assignments after redeclaring = %v, want [%s]", assigned, want)
	}
	// A file that is already where its language puts it is left alone.
	inPlace := map[string]any{"additions": []any{lyricsEditFolderAddition("lyrics_kikoto/en/"+sidecar, "en-us")}}
	if plan := fixture.plan(t, inPlace); plan.Summary.Skip != 1 || plan.Summary.Add != 0 {
		t.Fatalf("in-place plan = %+v", plan.Summary)
	}
	if response := fixture.edit(t, inPlace); response.Code != http.StatusBadRequest {
		t.Fatalf("an edit that changes nothing = %d, want 400", response.Code)
	}
	fixture.assertNoStagingLeft(t)
}

// The work's own lyrics stay where they are unless the edit, or the
// administrator's default, chooses to move them. Managed lyrics that change
// language always move.
func TestLyricsEditCopiesFolderFilesUnlessMoveIsChosen(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	const sidecar = "mp3/Track1.Original name.mp3.vtt"
	const other = "subtitles/Track1.vtt"
	fixture.write(t, map[string]string{sidecar: lyricsFetchVTT, other: "WEBVTT\n\nother\n"})
	_, sidecarItem := fixture.location(t, sidecar)
	if _, err := fixture.db.Exec(
		"INSERT INTO media_lyrics_assignment (audio_media_item_id, language, lyrics_media_item_id) VALUES (?, '', ?)",
		fixture.audioID, sidecarItem,
	); err != nil {
		t.Fatal(err)
	}

	copyEdit := map[string]any{"additions": []any{lyricsEditFolderAddition(sidecar, "zh-cn")}}
	if plan := fixture.plan(t, copyEdit); plan.FolderMode != "copy" || plan.Summary.Copy != 1 || plan.Summary.Move != 0 {
		t.Fatalf("default plan = %s %+v", plan.FolderMode, plan.Summary)
	}
	result := fixture.decode(t, fixture.edit(t, copyEdit))
	if result.Copied != 1 || result.Moved != 0 || fixture.content(sidecar) != lyricsFetchVTT ||
		fixture.content("lyrics_kikoto/zh-hans/"+sidecar) != lyricsFetchVTT {
		t.Fatalf("copy result = %+v", result)
	}
	// The work's file keeps its assignment; the copy is a file of its own.
	if assigned := fixture.assignedLanguages(t); len(assigned) != 1 || assigned[0] != "=manual:"+fixture.root+"/"+sidecar {
		t.Fatalf("assignments after copying = %v", assigned)
	}

	// Changing the language of the managed copy moves it even while copying.
	redeclare := map[string]any{"additions": []any{lyricsEditFolderAddition("lyrics_kikoto/zh-hans/"+sidecar, "en-us")}}
	if result := fixture.decode(t, fixture.edit(t, redeclare)); result.Moved != 1 || result.Copied != 0 ||
		fixture.content("lyrics_kikoto/zh-hans/"+sidecar) != "" || fixture.content("lyrics_kikoto/en/"+sidecar) != lyricsFetchVTT {
		t.Fatalf("redeclare result = %+v", result)
	}

	// The administrator's default applies when the edit does not choose.
	if response := patchSettingsAsSourceWriter(t, fixture.server, `{"folderLyricsMode":"link"}`); response.Code != http.StatusBadRequest {
		t.Fatalf("an unknown mode saved: %d %s", response.Code, response.Body.String())
	}
	if response := patchSettingsAsSourceWriter(t, fixture.server, `{"folderLyricsMode":"move"}`); response.Code != http.StatusOK {
		t.Fatalf("saving the move default = %d %s", response.Code, response.Body.String())
	}
	moveEdit := map[string]any{"additions": []any{lyricsEditFolderAddition(other, "zh-cn")}}
	if result := fixture.decode(t, fixture.edit(t, moveEdit)); result.Moved != 1 || fixture.content(other) != "" {
		t.Fatalf("default move result = %+v", result)
	}
	if response := fixture.edit(t, map[string]any{
		"additions": []any{lyricsEditFolderAddition(sidecar, "ja-jp")}, "folderMode": "link",
	}); response.Code != http.StatusBadRequest || fixture.content(sidecar) != lyricsFetchVTT {
		t.Fatalf("an unknown edit mode = %d %s", response.Code, response.Body.String())
	}
	fixture.assertNoStagingLeft(t)
}

func TestLyricsEditCopiesFromAnotherLocalFolderOfTheFamily(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	translated := filepath.Join(fixture.dataRoot, "RJ00000002", "lyrics_kikoto", "zh-hans")
	if err := os.MkdirAll(translated, 0o755); err != nil {
		t.Fatal(err)
	}
	for name, content := range map[string]string{"Track1.vtt": lyricsFetchVTT, "Track1.mp3": "synthetic audio"} {
		if err := os.WriteFile(filepath.Join(translated, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	executeLocalScanForTest(t, fixture.server)
	var sourceFolderID int64
	if err := fixture.db.QueryRow("SELECT id FROM work_folder_location WHERE work_id = 902").Scan(&sourceFolderID); err != nil {
		t.Fatal(err)
	}
	local := func(folderID int64, file string) map[string]any {
		return map[string]any{"kind": "local", "folderId": folderID, "path": file, "language": "zh-cn"}
	}
	edit := map[string]any{
		"additions":   []any{local(sourceFolderID, "lyrics_kikoto/zh-hans/Track1.vtt")},
		"assignments": []map[string]any{{"audioMediaItemId": fixture.audioID, "itemKey": "local:" + jsonNumber(sourceFolderID) + ":lyrics_kikoto/zh-hans/Track1.vtt"}},
	}

	result := fixture.decode(t, fixture.edit(t, edit))
	// A file of a lyrics folder keeps its place inside the target's lyrics folder.
	if result.Copied != 1 || result.Assigned != 1 || fixture.content("lyrics_kikoto/zh-hans/Track1.vtt") != lyricsFetchVTT {
		t.Fatalf("result = %+v", result)
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("a local copy made %d upstream requests", fixture.requests.Load())
	}
	want := "zh-cn=library_import:" + fixture.root + "/lyrics_kikoto/zh-hans/Track1.vtt"
	if assigned := fixture.assignedLanguages(t); len(assigned) != 1 || assigned[0] != want {
		t.Fatalf("assignments = %v, want [%s]", assigned, want)
	}
	if _, err := os.Stat(filepath.Join(translated, "Track1.vtt")); err != nil {
		t.Fatalf("the source folder lost its lyrics: %v", err)
	}
	// A file the folder already holds with the same content is left alone.
	if plan := fixture.plan(t, edit); plan.Summary.Skip != 1 || plan.Summary.Conflict != 0 {
		t.Fatalf("repeated plan = %+v", plan.Summary)
	}

	for name, addition := range map[string]map[string]any{
		"the target folder itself": local(fixture.folderID, "lyrics_kikoto/zh-hans/Track1.vtt"),
		"an audio file":            local(sourceFolderID, "lyrics_kikoto/zh-hans/Track1.mp3"),
		"a file that is not there": local(sourceFolderID, "lyrics_kikoto/zh-hans/missing.vtt"),
		"an unknown kind":          {"kind": "elsewhere", "path": "Track1.vtt", "language": "zh-cn"},
	} {
		if response := fixture.edit(t, map[string]any{"additions": []any{addition}}); response.Code < 400 || response.Code >= 500 {
			t.Fatalf("%s: status = %d, body = %s", name, response.Code, response.Body.String())
		}
	}
	fixture.assertNoStagingLeft(t)
}

func TestLyricsEditRemovesOnlyManagedLyrics(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	fixture.write(t, map[string]string{
		"lyrics_kikoto/ja/Track1.vtt": "managed", "lyrics_kikoto/en/Track1.vtt": "other language", "Track1.vtt": lyricsFetchVTT, "mp3/notes.txt": "notes",
	})
	japanese, _ := fixture.location(t, "lyrics_kikoto/ja/Track1.vtt")
	english, _ := fixture.location(t, "lyrics_kikoto/en/Track1.vtt")
	notes, _ := fixture.location(t, "mp3/notes.txt")

	if response := fixture.edit(t, map[string]any{"removeLocationIds": []int64{notes}}); response.Code != http.StatusBadRequest || fixture.content("mp3/notes.txt") != "notes" {
		t.Fatalf("removing a file Kikoto does not manage = %d", response.Code)
	}
	// A file that takes the place of a removed one needs no decision.
	edit := map[string]any{
		"removeLocationIds": []int64{japanese, english},
		"additions":         []any{lyricsEditFolderAddition("Track1.vtt", "ja-jp")},
		"folderMode":        "move",
	}
	if plan := fixture.plan(t, edit); plan.Summary.Conflict != 0 || plan.Summary.Move != 1 || plan.Summary.Remove != 2 {
		t.Fatalf("plan = %+v", plan.Summary)
	}
	result := fixture.decode(t, fixture.edit(t, edit))
	if result.Removed != 2 || result.Moved != 1 || fixture.content("lyrics_kikoto/ja/Track1.vtt") != lyricsFetchVTT {
		t.Fatalf("result = %+v", result)
	}
	if folders := fixture.lyricsFolders(t); len(folders) != 1 || folders[0] != "ja" {
		t.Fatalf("lyrics folders = %v, want the emptied one removed", folders)
	}
	// Removing the last managed lyrics leaves no lyrics folder behind.
	remaining, _ := fixture.location(t, "lyrics_kikoto/ja/Track1.vtt")
	fixture.decode(t, fixture.edit(t, map[string]any{"removeLocationIds": []int64{remaining}}))
	if _, err := os.Lstat(fixture.absolute(localfs.LyricsRootName)); !os.IsNotExist(err) {
		t.Fatalf("the emptied lyrics folder was left behind: %v", err)
	}
	fixture.assertNoStagingLeft(t)
}

func TestLyricsLanguageFolderNamesCarryNoWorkCode(t *testing.T) {
	if code, _ := localfs.ExtractWorkCode(localfs.LyricsRootName); code != "" {
		t.Fatalf("the lyrics folder reads as work code %q", code)
	}
	for language, want := range map[string]string{
		"":      "fallback",
		"ja-jp": "ja",
		"en-us": "en",
		"zh-cn": "zh-hans",
		"zh-tw": "zh-hant",
		"ko-kr": "ko",
	} {
		got := lyricsLanguageFolderName(language)
		if got != want || lyricsLanguageFolderPath(language) != "lyrics_kikoto/"+want {
			t.Fatalf("folder for %q = %q, want %q", language, got, want)
		}
		if code, _ := localfs.ExtractWorkCode(got); code != "" {
			t.Fatalf("folder %q reads as work code %q", got, code)
		}
		if back, ok := lyricsFolderLanguage(got); !ok || back != language {
			t.Fatalf("language of folder %q = %q, %v", got, back, ok)
		}
	}
	if _, ok := lyricsFolderLanguage("subtitles"); ok {
		t.Fatal("an ordinary folder reads as a lyrics folder")
	}
	for relative, want := range map[string]bool{
		"lyrics_kikoto/ja/mp3/Track1.vtt":   true,
		"lyrics_kikoto/fallback/Track1.lrc": true,
		"lyrics_kikoto/Track1.vtt":          false,
		"lyrics_kikoto/ja/Track1.mp3":       false,
		"lyrics_kikoto/subtitles/a.vtt":     false,
		"lyrics/Track1.vtt":                 false,
		"lyrics_ja/Track1.vtt":              false,
		"mp3/lyrics_kikoto/ja/Track1.vtt":   false,
	} {
		if managedLyricsPath(relative) != want {
			t.Fatalf("managed %q = %v, want %v", relative, !want, want)
		}
	}
}

func TestLyricsEditRejectsUnsafeRequestsWithoutWriting(t *testing.T) {
	okHandler := func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(lyricsFetchVTT)) }
	sameOrigin := func(upstream string) string { return upstream + "/media/1.vtt" }
	remote := func(changes map[string]any) []any {
		addition := lyricsEditRemoteAddition("zh-cn")
		for key, value := range changes {
			addition[key] = value
		}
		return []any{addition}
	}
	assigned := func(audioID int64) []map[string]any {
		return []map[string]any{{"audioMediaItemId": audioID, "itemKey": lyricsEditRemoteKey}}
	}
	for _, testCase := range []struct {
		name         string
		handler      http.HandlerFunc
		textURL      func(string) string
		body         func(fixture lyricsFetchFixture) map[string]any
		permissions  []string
		status       int
		wantRequests int32
	}{
		{name: "edition outside the family", status: http.StatusBadRequest, body: func(lyricsFetchFixture) map[string]any {
			return map[string]any{"additions": remote(map[string]any{"remoteCode": "RJ00000003"})}
		}},
		{name: "file outside the remote tree", status: http.StatusNotFound, body: func(lyricsFetchFixture) map[string]any {
			return map[string]any{"additions": remote(map[string]any{"path": "Translated/other.vtt"})}
		}},
		{name: "non-lyrics file", status: http.StatusBadRequest, body: func(lyricsFetchFixture) map[string]any {
			return map[string]any{"additions": remote(map[string]any{"path": "Translated/Track1.Translated name.mp3"})}
		}},
		{name: "unconfigured host", textURL: func(string) string { return "https://media.invalid/1.vtt" }, status: http.StatusBadGateway},
		{name: "credentials in URL", textURL: func(upstream string) string {
			withCredentials, err := url.Parse(upstream + "/media/1.vtt")
			if err != nil {
				t.Fatal(err)
			}
			withCredentials.User = url.UserPassword("synthetic-user", "synthetic-password")
			return withCredentials.String()
		}, status: http.StatusBadGateway},
		{name: "redirect to another origin", handler: func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "https://media.invalid/1.vtt", http.StatusFound)
		}, status: http.StatusBadGateway, wantRequests: 1},
		{name: "oversized lyrics", handler: func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(strings.Repeat("x", maxLyricsFetchFileBytes+1)))
		}, status: http.StatusBadRequest, wantRequests: 1},
		{name: "upstream error", handler: func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "synthetic failure", http.StatusInternalServerError)
		}, status: http.StatusBadGateway, wantRequests: 1},
		{name: "assignment without library write", permissions: []string{"downloads:manage"}, status: http.StatusForbidden, body: func(fixture lyricsFetchFixture) map[string]any {
			return map[string]any{"additions": remote(nil), "assignments": assigned(fixture.audioID)}
		}},
		{name: "assignment of another work's audio", status: http.StatusBadRequest, body: func(lyricsFetchFixture) map[string]any {
			return map[string]any{"additions": remote(nil), "assignments": assigned(999999)}
		}},
		{name: "assignment of a file the edit does not add", status: http.StatusBadRequest, body: func(fixture lyricsFetchFixture) map[string]any {
			return map[string]any{"additions": remote(nil), "assignments": []map[string]any{{"audioMediaItemId": fixture.audioID, "itemKey": "folder:other.vtt"}}}
		}},
		{name: "a file outside the folder", status: http.StatusNotFound, body: func(lyricsFetchFixture) map[string]any {
			return map[string]any{"additions": []any{lyricsEditFolderAddition("../RJ00000002/outside.vtt", "ja-jp")}}
		}},
		{name: "a folder that is not this work's", status: http.StatusBadRequest, body: func(lyricsFetchFixture) map[string]any {
			return map[string]any{"folderId": 999999, "additions": remote(nil)}
		}},
		{name: "an edit that changes nothing", status: http.StatusBadRequest, body: func(lyricsFetchFixture) map[string]any {
			return map[string]any{}
		}},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			handler, textURL := testCase.handler, testCase.textURL
			if handler == nil {
				handler = okHandler
			}
			if textURL == nil {
				textURL = sameOrigin
			}
			fixture := newLyricsFetchFixture(t, handler, textURL)
			body := map[string]any{"additions": remote(nil)}
			if testCase.body != nil {
				body = testCase.body(fixture)
			}
			response := fixture.edit(t, body, testCase.permissions...)
			if response.Code != testCase.status {
				t.Fatalf("status = %d, want %d, body = %s", response.Code, testCase.status, response.Body.String())
			}
			if strings.Contains(response.Body.String(), "127.0.0.1") || strings.Contains(response.Body.String(), "media.invalid") || strings.Contains(response.Body.String(), fixture.dataRoot) {
				t.Fatalf("error exposes a URL or local path: %s", response.Body.String())
			}
			if got := fixture.requests.Load(); got != testCase.wantRequests {
				t.Fatalf("upstream requests = %d, want %d", got, testCase.wantRequests)
			}
			if folders := fixture.lyricsFolders(t); len(folders) != 0 {
				t.Fatalf("a rejected edit created %v", folders)
			}
			fixture.assertNoStagingLeft(t)
		})
	}
}

func TestLyricsEditStopsWhenCancelled(t *testing.T) {
	fixture := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	plan, err := fixture.server.buildLyricsEditPlan(context.Background(), fixture.workID, lyricsEditRequest{
		FolderID: fixture.folderID,
		Additions: []lyricsEditAdditionRequest{{
			Kind: "remote", SourceID: 7, RemoteCode: "RJ00000002", Path: lyricsEditRemotePath, Language: new(string),
		}},
	})
	if err != nil || plan.Summary.Download != 1 {
		t.Fatalf("plan = %+v, %v", plan.Summary, err)
	}
	stagingRoot := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := fixture.server.stageLyricsEdit(ctx, plan, stagingRoot); err == nil {
		t.Fatal("a cancelled edit collected lyrics")
	}
	if fixture.requests.Load() != 0 {
		t.Fatalf("a cancelled edit made %d upstream requests", fixture.requests.Load())
	}
	if folders := fixture.lyricsFolders(t); len(folders) != 0 {
		t.Fatalf("a cancelled edit created %v", folders)
	}
}
