package httpapi

import (
	"context"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

const localMediaProbeBatchSize = 64

type localMediaProbeTarget struct {
	locationID   int64
	fileSourceID int64
	kind         string
	file         localfs.LocalFile
}

func (s *Server) localMediaProbeSignal() chan struct{} {
	s.localMediaIndexMu.Lock()
	defer s.localMediaIndexMu.Unlock()
	if s.localMediaProbeWake == nil {
		s.localMediaProbeWake = make(chan struct{}, 1)
	}
	return s.localMediaProbeWake
}

// The database owns pending metadata; the channel only coalesces wakeups. A
// burst of indexing never retains file trees or creates waiting goroutines.
func (s *Server) requestLocalMediaProbe() {
	select {
	case s.localMediaProbeSignal() <- struct{}{}:
	default:
	}
}

func (s *Server) runLocalMediaProbeWorker(ctx context.Context) {
	if s.cfg.IsDemo() {
		return
	}
	wake := s.localMediaProbeSignal()
	s.requestLocalMediaProbe() // Recover missing metadata left by a previous stop.
	for {
		select {
		case <-ctx.Done():
			return
		case <-wake:
			if err := s.probeMissingLocalMedia(ctx, s.probeMediaMetadataSeconds); err != nil && ctx.Err() == nil {
				slog.Warn("probe pending local media", "error", err)
			}
		}
	}
}

func (s *Server) probeMissingLocalMedia(ctx context.Context, probe func(context.Context, string) (int64, bool, bool)) error {
	// Fix the pass boundary. Indexing during this pass leaves one wakeup for a
	// follow-up, including changes to locations already passed by the cursor.
	var lastID int64
	if err := s.db.QueryRowContext(ctx, "SELECT COALESCE(MAX(id), 0) FROM media_file_location").Scan(&lastID); err != nil {
		return err
	}
	var cursor int64
	for cursor < lastID {
		batch, err := s.loadLocalMediaProbeBatch(ctx, cursor, lastID)
		if err != nil || len(batch) == 0 {
			return err
		}
		for _, target := range batch {
			if err := ctx.Err(); err != nil {
				return err
			}
			cursor = target.locationID
			if err := s.probeLocalMediaTarget(ctx, target, probe); err != nil {
				return err
			}
		}
	}
	return nil
}

func (s *Server) loadLocalMediaProbeBatch(ctx context.Context, afterID, lastID int64) ([]localMediaProbeTarget, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.id, location.file_source_id, location.path, location.size_bytes, item.kind
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id > ? AND location.id <= ?
			AND location.location_type = 'local' AND location.availability = 'available'
			AND item.kind IN ('audio', 'video') AND location.size_bytes IS NOT NULL
			AND (location.duration_seconds IS NULL OR item.duration_seconds IS NULL)
		ORDER BY location.id LIMIT ?
	`, afterID, lastID, localMediaProbeBatchSize)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	batch := make([]localMediaProbeTarget, 0, localMediaProbeBatchSize)
	for rows.Next() {
		var target localMediaProbeTarget
		if err := rows.Scan(&target.locationID, &target.fileSourceID, &target.file.RelPath, &target.file.SizeBytes, &target.kind); err != nil {
			return nil, err
		}
		batch = append(batch, target)
	}
	return batch, rows.Err()
}

func (s *Server) probeLocalMediaTarget(ctx context.Context, target localMediaProbeTarget, probe func(context.Context, string) (int64, bool, bool)) error {
	root, err := filepath.Abs(s.cfg.DataRoot)
	if err != nil {
		return err
	}
	file := target.file
	file.AbsPath, err = filepath.Abs(filepath.Join(root, filepath.FromSlash(file.RelPath)))
	if err != nil || !isPathWithinRoot(root, file.AbsPath) {
		return nil
	}
	resolved, err := filepath.EvalSymlinks(file.AbsPath)
	if err != nil || !isPathWithinRoot(root, resolved) {
		return nil
	}
	before, err := os.Stat(file.AbsPath)
	if err != nil || !before.Mode().IsRegular() || before.Size() != file.SizeBytes {
		return nil
	}
	duration, hasAudio, ok := probe(ctx, file.AbsPath)
	if !ok {
		return ctx.Err()
	}
	after, err := os.Stat(file.AbsPath)
	if err != nil || after.Size() != before.Size() || !after.ModTime().Equal(before.ModTime()) {
		return nil
	}
	if target.kind == "audio" {
		hasAudio = true
	}
	return s.updateLocalMediaMetadata(ctx, target.fileSourceID, file, duration, hasAudio)
}
