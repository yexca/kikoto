package record

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

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
	page, err := store.ListTree(context.Background(), 0, 0, TreePageMax, 0)
	folders, assets := page.Folders, page.Assets
	if err != nil || len(folders) != 1 || len(assets) != 0 {
		t.Fatalf("root tree = folders %d assets %d err %v", len(folders), len(assets), err)
	}
	page, err = store.ListTree(context.Background(), folders[0].ID, 0, TreePageMax, 0)
	childFolders := page.Folders
	if err != nil || len(childFolders) != 1 {
		t.Fatalf("artist tree = folders %d err %v", len(childFolders), err)
	}
	_, _, err = store.ArtworkPath(context.Background(), childFolders[0].ID, "poster")
	if err != nil {
		t.Fatalf("poster artwork = %v", err)
	}
	page, err = store.ListTree(context.Background(), childFolders[0].ID, 0, TreePageMax, 0)
	assets = page.Assets
	if err != nil || len(assets) != 2 {
		t.Fatalf("folder assets = %d err %v", len(assets), err)
	}
}

func TestListTreePagesThroughEveryChild(t *testing.T) {
	store, _, _ := scannedStore(t, map[string]string{
		"b/x.mp4": "video", "a/x.mp4": "video", "c/x.mp4": "video",
		"d.mp4": "video", "B.jpg": "image", "a.mp4": "video", "c.txt": "text",
	})
	ctx := context.Background()
	names := []string{}
	offsets := []int{}
	offset := 0
	for {
		page, err := store.ListTree(ctx, 0, offset, 3, 0)
		if err != nil || page.Total != 7 {
			t.Fatalf("page at %d = %+v, %v", offset, page, err)
		}
		for _, folder := range page.Folders {
			names = append(names, folder.Name+"/")
		}
		for _, asset := range page.Assets {
			names = append(names, asset.Name)
		}
		offsets = append(offsets, page.NextOffset)
		if page.NextOffset == 0 {
			break
		}
		offset = page.NextOffset
	}
	want := []string{"a/", "b/", "c/", "a.mp4", "B.jpg", "c.txt", "d.mp4"}
	if strings.Join(names, " ") != strings.Join(want, " ") || fmt.Sprint(offsets) != "[3 6 0]" {
		t.Fatalf("pages = %v with next offsets %v", names, offsets)
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

func TestAnotherInitializedDiskAtTheRootIsOffline(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"trip/clip.mp4": "video"})
	ctx := context.Background()
	// Another disk, initialized by another Kikoto, is mounted at the same path.
	if err := os.Remove(filepath.Join(root, "trip", "clip.mp4")); err != nil {
		t.Fatal(err)
	}
	if err := writeMarker(root, "00000000000000000000000000000001"); err != nil {
		t.Fatal(err)
	}
	result, err := store.Scan(ctx)
	if err != nil || result.State != "offline" || result.MissingMarked {
		t.Fatalf("scan of another disk = %+v, %v", result, err)
	}
	var availability string
	if err := db.QueryRow(`SELECT availability FROM record_asset WHERE name='clip.mp4'`).Scan(&availability); err != nil || availability != "available" {
		t.Fatalf("asset on the absent disk = %q, %v", availability, err)
	}
	if _, err := store.TrashFolder(ctx, 0, "trip", time.Now(), nil); !errors.Is(err, ErrRootOffline) {
		t.Fatalf("delete on another disk = %v", err)
	}
}

// Initializing the root again keeps its catalog; initializing it for another
// disk starts a new one, so the other disk's files never take over the earlier
// disk's assets or their progress by path.
func TestInitializingAnotherDiskStartsANewCatalog(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"trip/clip.mp4": "first"})
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO user_account(id,username,role,enabled) VALUES (7,'viewer','user',1)`); err != nil {
		t.Fatal(err)
	}
	first := assetID(t, db, "clip.mp4")
	var firstFolder int64
	if err := db.QueryRow(`SELECT id FROM record_folder WHERE name = 'trip'`).Scan(&firstFolder); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveProgress(ctx, 7, first, Progress{PositionSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InitializeRoot(ctx); err != nil {
		t.Fatal(err)
	}
	if progress, err := store.Progress(ctx, 7, first); err != nil || progress.PositionSeconds != 60 {
		t.Fatalf("progress after initializing the same disk = %+v, %v", progress, err)
	}

	// Another initialized disk is mounted at the path, and the administrator
	// initializes it.
	if err := os.WriteFile(filepath.Join(root, "trip", "clip.mp4"), []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeMarker(root, "00000000000000000000000000000001"); err != nil {
		t.Fatal(err)
	}
	if state, err := store.InitializeRoot(ctx); err != nil || state.State != "online" {
		t.Fatalf("initialize another disk = %+v, %v", state, err)
	}
	if _, err := store.Asset(ctx, first); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("earlier disk's asset before a scan = %v", err)
	}
	var assets, folders, progress int
	if err := db.QueryRow(`SELECT (SELECT COUNT(*) FROM record_asset), (SELECT COUNT(*) FROM record_folder), (SELECT COUNT(*) FROM record_asset_progress)`).Scan(&assets, &folders, &progress); err != nil {
		t.Fatal(err)
	}
	if assets != 0 || folders != 0 || progress != 0 {
		t.Fatalf("catalog after initializing another disk = %d assets, %d folders, %d progress", assets, folders, progress)
	}
	if _, err := store.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	second := assetID(t, db, "clip.mp4")
	if got, err := store.Progress(ctx, 7, second); err != nil || got.PositionSeconds != 0 {
		t.Fatalf("progress of the other disk's file = %+v, %v", got, err)
	}
	// The earlier disk's ids name nothing after the scan either.
	if _, err := store.Asset(ctx, first); second == first || !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("earlier disk's asset %d after a scan = %v (other disk's file is %d)", first, err, second)
	}
	var secondFolder int64
	if err := db.QueryRow(`SELECT id FROM record_folder WHERE name = 'trip'`).Scan(&secondFolder); err != nil {
		t.Fatal(err)
	}
	if secondFolder == firstFolder {
		t.Fatalf("other disk's folder reuses the earlier folder id %d", firstFolder)
	}
}

func TestInitializeGivesAnUnidentifiedMarkerAnIdentity(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, markerName), []byte(markerVersion+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	store := NewStore(storagetest.Open(t), root)
	ctx := context.Background()
	if state, err := store.EnsureRoot(ctx); err != nil || state.State != "unconfigured" {
		t.Fatalf("root with an unidentified marker = %+v, %v", state, err)
	}
	if state, err := store.InitializeRoot(ctx); err != nil || state.State != "online" {
		t.Fatalf("initialize = %+v, %v", state, err)
	}
	id, found, err := readMarker(root)
	if err != nil || !found || len(id) != 32 {
		t.Fatalf("marker after initialize = %q %v %v", id, found, err)
	}
	if state, err := store.EnsureRoot(ctx); err != nil || state.State != "online" {
		t.Fatalf("root after initialize = %+v, %v", state, err)
	}
	// Each root initialized afresh gets its own identity.
	other := t.TempDir()
	if _, err := NewStore(storagetest.Open(t), other).InitializeRoot(ctx); err != nil {
		t.Fatal(err)
	}
	if otherID, _, _ := readMarker(other); otherID == id || otherID == "" {
		t.Fatalf("identities = %q and %q", id, otherID)
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
