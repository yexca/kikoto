package httpapi

import (
	"context"
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
