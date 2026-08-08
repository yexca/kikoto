package httpapi

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

func TestRemoteFetchManagedRootFromTemplate(t *testing.T) {
	tests := []struct {
		name     string
		template string
		want     string
		ok       bool
	}{
		{name: "default", template: defaultRemoteSaveRootTemplate, want: "example_remote_a", ok: true},
		{name: "nested", template: "/data/remote/<source_name>/library/<work_code>", want: "remote/example_remote_a", ok: true},
		{name: "canonical source code", template: "/data/<source_code>/library/<work_code>", want: "example_remote_a", ok: true},
		{name: "compact shard", template: "/data/<source_code>/<code_prefix>_<code_group>/<work_code>", want: "example_remote_a", ok: true},
		{name: "work token first", template: "/data/<code_prefix>/<source_name>/<work_code>", ok: false},
		{name: "shared root", template: "/data/library/<work_code>", ok: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, ok := remoteFetchManagedRootFromTemplate(test.template, "example_remote_a")
			if ok != test.ok || got != test.want {
				t.Fatalf("managed root = %q/%v, want %q/%v", got, ok, test.want, test.ok)
			}
		})
	}
}

func TestRemoteSaveRootRendersCompactDefaultAndLegacySourceToken(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	source := remoteSourceForUse{Code: "example_remote_a"}

	if got := server.remoteSaveRoot(source, "RJ00000000"); got != "example_remote_a/RJ_000/RJ00000000" {
		t.Fatalf("default save root = %q, want compact source-code layout", got)
	}

	source.Config.SaveRootTemplate = "/data/<source_name>/<code_prefix>/<code_group>/<work_code>"
	if got := server.remoteSaveRoot(source, "RJ00000000"); got != "example_remote_a/RJ/000/RJ00000000" {
		t.Fatalf("legacy save root = %q, want legacy source-name alias to remain supported", got)
	}

	source.Config.SaveRootTemplate = "/data/<source_code>/<code_prefix>_<code_group>/<work_code>"
	if got := server.remoteSaveRoot(source, "RJ00000000"); got != "example_remote_a/RJ_000/RJ00000000" {
		t.Fatalf("canonical save root = %q, want compact source-code layout", got)
	}
}

func TestRemoteFetchRootClaimWritesMarkerAndMultilingualReadme(t *testing.T) {
	dataRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot})
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}
	saveRoot := "example_remote_a/RJ/000/RJ00000000"

	review, err := server.inspectRemoteFetchRoot(context.Background(), source, saveRoot)
	if err != nil || review.Conflict || review.Status != "ready" {
		t.Fatalf("initial review = %+v, error = %v", review, err)
	}
	review, err = server.ensureRemoteFetchRootClaim(context.Background(), source, saveRoot)
	if err != nil || review.Conflict || review.Status != "managed" {
		t.Fatalf("claimed review = %+v, error = %v", review, err)
	}
	root := filepath.Join(dataRoot, "example_remote_a")
	marker, exists, err := readRemoteFetchRootMarker(root)
	if err != nil || !exists || marker.SourceCode != source.Code {
		t.Fatalf("marker = %+v/%v, error = %v", marker, exists, err)
	}
	readme, err := os.ReadFile(filepath.Join(root, remoteFetchRootReadmeName))
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range []string{"## English", "## 简体中文", "## 繁體中文", "## 日本語", "## 한국어"} {
		if !strings.Contains(string(readme), text) {
			t.Fatalf("README does not contain %q", text)
		}
	}
}

func TestRemoteFetchRootReviewBlocksNonEmptyUnclaimedDirectory(t *testing.T) {
	dataRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot})
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}
	root := filepath.Join(dataRoot, source.Code)
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "user-file.txt"), []byte("user data"), 0o644); err != nil {
		t.Fatal(err)
	}
	plan := remoteWorkSavePlan{SaveRoot: "example_remote_a/RJ/000/RJ00000000"}
	if err := server.attachRemoteFetchRootReview(context.Background(), source, &plan); err != nil {
		t.Fatal(err)
	}
	if !plan.FetchRoot.Conflict || plan.Summary.Conflict != 1 || !strings.Contains(plan.FetchRoot.Message, "not managed by Kikoto") {
		t.Fatalf("plan review = %+v, summary = %+v", plan.FetchRoot, plan.Summary)
	}
	if _, err := os.Stat(filepath.Join(root, localfs.FetchRootMarkerName)); !os.IsNotExist(err) {
		t.Fatalf("unclaimed directory received a marker: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, remoteFetchRootReadmeName)); !os.IsNotExist(err) {
		t.Fatalf("unclaimed directory received a README: %v", err)
	}
}

