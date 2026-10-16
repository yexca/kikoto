package httpapi

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLyricsEditRollbackDiagnosticsStayOutOfAPIResponses(t *testing.T) {
	for _, cause := range []error{lyricsEditConflictError{}, symlinkMediaLocationError{}, mediaCleanupTargetConflictError{}} {
		privatePath := filepath.Join(t.TempDir(), "staged-original.vtt")
		err := errors.Join(cause, &os.PathError{Op: "rename", Path: privatePath, Err: os.ErrPermission})
		w := httptest.NewRecorder()
		writeLyricsEditError(w, 1, err)
		if w.Code != http.StatusConflict || strings.Contains(w.Body.String(), "staged-original") || strings.Contains(w.Body.String(), "rename") {
			t.Fatalf("private rollback diagnostics exposed: %d %s", w.Code, w.Body.String())
		}
	}
}

func TestLyricsEditRestoresSourcesOccupiedByEarlierPublications(t *testing.T) {
	var f lyricsFetchFixture
	f = newLyricsFetchFixture(t, func(w http.ResponseWriter, r *http.Request) {
		// A destination is occupied while the remote addition is staged.
		if err := os.MkdirAll(f.absolute("lyrics_kikoto/zh-hans"), 0o755); err != nil {
			t.Error(err)
			return
		}
		if err := os.WriteFile(f.absolute("lyrics_kikoto/zh-hans/b.vtt"), []byte("concurrent-file"), 0o644); err != nil {
			t.Error(err)
			return
		}
		serveLyricsFetchVTT(w, r)
	}, lyricsFetchVTTURL)
	f.write(t, map[string]string{"lyrics_kikoto/en/b.vtt": "original-A", "lyrics_kikoto/ja/b.vtt": "original-B"})
	body := map[string]any{
		"additions": []any{lyricsEditFolderAddition("lyrics_kikoto/en/b.vtt", "ja-jp"), lyricsEditFolderAddition("lyrics_kikoto/ja/b.vtt", "zh-cn"), lyricsEditRemoteAddition("en-us")},
		"decisions": []any{map[string]any{"itemKey": "folder:lyrics_kikoto/en/b.vtt", "resolution": "replace"}},
	}
	if plan := f.plan(t, body); plan.Summary.Conflict != 0 {
		t.Fatal("unexpected initial conflict")
	}
	response := f.edit(t, body)
	if response.Code != http.StatusConflict {
		t.Fatalf("status=%d %s", response.Code, response.Body.String())
	}
	for file, want := range map[string]string{"lyrics_kikoto/en/b.vtt": "original-A", "lyrics_kikoto/ja/b.vtt": "original-B", "lyrics_kikoto/zh-hans/b.vtt": "concurrent-file"} {
		if got := f.content(file); got != want {
			t.Fatalf("%s=%q want=%q", file, got, want)
		}
	}
	f.assertNoStagingLeft(t)
}

func TestLyricsEditKeepsStagingWhenRollbackCannotRestoreASource(t *testing.T) {
	f := newLyricsFetchFixture(t, serveLyricsFetchVTT, lyricsFetchVTTURL)
	f.write(t, map[string]string{"lyrics_kikoto/en/b.vtt": "original-A", "lyrics_kikoto/ja/b.vtt": "original-B"})
	language := "zh-cn"
	plan, err := f.server.buildLyricsEditPlan(context.Background(), f.workID, lyricsEditRequest{
		FolderID:  f.folderID,
		Additions: []lyricsEditAdditionRequest{{Kind: "folder", Path: "lyrics_kikoto/en/b.vtt", Language: &language}, {Kind: "folder", Path: "lyrics_kikoto/ja/b.vtt", Language: &language}},
	})
	if err != nil {
		t.Fatal(err)
	}
	staging := t.TempDir()
	if err := writeLyricsEditRecovery(plan, staging); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(plan.Items[0].sourceAbsolute, lyricsEditStagedPath(staging, 0)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(plan.Items[0].sourceAbsolute, []byte("concurrent-file"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := restoreLyricsEdit(plan, staging, []int{0}, nil); err == nil {
		t.Fatal("occupied original path was accepted")
	}
	saved, err := os.ReadFile(lyricsEditStagedPath(staging, 0))
	if err != nil || string(saved) != "original-A" || f.content("lyrics_kikoto/en/b.vtt") != "concurrent-file" {
		t.Fatalf("staged=%q err=%v", saved, err)
	}
	manifest, err := os.ReadFile(filepath.Join(staging, "recovery.json"))
	if err != nil || !strings.Contains(string(manifest), "lyrics_kikoto/en/b.vtt") {
		t.Fatalf("missing recovery mapping: %s %v", manifest, err)
	}
}
