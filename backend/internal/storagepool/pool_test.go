package storagepool

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMarkerRoundTripAndCheck(t *testing.T) {
	dataRoot := t.TempDir()
	pool := Pool{Path: "disk1", ID: "pool-one"}
	if online, reason := Check(dataRoot, pool, pool.ID); online || reason != ReasonMissing {
		t.Fatalf("missing pool = %v %q", online, reason)
	}
	if err := os.Mkdir(Root(dataRoot, pool), 0o755); err != nil {
		t.Fatal(err)
	}
	// An empty mount point without a marker is offline, not an empty pool.
	if online, reason := Check(dataRoot, pool, pool.ID); online || reason != ReasonMarkerMissing {
		t.Fatalf("unmarked pool = %v %q", online, reason)
	}
	if err := WriteMarker(Root(dataRoot, pool), pool.ID); err != nil {
		t.Fatal(err)
	}
	if online, reason := Check(dataRoot, pool, pool.ID); !online || reason != "" {
		t.Fatalf("marked pool = %v %q", online, reason)
	}
	if online, reason := Check(dataRoot, pool, "another-pool"); online || reason != ReasonMarkerOther {
		t.Fatalf("another disk mounted at the pool = %v %q", online, reason)
	}
	if err := os.WriteFile(filepath.Join(Root(dataRoot, pool), MarkerName), []byte("{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	if online, reason := Check(dataRoot, pool, pool.ID); online || reason != ReasonMarkerInvalid {
		t.Fatalf("invalid marker = %v %q", online, reason)
	}
}

func TestCandidateDirectoriesSkipsHiddenEntriesAndFiles(t *testing.T) {
	dataRoot := t.TempDir()
	for _, name := range []string{"disk2", "disk1", ".kikoto-staging"} {
		if err := os.Mkdir(filepath.Join(dataRoot, name), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "notes.txt"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	names, err := CandidateDirectories(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 || names[0] != "disk1" || names[1] != "disk2" {
		t.Fatalf("candidates = %v", names)
	}
	visible, err := HasVisibleEntries(dataRoot)
	if err != nil || !visible {
		t.Fatalf("visible = %v, err = %v", visible, err)
	}
	onlyHidden := filepath.Join(dataRoot, "disk1")
	if err := os.Mkdir(filepath.Join(onlyHidden, ".kikoto-trash"), 0o755); err != nil {
		t.Fatal(err)
	}
	if visible, err := HasVisibleEntries(onlyHidden); err != nil || visible {
		t.Fatalf("hidden-only directory visible = %v, err = %v", visible, err)
	}
}

func TestSplitJoinAndNames(t *testing.T) {
	cases := []struct {
		mode, rel, pool, rest string
	}{
		{ModeStandard, "source/RJ_000/RJ00000001", "", "source/RJ_000/RJ00000001"},
		{ModePools, "disk1/source/RJ00000001", "disk1", "source/RJ00000001"},
		{ModePools, "disk1", "disk1", ""},
		{ModePools, "/disk1//source/", "disk1", "source"},
	}
	for _, item := range cases {
		pool, rest := Split(item.mode, item.rel)
		if pool != item.pool || rest != item.rest {
			t.Fatalf("Split(%q, %q) = %q, %q", item.mode, item.rel, pool, rest)
		}
	}
	if Join("", "a/b") != "a/b" || Join("disk1", "a/b") != "disk1/a/b" || Join("disk1", "") != "disk1" {
		t.Fatal("Join does not prefix pool paths")
	}
	if Depth("") != 0 || Depth("a") != 1 || Depth("a/b/c") != 3 {
		t.Fatal("Depth counts segments")
	}
	for _, name := range []string{"disk1", "Cloud Drive", "磁盘"} {
		if !ValidName(name) {
			t.Fatalf("%q should be a valid pool name", name)
		}
	}
	for _, name := range []string{"", ".hidden", "a/b", `a\b`, " padded", "..", "a:b"} {
		if ValidName(name) {
			t.Fatalf("%q should be rejected", name)
		}
	}
}

func TestProbeRenameLeavesNoFiles(t *testing.T) {
	dir := t.TempDir()
	if err := ProbeRename(dir); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 0 {
		t.Fatalf("probe left %d entries, err = %v", len(entries), err)
	}
}
