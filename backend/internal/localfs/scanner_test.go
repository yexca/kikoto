package localfs

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestDiscoverMatchesDeepestFoldersWithinDepth(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "RJ00000009", "track01.mp3"))
	writeFile(t, filepath.Join(root, "RJ00000009", "cover.jpg"))
	writeFile(t, filepath.Join(root, "RJ00000009", "readme.txt"))
	writeFile(t, filepath.Join(root, "Chinese", "RJ00000008 name", "track01.flac"))
	writeFile(t, filepath.Join(root, "RJ01", "RJ00000002 name", "track01.wav"))
	writeFile(t, filepath.Join(root, "RJ09", "RJ00000007 name", "track01.ogg"))
	writeFile(t, filepath.Join(root, "Other", "No code", "track01.mp3"))

	works, summary, err := Discover(root, Options{ScanDepth: 2})
	if err != nil {
		t.Fatal(err)
	}

	got := make([]string, 0, len(works))
	for _, work := range works {
		got = append(got, work.Code)
	}

	want := map[string]bool{
		"RJ00000008": true,
		"RJ00000002": true,
		"RJ00000007": true,
		"RJ00000009": true,
	}
	if len(got) != len(want) {
		t.Fatalf("codes = %v, want %v", got, want)
	}
	for _, code := range got {
		if !want[code] {
			t.Fatalf("unexpected code %q in %v", code, got)
		}
	}
	if summary.DetectedWorks != 4 {
		t.Fatalf("DetectedWorks = %d, want 4", summary.DetectedWorks)
	}
	if summary.ScannedFiles != 6 {
		t.Fatalf("ScannedFiles = %d, want 6", summary.ScannedFiles)
	}
	for _, work := range works {
		if work.Code == "RJ00000009" && len(work.Files) != 3 {
			t.Fatalf("RJ00000009 files = %d, want 3", len(work.Files))
		}
	}
}

func TestExtractWorkCodeAllowsSeparatorAndIgnoresShortBuckets(t *testing.T) {
	tests := []struct {
		name string
		path string
		want string
	}{
		{name: "RJ with space", path: "RJ 00000000 title", want: testfixture.WorkCode(testfixture.PrefixRJ, 0)},
		{name: "BJ with underscore", path: "edition_BJ_00000001", want: testfixture.WorkCode(testfixture.PrefixBJ, 1)},
		{name: "VJ with hyphen and lowercase", path: "vj-00000002 title", want: testfixture.WorkCode(testfixture.PrefixVJ, 2)},
		{name: "CC without separator", path: "CC00000003 title", want: testfixture.WorkCode(testfixture.PrefixCC, 3)},
		{name: "five digit minimum", path: "RJ00000 title", want: "RJ00000"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			code, ambiguous := ExtractWorkCode(test.path)
			if code != test.want || ambiguous {
				t.Fatalf("ExtractWorkCode(%q) returned %q, %v", test.path, code, ambiguous)
			}
		})
	}

	for _, path := range []string{"RJ0000", "RJ000000000", "RJ01"} {
		code, ambiguous := ExtractWorkCode(path)
		if code != "" || ambiguous {
			t.Fatalf("ExtractWorkCode(%q) returned %q, %v", path, code, ambiguous)
		}
	}
}

func TestDiscoverFoldersIgnoresKikotoInternalTrees(t *testing.T) {
	root := t.TempDir()
	for _, relative := range []string{
		filepath.Join(".kikoto-staging", "12", "RJ00000004"),
		filepath.Join(".kikoto-backup", "12", "RJ00000006"),
		filepath.Join(".kikoto-trash", "fetch", "12", "RJ00000005"),
		filepath.Join("Library", "RJ00000001"),
	} {
		if err := os.MkdirAll(filepath.Join(root, relative), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	folders, _, err := DiscoverFolders(root, Options{ScanDepth: 4})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].Code != "RJ00000001" {
		t.Fatalf("folders = %+v", folders)
	}
}

func TestDiscoverFindsCompactFetchLayoutAtDepthThree(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "example_remote_a", "RJ_000", "RJ00000000", "track.mp3"))

	folders, summary, err := DiscoverFolders(root, Options{ScanDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].Code != "RJ00000000" || folders[0].Depth != 3 {
		t.Fatalf("folders = %+v, want one depth-three compact Fetch folder", folders)
	}
	if summary.DetectedWorks != 1 {
		t.Fatalf("DetectedWorks = %d, want 1", summary.DetectedWorks)
	}
}

func TestDiscoverChangedFoldersResolvesDeepMediaPathToWorkRoot(t *testing.T) {
	root := t.TempDir()
	relativeFile := filepath.Join("Library", "RJ00000020 Work", "Disc 1", "Bonus", "track.flac")
	writeFile(t, filepath.Join(root, relativeFile))

	folders, summary, err := DiscoverChangedFolders(root, Options{ScanDepth: 2}, []string{filepath.ToSlash(relativeFile)})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].Code != "RJ00000020" || folders[0].RelPath != "Library/RJ00000020 Work" {
		t.Fatalf("changed folders = %+v", folders)
	}
	if summary.CandidateFolders != 1 || summary.DetectedWorks != 1 {
		t.Fatalf("changed summary = %+v", summary)
	}
}

func TestDiscoverChangedFoldersWalksOnlyChangedDirectoryScope(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "Changed", "RJ00000021", "track.flac"))
	writeFile(t, filepath.Join(root, "Unchanged", "RJ00000022", "track.flac"))

	folders, _, err := DiscoverChangedFolders(root, Options{ScanDepth: 2}, []string{"Changed"})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].Code != "RJ00000021" {
		t.Fatalf("changed directory folders = %+v", folders)
	}
}

func TestDiscoverChangedFoldersLeavesRemovedWorkForDatabaseReconciliation(t *testing.T) {
	root := t.TempDir()
	folders, summary, err := DiscoverChangedFolders(root, Options{ScanDepth: 2}, []string{"Library/RJ00000023 Removed"})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 0 || summary.DetectedWorks != 0 {
		t.Fatalf("removed changed folders = %+v, summary = %+v", folders, summary)
	}
}

func TestDiscoverChangedFoldersDoesNotTreatDirectorySymlinkAsWorkRoot(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	link := filepath.Join(root, "RJ00000032 Linked")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("directory symlinks are unavailable: %v", err)
	}

	folders, summary, err := DiscoverChangedFolders(root, Options{ScanDepth: 2}, []string{filepath.Base(link)})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 0 || summary.DetectedWorks != 0 {
		t.Fatalf("symlink folders = %+v, summary = %+v", folders, summary)
	}
}

func writeFile(t *testing.T, path string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
}
