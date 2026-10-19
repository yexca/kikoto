package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
	"github.com/yexca/kikoto/backend/internal/localfs"
)

func TestLocalMediaProbeBatchesOnlyPendingLocalFiles(t *testing.T) {
	s := newLocalProbeTestServer(t, localMediaProbeBatchSize+5)
	for _, query := range []string{
		"UPDATE media_file_location SET duration_seconds = 120 WHERE id = 1",
		"UPDATE media_item SET duration_seconds = 120 WHERE id = 1",
		"UPDATE media_file_location SET availability = 'missing' WHERE id = 2",
		"UPDATE media_file_location SET location_type = 'remote_stream' WHERE id = 3",
	} {
		if _, err := s.db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	calls := map[string]int{}
	probe := func(_ context.Context, path string) (int64, bool, error) {
		calls[path]++
		return 60, true, nil
	}
	if err := s.probeMissingLocalMedia(context.Background(), probe); err != nil {
		t.Fatal(err)
	}
	if len(calls) != localMediaProbeBatchSize+2 {
		t.Fatalf("probed %d files", len(calls))
	}
	for _, count := range calls {
		if count != 1 {
			t.Fatal("probed a file more than once")
		}
	}
	// A new indexing wakeup must not probe completed metadata again.
	if err := s.probeMissingLocalMedia(context.Background(), probe); err != nil {
		t.Fatal(err)
	}
	for _, count := range calls {
		if count != 1 {
			t.Fatal("re-probed completed metadata")
		}
	}
	var completed int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE duration_seconds = 60").Scan(&completed); err != nil {
		t.Fatal(err)
	}
	if completed != localMediaProbeBatchSize+2 {
		t.Fatalf("completed = %d", completed)
	}
}

func TestLocalMediaProbeCancellationAndChangedFile(t *testing.T) {
	s := newLocalProbeTestServer(t, 2)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if err := s.probeMissingLocalMedia(ctx, func(ctx context.Context, _ string) (int64, bool, error) {
		cancel()
		<-ctx.Done()
		return 0, false, ctx.Err()
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled probe = %v", err)
	}
	if err := s.probeMissingLocalMedia(context.Background(), func(_ context.Context, path string) (int64, bool, error) {
		if err := os.WriteFile(path, []byte("changed synthetic media"), 0o600); err != nil {
			t.Fatal(err)
		}
		return 60, true, nil
	}); err != nil {
		t.Fatal(err)
	}
	var completed int
	if err := s.db.QueryRow("SELECT COUNT(*) FROM media_file_location WHERE duration_seconds IS NOT NULL").Scan(&completed); err != nil {
		t.Fatal(err)
	}
	if completed != 0 {
		t.Fatal("published metadata from a changed or cancelled file")
	}
}

func TestLocalMediaProbeRemembersRejectedFileVersionsOnly(t *testing.T) {
	s := newLocalProbeTestServer(t, 2)
	calls := map[string]int{}
	probe := func(_ context.Context, path string) (int64, bool, error) {
		calls[filepath.Base(path)]++
		if filepath.Base(path) == "track-1.mp3" {
			return 0, false, fmt.Errorf("%w: synthetic corrupt file", errMediaProbeRejected)
		}
		return 0, false, errors.New("media probe timed out")
	}
	for range 2 {
		if err := s.probeMissingLocalMedia(context.Background(), probe); err != nil {
			t.Fatal(err)
		}
	}
	if calls["track-1.mp3"] != 1 {
		t.Fatalf("rejected file probed %d times, want once", calls["track-1.mp3"])
	}
	if calls["track-2.mp3"] != 2 {
		t.Fatalf("timed-out file probed %d times, want a retry on every pass", calls["track-2.mp3"])
	}

	// A scan that sees a new version of the rejected file clears the mark.
	path := filepath.Join(s.cfg.DataRoot, "RJ00000000", "track-1.mp3")
	if err := os.WriteFile(path, []byte("MEDIA"), 0o600); err != nil {
		t.Fatal(err)
	}
	future := time.Now().Add(time.Hour)
	if err := os.Chtimes(path, future, future); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := upsertDetectedLocation(context.Background(), tx, 1, 1, localfs.LocalFile{
		RelPath: "RJ00000000/track-1.mp3", SizeBytes: info.Size(), FileVersion: localfs.FileVersion(info),
	}); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err := s.probeMissingLocalMedia(context.Background(), func(_ context.Context, path string) (int64, bool, error) {
		calls[filepath.Base(path)]++
		return 60, true, nil
	}); err != nil {
		t.Fatal(err)
	}
	if calls["track-1.mp3"] != 2 {
		t.Fatal("a changed file version was not probed again")
	}
	var duration sql.NullInt64
	var failed sql.NullString
	if err := s.db.QueryRow("SELECT duration_seconds, probe_failed_version FROM media_file_location WHERE id = 1").Scan(&duration, &failed); err != nil {
		t.Fatal(err)
	}
	if duration.Int64 != 60 || failed.Valid {
		t.Fatalf("duration = %v, probe_failed_version = %v", duration, failed)
	}
}

func TestLocalMediaProbeWakeupsCoalesceAndStop(t *testing.T) {
	s := newLocalProbeTestServer(t, 0)
	var senders sync.WaitGroup
	for range 100 {
		senders.Go(s.requestLocalMediaProbe)
	}
	senders.Wait()
	if len(s.localMediaProbeSignal()) != 1 {
		t.Fatal("indexing burst did not coalesce")
	}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() { defer close(done); s.runLocalMediaProbeWorker(ctx) }()
	cancel()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("probe worker ignored shutdown")
	}
}

