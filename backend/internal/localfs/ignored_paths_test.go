package localfs

import (
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

func TestDiscoverSkipsNASAndOperatingSystemJunk(t *testing.T) {
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "RJ00000010", "01.mp3"))
	writeFile(t, filepath.Join(root, "RJ00000010", "._01.mp3"))
	writeFile(t, filepath.Join(root, "RJ00000010", ".DS_Store"))
	writeFile(t, filepath.Join(root, "RJ00000010", "Thumbs.db"))
	writeFile(t, filepath.Join(root, "RJ00000010", "__MACOSX", "._02.mp3"))
	writeFile(t, filepath.Join(root, "RJ00000010", "@eaDir", "01.mp3", "SYNOINDEX_MEDIA_INFO"))
	for _, junk := range []string{"@eaDir", "#recycle", "#snapshot", "__MACOSX", ".Trash-1000", "$RECYCLE.BIN", "System Volume Information", "lost+found"} {
		writeFile(t, filepath.Join(root, junk, "RJ00000011", "01.mp3"))
	}

	works, _, err := Discover(root, Options{ScanDepth: 3})
	if err != nil {
		t.Fatal(err)
	}
	if len(works) != 1 || works[0].Code != "RJ00000010" {
		t.Fatalf("works = %+v, want only RJ00000010", works)
	}
	if got := []string{works[0].Files[0].WorkRelPath}; len(works[0].Files) != 1 || got[0] != "01.mp3" {
		t.Fatalf("files = %+v, want only 01.mp3", works[0].Files)
	}

	changed, _, err := DiscoverChangedFolders(root, Options{ScanDepth: 3}, []string{"@eaDir/RJ00000011/01.mp3", "#recycle"})
	if err != nil {
		t.Fatal(err)
	}
	if len(changed) != 0 {
		t.Fatalf("changes inside ignored folders discovered %+v", changed)
	}
}

func TestIgnoredPathRecognizesDirectoriesAndSidecarFiles(t *testing.T) {
	for path, want := range map[string]bool{
		"pool/@eaDir/RJ00000012":            true,
		`pool\#Recycle\RJ00000012\01.wav`:   true,
		".trash-1000/RJ00000012":            true,
		"RJ00000012/__macosx/01.mp3":        true,
		"RJ00000012/._01.mp3":               true,
		"RJ00000012/thumbs.db":              true,
		"RJ00000012/01.mp3":                 false,
		"RJ00000012/recycle/01.mp3":         false,
		"RJ00000012/notes._draft.txt":       false,
		"RJ00000012/.DS_Store.backup/a.mp3": false,
	} {
		if got := IsIgnoredPath(path); got != want {
			t.Errorf("IsIgnoredPath(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestDiscoverSkipsUnreadableFoldersAndReportsThem(t *testing.T) {
	root := t.TempDir()
	folders := unreadableFolders{root: root}
	inside := filepath.Join(root, "locked", "RJ00000013")
	if err := folders.skip(filepath.Join(root, "locked"), fakeDirEntry{}, fs.ErrPermission); err != filepath.SkipDir {
		t.Fatalf("permission error = %v, want SkipDir", err)
	}
	if err := folders.skip(filepath.Join(root, "gone"), fakeDirEntry{}, &fs.PathError{Op: "open", Err: fs.ErrNotExist}); err != filepath.SkipDir {
		t.Fatalf("removed folder = %v, want SkipDir", err)
	}
	ioErr := &fs.PathError{Op: "readdirent", Err: fs.ErrClosed}
	if err := folders.skip(filepath.Join(root, "broken"), fakeDirEntry{}, ioErr); err != ioErr {
		t.Fatalf("other error = %v, want it returned", err)
	}
	if err := folders.skip(root, fakeDirEntry{}, fs.ErrPermission); err != fs.ErrPermission {
		t.Fatalf("unreadable root = %v, want it returned", err)
	}
	kept := folders.withoutCandidatesInside([]WorkFolder{{Code: "RJ00000013", AbsPath: inside}, {Code: "RJ00000014", AbsPath: filepath.Join(root, "RJ00000014")}})
	if len(kept) != 1 || kept[0].Code != "RJ00000014" {
		t.Fatalf("kept = %+v, want the readable work only", kept)
	}
	if got := folders.list(); !reflect.DeepEqual(got, []string{"gone", "locked"}) {
		t.Fatalf("unreadable folders = %v", got)
	}
}

func TestDiscoverContinuesPastAFolderWithoutPermission(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("directory permissions are not enforced here")
	}
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "RJ00000015", "01.mp3"))
	writeFile(t, filepath.Join(root, "lost+found-like", "RJ00000016", "01.mp3"))
	locked := filepath.Join(root, "lost+found-like")
	if err := os.Chmod(locked, 0); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(locked, 0o700) })

	works, summary, err := DiscoverFolders(root, Options{ScanDepth: 3})
	if err != nil {
		t.Fatalf("one unreadable folder stopped discovery: %v", err)
	}
	if len(works) != 1 || works[0].Code != "RJ00000015" {
		t.Fatalf("works = %+v", works)
	}
	if !reflect.DeepEqual(summary.UnreadableFolders, []string{"lost+found-like"}) {
		t.Fatalf("unreadable folders = %v", summary.UnreadableFolders)
	}
}

type fakeDirEntry struct{}

func (fakeDirEntry) Name() string               { return "folder" }
func (fakeDirEntry) IsDir() bool                { return true }
func (fakeDirEntry) Type() fs.FileMode          { return fs.ModeDir }
func (fakeDirEntry) Info() (fs.FileInfo, error) { return fakeDirInfo{}, nil }

type fakeDirInfo struct{}

func (fakeDirInfo) Name() string       { return "folder" }
func (fakeDirInfo) Size() int64        { return 0 }
func (fakeDirInfo) Mode() fs.FileMode  { return fs.ModeDir }
func (fakeDirInfo) ModTime() time.Time { return time.Time{} }
func (fakeDirInfo) IsDir() bool        { return true }
func (fakeDirInfo) Sys() any           { return nil }
