package record

import (
	"context"
	"database/sql"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/storage/storagetest"
)

// sectionOf returns one section of a folder view.
func sectionOf(t *testing.T, view FolderView, section string) SectionPage {
	t.Helper()
	for _, page := range view.Sections {
		if page.Section == section {
			return page
		}
	}
	t.Fatalf("view has no %s section", section)
	return SectionPage{}
}

// pageNames names a section page's children, a folder with a trailing slash.
func pageNames(page SectionPage) []string {
	names := []string{}
	for _, folder := range page.Folders {
		names = append(names, folder.Name+"/")
	}
	for _, asset := range page.Assets {
		names = append(names, asset.Name)
	}
	return names
}

func TestScanIndexesTreeAndArtwork(t *testing.T) {
	store, _, _ := scannedStore(t, map[string]string{
		"artist1/trip/movie.mp4": "video", "artist1/trip/poster.jpg": string(tinyJPEG),
	})
	ctx := context.Background()
	root, err := store.FolderView(ctx, 0, SectionPageMax, 0)
	folders := sectionOf(t, root, SectionFolders).Folders
	if err != nil || len(folders) != 1 || len(root.Trail) != 0 {
		t.Fatalf("root = %+v, %v", root, err)
	}
	artist, err := store.FolderView(ctx, folders[0].ID, SectionPageMax, 0)
	childFolders := sectionOf(t, artist, SectionFolders).Folders
	if err != nil || len(childFolders) != 1 || !childFolders[0].HasPoster || childFolders[0].HasBackdrop {
		t.Fatalf("artist folders = %+v err %v", childFolders, err)
	}
	if _, _, err := store.ArtworkPath(ctx, childFolders[0].ID, "poster"); err != nil {
		t.Fatalf("poster artwork = %v", err)
	}
	trip, err := store.FolderView(ctx, childFolders[0].ID, SectionPageMax, 0)
	if err != nil {
		t.Fatal(err)
	}
	// The poster is the folder's artwork, never one of its photos.
	if videos, photos := pageNames(sectionOf(t, trip, SectionVideos)), sectionOf(t, trip, SectionPhotos); strings.Join(videos, " ") != "movie.mp4" || photos.Total != 0 {
		t.Fatalf("trip videos %v, photos %+v", videos, photos)
	}
	// The listing names the folder and the folders above it, below the root.
	if len(trip.Trail) != 2 || trip.Trail[0].Name != "artist1" || trip.Trail[1].Name != "trip" || !trip.Trail[1].HasPoster {
		t.Fatalf("trail = %+v", trip.Trail)
	}
}

// A folder's artwork is the first image in its role's order that is a real
// image; a file that only carries an image name is passed over.
func TestScanChoosesArtworkThatIsAnImage(t *testing.T) {
	store, _, _ := scannedStore(t, map[string]string{
		"trip/folder.jpg": "not an image", "trip/cover.jpg": string(tinyJPEG), "trip/fanart.jpg": "not an image",
		"trip/movie.mp4": "video",
	})
	ctx := context.Background()
	view, err := store.FolderView(ctx, 0, SectionPageMax, 0)
	folders := sectionOf(t, view, SectionFolders).Folders
	if err != nil || len(folders) != 1 || !folders[0].HasPoster || folders[0].HasBackdrop {
		t.Fatalf("root folders = %+v, %v", folders, err)
	}
	_, poster, err := store.ArtworkPath(ctx, folders[0].ID, "poster")
	if err != nil || poster.Name != "cover.jpg" {
		t.Fatalf("poster = %q, %v", poster.Name, err)
	}
	if _, _, err := store.ArtworkPath(ctx, folders[0].ID, "backdrop"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("backdrop error = %v", err)
	}
}

