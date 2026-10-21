package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"net/http"
	"path"
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/yexca/kikoto/backend/internal/dlsite"
)

// Display names change only what the directory shows for local files and
// folders. Each is stored per metadata language: a file's by its media item,
// so it follows the item through rescans and folder edits and goes with it,
// and a folder's by its path below the work folder, kept while a local media
// item of the work lies below that path. A viewer sees the name of the first
// of their own languages that has one, and the real name when the original
// language comes first. Names are shared by every viewer, like manual
// metadata.

const (
	// maxFileDisplayNameChanges bounds one save so a single request cannot hold
	// the write transaction for an unbounded tree.
	maxFileDisplayNameChanges = 5000
	maxFileDisplayNameRunes   = 255
	maxFileDisplayNamesBody   = 2 << 20
)

type fileDisplayNameEntry struct {
	MediaItemID int64 `json:"mediaItemId,omitempty"`
	// Path is the file or folder below the work folder.
	Path  string            `json:"path"`
	Names map[string]string `json:"names"`
}

type fileDisplayNamesResponse struct {
	WorkID      int64                  `json:"workId"`
	MediaWorkID int64                  `json:"mediaWorkId"`
	Folders     []fileDisplayNameEntry `json:"folders"`
	Files       []fileDisplayNameEntry `json:"files"`
}

type fileDisplayNameFileChange struct {
	MediaItemID int64  `json:"mediaItemId"`
	Name        string `json:"name"`
}

type fileDisplayNameFolderChange struct {
	Path string `json:"path"`
	Name string `json:"name"`
}

// fileDisplayNamesChange sets or, with an empty name, removes the names of
// one language.
type fileDisplayNamesChange struct {
	Language string                        `json:"language"`
	Files    []fileDisplayNameFileChange   `json:"files"`
	Folders  []fileDisplayNameFolderChange `json:"folders"`
}

func (s *Server) getWorkFileDisplayNames(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	workID, mediaWorkID, ok := s.fileDisplayNamesWork(w, r)
	if !ok {
		return
	}
	response, err := s.loadFileDisplayNames(r.Context(), workID, mediaWorkID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) setWorkFileDisplayNames(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:write")
	if !ok {
		return
	}
	workID, mediaWorkID, ok := s.fileDisplayNamesWork(w, r)
	if !ok {
		return
	}
	var change fileDisplayNamesChange
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxFileDisplayNamesBody)).Decode(&change); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if err := normalizeFileDisplayNamesChange(&change); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if err := s.applyFileDisplayNames(r.Context(), user.ID, mediaWorkID, change); err != nil {
		var requestErr fileDisplayNameRequestError
		if errors.As(err, &requestErr) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": requestErr.message})
			return
		}
		writeError(w, err)
		return
	}
	response, err := s.loadFileDisplayNames(r.Context(), workID, mediaWorkID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

// fileDisplayNamesWork resolves the requested work to the work whose media its
// detail shows, as the media read does.
func (s *Server) fileDisplayNamesWork(w http.ResponseWriter, r *http.Request) (int64, int64, bool) {
	workID, err := s.workReadID(r)
	if err != nil {
		writeWorkReadError(w, err)
		return 0, 0, false
	}
	if !s.requireDemoWork(w, r, workID) {
		return 0, 0, false
	}
	mediaWorkID, err := s.resolveMediaWorkIDForRequest(r.Context(), workID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return 0, 0, false
		}
		writeError(w, err)
		return 0, 0, false
	}
	return workID, mediaWorkID, true
}

type fileDisplayNameRequestError struct{ message string }

func (err fileDisplayNameRequestError) Error() string { return err.message }

