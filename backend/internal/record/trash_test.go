package record

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTrashAssetRefusesAFileReachedThroughALink(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"trip/clip.mp4": "video"})
	id := assetID(t, db, "clip.mp4")
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "clip.mp4"), []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	// The indexed folder is swapped for a link to a folder outside the root.
	if err := os.RemoveAll(filepath.Join(root, "trip")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "trip")); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	if _, err := store.TrashAsset(context.Background(), id, time.Now()); !errors.Is(err, ErrAssetNotDeletable) {
		t.Fatalf("trash through a link = %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "clip.mp4")); err != nil {
		t.Fatalf("file outside the root moved: %v", err)
	}
}

func TestTrashAssetKeepsTheRowOfAFileItCannotMove(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"clip.mp4": "video"})
	id := assetID(t, db, "clip.mp4")
	if err := os.Remove(filepath.Join(root, "clip.mp4")); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if _, err := store.TrashAsset(ctx, id, time.Now()); !errors.Is(err, ErrAssetNotDeletable) {
		t.Fatalf("trash of a vanished file = %v", err)
	}
	if _, err := store.Asset(ctx, id); err != nil {
		t.Fatalf("row of an unmoved file = %v", err)
	}
}

func TestTrashFolderRefusesAFolderReachedThroughALink(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"trip/day/clip.mp4": "video"})
	var id int64
	if err := db.QueryRow(`SELECT id FROM record_folder WHERE relative_path='trip/day'`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	if err := os.Mkdir(filepath.Join(outside, "day"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "trip")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "trip")); err != nil {
		t.Skipf("symbolic links are unavailable: %v", err)
	}
	moved := false
	if _, err := store.TrashFolder(context.Background(), id, time.Now(), func([]int64) { moved = true }); !errors.Is(err, ErrFolderNotDeletable) || moved {
		t.Fatalf("trash through a link = %v, before move ran %v", err, moved)
	}
	if _, err := os.Stat(filepath.Join(outside, "day")); err != nil {
		t.Fatalf("folder outside the root moved: %v", err)
	}
}