// A folder's files fall into the sections it shows: videos, photos without
// the folder's artwork, audio for the player, and the list of other files,
// which holds the audio files too. A video carries its same-name subtitle,
// WebVTT before SubRip.
func TestFolderViewSplitsFilesIntoSections(t *testing.T) {
	store, _, _ := scannedStore(t, map[string]string{
		"Day 2.mp4": "video", "Day 10.mp4": "video", "Day 2.srt": "s", "Day 2.vtt": "v", "day 10.SRT": "s",
		"beach.jpg": "image", "Poster.JPG": "image", "fanart.webp": "image",
		"Narration 10.mp3": "audio", "Narration 2.flac": "audio", "notes.nfo": "nfo", "Day 3.ass": "ass",
	})
	view, err := store.FolderView(context.Background(), 0, SectionPageMax, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		SectionFolders: "",
		SectionVideos:  "Day 2.mp4 Day 10.mp4",
		SectionPhotos:  "beach.jpg",
		SectionAudio:   "Narration 2.flac Narration 10.mp3",
		SectionFiles:   "Day 2.srt Day 2.vtt Day 3.ass day 10.SRT Narration 2.flac Narration 10.mp3 notes.nfo",
	}
	for section, names := range want {
		page := sectionOf(t, view, section)
		if got := strings.Join(pageNames(page), " "); got != names || page.Total != len(pageNames(page)) || page.Next != "" {
			t.Errorf("%s = %q (total %d, next %q), want %q", section, got, page.Total, page.Next, names)
		}
	}
	subtitles := []string{}
	for _, video := range sectionOf(t, view, SectionVideos).Assets {
		if video.Subtitle == nil {
			subtitles = append(subtitles, "-")
		} else {
			subtitles = append(subtitles, video.Subtitle.Name)
		}
	}
	if strings.Join(subtitles, " ") != "Day 2.vtt day 10.SRT" {
		t.Fatalf("subtitles = %v", subtitles)
	}
}

// A folder's children show in the order a listener reads the names, so each
// page is the next stretch of what the browser shows.
func TestFolderViewOrdersNamesNaturally(t *testing.T) {
	store, _, _ := scannedStore(t, map[string]string{
		"Disc 10/a.mp4": "video", "disc 2/a.mp4": "video", "第十話/a.mp4": "video", "第二話/a.mp4": "video",
		"Track10.mp4": "video", "track2.mp4": "video", "Track1.mp4": "video",
	})
	view, err := store.FolderView(context.Background(), 0, SectionPageMax, 0)
	if err != nil {
		t.Fatal(err)
	}
	names := append(pageNames(sectionOf(t, view, SectionFolders)), pageNames(sectionOf(t, view, SectionVideos))...)
	want := []string{"disc 2/", "Disc 10/", "第二話/", "第十話/", "Track1.mp4", "track2.mp4", "Track10.mp4"}
	if strings.Join(names, " ") != strings.Join(want, " ") {
		t.Fatalf("names = %v, want %v", names, want)
	}
}