func TestRemoteFetchRootClaimDoesNotOverwriteExistingReadme(t *testing.T) {
	dataRoot := t.TempDir()
	server := NewServer(openMigratedTestDB(t), config.Config{DataRoot: dataRoot})
	rootRelative := "example_remote_a/RJ/000/RJ00000000"
	root := filepath.Join(dataRoot, filepath.FromSlash("example_remote_a"))
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := createRemoteFetchRootMarker(root, "example_remote_a"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, remoteFetchRootReadmeName), []byte("operator README"), 0o644); err != nil {
		t.Fatal(err)
	}
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}
	review, err := server.ensureRemoteFetchRootClaim(context.Background(), source, rootRelative)
	if err != nil || review.Conflict || review.Status != "managed" {
		t.Fatalf("review = %+v, error = %v", review, err)
	}
	readme, err := os.ReadFile(filepath.Join(root, remoteFetchRootReadmeName))
	if err != nil || string(readme) != "operator README" {
		t.Fatalf("README = %q, error = %v", readme, err)
	}
	if _, exists, err := readRemoteFetchRootMarker(root); err != nil || !exists {
		t.Fatalf("marker exists = %v, error = %v", exists, err)
	}
}

func TestConfiguredRemoteFetchWatchRootsLeaveUnclaimedSourceFolderWatched(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (code, display_name, source_type, config_json) VALUES ('example_remote_a', 'Example Remote A', 'kikoeru_compatible', '{}')`); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	roots, err := server.configuredRemoteFetchWatchRoots(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 0 {
		t.Fatalf("unclaimed Fetch root was excluded from watching: %v", roots)
	}
}

func TestConfiguredRemoteFetchWatchRootsIncludeClaimedSourceFolder(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (code, display_name, source_type, config_json) VALUES ('example_remote_a', 'Example Remote A', 'kikoeru_compatible', '{}')`); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataRoot, "example_remote_a")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := createRemoteFetchRootMarker(root, "example_remote_a"); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	roots, err := server.configuredRemoteFetchWatchRoots(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || !strings.EqualFold(roots[0], root) {
		t.Fatalf("watch roots = %v, want %q", roots, root)
	}
}

