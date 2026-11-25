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

// TrashDir is where deleted record files and folders go, relative to the
// record root. It stays on the root's filesystem so a deletion is a rename,
// and the scanner skips it. Kikoto never empties it.
const TrashDir = ".kikoto-trash/records"

var (
	// ErrRootOffline refuses a deletion, or a media details pass, while the
	// record root is not online, where the path may be an empty mount point or
	// another disk.
	ErrRootOffline = errors.New("record root is not online")
	// ErrAssetNotDeletable refuses a file that is missing, is not a regular
	// file, or is reached through a link.
	ErrAssetNotDeletable = errors.New("record file cannot be deleted")
	// ErrFolderNotDeletable refuses the root folder, a missing folder, and a
	// folder that is reached through a link or is not a plain directory.
	ErrFolderNotDeletable = errors.New("record folder cannot be deleted")
	// ErrItemChanged refuses a deletion whose id names another path than the
	// one the viewer confirmed.
	ErrItemChanged = errors.New("record item changed since it was confirmed")
)

// ConfirmedPath reports whether the path a viewer confirmed is the indexed
// path of the item.
func ConfirmedPath(indexed, expected string) bool {
	expected = strings.TrimSpace(expected)
	return expected != "" && path.Clean(filepath.ToSlash(expected)) == path.Clean(filepath.ToSlash(indexed))
}

// TrashedAsset is a record file moved to the trash.
type TrashedAsset struct {
	Asset Asset
	// TrashPath is where the file now is, relative to the record root.
	TrashPath string
}

// TrashedFolder is a record folder moved to the trash with everything in it.
type TrashedFolder struct {
	FolderID int64
	// AssetIDs are the indexed files the folder held, at any depth.
	AssetIDs []int64
	// TrashPath is where the folder now is, relative to the record root.
	TrashPath string
}

// TrashAsset moves one available record file into the record root's trash,
// keeping its relative path under a folder named for the time and the file,
// and forgets the asset with every viewer's progress and state. It never
// follows a link: every component of the file's path and of the trash must be
// a plain directory, and the file a regular file. expectedPath is the
// relative path the viewer confirmed; another path under the same id is
// refused.
func (s *Store) TrashAsset(ctx context.Context, id int64, expectedPath string, now time.Time) (TrashedAsset, error) {
	unlock, err := s.lockCatalog(ctx)
	if err != nil {
		return TrashedAsset{}, err
	}
	defer unlock()
	if err := s.RequireOnline(ctx); err != nil {
		return TrashedAsset{}, err
	}
	asset, err := s.Asset(ctx, id)
	if err != nil {
		return TrashedAsset{}, err
	}
	if !ConfirmedPath(asset.RelativePath, expectedPath) {
		return TrashedAsset{}, ErrItemChanged
	}
	if asset.Availability != "available" {
		return TrashedAsset{}, ErrAssetNotDeletable
	}
	trashRel, err := s.moveToTrash(asset.RelativePath, fmt.Sprintf("file-%d", asset.ID), false, now, func() error {
		return s.forget(ctx, []string{
			`DELETE FROM record_asset_progress WHERE asset_id=?`,
			`DELETE FROM record_asset_state WHERE asset_id=?`,
			`DELETE FROM record_asset WHERE id=?`,
		}, asset.ID)
	})
	if err != nil {
		return TrashedAsset{}, err
	}
	if asset.Kind == "image" {
		// An image that was the folder's poster or backdrop leaves the role to
		// the next candidate. The file is already in the trash, so a failure
		// here only leaves the role empty until the next scan.
		_ = s.refreshFolderArtwork(ctx, asset.FolderID)
	}
	return TrashedAsset{Asset: asset, TrashPath: trashRel}, nil
}

