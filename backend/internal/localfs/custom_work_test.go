package localfs

import (
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"

	"github.com/yexca/kikoto/backend/internal/testfixture"
)

func TestDiscoverCustomWorkCandidatesExcludesWorkFoldersAndTheirRelatives(t *testing.T) {
	root := t.TempDir()
	code := testfixture.WorkCode(testfixture.PrefixRJ, 0)
	writeFile(t, filepath.Join(root, "Example Work 1", "track01.mp3"))
	writeFile(t, filepath.Join(root, "Shelf", "Example Work 2", "track01.mp3"))
	writeFile(t, filepath.Join(root, "Collection", code+" Example Work", "Extras", "track01.mp3"))
	writeFile(t, filepath.Join(root, ".hidden", "Example Work 3", "track01.mp3"))
	writeFile(t, filepath.Join(root, ".kikoto-staging", "Example Work 4", "track01.mp3"))
	writeFile(t, filepath.Join(root, "Deep", "Level 2", "Level 3", "track01.mp3"))

	discovery, err := DiscoverCustomWorkCandidates(root, Options{ScanDepth: 2})
	if err != nil {
		t.Fatal(err)
	}
	got := []string{}
	for _, candidate := range discovery.Candidates {
		got = append(got, candidate.RelPath)
	}
	// Collection holds a work folder, Extras lies inside one, hidden and
	// Kikoto folders are skipped, and Level 3 is deeper than the scan.
	want := []string{"Deep", "Deep/Level 2", "Example Work 1", "Shelf", "Shelf/Example Work 2"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
	if !reflect.DeepEqual(discovery.Codes, map[string]bool{code: true}) {
		t.Fatalf("codes = %v, want %s", discovery.Codes, code)
	}
}

func TestDiscoverCustomWorkCandidatesLeavesOutUnreadableFoldersAndTheirAncestors(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("directory permissions are not enforced here")
	}
	root := t.TempDir()
	code := testfixture.WorkCode(testfixture.PrefixRJ, 1)
	writeFile(t, filepath.Join(root, "Example Work 1", "track01.mp3"))
	writeFile(t, filepath.Join(root, "Shelf", "Locked", code, "track01.mp3"))
	locked := filepath.Join(root, "Shelf", "Locked")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	discovery, err := DiscoverCustomWorkCandidates(root, Options{ScanDepth: 3})
	if err != nil {
		t.Fatalf("one unreadable folder stopped discovery: %v", err)
	}
	got := []string{}
	for _, candidate := range discovery.Candidates {
		got = append(got, candidate.RelPath)
	}
	// Locked may hold a work folder, so neither it nor Shelf, which would
	// carry it along, can become a custom work.
	if want := []string{"Example Work 1"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("candidates = %v, want %v", got, want)
	}
}