func TestConfiguredRemoteFetchWatchRootsKeepUnclaimedCollisionVisible(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	if _, err := db.Exec(`INSERT INTO file_source (code, display_name, source_type, config_json) VALUES ('example_remote_a', 'Example Remote A', 'kikoeru_compatible', '{}')`); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataRoot, "example_remote_a")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "user-file.txt"), []byte("user data"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	roots, err := server.configuredRemoteFetchWatchRoots(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 0 {
		t.Fatalf("unclaimed collision was excluded from watching: %v", roots)
	}
}

func TestLegacyRemoteFetchRootManagedLocationBackfillsClaim(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	seedLegacyRemoteFetchSources(t, db)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Synthetic work');
		INSERT INTO work_folder_location (
			work_id, file_source_id, root_path, role, origin_source_id, origin_remote_code, state, is_primary
		) VALUES (1, 2, 'example_remote_a/RJ/000/RJ00000000', 'managed_fetch', 1, 'RJ00000000', 'active', 1)
	`); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dataRoot, filepath.FromSlash("example_remote_a/RJ/000/RJ00000000"))
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "track.mp3"), []byte("fetched data"), 0o644); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataRoot, "example_remote_a")
	if err := os.WriteFile(filepath.Join(root, remoteFetchRootReadmeName), []byte("operator README"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}

	review, err := server.inspectRemoteFetchRoot(context.Background(), source, "example_remote_a/RJ/000/RJ00000001")
	if err != nil || review.Conflict || review.Status != "legacy_managed" {
		t.Fatalf("legacy review = %+v, error = %v", review, err)
	}
	if _, exists, err := readRemoteFetchRootMarker(root); err != nil || exists {
		t.Fatalf("inspection marker exists = %v, error = %v", exists, err)
	}

	review, err = server.ensureRemoteFetchRootClaim(context.Background(), source, "example_remote_a/RJ/000/RJ00000001")
	if err != nil || review.Conflict || review.Status != "managed" {
		t.Fatalf("claimed review = %+v, error = %v", review, err)
	}
	marker, exists, err := readRemoteFetchRootMarker(root)
	if err != nil || !exists || marker.SourceCode != source.Code {
		t.Fatalf("marker = %+v/%v, error = %v", marker, exists, err)
	}
	readme, err := os.ReadFile(filepath.Join(root, remoteFetchRootReadmeName))
	if err != nil || string(readme) != "operator README" {
		t.Fatalf("README = %q, error = %v", readme, err)
	}
	if contents, err := os.ReadFile(filepath.Join(target, "track.mp3")); err != nil || string(contents) != "fetched data" {
		t.Fatalf("historical target contents = %q, error = %v", contents, err)
	}
}

func TestLegacyRemoteFetchRootSucceededWorkflowPlanBackfillsClaim(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	seedLegacyRemoteFetchSources(t, db)
	targetRoot := "example_remote_a/RJ/000/RJ00000001"
	insertLegacyRemoteFetchWorkflow(t, db, 1, "succeeded", "succeeded", 1, 1, targetRoot)
	target := filepath.Join(dataRoot, filepath.FromSlash(targetRoot))
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "track.flac"), []byte("legacy fetch"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}

	review, err := server.inspectRemoteFetchRoot(context.Background(), source, "example_remote_a/RJ/000/RJ00000002")
	if err != nil || review.Conflict || review.Status != "legacy_managed" {
		t.Fatalf("legacy review = %+v, error = %v", review, err)
	}
	review, err = server.ensureRemoteFetchRootClaim(context.Background(), source, "example_remote_a/RJ/000/RJ00000002")
	if err != nil || review.Conflict || review.Status != "managed" {
		t.Fatalf("claimed review = %+v, error = %v", review, err)
	}
	if _, exists, err := readRemoteFetchRootMarker(filepath.Join(dataRoot, "example_remote_a")); err != nil || !exists {
		t.Fatalf("marker exists = %v, error = %v", exists, err)
	}
}

func TestLegacyRemoteFetchRootRejectsUnexplainedSibling(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	seedLegacyRemoteFetchSources(t, db)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000002', 'Synthetic work');
		INSERT INTO work_folder_location (
			work_id, file_source_id, root_path, role, origin_source_id, state, is_primary
		) VALUES (1, 2, 'example_remote_a/RJ/000/RJ00000002', 'managed_fetch', 1, 'active', 1)
	`); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dataRoot, filepath.FromSlash("example_remote_a/RJ/000/RJ00000002"))
	if err := os.MkdirAll(target, 0o755); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataRoot, "example_remote_a")
	if err := os.WriteFile(filepath.Join(root, "user-file.txt"), []byte("manual content"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}

	review, err := server.ensureRemoteFetchRootClaim(context.Background(), source, "example_remote_a/RJ/000/RJ00000003")
	if err != nil {
		t.Fatal(err)
	}
	if !review.Conflict || review.Status != "conflict" || !strings.Contains(review.Message, "not managed by Kikoto") {
		t.Fatalf("review = %+v", review)
	}
	if _, exists, err := readRemoteFetchRootMarker(root); err != nil || exists {
		t.Fatalf("conflicting root marker exists = %v, error = %v", exists, err)
	}
}

func TestLegacyRemoteFetchRootRejectsUntrustedWorkflowHistory(t *testing.T) {
	tests := []struct {
		name           string
		runStatus      string
		planStatus     string
		inputSourceID  int64
		outputSourceID int64
	}{
		{name: "mismatched run source", runStatus: "succeeded", planStatus: "succeeded", inputSourceID: 2, outputSourceID: 1},
		{name: "mismatched plan source", runStatus: "succeeded", planStatus: "succeeded", inputSourceID: 1, outputSourceID: 2},
		{name: "failed run", runStatus: "failed", planStatus: "succeeded", inputSourceID: 1, outputSourceID: 1},
		{name: "failed plan", runStatus: "succeeded", planStatus: "failed", inputSourceID: 1, outputSourceID: 1},
	}
	for index, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			dataRoot := t.TempDir()
			db := openMigratedTestDB(t)
			seedLegacyRemoteFetchSources(t, db)
			targetRoot := "example_remote_a/RJ/000/RJ00000004"
			insertLegacyRemoteFetchWorkflow(t, db, int64(index+1), test.runStatus, test.planStatus, test.inputSourceID, test.outputSourceID, targetRoot)
			target := filepath.Join(dataRoot, filepath.FromSlash(targetRoot))
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
			server := NewServer(db, config.Config{DataRoot: dataRoot})
			source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}

			review, err := server.inspectRemoteFetchRoot(context.Background(), source, "example_remote_a/RJ/000/RJ00000005")
			if err != nil {
				t.Fatal(err)
			}
			if !review.Conflict || review.Status != "conflict" {
				t.Fatalf("review = %+v", review)
			}
		})
	}
}

