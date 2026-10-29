package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

const localMediaProbeBatchSize = 64

// localMediaProbe returns a file's duration and whether it has audio. An error
// wrapping errMediaProbeRejected is a definite failure for that file version.
type localMediaProbe func(context.Context, string) (int64, bool, error)

type localMediaProbeTarget struct {
	locationID   int64
	fileSourceID int64
	workID       int64
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
			if err := s.probeMissingLocalMedia(ctx, s.probeMediaMetadata); err != nil && ctx.Err() == nil {
				slog.Warn("probe pending local media", "error", err)
			}
		}
	}
}

func (s *Server) probeMissingLocalMedia(ctx context.Context, probe localMediaProbe) error {
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
		SELECT location.id, location.file_source_id, item.work_id, location.path, location.size_bytes, location.file_version, item.kind
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id > ? AND location.id <= ?
			AND location.location_type = 'local' AND location.availability = 'available'
			AND item.kind IN ('audio', 'video') AND location.size_bytes IS NOT NULL
			AND (location.file_version = '' OR location.duration_seconds IS NULL OR item.duration_seconds IS NULL OR item.has_audio IS NULL)
			AND (location.probe_failed_version IS NULL OR location.probe_failed_version <> location.file_version)
		ORDER BY location.id LIMIT ?
	`, afterID, lastID, localMediaProbeBatchSize)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	batch := make([]localMediaProbeTarget, 0, localMediaProbeBatchSize)
	for rows.Next() {
		var target localMediaProbeTarget
		if err := rows.Scan(&target.locationID, &target.fileSourceID, &target.workID, &target.file.RelPath, &target.file.SizeBytes, &target.file.FileVersion, &target.kind); err != nil {
			return nil, err
		}
		batch = append(batch, target)
	}
	return batch, rows.Err()
}

func (s *Server) probeLocalMediaTarget(ctx context.Context, target localMediaProbeTarget, probe localMediaProbe) error {
	allowed, err := s.localMediaPathInScanScope(ctx, target.workID, target.fileSourceID, target.file.RelPath)
	if err != nil || !allowed {
		return err
	}
	root, err := filepath.Abs(s.cfg.DataRoot)
	if err != nil {
		return err
	}
	file := target.file
	file.AbsPath, err = filepath.Abs(filepath.Join(root, filepath.FromSlash(file.RelPath)))
	if err != nil || !isPathWithinRoot(root, file.AbsPath) {
		return nil
	}
	// Probe the checked location itself, which holds no link.
	probePath, err := resolvePathWithinRoot(root, file.AbsPath)
	if err != nil {
		return nil
	}
	before, err := os.Stat(probePath)
	if err != nil || !before.Mode().IsRegular() || before.Size() != file.SizeBytes {
		return nil
	}
	file.FileVersion = localfs.FileVersion(before)
	if target.file.FileVersion != "" && target.file.FileVersion != file.FileVersion {
		return nil
	}
	duration, hasAudio, probeErr := probe(ctx, probePath)
	if probeErr != nil && !errors.Is(probeErr, errMediaProbeRejected) {
		// A timeout, cancellation, or busy probe says nothing about the file.
		return ctx.Err()
	}
	after, err := os.Stat(probePath)
	if err != nil || !os.SameFile(before, after) || localfs.FileVersion(after) != file.FileVersion {
		return nil
	}
	if probeErr != nil {
		return s.recordLocalMediaProbeFailure(ctx, target.locationID, file, target.file.FileVersion)
	}
	if target.kind == "audio" {
		hasAudio = true
	}
	allowed, err = s.localMediaPathInScanScope(ctx, target.workID, target.fileSourceID, file.RelPath)
	if err != nil || !allowed {
		return err
	}
	return s.updateLocalMediaMetadata(ctx, target.locationID, file, target.file.FileVersion, duration, hasAudio)
}

// recordLocalMediaProbeFailure remembers that the probe rejected this file
// version. The background probe skips the location until a scan records a
// different version, which clears the mark.
func (s *Server) recordLocalMediaProbeFailure(ctx context.Context, locationID int64, file localfs.LocalFile, expectedVersion string) error {
	_, err := s.db.ExecContext(ctx, `
		UPDATE media_file_location
		SET probe_failed_version = ?, file_version = ?
		WHERE id = ? AND location_type = 'local' AND path = ?
			AND size_bytes = ? AND file_version = ? AND availability = 'available'
	`, file.FileVersion, file.FileVersion, locationID, file.RelPath, file.SizeBytes, expectedVersion)
	return err
}