func normalizeFileDisplayNamesChange(change *fileDisplayNamesChange) error {
	if !slices.Contains(dlsite.SupportedMetadataLanguages, change.Language) {
		return errors.New("unsupported display name language")
	}
	if len(change.Files)+len(change.Folders) == 0 {
		return errors.New("names are required")
	}
	if len(change.Files)+len(change.Folders) > maxFileDisplayNameChanges {
		return fmt.Errorf("at most %d names can be saved at once", maxFileDisplayNameChanges)
	}
	seenFiles := map[int64]bool{}
	for index := range change.Files {
		file := &change.Files[index]
		if file.MediaItemID <= 0 || seenFiles[file.MediaItemID] {
			return errors.New("each file needs one positive media item id")
		}
		seenFiles[file.MediaItemID] = true
		name, err := normalizeFileDisplayName(file.Name)
		if err != nil {
			return err
		}
		file.Name = name
	}
	seenFolders := map[string]bool{}
	for index := range change.Folders {
		folder := &change.Folders[index]
		folder.Path = normalizeFolderRootPath(folder.Path)
		if folder.Path == "" || seenFolders[folder.Path] {
			return errors.New("each folder needs one path")
		}
		seenFolders[folder.Path] = true
		name, err := normalizeFileDisplayName(folder.Name)
		if err != nil {
			return err
		}
		folder.Name = name
	}
	return nil
}

