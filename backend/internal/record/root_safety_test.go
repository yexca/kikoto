package record

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A root whose path is gone, as when its disk is unmounted, is never
// initialized over its catalog without an explicit fresh initialization.
func TestInitializingAnOfflineRootKeepsItsCatalog(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"trip/clip.mp4": "video"})
	ctx := context.Background()
	if err := os.Rename(root, root+"-unmounted"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InitializeRoot(ctx, false); !errors.Is(err, ErrRootFreshRequired) {
		t.Fatalf("initializing an offline root = %v, want ErrRootFreshRequired", err)
	}
	// Nor does a fresh initialization make a new catalog where the disk is not.
	if _, err := store.InitializeRoot(ctx, true); !errors.Is(err, ErrRootPathMissing) {
		t.Fatalf("fresh initialization of a missing root = %v, want ErrRootPathMissing", err)
	}
	if _, err := os.Stat(root); !os.IsNotExist(err) {
		t.Fatalf("a refused initialization created the root path: %v", err)
	}
	var assets int
	if err := db.QueryRow(`SELECT COUNT(*) FROM record_asset`).Scan(&assets); err != nil || assets != 1 {
		t.Fatalf("catalog after a refused initialization = %d assets, %v", assets, err)
	}
}

// Restoring the marker needs the catalog's disk: an empty mount point without
// any recorded folder or file is refused, so it never goes online over the
// catalog and has every file marked missing.
func TestRestoreMarkerRefusesAnEmptyMountPoint(t *testing.T) {
	store, _, root := scannedStore(t, map[string]string{"trip/clip.mp4": "video"})
	ctx := context.Background()
	if err := os.Rename(root, root+"-unmounted"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if state, err := store.EnsureRoot(ctx); err != nil || state.State != RootStateMarkerMissing {
		t.Fatalf("empty mount point = %+v, %v", state, err)
	}
	if _, err := store.RestoreMarker(ctx); !errors.Is(err, ErrRootNotRecognized) {
		t.Fatalf("restoring onto an empty mount point = %v, want ErrRootNotRecognized", err)
	}
	if _, found, _ := readMarker(root); found {
		t.Fatal("a refused restore wrote a marker")
	}
}

// A fresh initialization never makes a new catalog on an empty mount point
// while the catalog records files: the disk may only be unmounted, and its
// files keep everyone's progress and states. A folder with files of its own
// may start a new catalog.
func TestFreshInitializationRefusesAnEmptyMountPoint(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"trip/clip.mp4": "video"})
	ctx := context.Background()
	if err := os.Rename(root, root+"-unmounted"); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, ".kikoto-trash"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InitializeRoot(ctx, true); !errors.Is(err, ErrRootEmpty) {
		t.Fatalf("fresh initialization of an empty mount point = %v, want ErrRootEmpty", err)
	}
	if _, found, _ := readMarker(root); found {
		t.Fatal("a refused initialization wrote a marker")
	}
	var assets int
	if err := db.QueryRow(`SELECT COUNT(*) FROM record_asset`).Scan(&assets); err != nil || assets != 1 {
		t.Fatalf("catalog after a refused initialization = %d assets, %v", assets, err)
	}
	if err := os.WriteFile(filepath.Join(root, "other.mp4"), []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	if state, err := store.InitializeRoot(ctx, true); err != nil || state.State != "online" {
		t.Fatalf("fresh initialization of a folder with files = %+v, %v", state, err)
	}
}
