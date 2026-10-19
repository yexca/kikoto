package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

// A folder edit can also arrange the edited folder: a file already in it can
// take another path inside it, an added file can land at a path of its own,
// and empty folders can be created. Kikoto's lyrics folder is arranged only by
// lyrics roles, so no move or folder reaches into it.

const maxWorkFolderEditFolders = 1000

// workFolderEditMoveRequest gives a file of the edited folder a new path below
// the folder.
type workFolderEditMoveRequest struct {
	LocationID int64  `json:"locationId"`
	Path       string `json:"path"`
}

// workFolderEditMove is one file of the edited folder that the edit moves to
// another path inside it. Both paths are library paths.
type workFolderEditMove struct {
	LocationID  int64  `json:"locationId"`
	MediaItemID int64  `json:"mediaItemId"`
	Path        string `json:"path"`
	TargetPath  string `json:"targetPath"`
	SizeBytes   *int64 `json:"sizeBytes"`
}

// workFolderEditLayout is what the edit leaves where in the edited folder:
// the paths it frees, the paths moved files take, and the folders to create.
type workFolderEditLayout struct {
	vacated map[string]bool
	moved   map[string]string
	folders []string
	// newFolders counts the requested folders that do not exist yet.
	newFolders int
}

// inLyricsRoot reports whether relative, a path below a work folder, lies in
// Kikoto's lyrics folder or is that folder.
func inLyricsRoot(relative string) bool {
	first, _, _ := strings.Cut(relative, "/")
	return strings.EqualFold(first, localfs.LyricsRootName)
}

type workFolderEditLocation struct {
	locationID  int64
	mediaItemID int64
	path        string
	size        *int64
}

// workFolderEditLocalFile loads a local file of the edited work inside the
// edited folder.
func (s *Server) workFolderEditLocalFile(ctx context.Context, target workFolderEditFolder, locationID int64, role string) (workFolderEditLocation, error) {
	var location workFolderEditLocation
	var workID, sourceID int64
	var locationType string
	var size sql.NullInt64
	err := s.db.QueryRowContext(ctx, `
		SELECT location.id, location.media_item_id, item.work_id, location.file_source_id, location.location_type,
			location.path, location.size_bytes
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE location.id = ?
	`, locationID).Scan(&location.locationID, &location.mediaItemID, &workID, &sourceID, &locationType, &location.path, &size)
	if errors.Is(err, sql.ErrNoRows) {
		return workFolderEditLocation{}, mediaCleanupTargetConflictError{message: "a file to " + role + " is no longer listed; refresh the work and try again"}
	}
	if err != nil {
		return workFolderEditLocation{}, err
	}
	location.path = filepath.ToSlash(location.path)
	if locationType != "local" || workID != target.WorkID || sourceID != target.FileSourceID ||
		normalizeFolderRootPath(location.path) == target.RootPath || !mediaCleanupPathWithinRoot(target.RootPath, location.path) {
		return workFolderEditLocation{}, invalidRequestError("a file to " + role + " is not inside the edited folder")
	}
	if size.Valid {
		value := size.Int64
		location.size = &value
	}
	return location, nil
}

// workFolderEditMoves resolves the files to move. A file is either moved or
// removed, and no file of Kikoto's lyrics folder moves.
func (s *Server) workFolderEditMoves(ctx context.Context, target workFolderEditFolder, requested []workFolderEditMoveRequest, removals []workFolderEditRemoval) ([]workFolderEditMove, error) {
	if len(requested) > maxWorkFolderEditRemovals {
		return nil, invalidRequestError(fmt.Sprintf("at most %d files can be moved at once", maxWorkFolderEditRemovals))
	}
	removed := map[int64]bool{}
	for _, removal := range removals {
		removed[removal.LocationID] = true
	}
	seen := map[int64]bool{}
	moves := make([]workFolderEditMove, 0, len(requested))
	for _, request := range requested {
		if request.LocationID <= 0 || seen[request.LocationID] {
			continue
		}
		seen[request.LocationID] = true
		relative := cleanRemoteRelativePath(request.Path)
		if relative == "" {
			return nil, invalidRequestError("each moved file needs a path")
		}
		if inLyricsRoot(relative) {
			return nil, invalidRequestError("files go to the lyrics folder as lyrics of a language, not by a move")
		}
		if removed[request.LocationID] {
			return nil, invalidRequestError("a file cannot be both moved and removed")
		}
		location, err := s.workFolderEditLocalFile(ctx, target, request.LocationID, "move")
		if err != nil {
			return nil, err
		}
		current, err := fetchPathRelativeToRoot(target.RootPath, location.path)
		if err != nil {
			return nil, invalidRequestError("a file to move is not inside the edited folder")
		}
		if inLyricsRoot(current) {
			return nil, invalidRequestError("the lyrics Kikoto manages are arranged in Manage lyrics")
		}
		if current == relative {
			continue
		}
		moves = append(moves, workFolderEditMove{
			LocationID: location.locationID, MediaItemID: location.mediaItemID,
			Path: location.path, TargetPath: path.Join(target.RootPath, relative), SizeBytes: location.size,
		})
	}
	return moves, nil
}

