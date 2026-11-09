package record

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

func TestScanIndexesTreeAndArtwork(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "artist1", "trip"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "artist1", "trip", "movie.mp4"), []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "artist1", "trip", "poster.jpg"), []byte("image"), 0o600); err != nil {
		t.Fatal(err)
	}

	db := storagetest.Open(t)
	store := NewStore(db, root)
	if _, err := store.InitializeRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	result, err := store.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "complete" || !result.MissingMarked {
		t.Fatalf("scan result = %+v", result)
	}
	folders, assets, err := store.ListTree(context.Background(), 0, 200)
	if err != nil || len(folders) != 1 || len(assets) != 0 {
		t.Fatalf("root tree = folders %d assets %d err %v", len(folders), len(assets), err)
	}
	childFolders, _, err := store.ListTree(context.Background(), folders[0].ID, 200)
	if err != nil || len(childFolders) != 1 {
		t.Fatalf("artist tree = folders %d err %v", len(childFolders), err)
	}
	_, _, err = store.ArtworkPath(context.Background(), childFolders[0].ID, "poster")
	if err != nil {
		t.Fatalf("poster artwork = %v", err)
	}
	_, assets, err = store.ListTree(context.Background(), childFolders[0].ID, 200)
	if err != nil || len(assets) != 2 {
		t.Fatalf("folder assets = %d err %v", len(assets), err)
	}
}

func TestOfflineRootDoesNotMarkAssetsMissing(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "movie.mp4"), []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	db := storagetest.Open(t)
	store := NewStore(db, root)
	if _, err := store.InitializeRoot(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Scan(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(root, markerName)); err != nil {
		t.Fatal(err)
	}
	result, err := store.Scan(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if result.State != "unconfigured" || result.MissingMarked {
		t.Fatalf("offline scan result = %+v", result)
	}
	var availability string
	if err := db.QueryRow("SELECT availability FROM record_asset WHERE kind='video'").Scan(&availability); err != nil {
		t.Fatal(err)
	}
	if availability != "available" {
		t.Fatalf("offline asset availability = %q", availability)
	}
}

func TestValidateImageFileRequiresMatchingSignature(t *testing.T) {
	path := filepath.Join(t.TempDir(), "poster.jpg")
	if err := os.WriteFile(path, []byte("not an image"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateImageFile(path, "image/jpeg"); err == nil {
		t.Fatal("invalid JPEG signature was accepted")
	}
	if err := os.WriteFile(path, []byte{0xff, 0xd8, 0xff, 0xd9}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := ValidateImageFile(path, "image/jpeg"); err != nil {
		t.Fatalf("valid JPEG signature rejected: %v", err)
	}
}
