package httpapi

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/metasync"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func waitStartupRepair(t *testing.T, s *Server, key, want string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var raw string
		if s.db.QueryRow("SELECT value_json FROM app_setting WHERE key=?", key).Scan(&raw) == nil {
			var state struct {
				Status         string
				RetryOnStartup bool
			}
			if err := json.Unmarshal([]byte(raw), &state); err != nil {
				t.Fatal(err)
			}
			if state.Status == want {
				if state.RetryOnStartup != (want != "complete") {
					t.Fatalf("repair retry state=%s", raw)
				}
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("repair %s did not reach %s", key, want)
}

func TestStartupRepairsFailIndependentlyContinueOtherCoversAndRetry(t *testing.T) {
	db := openMigratedTestDB(t)
	cache := t.TempDir()
	s := NewServer(db, config.Config{CacheRoot: cache})
	t.Cleanup(func() {
		if err := s.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	codes := []string{testfixture.WorkCode(testfixture.PrefixRJ, 0), testfixture.WorkCode(testfixture.PrefixRJ, 1)}
	root := filepath.Join(cache, "cover")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, code := range codes {
		if err := os.WriteFile(filepath.Join(root, code+".png"), []byte("synthetic cover"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	badTarget := filepath.Join(root, filepath.FromSlash(coverAssetRelativePath(codes[0], ".png")))
	if err := os.MkdirAll(badTarget, 0o755); err != nil {
		t.Fatal(err)
	}
	badWork := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Synthetic bad snapshot')", codes[0])
	goodWork := metadataReviewExec(t, db, "INSERT INTO work(primary_code,title) VALUES (?,'Synthetic good snapshot')", codes[1])
	insertProjectionSnapshot(t, db, badWork, "2026-01-01 00:00:00", "invalid synthetic json")
	insertProjectionSnapshot(t, db, goodWork, "2026-01-01 00:00:00", `{"product":{"workno":"`+codes[1]+`","maker_id":"RG00000000","maker_name":"Synthetic projected circle"}}`)
	if err := s.RunStartupWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	// These core effects are available before waiting for optional repairs.
	var definitions, runs, parties int
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_definition WHERE scope='system'").Scan(&definitions); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM workflow_run WHERE trigger_type='startup'").Scan(&runs); err != nil {
		t.Fatal(err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM party WHERE display_name='Synthetic projected circle'").Scan(&parties); err != nil {
		t.Fatal(err)
	}
	if definitions == 0 || runs == 0 || parties != 1 {
		t.Fatalf("core startup effects definitions=%d runs=%d parties=%d", definitions, runs, parties)
	}
	waitStartupRepair(t, s, "startup_cover_migration", "failed")
	waitStartupRepair(t, s, "startup_metadata_tag_backfill", "complete")
	goodTarget := filepath.Join(root, filepath.FromSlash(coverAssetRelativePath(codes[1], ".png")))
	if _, err := os.Stat(goodTarget); err != nil {
		t.Fatalf("one failed file prevented another migration: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, codes[0]+".png")); err != nil {
		t.Fatalf("failed cover not retained for retry: %v", err)
	}
	var markers int
	if err := db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key IN ('cover_layout_version','metadata_tag_projection_version')").Scan(&markers); err != nil {
		t.Fatal(err)
	}
	if markers != 1 {
		t.Fatal("invalid snapshot blocked tag repair or failed cover recorded completion")
	}
	if err := s.Shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(badTarget); err != nil {
		t.Fatal(err)
	}
	metadataReviewExec(t, db, "UPDATE metadata_snapshot SET snapshot_json='{\"product\":{\"genres\":[]}}' WHERE work_id=?", badWork)
	retry := NewServer(db, config.Config{CacheRoot: cache})
	t.Cleanup(func() {
		if err := retry.Shutdown(context.Background()); err != nil {
			t.Error(err)
		}
	})
	if err := retry.RunStartupWorkflows(context.Background()); err != nil {
		t.Fatal(err)
	}
	waitStartupRepair(t, retry, "startup_cover_migration", "complete")
	waitStartupRepair(t, retry, "startup_metadata_tag_backfill", "complete")
	if _, err := os.Stat(badTarget); err != nil {
		t.Fatalf("cover retry failed: %v", err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key IN ('cover_layout_version','metadata_tag_projection_version') AND value_json='1'").Scan(&markers); err != nil {
		t.Fatal(err)
	}
	if markers != 2 {
		t.Fatalf("retry completion markers=%d", markers)
	}
}

// Retiring the former instance metadata language deletes both settings and,
// when a database was projected in another language, re-projects stored tag
// names in the original language.
func TestRetireInstanceMetadataLanguageReprojectsNonOriginDatabases(t *testing.T) {
	for _, check := range []struct {
		name, languages, legacy string
		reproject               bool
	}{
		{"non-origin priority", `["zh-cn","origin"]`, `"zh-cn"`, true},
		{"legacy scalar only", "", `"en-us"`, true},
		{"origin only", `["origin"]`, `"origin"`, false},
	} {
		t.Run(check.name, func(t *testing.T) {
			db := openMigratedTestDB(t)
			ctx := context.Background()
			metadataReviewExec(t, db, "INSERT INTO dlsite_genre_name(genre_id,language,name) VALUES (1,'ja-jp','合成日本語タグ'),(1,'zh-cn','合成中文标签')")
			tx, err := db.Begin()
			if err != nil {
				t.Fatal(err)
			}
			tag, err := metadatatags.EnsureGenreTx(ctx, tx, 1)
			if err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			// A completed projection that used the former instance language.
			metadataReviewExec(t, db, "UPDATE tag SET display_name='合成中文标签' WHERE id=?", tag)
			metadataReviewExec(t, db, `INSERT INTO app_setting(key,value_json) VALUES ('metadata_tag_projection_version','1')
				ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`)
			if check.languages != "" {
				metadataReviewExec(t, db, "INSERT INTO app_setting(key,value_json) VALUES (?,?)", dlsiteMetadataLanguagesSetting, check.languages)
			}
			metadataReviewExec(t, db, "INSERT INTO app_setting(key,value_json) VALUES (?,?)", dlsiteMetadataLanguageSetting, check.legacy)

			if err := retireInstanceMetadataLanguage(ctx, db); err != nil {
				t.Fatal(err)
			}
			var settings, pending int
			if err := db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key IN (?,?)", dlsiteMetadataLanguagesSetting, dlsiteMetadataLanguageSetting).Scan(&settings); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key='metadata_projection_pending'").Scan(&pending); err != nil {
				t.Fatal(err)
			}
			if settings != 0 || (pending == 1) != check.reproject {
				t.Fatalf("settings left=%d pending=%d, want reprojection %v", settings, pending, check.reproject)
			}
			if !check.reproject {
				return
			}
			s := NewServer(db, config.Config{})
			if err := metasync.BackfillMetadataTags(ctx, db, s.instanceMetadataLanguages(ctx)); err != nil {
				t.Fatal(err)
			}
			var name string
			if err := db.QueryRow("SELECT display_name FROM tag WHERE id=?", tag).Scan(&name); err != nil {
				t.Fatal(err)
			}
			if err := db.QueryRow("SELECT COUNT(*) FROM app_setting WHERE key='metadata_projection_pending'").Scan(&pending); err != nil {
				t.Fatal(err)
			}
			if name != "合成日本語タグ" || pending != 0 {
				t.Fatalf("after backfill: name=%q pending=%d", name, pending)
			}
		})
	}
}