// workFolderEditCurrentPaths lists the available local files of the edited
// folder by library path.
func (s *Server) workFolderEditCurrentPaths(ctx context.Context, target workFolderEditFolder) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.file_source_id = ? AND location.location_type = 'local'
			AND location.availability = 'available'
			AND substr(location.path, 1, length(?) + 1) = ? || '/'
	`, target.WorkID, target.FileSourceID, target.RootPath, target.RootPath)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	paths := []string{}
	for rows.Next() {
		var value string
		if err := rows.Scan(&value); err != nil {
			return nil, err
		}
		paths = append(paths, filepath.ToSlash(value))
	}
	return paths, rows.Err()
}

// planWorkFolderEditLayout checks that the files staying in the folder, the
// moved files, and the requested folders fit together: no two files share a
// path, no file sits where a folder of another path belongs, and a moved file
// lands only on a path that is free once the edit has removed and moved what
// it takes away.
func (s *Server) planWorkFolderEditLayout(ctx context.Context, target workFolderEditFolder, moves []workFolderEditMove, removals []workFolderEditRemoval, folders []string) (workFolderEditLayout, error) {
	if len(folders) > maxWorkFolderEditFolders {
		return workFolderEditLayout{}, invalidRequestError(fmt.Sprintf("at most %d folders can be created at once", maxWorkFolderEditFolders))
	}
	layout := workFolderEditLayout{vacated: map[string]bool{}, moved: map[string]string{}, folders: []string{}}
	for _, removal := range removals {
		layout.vacated[fetchTargetKey(removal.Path)] = true
	}
	for _, move := range moves {
		layout.vacated[fetchTargetKey(move.Path)] = true
	}
	current, err := s.workFolderEditCurrentPaths(ctx, target)
	if err != nil {
		return workFolderEditLayout{}, err
	}
	// Every file of the folder as the edit leaves it, by identity.
	final := map[string]string{}
	for _, file := range current {
		if key := fetchTargetKey(file); !layout.vacated[key] {
			final[key] = file
		}
	}
	for _, move := range moves {
		key := fetchTargetKey(move.TargetPath)
		if previous, taken := final[key]; taken {
			return workFolderEditLayout{}, invalidRequestError("two files would have the same path: " + previous)
		}
		final[key] = move.TargetPath
		layout.moved[key] = move.Path
	}
	parentTaken := func(libraryPath string) (string, bool) {
		for dir := path.Dir(libraryPath); dir != target.RootPath && dir != "." && dir != "/"; dir = path.Dir(dir) {
			if file, taken := final[fetchTargetKey(dir)]; taken {
				return file, true
			}
		}
		return "", false
	}
	for _, move := range moves {
		if blocker, taken := parentTaken(move.TargetPath); taken {
			return workFolderEditLayout{}, invalidRequestError("a file named " + blocker + " is where a folder of a moved file belongs")
		}
		if err := s.checkWorkFolderEditFreePath(target, move.TargetPath, layout.vacated, false); err != nil {
			return workFolderEditLayout{}, err
		}
	}
	seen := map[string]bool{}
	for _, folder := range folders {
		relative := cleanRemoteRelativePath(folder)
		if relative == "" {
			continue
		}
		if inLyricsRoot(relative) {
			return workFolderEditLayout{}, invalidRequestError("Kikoto's lyrics folder holds only lyrics of a language")
		}
		libraryPath := path.Join(target.RootPath, relative)
		key := fetchTargetKey(libraryPath)
		if seen[key] {
			continue
		}
		seen[key] = true
		if file, taken := final[key]; taken {
			return workFolderEditLayout{}, invalidRequestError("a file named " + file + " is where a new folder belongs")
		}
		if blocker, taken := parentTaken(libraryPath); taken {
			return workFolderEditLayout{}, invalidRequestError("a file named " + blocker + " is where a folder of a new folder belongs")
		}
		if err := s.checkWorkFolderEditFreePath(target, libraryPath, layout.vacated, true); err != nil {
			return workFolderEditLayout{}, err
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, libraryPath)
		if err != nil {
			return workFolderEditLayout{}, invalidRequestError("a new folder is outside the library")
		}
		if info, err := os.Lstat(absolute); err != nil || !info.IsDir() {
			layout.newFolders++
		}
		layout.folders = append(layout.folders, libraryPath)
	}
	return layout, nil
}

// checkWorkFolderEditFreePath checks on disk that libraryPath can become a
// file, or a folder when folder is set: whatever is there now leaves with the
// edit, and every folder above it is a plain folder or not there yet.
func (s *Server) checkWorkFolderEditFreePath(target workFolderEditFolder, libraryPath string, vacated map[string]bool, folder bool) error {
	relative, err := fetchPathRelativeToRoot(target.RootPath, libraryPath)
	if err != nil {
		return invalidRequestError("a path is outside the edited folder")
	}
	if blocker, blocked := blockingPathEntry(target.Absolute, relative); blocked {
		if !vacated[fetchTargetKey(path.Join(target.RootPath, blocker))] {
			return invalidRequestError("a file named " + blocker + " is where a folder belongs")
		}
	}
	absolute := filepath.Join(target.Absolute, filepath.FromSlash(relative))
	info, err := os.Lstat(absolute)
	switch {
	case errors.Is(err, os.ErrNotExist):
		return nil
	case err != nil:
		return conflictError("a path in the edited folder could not be checked")
	case folder && info.IsDir() && !unsafeFetchStagingEntry(info):
		return nil
	case !folder && info.Mode().IsRegular() && vacated[fetchTargetKey(libraryPath)]:
		return nil
	case info.IsDir():
		return invalidRequestError("a folder is already at " + relative)
	default:
		return invalidRequestError(relative + " is already in the folder")
	}
}

// workFolderEditAdditionTarget is the path below the edited folder an added
// file lands at: the path the request gives it, or its own path.
func workFolderEditAdditionTarget(addition workFolderEditAdditionRequest, relative string) (string, error) {
	if strings.TrimSpace(addition.TargetPath) == "" || addition.Language != nil {
		return relative, nil
	}
	placed := cleanRemoteRelativePath(addition.TargetPath)
	if placed == "" {
		return "", invalidRequestError("an added file needs a target path")
	}
	if inLyricsRoot(placed) {
		return "", invalidRequestError("files go to the lyrics folder as lyrics of a language")
	}
	return placed, nil
}
