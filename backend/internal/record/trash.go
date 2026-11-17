package record

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// TrashDir is where deleted record files go, relative to the record root. It
// stays on the root's filesystem so a deletion is a rename, and the scanner
// skips it. Kikoto never empties it.
const TrashDir = ".kikoto-trash/records"

var (
	// ErrRootOffline refuses a deletion while the record root is not online,
	// where the path may be an empty mount point or another disk.
	ErrRootOffline = errors.New("record root is not online")
	// ErrAssetNotDeletable refuses a file that is missing, is not a regular
	// file, or is reached through a link.
	ErrAssetNotDeletable = errors.New("record file cannot be deleted")
)

// TrashedAsset is a record file moved to the trash.
type TrashedAsset struct {
	Asset Asset
	// TrashPath is where the file now is, relative to the record root.
	TrashPath string
}

// TrashAsset moves one available record file into the record root's trash,
// keeping its relative path under a folder named for the time and the asset,
// and forgets the asset with every viewer's progress and state. It never
// follows a link: every component of the file's path and of the trash must be
// a plain directory, and the file a regular file.
func (s *Store) TrashAsset(ctx context.Context, id int64, now time.Time) (TrashedAsset, error) {
	root, err := s.EnsureRoot(ctx)
	if err != nil {
		return TrashedAsset{}, err
	}
	if root.State != "online" {
		return TrashedAsset{}, ErrRootOffline
	}
	asset, err := s.Asset(ctx, id)
	if err != nil {
		return TrashedAsset{}, err
	}
	if asset.Availability != "available" {
		return TrashedAsset{}, ErrAssetNotDeletable
	}
	base := filepath.Clean(s.root)
	source, err := plainFilePath(base, asset.RelativePath)
	if err != nil {
		return TrashedAsset{}, err
	}
	trashRel := path.Join(TrashDir, fmt.Sprintf("%s-%d", now.UTC().Format("20060102T150405Z"), asset.ID), filepath.ToSlash(asset.RelativePath))
	target, err := prepareTrashTarget(base, trashRel)
	if err != nil {
		return TrashedAsset{}, err
	}
	// The source is checked again right before the rename, closing most of the
	// window in which a component could be swapped for a link.
	if _, err := plainFilePath(base, asset.RelativePath); err != nil {
		return TrashedAsset{}, err
	}
	if err := os.Rename(source, target); err != nil {
		return TrashedAsset{}, fmt.Errorf("move record file to trash: %w", err)
	}
	if err := s.forgetAsset(ctx, asset.ID); err != nil {
		// The file goes back so the index still describes it.
		if restoreErr := os.Rename(target, source); restoreErr != nil {
			return TrashedAsset{}, errors.Join(err, fmt.Errorf("restore record file from trash: %w", restoreErr))
		}
		return TrashedAsset{}, err
	}
	return TrashedAsset{Asset: asset, TrashPath: trashRel}, nil
}

func (s *Store) forgetAsset(ctx context.Context, id int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, statement := range []string{
		`DELETE FROM record_asset_progress WHERE asset_id=?`,
		`DELETE FROM record_asset_state WHERE asset_id=?`,
		`DELETE FROM record_asset WHERE id=?`,
	} {
		if _, err := tx.ExecContext(ctx, statement, id); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// plainFilePath resolves rel under base when every directory on the way is a
// plain directory and rel itself a regular file.
func plainFilePath(base, rel string) (string, error) {
	target, parts, err := containedPath(base, rel)
	if err != nil || len(parts) == 0 {
		return "", ErrAssetNotDeletable
	}
	current := base
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return "", ErrAssetNotDeletable
		}
		last := index == len(parts)-1
		if (last && !info.Mode().IsRegular()) || (!last && info.Mode().Type() != fs.ModeDir) {
			return "", ErrAssetNotDeletable
		}
	}
	if err := resolvesInside(base, target); err != nil {
		return "", ErrAssetNotDeletable
	}
	return target, nil
}

// prepareTrashTarget creates the trash folders of rel under base, refusing
// any component that is not a plain directory, and returns the path the file
// moves to, which must not exist yet.
func prepareTrashTarget(base, rel string) (string, error) {
	target, parts, err := containedPath(base, rel)
	if err != nil || len(parts) == 0 {
		return "", fmt.Errorf("record trash path escapes root")
	}
	current := base
	for _, part := range parts[:len(parts)-1] {
		current = filepath.Join(current, part)
		if err := os.Mkdir(current, 0o755); err != nil && !errors.Is(err, os.ErrExist) {
			return "", err
		}
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		if info.Mode().Type() != fs.ModeDir {
			return "", fmt.Errorf("record trash folder is not a plain directory")
		}
	}
	if err := resolvesInside(base, filepath.Dir(target)); err != nil {
		return "", err
	}
	if _, err := os.Lstat(target); !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("record trash target already exists")
	}
	return target, nil
}

// containedPath joins rel to base and splits the result into the components
// below base; rel must stay inside base.
func containedPath(base, rel string) (string, []string, error) {
	target := filepath.Clean(filepath.Join(base, filepath.FromSlash(rel)))
	relative, err := filepath.Rel(base, target)
	if err != nil || relative == "." || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", nil, fmt.Errorf("record path escapes root")
	}
	return target, strings.Split(relative, string(filepath.Separator)), nil
}

func resolvesInside(base, target string) error {
	resolvedBase, err := filepath.EvalSymlinks(base)
	if err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(target)
	if err != nil {
		return err
	}
	rel, err := filepath.Rel(resolvedBase, resolved)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return fmt.Errorf("record path escapes root")
	}
	return nil
}
