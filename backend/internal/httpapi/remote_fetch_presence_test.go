package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

// A Fetch that publishes a file a scan already recorded keeps the location on
// the item that holds it, whichever item the plan names.
func TestFetchRegistrationKeepsRecordedPathOnItsMediaItem(t *testing.T) {
	ctx := context.Background()
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	target := "Library/RJ00000000/track.mp3"
	if err := os.MkdirAll(filepath.Join(dataRoot, "Library", "RJ00000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, filepath.FromSlash(target)), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	workID, err := sqlutil.InsertID(ctx, db, `INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Example Work')`)
	if err != nil {
		t.Fatal(err)
	}
	localSourceID, err := sqlutil.InsertID(ctx, db, `INSERT INTO file_source (code, display_name, source_type, enabled)
		VALUES ('local', 'Local', 'local_folder', 1)`)
	if err != nil {
		t.Fatal(err)
	}
	recordedID, err := sqlutil.InsertID(ctx, db, `INSERT INTO media_item (work_id, kind, title, fingerprint)
		VALUES (?, 'audio', 'track', 'local:RJ00000000:track.mp3')`, workID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'local', ?, 'available')`, recordedID, localSourceID, target); err != nil {
		t.Fatal(err)
	}
	plannedID, err := sqlutil.InsertID(ctx, db, `INSERT INTO media_item (work_id, kind, title, fingerprint)
		VALUES (?, 'audio', 'track.mp3', 'remote:9:RJ00000000:track.mp3')`, workID)
	if err != nil {
		t.Fatal(err)
	}
	item := remoteWorkSavePlanItem{Path: "track.mp3", Kind: "audio", TargetPath: target, MediaItemID: plannedID}
	if err := server.upsertSavedLocalLocation(ctx, workID, localSourceID, item, filepath.Join(dataRoot, filepath.FromSlash(target))); err != nil {
		t.Fatal(err)
	}

	var locations int
	var holderID int64
	if err := db.QueryRow(`SELECT COUNT(*), MIN(media_item_id) FROM media_file_location WHERE location_type = 'local' AND path = ?`, target).Scan(&locations, &holderID); err != nil {
		t.Fatal(err)
	}
	if locations != 1 || holderID != recordedID {
		t.Fatalf("registration = %d locations held by %d, want 1 held by %d", locations, holderID, recordedID)
	}
}

// A scan that records a published file while a Fetch registers it leaves one
// location: registration resolves the path's item in its own write
// transaction, after the scan commits.
func TestFetchRegistrationWaitsForAScanRecordingThePath(t *testing.T) {
	ctx := context.Background()
	db := openMigratedTestDB(t)
	dataRoot := t.TempDir()
	server := NewServer(db, config.Config{DataRoot: dataRoot, LocalScanDepth: 2})
	target := "Library/RJ00000000/track.mp3"
	if err := os.MkdirAll(filepath.Join(dataRoot, "Library", "RJ00000000"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, filepath.FromSlash(target)), []byte("audio"), 0o644); err != nil {
		t.Fatal(err)
	}
	workID, err := sqlutil.InsertID(ctx, db, `INSERT INTO work (primary_code, title) VALUES ('RJ00000000', 'Example Work')`)
	if err != nil {
		t.Fatal(err)
	}
	localSourceID, err := sqlutil.InsertID(ctx, db, `INSERT INTO file_source (code, display_name, source_type, enabled)
		VALUES ('local', 'Local', 'local_folder', 1)`)
	if err != nil {
		t.Fatal(err)
	}
	plannedID, err := sqlutil.InsertID(ctx, db, `INSERT INTO media_item (work_id, kind, title, fingerprint)
		VALUES (?, 'audio', 'track.mp3', 'remote:9:RJ00000000:track.mp3')`, workID)
	if err != nil {
		t.Fatal(err)
	}

	scan, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = scan.Rollback() }()
	scannedID, err := sqlutil.InsertID(ctx, scan, `INSERT INTO media_item (work_id, kind, title, fingerprint)
		VALUES (?, 'audio', 'track', 'local:RJ00000000:track.mp3')`, workID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := scan.ExecContext(ctx, `INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, availability)
		VALUES (?, ?, 'local', ?, 'available')`, scannedID, localSourceID, target); err != nil {
		t.Fatal(err)
	}
	registered := make(chan error, 1)
	go func() {
		item := remoteWorkSavePlanItem{Path: "track.mp3", Kind: "audio", TargetPath: target, MediaItemID: plannedID}
		registered <- server.upsertSavedLocalLocation(ctx, workID, localSourceID, item, filepath.Join(dataRoot, filepath.FromSlash(target)))
	}()
	// Registration starts while the scan holds the write transaction.
	time.Sleep(200 * time.Millisecond)
	if err := scan.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := <-registered; err != nil {
		t.Fatal(err)
	}

	var locations int
	var holderID int64
	if err := db.QueryRow(`SELECT COUNT(*), MIN(media_item_id) FROM media_file_location WHERE location_type = 'local' AND path = ?`, target).Scan(&locations, &holderID); err != nil {
		t.Fatal(err)
	}
	if locations != 1 || holderID != scannedID {
		t.Fatalf("registration = %d locations held by %d, want 1 held by %d", locations, holderID, scannedID)
	}
}
