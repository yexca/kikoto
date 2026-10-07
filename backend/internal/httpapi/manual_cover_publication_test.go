package httpapi

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/download"
)

func TestManualCoverInterruptedCopyDoesNotPublishAnAsset(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	directory := t.TempDir()
	target := filepath.Join(directory, ".synthetic-cover.pending")
	_, err := download.WriteFile(manualCoverReader{ctx, bytes.NewReader(make([]byte, 128<<10))}, -1, target, download.Options{
		MaxBytes: download.CoverMaxBytes,
		OnProgress: func(written int64) {
			if written > 0 {
				cancel()
			}
		},
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("interrupted copy = %v", err)
	}
	files, err := os.ReadDir(directory)
	if err != nil || len(files) != 0 {
		t.Fatalf("interrupted copy left a partial asset: %v %v", files, err)
	}
}

func TestManualCoverFailurePreservesCommittedAssetAndCleansOrphans(t *testing.T) {
	f := newManualOverrideFixture(t, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
	path := filepath.Join(f.server.cfg.DataRoot, "RJ00000000", "cover.jpg")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("synthetic original cover"), 0o600); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, f.db, "INSERT INTO file_source(id,code,display_name,source_type) VALUES (1,'example_local','Example Local','local_folder')")
	itemID := metadataReviewExec(t, f.db, "INSERT INTO media_item(work_id,kind,title) VALUES (?,'image','Example Cover')", f.workID)
	locationID := metadataReviewExec(t, f.db, "INSERT INTO media_file_location(media_item_id,file_source_id,location_type,path,availability) VALUES (?,1,'local','RJ00000000/cover.jpg','available')", itemID)
	if response := setManualCoverRequest(t, f, locationID); response.Code != http.StatusOK {
		t.Fatalf("initial save = %d %s", response.Code, response.Body.String())
	}
	var oldAsset string
	if err := f.db.QueryRow("SELECT asset_path FROM work_manual_override WHERE work_id = ? AND field_name = 'cover'", f.workID).Scan(&oldAsset); err != nil {
		t.Fatal(err)
	}
	assertOld := func() {
		t.Helper()
		var asset string
		if err := f.db.QueryRow("SELECT asset_path FROM work_manual_override WHERE work_id = ? AND field_name = 'cover'", f.workID).Scan(&asset); err != nil {
			t.Fatal(err)
		}
		content, err := os.ReadFile(filepath.Join(f.server.cfg.CacheRoot, "manual", oldAsset))
		if err != nil || asset != oldAsset || string(content) != "synthetic original cover" {
			t.Fatalf("committed cover changed after failed save: %q %q %v", asset, content, err)
		}
		files, err := os.ReadDir(filepath.Join(f.server.cfg.CacheRoot, "manual"))
		if err != nil || len(files) != 1 {
			t.Fatalf("failed save left unpublished assets: %v %v", files, err)
		}
	}
	metadataReviewExec(t, f.db, `CREATE TRIGGER fail_cover_commit BEFORE UPDATE ON work_manual_override WHEN NEW.field_name = 'cover' BEGIN SELECT RAISE(ABORT,'synthetic cover failure'); END`)
	if err := os.WriteFile(path, []byte("synthetic replacement cover"), 0o600); err != nil {
		t.Fatal(err)
	}
	if response := setManualCoverRequest(t, f, locationID); response.Code != http.StatusInternalServerError {
		t.Fatalf("failed save = %d %s", response.Code, response.Body.String())
	}
	assertOld()
	metadataReviewExec(t, f.db, "DROP TRIGGER fail_cover_commit")
	file, err := os.OpenFile(path, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(download.CoverMaxBytes + 1); err != nil {
		t.Fatal(err)
	}
	_ = file.Close()
	if response := setManualCoverRequest(t, f, locationID); response.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversized save = %d %s", response.Code, response.Body.String())
	}
	assertOld()
	if err := os.WriteFile(path, []byte("synthetic replacement cover"), 0o600); err != nil {
		t.Fatal(err)
	}
	if response := setManualCoverRequest(t, f, locationID); response.Code != http.StatusOK {
		t.Fatalf("replacement save = %d %s", response.Code, response.Body.String())
	}
	if _, err := os.Stat(filepath.Join(f.server.cfg.CacheRoot, "manual", oldAsset)); !os.IsNotExist(err) {
		t.Fatalf("superseded asset remains: %v", err)
	}
	orphan := filepath.Join(f.server.cfg.CacheRoot, "manual", ".synthetic-orphan.pending")
	if err := os.WriteFile(orphan, []byte("synthetic incomplete copy"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.server.cleanupUnreferencedManualAssets(context.Background()); err != nil {
		t.Fatal(err)
	}
	files, err := os.ReadDir(filepath.Dir(orphan))
	if err != nil || len(files) != 1 {
		t.Fatalf("orphan sweep lost reference or retained orphan: %v %v", files, err)
	}
	request := httptest.NewRequest(http.MethodDelete, "/api/works/"+strconv.FormatInt(f.workID, 10)+"/manual-overrides/cover", nil)
	request.SetPathValue("id", strconv.FormatInt(f.workID, 10))
	request.SetPathValue("field", "cover")
	request = request.WithContext(context.WithValue(request.Context(), currentUserKey, manualOverrideActor(t, f)))
	response := httptest.NewRecorder()
	f.server.deleteWorkManualOverride(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("reset = %d %s", response.Code, response.Body.String())
	}
	files, err = os.ReadDir(filepath.Dir(orphan))
	if err != nil || len(files) != 0 {
		t.Fatalf("reset retained its asset: %v %v", files, err)
	}
}
