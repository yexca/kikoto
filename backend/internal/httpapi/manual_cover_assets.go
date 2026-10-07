package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/download"
)

var errManualCoverCandidate = errors.New("invalid manual cover candidate")

func (s *Server) copyManualCoverFromLocation(ctx context.Context, workID, locationID int64) (string, string, error) {
	var relPath, kind string
	var sourceID int64
	if locationID <= 0 {
		return "", "", errManualCoverCandidate
	}
	err := s.db.QueryRowContext(ctx, `
		SELECT location.path, item.kind, location.file_source_id
		FROM media_file_location AS location JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ? AND item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
	`, locationID, workID).Scan(&relPath, &kind, &sourceID)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", errManualCoverCandidate
	}
	if err != nil {
		return "", "", err
	}
	if kind != "image" || localFileKind(relPath) != "image" {
		return "", "", errManualCoverCandidate
	}
	allowed, err := s.localMediaPathInScanScope(ctx, workID, sourceID, relPath)
	if err != nil {
		return "", "", err
	}
	if !allowed {
		return "", "", errManualCoverCandidate
	}
	sourcePath, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		return "", "", errManualCoverCandidate
	}
	resolved, err := filepath.EvalSymlinks(sourcePath)
	root, rootErr := filepath.Abs(s.cfg.DataRoot)
	if err != nil || rootErr != nil || !isPathWithinRoot(root, resolved) {
		return "", "", errManualCoverCandidate
	}
	source, err := os.Open(sourcePath)
	if err != nil {
		return "", "", err
	}
	defer func() { _ = source.Close() }()
	before, err := source.Stat()
	if err != nil || !before.Mode().IsRegular() {
		return "", "", errManualCoverCandidate
	}
	directory := filepath.Join(s.cfg.CacheRoot, "manual")
	if err := os.MkdirAll(directory, 0o755); err != nil {
		return "", "", err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", "", err
	}
	asset := fmt.Sprintf("work-%d-cover-%s%s", workID, hex.EncodeToString(nonce[:]), strings.ToLower(filepath.Ext(relPath)))
	staged := filepath.Join(directory, "."+asset+".pending")
	defer func() { _ = os.Remove(staged) }()
	size := before.Size()
	if _, err := download.WriteFile(manualCoverReader{ctx, source}, size, staged, download.Options{MaxBytes: download.CoverMaxBytes, ExpectedBytes: &size}); err != nil {
		return "", "", err
	}
	after, err := os.Stat(sourcePath)
	if err != nil || !os.SameFile(before, after) || before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) {
		return "", "", errManualCoverCandidate
	}
	allowed, err = s.localMediaPathInScanScope(ctx, workID, sourceID, relPath)
	if err != nil {
		return "", "", err
	}
	if !allowed {
		return "", "", errManualCoverCandidate
	}
	if err := download.PublishCover(ctx, staged, filepath.Join(directory, asset), false); err != nil {
		return "", "", err
	}
	return asset, filepath.ToSlash(relPath), nil
}

type manualCoverReader struct {
	ctx context.Context
	io.Reader
}

func (reader manualCoverReader) Read(buf []byte) (int, error) {
	if err := reader.ctx.Err(); err != nil {
		return 0, err
	}
	return reader.Reader.Read(buf)
}

// Callers hold manualCoverMu, including startup's orphan sweep. A failure to
// check references leaves the file in place for a later cleanup attempt.
func (s *Server) removeUnreferencedManualAsset(asset string) error {
	if asset == "" || asset != filepath.Base(asset) || strings.Contains(asset, "..") {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var referenced bool
	if err := s.db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM work_manual_override WHERE asset_path = ?)", asset).Scan(&referenced); err != nil {
		slog.Warn("check manual asset references", "error", err)
		return err
	}
	if referenced {
		return nil
	}
	path := filepath.Join(s.cfg.CacheRoot, "manual", asset)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		slog.Warn("inspect unreferenced manual asset", "error", err)
		return err
	}
	if !info.Mode().IsRegular() {
		return nil
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("remove unreferenced manual asset", "error", err)
		return err
	}
	return nil
}

func (s *Server) cleanupUnreferencedManualAssets(ctx context.Context) error {
	s.manualCoverMu.Lock()
	defer s.manualCoverMu.Unlock()
	dir, err := os.Open(filepath.Join(s.cfg.CacheRoot, "manual"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer func() { _ = dir.Close() }()
	for {
		entries, err := dir.ReadDir(128)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		for _, entry := range entries {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := s.removeUnreferencedManualAsset(entry.Name()); err != nil {
				return err
			}
		}
		if errors.Is(err, io.EOF) {
			return nil
		}
	}
}