func TestLegacyRemoteFetchRootRequiresHistoricalTargetOnDisk(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	seedLegacyRemoteFetchSources(t, db)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000005', 'Synthetic work');
		INSERT INTO work_folder_location (
			work_id, file_source_id, root_path, role, origin_source_id, state, is_primary
		) VALUES (1, 2, 'example_remote_a/RJ/000/RJ00000005', 'managed_fetch', 1, 'active', 1)
	`); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataRoot, "example_remote_a")
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, remoteFetchRootReadmeName), []byte("legacy README"), 0o644); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})
	source := remoteSourceForUse{ID: 1, Code: "example_remote_a", SourceType: sourceTypeKikoeruCompatible}

	review, err := server.inspectRemoteFetchRoot(context.Background(), source, "example_remote_a/RJ/000/RJ00000006")
	if err != nil {
		t.Fatal(err)
	}
	if !review.Conflict || review.Status != "conflict" {
		t.Fatalf("review = %+v", review)
	}
	if _, exists, err := readRemoteFetchRootMarker(root); err != nil || exists {
		t.Fatalf("stale history marker exists = %v, error = %v", exists, err)
	}
}

func TestConfiguredRemoteFetchWatchRootsIncludeVerifiedLegacySourceFolder(t *testing.T) {
	dataRoot := t.TempDir()
	db := openMigratedTestDB(t)
	seedLegacyRemoteFetchSources(t, db)
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000006', 'Synthetic work');
		INSERT INTO work_folder_location (
			work_id, file_source_id, root_path, role, origin_source_id, state, is_primary
		) VALUES (1, 2, 'example_remote_a/RJ/000/RJ00000006', 'managed_fetch', 1, 'active', 1)
	`); err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(dataRoot, "example_remote_a")
	if err := os.MkdirAll(filepath.Join(root, filepath.FromSlash("RJ/000/RJ00000006")), 0o755); err != nil {
		t.Fatal(err)
	}
	server := NewServer(db, config.Config{DataRoot: dataRoot})

	roots, err := server.configuredRemoteFetchWatchRoots(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(roots) != 1 || !strings.EqualFold(roots[0], root) {
		t.Fatalf("watch roots = %v, want %q", roots, root)
	}
	if _, exists, err := readRemoteFetchRootMarker(root); err != nil || exists {
		t.Fatalf("watch-root inspection marker exists = %v, error = %v", exists, err)
	}
}

func seedLegacyRemoteFetchSources(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(`
		INSERT INTO file_source (id, code, display_name, source_type, config_json)
		VALUES
			(1, 'example_remote_a', 'Example Remote A', 'kikoeru_compatible', '{}'),
			(2, 'local', 'Local', 'local_folder', '{}')
	`); err != nil {
		t.Fatal(err)
	}
}

func insertLegacyRemoteFetchWorkflow(t *testing.T, db *sql.DB, runID int64, runStatus string, planStatus string, inputSourceID int64, outputSourceID int64, saveRoot string) {
	t.Helper()
	workCode := filepath.Base(filepath.FromSlash(saveRoot))
	_, err := db.Exec(`
		INSERT INTO workflow_run (id, workflow_code, display_name, status, trigger_type, input_json)
		VALUES (?, 'remote_work_fetch', 'Fetch remote work', ?, 'manual', ?)
	`, runID, runStatus, mustJSON(map[string]any{"source_id": inputSourceID, "work_code": workCode}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO workflow_node_run (
			workflow_run_id, node_id, node_type, display_name, position, status, output_json
		) VALUES (?, 'plan', 'plan_save', 'Plan save', 3, ?, ?)
	`, runID, planStatus, mustJSON(map[string]any{"sourceId": outputSourceID, "saveRoot": saveRoot})); err != nil {
		t.Fatal(err)
	}
}
