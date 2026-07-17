package localfs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDiscoverMatchesDeepestFoldersWithinDepth(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "RJ23456", "track01.mp3"))
	writeFile(t, filepath.Join(root, "RJ23456", "cover.jpg"))
	writeFile(t, filepath.Join(root, "RJ23456", "readme.txt"))
	writeFile(t, filepath.Join(root, "Chinese", "RJ12345 name", "track01.flac"))
	writeFile(t, filepath.Join(root, "RJ01", "RJ0123456 name", "track01.wav"))
	writeFile(t, filepath.Join(root, "RJ09", "RJ099999 name", "track01.ogg"))
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
		"RJ12345":   true,
		"RJ0123456": true,
		"RJ099999":  true,
		"RJ23456":   true,
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
		if work.Code == "RJ23456" && len(work.Files) != 3 {
			t.Fatalf("RJ23456 files = %d, want 3", len(work.Files))
		}
	}
}

func TestExtractWorkCodeAllowsSeparatorAndIgnoresShortBuckets(t *testing.T) {
	code, ambiguous := ExtractWorkCode("RJ 0123456 title")
	if code != "RJ0123456" || ambiguous {
		t.Fatalf("ExtractWorkCode returned %q, %v", code, ambiguous)
	}

	code, ambiguous = ExtractWorkCode("RJ01")
	if code != "" || ambiguous {
		t.Fatalf("ExtractWorkCode returned %q, %v for short bucket", code, ambiguous)
	}
}

func TestDiscoverFoldersIgnoresKikotoInternalTrees(t *testing.T) {
	root := t.TempDir()
	for _, relative := range []string{
		filepath.Join(".kikoto-staging", "12", "RJ01234567"),
		filepath.Join(".kikoto-backup", "12", "RJ07654321"),
		filepath.Join(".kikoto-trash", "fetch", "12", "RJ02222222"),
		filepath.Join("Library", "RJ01111111"),
	} {
		if err := os.MkdirAll(filepath.Join(root, relative), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	folders, _, err := DiscoverFolders(root, Options{ScanDepth: 4})
	if err != nil {
		t.Fatal(err)
	}
	if len(folders) != 1 || folders[0].Code != "RJ01111111" {
		t.Fatalf("folders = %+v", folders)
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