// FolderAssetIDs lists the indexed files a folder holds at any depth.
func (s *Store) FolderAssetIDs(ctx context.Context, folderID int64) ([]int64, error) {
	var key string
	if err := s.db.QueryRowContext(ctx, `SELECT path_key FROM record_folder WHERE id=? AND root_id=1`, folderID).Scan(&key); err != nil {
		return nil, err
	}
	low, high := subtreeBounds(key)
	rows, err := s.db.QueryContext(ctx, `SELECT id FROM record_asset WHERE root_id=1 AND path_key>=? AND path_key<?`, low, high)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// TrashFolder moves one active record folder, other than the root, into the
// record root's trash with everything in it, under a folder named for the
// time and the folder, and forgets its subfolders and files with every
// viewer's progress and state. Every component of the folder's path must be
// a plain directory; what the folder holds moves with it and is never
// followed. beforeMove runs with the files the folder holds once the folder
// may be deleted, before it moves. expectedPath is the relative path the
// viewer confirmed; another path under the same id is refused.
func (s *Store) TrashFolder(ctx context.Context, id int64, expectedPath string, now time.Time, beforeMove func(assetIDs []int64)) (TrashedFolder, error) {
	unlock, err := s.lockCatalog(ctx)
	if err != nil {
		return TrashedFolder{}, err
	}
	defer unlock()
	if err := s.RequireOnline(ctx); err != nil {
		return TrashedFolder{}, err
	}
	var rel, key, state string
	if err := s.db.QueryRowContext(ctx, `SELECT relative_path, path_key, state FROM record_folder WHERE id=? AND root_id=1`, id).Scan(&rel, &key, &state); err != nil {
		return TrashedFolder{}, err
	}
	if !ConfirmedPath(rel, expectedPath) {
		return TrashedFolder{}, ErrItemChanged
	}
	if key == "." || state != "active" {
		return TrashedFolder{}, ErrFolderNotDeletable
	}
	if _, err := plainPath(filepath.Clean(s.root), rel, true); err != nil {
		return TrashedFolder{}, ErrFolderNotDeletable
	}
	assetIDs, err := s.FolderAssetIDs(ctx, id)
	if err != nil {
		return TrashedFolder{}, err
	}
	if beforeMove != nil {
		beforeMove(assetIDs)
	}
	low, high := subtreeBounds(key)
	trashRel, err := s.moveToTrash(rel, fmt.Sprintf("folder-%d", id), true, now, func() error {
		return s.forget(ctx, []string{
			`DELETE FROM record_asset_progress WHERE asset_id IN (SELECT id FROM record_asset WHERE root_id=1 AND path_key>=?2 AND path_key<?3)`,
			`DELETE FROM record_asset_state WHERE asset_id IN (SELECT id FROM record_asset WHERE root_id=1 AND path_key>=?2 AND path_key<?3)`,
			`DELETE FROM record_asset WHERE root_id=1 AND path_key>=?2 AND path_key<?3`,
			`DELETE FROM record_folder WHERE root_id=1 AND (id=?1 OR (path_key>=?2 AND path_key<?3))`,
		}, id, low, high)
	})
	if err != nil {
		return TrashedFolder{}, err
	}
	return TrashedFolder{FolderID: id, AssetIDs: assetIDs, TrashPath: trashRel}, nil
}

// subtreeBounds are the path keys below a folder's key: every key that starts
// with the key and a slash sorts between them, since "0" follows "/".
func subtreeBounds(key string) (string, string) {
	return key + "/", key + "0"
}

// RequireOnline refuses with ErrRootOffline unless the root is online, the
// only state in which a file read at its path is the catalog's: an offline
// root may be an empty mount point or another disk, and one without its
// marker proves neither. Deletions, media details, and new thumbnails need it.
func (s *Store) RequireOnline(ctx context.Context) error {
	root, err := s.EnsureRoot(ctx)
	if err != nil {
		return err
	}
	if root.State != "online" {
		return ErrRootOffline
	}
	return nil
}

// moveToTrash renames rel, a regular file or a plain directory below the
// record root, into the trash under a folder named for the time and name,
// keeping rel below it, then runs forget. When forget fails, the item moves
// back so the index still describes it.
func (s *Store) moveToTrash(rel, name string, directory bool, now time.Time, forget func() error) (string, error) {
	refused := ErrAssetNotDeletable
	if directory {
		refused = ErrFolderNotDeletable
	}
	base := filepath.Clean(s.root)
	source, err := plainPath(base, rel, directory)
	if err != nil {
		return "", refused
	}
	trashRel := path.Join(TrashDir, now.UTC().Format("20060102T150405Z")+"-"+name, filepath.ToSlash(rel))
	target, err := prepareTrashTarget(base, trashRel)
	if err != nil {
		return "", err
	}
	// The source is checked again right before the rename, closing most of the
	// window in which a component could be swapped for a link.
	if _, err := plainPath(base, rel, directory); err != nil {
		return "", refused
	}
	if err := os.Rename(source, target); err != nil {
		return "", fmt.Errorf("move record item to trash: %w", err)
	}
	if err := forget(); err != nil {
		if restoreErr := os.Rename(target, source); restoreErr != nil {
			return "", errors.Join(err, fmt.Errorf("restore record item from trash: %w", restoreErr))
		}
		return "", err
	}
	return trashRel, nil
}

// forget runs statements in one transaction with the same arguments.
func (s *Store) forget(ctx context.Context, statements []string, args ...any) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, statement := range statements {
		if _, err := tx.ExecContext(ctx, statement, args...); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// plainPath resolves rel under base when every directory on the way is a
// plain directory and rel itself a plain directory or a regular file.
func plainPath(base, rel string, directory bool) (string, error) {
	target, parts, err := containedPath(base, rel)
	if err != nil || len(parts) == 0 {
		return "", errors.New("record path escapes root")
	}
	current := base
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return "", err
		}
		last := index == len(parts)-1
		plainDir := info.Mode().Type() == fs.ModeDir
		if (last && !directory && !info.Mode().IsRegular()) || ((!last || directory) && !plainDir) {
			return "", errors.New("record path is not plain")
		}
	}
	if err := resolvesInside(base, target); err != nil {
		return "", err
	}
	return target, nil
}

// prepareTrashTarget creates the trash folders of rel under base, refusing
// any component that is not a plain directory, and returns the path the item
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
