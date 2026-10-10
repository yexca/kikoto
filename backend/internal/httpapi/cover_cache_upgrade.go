package httpapi

import (
	"context"
	"errors"
	"github.com/yexca/kikoto/backend/internal/download"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

func (s *Server) hasCachedWorkCover(code string) (bool, error) {
	for _, extension := range []string{".jpg", ".jpeg", ".png", ".webp"} {
		info, err := os.Lstat(filepath.Join(s.cfg.CacheRoot, "cover", filepath.FromSlash(coverAssetRelativePath(code, extension))))
		if err == nil {
			return info.Mode().IsRegular(), nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	}
	return false, nil
}

// Move only legacy flat raster covers. Existing nested provider covers win;
// interrupted moves are safe to retry before the completion marker is saved.
func (s *Server) migrateFlatCoverCache(ctx context.Context) error {
	var done bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM app_setting WHERE key = 'cover_layout_version' AND value_json = '1')`).Scan(&done); err != nil {
		return err
	}
	if done {
		return nil
	}
	root := filepath.Join(s.cfg.CacheRoot, "cover")
	entries, err := os.ReadDir(root)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	failures := []error{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !entry.Type().IsRegular() {
			continue
		}
		ext := strings.ToLower(filepath.Ext(entry.Name()))
		if ext != ".jpg" && ext != ".jpeg" && ext != ".png" && ext != ".webp" {
			continue
		}
		code := normalizeWorkCode(strings.TrimSuffix(entry.Name(), filepath.Ext(entry.Name())))
		if code == "" {
			continue
		}

		if err := s.migrateFlatCoverFile(ctx, root, entry.Name(), code, ext); err != nil {
			failures = append(failures, err)
			slog.Error("legacy cover migration failed", "work_code", code, "error", err)
		}
	}
	if len(failures) > 0 {
		return errors.Join(failures...)
	}
	_, err = s.db.ExecContext(ctx, `INSERT INTO app_setting (key, value_json) VALUES ('cover_layout_version', '1') ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`)
	return err
}

func (s *Server) migrateFlatCoverFile(ctx context.Context, root, name, code, ext string) error {
	if exists, err := s.hasCachedWorkCover(code); err != nil {
		return err
	} else if exists {
		return nil
	}
	target := filepath.Join(root, filepath.FromSlash(coverAssetRelativePath(code, ext)))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return err
	}
	return download.PublishCover(ctx, filepath.Join(root, name), target, false)
}