// normalizeFileDisplayName trims a name; empty removes it. A name is one path
// segment, so it holds no separator or control character.
func normalizeFileDisplayName(value string) (string, error) {
	name := strings.TrimSpace(value)
	if !utf8.ValidString(name) || utf8.RuneCountInString(name) > maxFileDisplayNameRunes {
		return "", fmt.Errorf("display names are at most %d characters", maxFileDisplayNameRunes)
	}
	if name == "." || name == ".." || strings.ContainsAny(name, `/\`) || strings.IndexFunc(name, unicode.IsControl) >= 0 {
		return "", errors.New("display names cannot contain path separators or control characters")
	}
	return name, nil
}

func (s *Server) applyFileDisplayNames(ctx context.Context, userID, mediaWorkID int64, change fileDisplayNamesChange) error {
	files, folders, err := s.localDisplayNameEntries(ctx, mediaWorkID)
	if err != nil {
		return err
	}
	knownFiles := map[int64]bool{}
	for _, file := range files {
		knownFiles[file.MediaItemID] = true
	}
	knownFolders := map[string]bool{}
	for _, folder := range folders {
		knownFolders[folder] = true
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	for _, file := range change.Files {
		if !knownFiles[file.MediaItemID] {
			return fileDisplayNameRequestError{message: "display names must name local files of this work"}
		}
		if file.Name == "" {
			_, err = tx.ExecContext(ctx, "DELETE FROM media_item_display_name WHERE media_item_id = ? AND language = ?",
				file.MediaItemID, change.Language)
		} else {
			_, err = tx.ExecContext(ctx, `
				INSERT INTO media_item_display_name (media_item_id, language, name, updated_by_user_id)
				VALUES (?, ?, ?, ?)
				ON CONFLICT(media_item_id, language) DO UPDATE SET
					name = excluded.name,
					updated_by_user_id = excluded.updated_by_user_id,
					updated_at = CURRENT_TIMESTAMP
				WHERE name IS NOT excluded.name
			`, file.MediaItemID, change.Language, file.Name, nullableUserID(userID))
		}
		if err != nil {
			return err
		}
	}
	for _, folder := range change.Folders {
		if !knownFolders[folder.Path] {
			return fileDisplayNameRequestError{message: "display names must name local folders of this work"}
		}
		if folder.Name == "" {
			_, err = tx.ExecContext(ctx, "DELETE FROM work_folder_display_name WHERE work_id = ? AND path = ? AND language = ?",
				mediaWorkID, folder.Path, change.Language)
		} else {
			_, err = tx.ExecContext(ctx, `
				INSERT INTO work_folder_display_name (work_id, path, language, name, updated_by_user_id)
				VALUES (?, ?, ?, ?, ?)
				ON CONFLICT(work_id, path, language) DO UPDATE SET
					name = excluded.name,
					updated_by_user_id = excluded.updated_by_user_id,
					updated_at = CURRENT_TIMESTAMP
				WHERE name IS NOT excluded.name
			`, mediaWorkID, folder.Path, change.Language, folder.Name, nullableUserID(userID))
		}
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Server) loadFileDisplayNames(ctx context.Context, workID, mediaWorkID int64) (fileDisplayNamesResponse, error) {
	response := fileDisplayNamesResponse{WorkID: workID, MediaWorkID: mediaWorkID, Folders: []fileDisplayNameEntry{}, Files: []fileDisplayNameEntry{}}
	files, folders, err := s.localDisplayNameEntries(ctx, mediaWorkID)
	if err != nil {
		return response, err
	}
	fileNames, err := s.mediaItemDisplayNames(ctx, mediaWorkID)
	if err != nil {
		return response, err
	}
	folderNames, err := s.workFolderDisplayNames(ctx, mediaWorkID)
	if err != nil {
		return response, err
	}
	for _, folder := range folders {
		response.Folders = append(response.Folders, fileDisplayNameEntry{Path: folder, Names: nonNilNames(folderNames[folder])})
	}
	for _, file := range files {
		file.Names = nonNilNames(fileNames[file.MediaItemID])
		response.Files = append(response.Files, file)
	}
	return response, nil
}

func nonNilNames(names map[string]string) map[string]string {
	if names == nil {
		return map[string]string{}
	}
	return names
}

// localDisplayNameEntries lists the files a display name can name, the media
// items with an available local file, by their path below the work folder, and
// every folder above them, both sorted by path.
func (s *Server) localDisplayNameEntries(ctx context.Context, mediaWorkID int64) ([]fileDisplayNameEntry, []string, error) {
	roots, err := s.localWorkRoots(ctx, mediaWorkID)
	if err != nil {
		return nil, nil, err
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT item.id, location.path
		FROM media_file_location AS location
		INNER JOIN media_item AS item ON item.id = location.media_item_id
		WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
		ORDER BY location.id
	`, mediaWorkID)
	if err != nil {
		return nil, nil, err
	}
	defer func() { _ = rows.Close() }()
	files := []fileDisplayNameEntry{}
	seenItems := map[int64]bool{}
	seenFolders := map[string]bool{}
	folders := []string{}
	for rows.Next() {
		var itemID int64
		var locationPath string
		if err := rows.Scan(&itemID, &locationPath); err != nil {
			return nil, nil, err
		}
		relative := localWorkRelativePath(locationPath, roots)
		if relative == "" || seenItems[itemID] {
			continue
		}
		seenItems[itemID] = true
		files = append(files, fileDisplayNameEntry{MediaItemID: itemID, Path: relative})
		for folder := path.Dir(relative); folder != "."; folder = path.Dir(folder) {
			if seenFolders[folder] {
				break
			}
			seenFolders[folder] = true
			folders = append(folders, folder)
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	slices.SortFunc(files, func(left, right fileDisplayNameEntry) int { return strings.Compare(left.Path, right.Path) })
	slices.Sort(folders)
	return files, folders, nil
}

// localWorkRoots are the folders a work's local files lie in, as the scan
// records them.
func (s *Server) localWorkRoots(ctx context.Context, workID int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT source_url FROM work_source_presence WHERE work_id = ? AND presence_type = 'local'
		UNION
		SELECT root_path FROM work_folder_location WHERE work_id = ?
	`, workID, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	roots := []string{}
	for rows.Next() {
		var root string
		if err := rows.Scan(&root); err != nil {
			return nil, err
		}
		if root = normalizeFolderRootPath(root); root != "" {
			roots = append(roots, root)
		}
	}
	return roots, rows.Err()
}

// localWorkRelativePath is a local file's path below its work folder, or ""
// when no work folder holds it.
func localWorkRelativePath(locationPath string, roots []string) string {
	normalized := normalizeFolderRootPath(locationPath)
	root := localLocationWorkRoot(normalized, roots)
	if root == "" || !strings.HasPrefix(normalized, root+"/") {
		return ""
	}
	return strings.TrimPrefix(normalized, root+"/")
}

func (s *Server) mediaItemDisplayNames(ctx context.Context, mediaWorkID int64) (map[int64]map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT name.media_item_id, name.language, name.name
		FROM media_item_display_name AS name
		INNER JOIN media_item AS item ON item.id = name.media_item_id
		WHERE item.work_id = ?
	`, mediaWorkID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	names := map[int64]map[string]string{}
	for rows.Next() {
		var itemID int64
		var language, name string
		if err := rows.Scan(&itemID, &language, &name); err != nil {
			return nil, err
		}
		if names[itemID] == nil {
			names[itemID] = map[string]string{}
		}
		names[itemID][language] = name
	}
	return names, rows.Err()
}

func (s *Server) workFolderDisplayNames(ctx context.Context, mediaWorkID int64) (map[string]map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT path, language, name FROM work_folder_display_name WHERE work_id = ?", mediaWorkID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	names := map[string]map[string]string{}
	for rows.Next() {
		var folder, language, name string
		if err := rows.Scan(&folder, &language, &name); err != nil {
			return nil, err
		}
		if names[folder] == nil {
			names[folder] = map[string]string{}
		}
		names[folder][language] = name
	}
	return names, rows.Err()
}

// displayNameLanguages are the languages of a viewer's priority that come
// before the original language. Names stop there: the original language shows
// the real names.
func displayNameLanguages(priority []string) []string {
	languages := []string{}
	for _, language := range priority {
		if language == dlsite.OriginMetadataLanguage {
			break
		}
		languages = append(languages, language)
	}
	return languages
}

func preferredDisplayName(names map[string]string, languages []string) (string, bool) {
	for _, language := range languages {
		if name, ok := names[language]; ok {
			return name, true
		}
	}
	return "", false
}

// attachLocalDisplayPaths gives each local location whose file or folders have
// a name in the viewer's languages a display path: its path with those names
// in place of the real ones, segment for segment.
func (s *Server) attachLocalDisplayPaths(ctx context.Context, mediaWorkID int64, mediaItems []mediaItemDetail) error {
	languages := displayNameLanguages(s.viewerMetadataLanguages(ctx))
	if len(languages) == 0 {
		return nil
	}
	fileNames, err := s.mediaItemDisplayNames(ctx, mediaWorkID)
	if err != nil {
		return err
	}
	folderNames, err := s.workFolderDisplayNames(ctx, mediaWorkID)
	if err != nil {
		return err
	}
	if len(fileNames) == 0 && len(folderNames) == 0 {
		return nil
	}
	roots, err := s.localWorkRoots(ctx, mediaWorkID)
	if err != nil {
		return err
	}
	for itemIndex := range mediaItems {
		item := &mediaItems[itemIndex]
		fileName, hasFileName := preferredDisplayName(fileNames[item.ID], languages)
		for locationIndex := range item.Locations {
			location := &item.Locations[locationIndex]
			if location.LocationType != "local" {
				continue
			}
			relative := localWorkRelativePath(location.Path, roots)
			if relative == "" {
				continue
			}
			original := strings.Split(relative, "/")
			segments := slices.Clone(original)
			changed := false
			for index := 0; index < len(segments)-1; index++ {
				if name, ok := preferredDisplayName(folderNames[strings.Join(original[:index+1], "/")], languages); ok {
					segments[index] = name
					changed = true
				}
			}
			if hasFileName {
				last := len(segments) - 1
				segments[last] = fileName + path.Ext(segments[last])
				changed = true
			}
			if changed {
				normalized := normalizeFolderRootPath(location.Path)
				location.DisplayPath = strings.TrimSuffix(normalized, relative) + strings.Join(segments, "/")
			}
		}
	}
	return nil
}

// pruneWorkFolderDisplayNames removes the names of folders that no local media
// item of their work lies below any more, by the work-relative path in the
// item's `local:<code>:<path>` fingerprint, and returns how many it removed.
// An item outlives its files until disk-verified cleanup removes its last
// location, so a folder on an unmounted pool or outside the scan keeps its
// names. A workID of 0 prunes every work.
func pruneWorkFolderDisplayNames(ctx context.Context, tx *sql.Tx, workID int64) (int, error) {
	query := `
		DELETE FROM work_folder_display_name
		WHERE NOT EXISTS (
			SELECT 1 FROM media_item AS item
			WHERE item.work_id = work_folder_display_name.work_id
				AND substr(item.fingerprint, 1, 6) = 'local:'
				AND substr(item.fingerprint, instr(substr(item.fingerprint, 7), ':') + 7,
					length(work_folder_display_name.path) + 1) = work_folder_display_name.path || '/'
		)`
	args := []any{}
	if workID > 0 {
		query += " AND work_id = ?"
		args = append(args, workID)
	}
	return execRowsAffected(ctx, tx, query, args...)
}

// followWorkFolderDisplayNames moves the names of the folders a folder edit
// renamed or moved. A folder counts as moved when every file the edit moved
// out of it keeps its path below the folder and lands below one other folder,
// and no available local file of the work is left below it. A folder that
// already has a name in a language keeps it. moves are file paths below the
// work folder, before and after the edit.
func followWorkFolderDisplayNames(ctx context.Context, tx *sql.Tx, workID int64, code string, moves [][2]string) error {
	targets := map[string]string{}
	conflicts := map[string]bool{}
	for _, move := range moves {
		from, to := strings.Split(move[0], "/"), strings.Split(move[1], "/")
		for depth := 1; depth < len(from); depth++ {
			folder := strings.Join(from[:depth], "/")
			suffix := from[depth:]
			if len(to) <= len(suffix) || !slices.Equal(to[len(to)-len(suffix):], suffix) {
				conflicts[folder] = true
				continue
			}
			target := strings.Join(to[:len(to)-len(suffix)], "/")
			if previous, ok := targets[folder]; ok && previous != target {
				conflicts[folder] = true
			}
			targets[folder] = target
		}
	}
	type folderName struct {
		language, name string
		updatedBy      sql.NullInt64
		updatedAt      string
	}
	moved := map[string][]folderName{}
	sources := []string{}
	for _, folder := range slices.Sorted(maps.Keys(targets)) {
		if conflicts[folder] || folder == targets[folder] {
			continue
		}
		prefix := fmt.Sprintf("local:%s:%s/", code, folder)
		var remains bool
		if err := tx.QueryRowContext(ctx, `
			SELECT EXISTS (
				SELECT 1 FROM media_item AS item
				INNER JOIN media_file_location AS location ON location.media_item_id = item.id
				WHERE item.work_id = ? AND location.location_type = 'local' AND location.availability = 'available'
					AND substr(item.fingerprint, 1, ?) = ?
			)
		`, workID, utf8.RuneCountInString(prefix), prefix).Scan(&remains); err != nil {
			return err
		}
		if remains {
			continue
		}
		rows, err := tx.QueryContext(ctx, `
			SELECT language, name, updated_by_user_id, updated_at
			FROM work_folder_display_name WHERE work_id = ? AND path = ?
		`, workID, folder)
		if err != nil {
			return err
		}
		names := []folderName{}
		for rows.Next() {
			var name folderName
			if err := rows.Scan(&name.language, &name.name, &name.updatedBy, &name.updatedAt); err != nil {
				_ = rows.Close()
				return err
			}
			names = append(names, name)
		}
		if err := rows.Close(); err != nil {
			return err
		}
		if len(names) > 0 {
			moved[folder] = names
			sources = append(sources, folder)
		}
	}
	// Every source gives its names up before any target takes them, so folders
	// that trade places trade names.
	for _, folder := range sources {
		if _, err := tx.ExecContext(ctx, "DELETE FROM work_folder_display_name WHERE work_id = ? AND path = ?", workID, folder); err != nil {
			return err
		}
	}
	for _, folder := range sources {
		for _, name := range moved[folder] {
			if _, err := tx.ExecContext(ctx, `
				INSERT OR IGNORE INTO work_folder_display_name (work_id, path, language, name, updated_by_user_id, updated_at)
				VALUES (?, ?, ?, ?, ?, ?)
			`, workID, targets[folder], name.language, name.name, name.updatedBy, name.updatedAt); err != nil {
				return err
			}
		}
	}
	return nil
}
