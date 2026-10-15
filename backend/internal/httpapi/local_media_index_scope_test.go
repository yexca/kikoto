package httpapi

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/storagepool"
)

func TestRefreshPreservesAdditionalFoldersOutsideScanScope(t *testing.T) {
	for _, scenario := range []string{"offline", "deep", "online"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			db := openMigratedTestDB(t)
			s := NewServer(db, config.Config{DataRoot: root, LocalScanDepth: 2})
			primary, additional := "disk1/RJ00000031", "disk2/RJ00000031"
			if scenario == "deep" {
				additional = "disk1/one/two/RJ00000031"
			}
			for _, dir := range []string{primary, additional} {
				if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash(dir)), 0o755); err != nil {
					t.Fatal(err)
				}
			}
			if err := os.WriteFile(filepath.Join(root, filepath.FromSlash(primary), "track.mp3"), []byte("synthetic audio"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := storagepool.WriteMarker(filepath.Join(root, "disk1"), "pool-disk1"); err != nil {
				t.Fatal(err)
			}
			if scenario == "online" {
				if err := storagepool.WriteMarker(filepath.Join(root, "disk2"), "pool-disk2"); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := db.Exec(`UPDATE app_setting SET value_json='"pools"' WHERE key='library_mode'; INSERT INTO app_setting(key,value_json) VALUES('storage_pools','[{"path":"disk1","id":"pool-disk1"},{"path":"disk2","id":"pool-disk2"}]')`); err != nil {
				t.Fatal(err)
			}
			seeded := seedIndexedLocalScanWork(t, db, s, "RJ00000031", primary, additional+"/track.mp3")
			if _, err := db.Exec("INSERT INTO work_folder_location(work_id,file_source_id,root_path,role,state,is_primary) VALUES(?,?,?,'external','active',0)", seeded.workID, seeded.sourceID, additional); err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader("{}"))
			r.SetPathValue("id", jsonNumber(seeded.workID))
			r = r.WithContext(context.WithValue(r.Context(), currentUserKey, currentUser{Permissions: []string{"downloads:manage"}}))
			w := httptest.NewRecorder()
			s.refreshWorkLocalFiles(w, r)
			if w.Code != http.StatusOK {
				t.Fatal(w.Body.String())
			}
			var availability string
			if err := db.QueryRow("SELECT availability FROM media_file_location WHERE id=?", seeded.locationID).Scan(&availability); err != nil {
				t.Fatal(err)
			}
			want := "available"
			if scenario == "online" {
				want = "missing"
			}
			if availability != want {
				t.Fatalf("additional folder became %q, want %q", availability, want)
			}
		})
	}
}