// A catalog scanned before the store kept sort keys and artwork, as after an
// upgrade, lists in natural order with its artwork before any new scan.
func TestFolderViewFillsInDerivedFieldsOfAnEarlierCatalog(t *testing.T) {
	_, db, root := scannedStore(t, map[string]string{
		"trip/poster.jpg": string(tinyJPEG), "trip/Track10.mp4": "video", "trip/Track2.mp4": "video",
	})
	for _, statement := range []string{
		`UPDATE record_folder SET sort_key=NULL, poster_asset_id=NULL, backdrop_asset_id=NULL`,
		`UPDATE record_asset SET sort_key=NULL`,
		`UPDATE record_root SET derived_version=0`,
	} {
		if _, err := db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	upgraded := NewStore(db, root)
	ctx := context.Background()
	view, err := upgraded.FolderView(ctx, 0, SectionPageMax, 0)
	folders := sectionOf(t, view, SectionFolders).Folders
	if err != nil || len(folders) != 1 || !folders[0].HasPoster {
		t.Fatalf("root folders = %+v, %v", folders, err)
	}
	view, err = upgraded.FolderView(ctx, folders[0].ID, SectionPageMax, 0)
	if names := pageNames(sectionOf(t, view, SectionVideos)); err != nil || strings.Join(names, " ") != "Track2.mp4 Track10.mp4" {
		t.Fatalf("videos = %v, %v", names, err)
	}
}

// An upgraded catalog read while its disk is unmounted keeps the artwork it
// had, and chooses it again once the disk is back.
func TestDerivedFieldsKeepArtworkWhileTheRootIsOffline(t *testing.T) {
	_, db, root := scannedStore(t, map[string]string{"trip/poster.jpg": string(tinyJPEG), "trip/clip.mp4": "video"})
	if _, err := db.Exec(`UPDATE record_root SET derived_version=0`); err != nil {
		t.Fatal(err)
	}
	away := root + "-away"
	if err := os.Rename(root, away); err != nil {
		t.Fatal(err)
	}
	upgraded := NewStore(db, root)
	ctx := context.Background()
	view, err := upgraded.FolderView(ctx, 0, SectionPageMax, 0)
	folders := sectionOf(t, view, SectionFolders).Folders
	if err != nil || len(folders) != 1 || !folders[0].HasPoster {
		t.Fatalf("offline root folders = %+v, %v", folders, err)
	}
	if err := os.Rename(away, root); err != nil {
		t.Fatal(err)
	}
	if _, err := upgraded.FolderView(ctx, 0, SectionPageMax, 0); err != nil {
		t.Fatal(err)
	}
	var version int
	if err := db.QueryRow(`SELECT derived_version FROM record_root WHERE id=1`).Scan(&version); err != nil || version != derivedVersion {
		t.Fatalf("derived version once online = %d, %v", version, err)
	}
}

// A scan of an empty mount point left by an unmounted disk adds nothing and
// keeps every folder's artwork for when the disk is back.
func TestScanWithoutTheMarkerKeepsArtwork(t *testing.T) {
	store, db, root := scannedStore(t, map[string]string{"trip/poster.jpg": string(tinyJPEG), "trip/clip.mp4": "video"})
	poster := func() sql.NullInt64 {
		t.Helper()
		var id sql.NullInt64
		if err := db.QueryRow(`SELECT poster_asset_id FROM record_folder WHERE name='trip'`).Scan(&id); err != nil {
			t.Fatal(err)
		}
		return id
	}
	chosen := poster()
	if !chosen.Valid {
		t.Fatal("the scan chose no poster")
	}
	away := root + "-away"
	if err := os.Rename(root, away); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(root, 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	result, err := store.Scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.MissingMarked {
		t.Fatalf("scan of the empty mount point marked files missing: %+v", result)
	}
	if got := poster(); got != chosen {
		t.Fatalf("poster after scanning the empty mount point = %+v, want %+v", got, chosen)
	}
	if err := os.Remove(root); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(away, root); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	if got := poster(); got != chosen {
		t.Fatalf("poster once the disk is back = %+v, want %+v", got, chosen)
	}
}

// A section pages on its own: each page follows the cursor the previous one
// handed out, and the last page hands out none.
func TestListSectionPagesThroughEveryChild(t *testing.T) {
	store, _, _ := scannedStore(t, map[string]string{
		"e.mp4": "video", "b.mp4": "video", "a.mp4": "video", "d.mp4": "video", "c.mp4": "video",
		"x.jpg": "image", "folder/a.mp4": "video",
	})
	ctx := context.Background()
	names := []string{}
	pages := 0
	after := ""
	for {
		page, err := store.ListSection(ctx, 0, SectionVideos, after, 2, 0)
		if err != nil || page.Total != 5 {
			t.Fatalf("page after %q = %+v, %v", after, page, err)
		}
		names = append(names, pageNames(page)...)
		pages++
		if page.Next == "" {
			break
		}
		after = page.Next
	}
	if strings.Join(names, " ") != "a.mp4 b.mp4 c.mp4 d.mp4 e.mp4" || pages != 3 {
		t.Fatalf("videos = %v over %d pages", names, pages)
	}
	if _, err := store.ListSection(ctx, 0, "everything", "", 2, 0); !errors.Is(err, ErrUnknownSection) {
		t.Fatalf("unknown section error = %v", err)
	}
	if _, err := store.ListSection(ctx, 0, SectionVideos, "not a cursor", 2, 0); !errors.Is(err, ErrInvalidCursor) {
		t.Fatalf("invalid cursor error = %v", err)
	}
}

// A file opened in a viewer is placed in its section, so the viewer steps to
// files the browser has not listed yet.
func TestAssetSiblingsPlacesAFileInItsSection(t *testing.T) {
	store, db, _ := scannedStore(t, map[string]string{
		"a.jpg": "image", "b.jpg": "image", "c.jpg": "image", "cover.jpg": "image", "clip.mp4": "video", "notes.nfo": "nfo",
	})
	ctx := context.Background()
	siblings, err := store.AssetSiblings(ctx, assetID(t, db, "b.jpg"), 0)
	if err != nil || siblings.Section != SectionPhotos || siblings.Index != 1 || siblings.Total != 3 ||
		siblings.Previous == nil || siblings.Previous.Name != "a.jpg" || siblings.Next == nil || siblings.Next.Name != "c.jpg" {
		t.Fatalf("siblings = %+v, %v", siblings, err)
	}
	last, err := store.AssetSiblings(ctx, assetID(t, db, "c.jpg"), 0)
	if err != nil || last.Index != 2 || last.Next != nil {
		t.Fatalf("last = %+v, %v", last, err)
	}
	for _, name := range []string{"cover.jpg", "notes.nfo"} {
		if _, err := store.AssetSiblings(ctx, assetID(t, db, name), 0); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("%s siblings error = %v", name, err)
		}
	}
}

// A root whose marker is gone keeps its catalog: a scan adds what it finds
// and marks nothing missing, initializing is refused unless it asks for a new
// catalog, and restoring the marker brings the same catalog back online.
func TestRootWithoutItsMarkerKeepsItsCatalog(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "movie.mp4"), []byte("video"), 0o600); err != nil {
		t.Fatal(err)
	}
	db := storagetest.Open(t)
	store := NewStore(db, root)
	ctx := context.Background()
	if _, err := store.InitializeRoot(ctx, false); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Scan(ctx); err != nil {
		t.Fatal(err)
	}
	var identity string
	if err := db.QueryRow("SELECT marker_id FROM record_root WHERE id=1").Scan(&identity); err != nil {
		t.Fatal(err)
	}
	for _, step := range []func() error{
		func() error { return os.Remove(filepath.Join(root, markerName)) },
		func() error { return os.Remove(filepath.Join(root, "movie.mp4")) },
		func() error { return os.WriteFile(filepath.Join(root, "added.mp4"), []byte("added"), 0o600) },
	} {
		if err := step(); err != nil {
			t.Fatal(err)
		}
	}
	if state, err := store.EnsureRoot(ctx); err != nil || state.State != RootStateMarkerMissing {
		t.Fatalf("root without its marker = %+v, %v", state, err)
	}
	result, err := store.Scan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if result.MissingMarked || result.State != "complete" {
		t.Fatalf("scan without the marker marked files missing: %+v", result)
	}
	availability := func(name string) string {
		t.Helper()
		var value string
		if err := db.QueryRow("SELECT availability FROM record_asset WHERE name=?", name).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	if availability("movie.mp4") != "available" || availability("added.mp4") != "available" {
		t.Fatalf("assets after the scan: movie=%q added=%q", availability("movie.mp4"), availability("added.mp4"))
	}
	if _, err := store.InitializeRoot(ctx, false); !errors.Is(err, ErrRootFreshRequired) {
		t.Fatalf("initializing a root that lost its marker = %v, want ErrRootFreshRequired", err)
	}

	restored, err := store.RestoreMarker(ctx)
	if err != nil || restored.State != "online" {
		t.Fatalf("restore marker = %+v, %v", restored, err)
	}
	if id, found, err := readMarker(root); err != nil || !found || id != identity {
		t.Fatalf("restored marker = %q found=%v, %v; want the catalog identity %q", id, found, err, identity)
	}
	if availability("added.mp4") != "available" {
		t.Fatal("restoring the marker lost the catalog")
	}

	// A new catalog is an explicit choice.
	if err := os.Remove(filepath.Join(root, markerName)); err != nil {
		t.Fatal(err)
	}
	if state, err := store.InitializeRoot(ctx, true); err != nil || state.State != "online" {
		t.Fatalf("fresh initialization = %+v, %v", state, err)
	}
	var assets int
	if err := db.QueryRow("SELECT COUNT(*) FROM record_asset").Scan(&assets); err != nil || assets != 0 {
		t.Fatalf("assets after a fresh initialization = %d, %v", assets, err)
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
	if _, err := store.SaveProgress(ctx, 7, first, Progress{PositionSeconds: 60}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InitializeRoot(ctx, false); err != nil {
		t.Fatal(err)
	}
	if progress, err := store.Progress(ctx, 7, first); err != nil || progress.PositionSeconds != 60 {
		t.Fatalf("progress after initializing the same disk = %+v, %v", progress, err)
	}

	// Another initialized disk is mounted at the path. Initializing it without
	// asking for a new catalog is refused and keeps the catalog; a fresh
	// initialization starts a new one.
	if err := os.WriteFile(filepath.Join(root, "trip", "clip.mp4"), []byte("second"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := writeMarker(root, "00000000000000000000000000000001"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.InitializeRoot(ctx, false); !errors.Is(err, ErrRootFreshRequired) {
		t.Fatalf("initializing another disk without fresh = %v, want ErrRootFreshRequired", err)
	}
	if _, err := store.Asset(ctx, first); err != nil {
		t.Fatalf("a refused initialization lost the catalog: %v", err)
	}
	if state, err := store.InitializeRoot(ctx, true); err != nil || state.State != "online" {
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
	if state, err := store.InitializeRoot(ctx, false); err != nil || state.State != "online" {
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
	if _, err := NewStore(storagetest.Open(t), other).InitializeRoot(ctx, false); err != nil {
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
