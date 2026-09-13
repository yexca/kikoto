package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestFetchReplacePreservesChosenContent(t *testing.T) {
	for _, scenario := range []string{"local", "remote", "remote_unknown_size", "resume_verified", "resume_corrupt"} {
		t.Run(scenario, func(t *testing.T) {
			ctx := context.Background()
			db := openMigratedTestDB(t)
			s := NewServer(db, config.Config{DataRoot: t.TempDir(), CacheRoot: t.TempDir()})
			code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
			root := "Target/" + code
			localPath := "Input/" + code + "/track.mp3"
			write := func(root, relative, content string) {
				t.Helper()
				absolute := filepath.Join(root, filepath.FromSlash(relative))
				if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(absolute, []byte(content), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			write(s.cfg.DataRoot, localPath, "NEW")
			write(s.cfg.DataRoot, root+"/track.mp3", "OLD")
			write(s.cfg.DataRoot, root+"/keep.txt", "retained")
			size := int64(3)
			inputs := remoteFetchPlanInputs{workCode: code, saveRoot: root}
			var item remoteWorkSavePlanItem
			var err error
			if scenario == "local" {
				inputs.localFiles = []remoteWorkSaveLocalFile{{Path: localPath, SizeBytes: &size}}
				inputs.decisions = map[string]remoteFetchFileDecision{"local:" + localPath: {Resolution: "replace"}}
				item, err = s.buildLocalFetchPlanItem(inputs, inputs.localFiles[0], map[string]string{})
			} else {
				expected := &size
				if scenario == "remote_unknown_size" {
					expected = nil
				}
				inputs.decisions = map[string]remoteFetchFileDecision{"remote:track.mp3": {Resolution: "replace"}}
				inputs.sourceOptions = map[string][]remoteFetchSourceOption{"track.mp3": {{SourceID: 101, SourceCode: "example_remote_a", Path: "track.mp3", SizeBytes: expected, SourcePath: "https://source.example.invalid/track.mp3"}}}
				item, err = s.buildRemoteFetchPlanRemoteItem(ctx, remoteSourceForUse{ID: 101, Code: "example_remote_a"}, inputs, remoteSaveFile{Path: "track.mp3", SizeBytes: expected}, map[string]string{})
				if err == nil {
					write(s.cfg.CacheRoot, item.CachePath, "NEW")
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			if item.Action == "skip" || item.Resolution != "replace" {
				t.Fatalf("replace plan: action=%q resolution=%q", item.Action, item.Resolution)
			}
			if _, err := db.Exec(`INSERT INTO work (id, primary_code, title) VALUES (1, ?, 'Example Work')`, code); err != nil {
				t.Fatal(err)
			}
			for _, query := range []string{
				`INSERT INTO file_source (id, code, display_name, source_type) VALUES (100, 'example_local', 'Example Local', 'local_folder'), (101, 'example_remote_a', 'Example Remote A', 'kikoeru')`,
				`INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type) VALUES (1, 'remote_work_fetch', 'Example Fetch', 'running', 'manual')`,
				`INSERT INTO workflow_job (id, workflow_run_id, worker_type, status) VALUES (1, 1, 'remote_work_fetch', 'running')`,
				`INSERT INTO workflow_node_run (workflow_run_id, node_id, node_type, display_name, status) VALUES (1, 'stage', 'stage', 'Stage', 'running'), (1, 'verify', 'verify', 'Verify', 'queued'), (1, 'promote', 'promote', 'Promote', 'queued')`,
			} {
				if _, err := db.Exec(query); err != nil {
					t.Fatal(err)
				}
			}
			plan := remoteWorkSavePlan{PrimaryCode: code, SaveRoot: root, Items: []remoteWorkSavePlanItem{item}}
			tx, err := db.BeginTx(ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = tx.Rollback() }()
			if _, err := createRemoteFetchManifest(ctx, tx, 1, 1, "synthetic-request", 1, 101, 100, plan); err != nil {
				t.Fatal(err)
			}
			if err := tx.Commit(); err != nil {
				t.Fatal(err)
			}
			manifest, err := s.loadRemoteFetchManifest(ctx, 1)
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "resume_verified" || scenario == "resume_corrupt" {
				paths, err := s.remoteFetchPublishPaths(manifest)
				if err != nil {
					t.Fatal(err)
				}
				if err := s.stageRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
					t.Fatal(err)
				}
				if err := s.verifyRemoteFetchItems(ctx, manifest, plan, paths); err != nil {
					t.Fatal(err)
				}
				if scenario == "resume_corrupt" {
					write(paths.stageRoot, "track.mp3", "BAD")
				} else {
					if err := os.Remove(filepath.Join(s.cfg.CacheRoot, filepath.FromSlash(item.CachePath))); err != nil {
						t.Fatal(err)
					}
				}
				manifest, err = s.loadRemoteFetchManifest(ctx, 1)
				if err != nil {
					t.Fatal(err)
				}
			}
			promoted, err := s.stageAndPublishRemoteFetch(ctx, manifest, plan)
			if err != nil || promoted != 1 {
				t.Fatalf("promoted=%d error=%v", promoted, err)
			}
			for relative, expected := range map[string]string{"track.mp3": "NEW", "keep.txt": "retained"} {
				actual, err := os.ReadFile(filepath.Join(s.cfg.DataRoot, filepath.FromSlash(root), relative))
				if err != nil || string(actual) != expected {
					t.Fatalf("%s content=%q error=%v", relative, actual, err)
				}
			}
		})
	}
}
