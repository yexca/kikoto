package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestCachePathLockSerializesSameFinalPath(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{CacheRoot: t.TempDir()})
	firstRelease, err := server.acquireCachePathLock(context.Background(), "media/synthetic/RJ/000/RJ00000000/track.mp3")
	if err != nil {
		t.Fatal(err)
	}

	type result struct {
		release func()
		err     error
	}
	acquired := make(chan result, 1)
	go func() {
		release, acquireErr := server.acquireCachePathLock(context.Background(), filepath.FromSlash("media/synthetic/RJ/000/RJ00000000/track.mp3"))
		acquired <- result{release: release, err: acquireErr}
	}()

	select {
	case <-acquired:
		t.Fatal("second holder acquired the same cache path before the first released it")
	case <-time.After(50 * time.Millisecond):
	}
	firstRelease()

	select {
	case next := <-acquired:
		if next.err != nil {
			t.Fatal(next.err)
		}
		next.release()
	case <-time.After(time.Second):
		t.Fatal("second cache path holder did not acquire after release")
	}
}

func TestFindAvailableCacheLocationRejectsWrongSizedFile(t *testing.T) {
	db := openMigratedTestDB(t)
	cacheRoot := t.TempDir()
	server := NewServer(db, config.Config{CacheRoot: cacheRoot})
	cachePath := "media/synthetic/RJ/000/RJ00000042/track.mp3"
	targetPath := filepath.Join(cacheRoot, filepath.FromSlash(cachePath))
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(targetPath, []byte("bad"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`
		INSERT INTO work (id, primary_code, title) VALUES (901, 'RJ00000042', 'Synthetic size check');
		INSERT INTO file_source (id, code, display_name, source_type) VALUES (902, 'synthetic-size', 'Synthetic size source', 'kikoeru_compatible');
		INSERT INTO media_item (id, work_id, kind, title, fingerprint) VALUES (903, 901, 'audio', 'Track', 'synthetic-size-check');
		INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, size_bytes, availability)
		VALUES (904, 903, 902, 'cache', 'media/synthetic/RJ/000/RJ00000042/track.mp3', 8, 'available');
	`); err != nil {
		t.Fatal(err)
	}
	expectedSize := int64(8)
	if _, ok, err := server.findAvailableCacheLocation(context.Background(), 903, 902, cachePath, &expectedSize); err != nil {
		t.Fatal(err)
	} else if ok {
		t.Fatal("wrong-sized cache file was reported as available")
	}
}
