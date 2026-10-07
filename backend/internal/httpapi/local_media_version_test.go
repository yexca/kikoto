package httpapi

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func TestSameSizeMediaReplacementInvalidatesDurationAndRejectsOldProbe(t *testing.T) {
	s := newLocalProbeTestServer(t, 1)
	ctx := context.Background()
	if _, err := s.db.Exec("UPDATE media_item SET fingerprint = 'local:RJ00000000:track-1.mp3' WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, s.db, "INSERT INTO user_account(id,username,role) VALUES (1,'synthetic-user','user')")
	metadataReviewExec(t, s.db, "INSERT INTO user_work_state(user_id,work_id,favorite,note) VALUES (1,1,1,'Example note')")
	if err := s.probeMissingLocalMedia(ctx, func(context.Context, string) (int64, bool, bool) { return 60, true, true }); err != nil {
		t.Fatal(err)
	}
	assertLocalVersionDuration(t, s, 60)
	// A rescan of the same observation retains known media metadata.
	scanLocalVersionFixture(t, s)
	assertLocalVersionDuration(t, s, 60)
	files, err := localfs.CollectWorkFiles(s.cfg.DataRoot, filepath.Join(s.cfg.DataRoot, "RJ00000000"))
	if err != nil || len(files) != 1 {
		t.Fatalf("old file observation = %+v %v", files, err)
	}
	oldFile := files[0]
	path := filepath.Join(s.cfg.DataRoot, oldFile.RelPath)
	if err := os.WriteFile(path, []byte("newer"), 0o600); err != nil {
		t.Fatal(err)
	}
	nextTime := time.Date(2026, 1, 2, 0, 0, 0, 123000000, time.UTC)
	if err := os.Chtimes(path, nextTime, nextTime); err != nil {
		t.Fatal(err)
	}
	scanLocalVersionFixture(t, s)
	assertLocalVersionDuration(t, s, 0)
	if err := s.updateLocalMediaMetadata(ctx, 1, oldFile, oldFile.FileVersion, 60, true); err != nil {
		t.Fatal(err)
	}
	assertLocalVersionDuration(t, s, 0)
	// Pending work remains durable across worker/server recreation.
	restarted := NewServer(s.db, s.cfg)
	if err := restarted.probeMissingLocalMedia(ctx, func(context.Context, string) (int64, bool, bool) { return 120, true, true }); err != nil {
		t.Fatal(err)
	}
	assertLocalVersionDuration(t, s, 120)
	var items, locations int
	var favorite bool
	var note string
	if err := s.db.QueryRow("SELECT COUNT(*) FROM media_item").Scan(&items); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT COUNT(*) FROM media_file_location").Scan(&locations); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT favorite,note FROM user_work_state WHERE user_id=1 AND work_id=1").Scan(&favorite, &note); err != nil {
		t.Fatal(err)
	}
	if items != 1 || locations != 1 || !favorite || note != "Example note" {
		t.Fatalf("replacement changed identity/user state: %d %d %t %q", items, locations, favorite, note)
	}
}

func scanLocalVersionFixture(t *testing.T, s *Server) {
	t.Helper()
	folder := localfs.WorkFolder{Code: "RJ00000000", RelPath: "RJ00000000", AbsPath: filepath.Join(s.cfg.DataRoot, "RJ00000000")}
	files, err := localfs.CollectWorkFiles(s.cfg.DataRoot, folder.AbsPath)
	if err != nil {
		t.Fatal(err)
	}
	folder.Files = files
	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := persistIndexedLocalFiles(context.Background(), tx, 1, 1, folder); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
}

func assertLocalVersionDuration(t *testing.T, s *Server, want int64) {
	t.Helper()
	var item, location sql.NullInt64
	if err := s.db.QueryRow("SELECT duration_seconds FROM media_item WHERE id=1").Scan(&item); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow("SELECT duration_seconds FROM media_file_location WHERE id=1").Scan(&location); err != nil {
		t.Fatal(err)
	}
	if item.Int64 != want || location.Int64 != want || (want == 0 && (item.Valid || location.Valid)) {
		t.Fatalf("item/location duration = %+v/%+v, want %d", item, location, want)
	}
}

func TestLocalMediaProbeSkipsOfflinePoolsAndRootsBeyondDepth(t *testing.T) {
	for _, scenario := range []string{"offline", "deep"} {
		t.Run(scenario, func(t *testing.T) {
			s := newLocalProbeTestServer(t, 1)
			ctx := context.Background()
			pool, err := storagepool.NewID()
			if err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(s.cfg.DataRoot, "ExamplePool")
			if err := os.MkdirAll(root, 0o700); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(filepath.Join(s.cfg.DataRoot, "RJ00000000"), filepath.Join(root, "RJ00000000")); err != nil {
				t.Fatal(err)
			}
			path := "ExamplePool/RJ00000000/track-1.mp3"
			if scenario == "deep" {
				deepRoot := filepath.Join(root, "Nested", "RJ00000000")
				if err := os.MkdirAll(filepath.Dir(deepRoot), 0o700); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(filepath.Join(root, "RJ00000000"), deepRoot); err != nil {
					t.Fatal(err)
				}
				path = "ExamplePool/Nested/RJ00000000/track-1.mp3"
				if err := storagepool.WriteMarker(root, pool); err != nil {
					t.Fatal(err)
				}
			}
			for key, value := range map[string]any{settingLibraryMode: storagepool.ModePools, settingStoragePools: []storagepool.Pool{{Path: "ExamplePool", ID: pool}}} {
				if err := s.saveSettingValue(ctx, key, value); err != nil {
					t.Fatal(err)
				}
			}
			metadataReviewExec(t, s.db, "UPDATE media_file_location SET path=? WHERE id=1", path)
			s.cfg.LocalScanDepth = 1
			if err := s.probeMissingLocalMedia(ctx, func(context.Context, string) (int64, bool, bool) {
				t.Fatal("probed a file outside the visible pool/depth scope")
				return 60, true, true
			}); err != nil {
				t.Fatal(err)
			}
			assertLocalVersionDuration(t, s, 0)
		})
	}
}