func TestLocalMediaProbeRejectsEscapingAndStalePaths(t *testing.T) {
	s := newLocalProbeTestServer(t, 2)
	if _, err := s.db.Exec("UPDATE media_file_location SET path = '../outside.mp3' WHERE id = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE media_file_location SET size_bytes = 900 WHERE id = 2"); err != nil {
		t.Fatal(err)
	}
	if err := s.probeMissingLocalMedia(context.Background(), func(context.Context, string) (int64, bool, error) {
		t.Fatal("probed a path outside its indexed file boundary")
		return 0, false, nil
	}); err != nil {
		t.Fatal(err)
	}
}

func newLocalProbeTestServer(t *testing.T, files int) *Server {
	t.Helper()
	db := openMigratedTestDB(t)
	s := NewServer(db, config.Config{DataRoot: t.TempDir()})
	for _, query := range []string{
		"INSERT INTO work (id, primary_code, title) VALUES (1, 'RJ00000000', 'Example Work')",
		"INSERT INTO file_source (id, code, display_name, source_type) VALUES (1, 'example_local', 'Example Local', 'local_folder')",
	} {
		if _, err := db.Exec(query); err != nil {
			t.Fatal(err)
		}
	}
	for index := 1; index <= files; index++ {
		path := fmt.Sprintf("RJ00000000/track-%d.mp3", index)
		if err := os.MkdirAll(filepath.Dir(filepath.Join(s.cfg.DataRoot, path)), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(s.cfg.DataRoot, path), []byte("media"), 0o600); err != nil {
			t.Fatal(err)
		}
		info, err := os.Stat(filepath.Join(s.cfg.DataRoot, path))
		if err != nil {
			t.Fatal(err)
		}
		version := localfs.FileVersion(info)
		if _, err := db.Exec("INSERT INTO media_item (id, work_id, kind, title, size_bytes, file_version, has_audio) VALUES (?, 1, 'audio', 'Example Track', 5, ?, 1)", index, version); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, size_bytes, file_version, availability)
			VALUES (?, ?, 1, 'local', ?, 5, ?, 'available')`, index, index, path, version); err != nil {
			t.Fatal(err)
		}
	}
	return s
}
