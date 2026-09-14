package httpapi

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/yexca/kikoto/backend/internal/config"
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
	probe := func(_ context.Context, path string) (int64, bool, bool) {
		calls[path]++
		return 60, true, true
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
	if err := s.probeMissingLocalMedia(ctx, func(ctx context.Context, _ string) (int64, bool, bool) {
		cancel()
		<-ctx.Done()
		return 0, false, false
	}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled probe = %v", err)
	}
	if err := s.probeMissingLocalMedia(context.Background(), func(_ context.Context, path string) (int64, bool, bool) {
		if err := os.WriteFile(path, []byte("changed synthetic media"), 0o600); err != nil {
			t.Fatal(err)
		}
		return 60, true, true
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
	if err := s.probeMissingLocalMedia(context.Background(), func(context.Context, string) (int64, bool, bool) {
		t.Fatal("probed a path outside its indexed file boundary")
		return 0, false, false
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
		path := fmt.Sprintf("track-%d.mp3", index)
		if err := os.WriteFile(filepath.Join(s.cfg.DataRoot, path), []byte("media"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec("INSERT INTO media_item (id, work_id, kind, title) VALUES (?, 1, 'audio', 'Example Track')", index); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO media_file_location (id, media_item_id, file_source_id, location_type, path, size_bytes, availability)
			VALUES (?, ?, 1, 'local', ?, 5, 'available')`, index, index, path); err != nil {
			t.Fatal(err)
		}
	}
	return s
}
