package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

// Lyrics are small text files. These bounds keep one request from turning a
// remote tree into an unbounded download or a long write transaction.
const (
	maxLyricsFetchFiles       = 200
	maxLyricsFetchFileBytes   = 2 << 20
	lyricsFetchRequestTimeout = 2 * time.Minute
	lyricsFetchFileTimeout    = 30 * time.Second
)

// lyricsFetchTarget is the existing local work folder that receives the
// lyrics.
type lyricsFetchTarget struct {
	WorkID       int64
	FileSourceID int64
	RootPath     string
}

type lyricsFetchRequestError struct {
	status int
	// code is the public error code for refusals the interface explains itself.
	code    string
	message string
}

func (err lyricsFetchRequestError) Error() string { return err.message }

// errLyricsFolderBlocked refuses generated lyrics when a file in the work
// folder sits where the lyrics folder, or a folder inside it, belongs.
var errLyricsFolderBlocked = lyricsFetchRequestError{
	status:  http.StatusConflict,
	code:    "lyrics_folder_blocked",
	message: "a file in the work folder is where the lyrics folder belongs; rename or move it, then add the lyrics again",
}

func lyricsFetchBadRequest(message string) error {
	return lyricsFetchRequestError{status: http.StatusBadRequest, message: message}
}

// lyricsFetchEditionLanguage confirms that the remote code is an edition of
// the requested work's family and returns its declared language when lyrics
// can declare it.
func (s *Server) lyricsFetchEditionLanguage(ctx context.Context, family map[int64]bool, remoteCode string) (string, error) {
	var workID int64
	var language string
	err := s.db.QueryRowContext(ctx, `
		SELECT work.id, COALESCE(edition.metadata_language, '')
		FROM work
		LEFT JOIN work_edition AS edition ON edition.work_id = work.id
		WHERE UPPER(work.primary_code) = UPPER(?)
	`, remoteCode).Scan(&workID, &language)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !family[workID]) {
		return "", lyricsFetchBadRequest("the remote edition does not belong to this work")
	}
	if err != nil {
		return "", err
	}
	return editionLyricsLanguage(language), nil
}

// editionLyricsLanguage maps an edition's declared language onto a lyrics
// language, and to the every-language assignment when it has none.
func editionLyricsLanguage(editionLanguage string) string {
	language, ok := normalizeLyricsLanguage(dlsite.EditionMetadataLanguage(editionLanguage))
	if !ok {
		return ""
	}
	return language
}

func (s *Server) lyricsFetchTarget(ctx context.Context, family map[int64]bool, folderID int64) (lyricsFetchTarget, error) {
	var target lyricsFetchTarget
	err := s.db.QueryRowContext(ctx, `
		SELECT folder.work_id, folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE folder.id = ? AND folder.state = 'active' AND source.source_type = 'local_folder'
	`, folderID).Scan(&target.WorkID, &target.FileSourceID, &target.RootPath)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !family[target.WorkID]) {
		return lyricsFetchTarget{}, lyricsFetchBadRequest("choose an active local folder of this work")
	}
	if err != nil {
		return lyricsFetchTarget{}, err
	}
	target.RootPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(target.RootPath)))
	absolute, err := safeDataPath(s.cfg.DataRoot, target.RootPath)
	if err != nil {
		return lyricsFetchTarget{}, lyricsFetchBadRequest("the local folder is outside the library")
	}
	if err := s.ensureFetchTargetWritable(ctx, target.RootPath); err != nil {
		return lyricsFetchTarget{}, err
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || unsafeFetchStagingEntry(info) {
		return lyricsFetchTarget{}, lyricsFetchRequestError{status: http.StatusConflict, message: "the local folder is not available"}
	}
	return target, nil
}

// lyricsSourceFolder is another active local folder of the family whose lyrics
// can be copied, such as a translated edition's folder.
type lyricsSourceFolder struct {
	RootPath string
	Absolute string
}

func (s *Server) lyricsSourceFolder(ctx context.Context, family map[int64]bool, folderID int64, target lyricsFetchTarget) (lyricsSourceFolder, error) {
	var workID int64
	var rootPath string
	err := s.db.QueryRowContext(ctx, `
		SELECT folder.work_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE folder.id = ? AND folder.state = 'active' AND source.source_type = 'local_folder'
	`, folderID).Scan(&workID, &rootPath)
	if errors.Is(err, sql.ErrNoRows) || (err == nil && !family[workID]) {
		return lyricsSourceFolder{}, lyricsFetchBadRequest("choose an active local folder of this work to copy from")
	}
	if err != nil {
		return lyricsSourceFolder{}, err
	}
	rootPath = filepath.ToSlash(filepath.Clean(filepath.FromSlash(rootPath)))
	if strings.EqualFold(rootPath, target.RootPath) {
		return lyricsSourceFolder{}, lyricsFetchBadRequest("the lyrics are already in this folder")
	}
	absolute, err := safeDataPath(s.cfg.DataRoot, rootPath)
	if err != nil {
		return lyricsSourceFolder{}, lyricsFetchBadRequest("the local folder is outside the library")
	}
	info, err := os.Lstat(absolute)
	if err != nil || !info.IsDir() || unsafeFetchStagingEntry(info) {
		return lyricsSourceFolder{}, lyricsFetchRequestError{status: http.StatusConflict, message: "the local folder is not available"}
	}
	return lyricsSourceFolder{RootPath: rootPath, Absolute: absolute}, nil
}

var errLyricsFileGone = lyricsFetchRequestError{
	status:  http.StatusNotFound,
	message: "a selected lyrics file is no longer in the folder",
}

// regularFileBelow returns the regular file relative names below root, when it
// is reached through regular directories only, so a link inside the folder
// cannot name a file outside it.
func regularFileBelow(root string, relative string) (os.FileInfo, bool) {
	current := root
	parts := strings.Split(relative, "/")
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if err != nil {
			return nil, false
		}
		last := index == len(parts)-1
		if unsafeFetchStagingEntry(info) || info.IsDir() == last || (last && !info.Mode().IsRegular()) {
			return nil, false
		}
		if last {
			return info, true
		}
	}
	return nil, false
}

// copyLibraryLyricsFile copies one lyrics file below sourceRoot to a staging
// destination. Every path component must be a regular directory or file, so a
// link inside the folder cannot read from outside it.
func copyLibraryLyricsFile(sourceRoot string, relative string, destination string) (int64, error) {
	info, ok := regularFileBelow(sourceRoot, relative)
	if !ok {
		return 0, errLyricsFileGone
	}
	if info.Size() > maxLyricsFetchFileBytes {
		return 0, lyricsFetchBadRequest("a lyrics file is too large")
	}
	input, err := os.Open(filepath.Join(sourceRoot, filepath.FromSlash(relative)))
	if err != nil {
		return 0, errLyricsFileGone
	}
	defer func() { _ = input.Close() }()
	return writeLyricsStagingFile(input, destination)
}

// writeLyricsStagingFile writes a bounded lyrics file to a new staging path.
func writeLyricsStagingFile(input io.Reader, destination string) (int64, error) {
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return 0, err
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(output, io.LimitReader(input, maxLyricsFetchFileBytes+1))
	closeErr := output.Close()
	if copyErr != nil {
		return 0, copyErr
	}
	if closeErr != nil {
		return 0, closeErr
	}
	if written > maxLyricsFetchFileBytes {
		return 0, lyricsFetchBadRequest("a lyrics file is too large")
	}
	return written, nil
}

func (s *Server) validateLyricsFetchAudio(ctx context.Context, workID int64, assignments map[int64]string) error {
	for audioID := range assignments {
		var audioWorkID int64
		var kind string
		err := s.db.QueryRowContext(ctx, "SELECT work_id, kind FROM media_item WHERE id = ?", audioID).Scan(&audioWorkID, &kind)
		if errors.Is(err, sql.ErrNoRows) || (err == nil && (kind != "audio" || audioWorkID != workID)) {
			return lyricsFetchBadRequest("assignments must target audio in the chosen local folder's work")
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// lyricsFetchRemoteTree reads the edition's remote tree without recording the
// edition as a work: browsing a sibling edition is not a request to track it.
func (s *Server) lyricsFetchRemoteTree(ctx context.Context, sourceID int64, remoteCode string) (remoteSourceForUse, []kikoeru.Track, error) {
	source, _, tracks, err := s.loadInstanceRemoteWorkTracksCached(ctx, sourceID, remoteCode)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || isNotFoundLikeError(err) {
			return remoteSourceForUse{}, nil, lyricsFetchRequestError{status: http.StatusNotFound, message: "the edition was not found on this source"}
		}
		return remoteSourceForUse{}, nil, err
	}
	if !source.Enabled || !isKikoeruSourceType(source.SourceType) {
		return remoteSourceForUse{}, nil, lyricsFetchBadRequest("source is not an enabled compatible remote source")
	}
	return source, tracks, nil
}

func (s *Server) createLyricsStaging(stagingParent string) (string, error) {
	parent, err := safeDataPath(s.cfg.DataRoot, stagingParent)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return "", err
	}
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return "", err
	}
	root := filepath.Join(parent, "lyrics-"+hex.EncodeToString(suffix))
	return root, os.Mkdir(root, 0o755)
}

func (s *Server) downloadLyricsFile(ctx context.Context, source remoteSourceForUse, remoteURL string, destination string) (int64, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, remoteURL, nil)
	if err != nil {
		return 0, err
	}
	request.Header.Set("Accept", "text/plain,text/*,*/*;q=0.5")
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	request.Header.Set("Accept-Language", s.instanceRemoteSourceAcceptLanguage(ctx, source))
	response, err := s.sourceDownloadHTTPClient(source, lyricsFetchFileTimeout).Do(request)
	if err != nil {
		return 0, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return 0, fmt.Errorf("lyrics download returned HTTP %d", response.StatusCode)
	}
	if response.ContentLength > maxLyricsFetchFileBytes {
		return 0, lyricsFetchBadRequest("a lyrics file is too large")
	}
	return writeLyricsStagingFile(response.Body, destination)
}

// lyricsFolderRelativePath is a file's path inside a lyrics folder: its path
// in its source, without the lyrics folder that already holds it there.
func lyricsFolderRelativePath(source string) string {
	first, rest, nested := strings.Cut(source, "/")
	if _, managed := lyricsFolderLanguage(first); managed && nested {
		return rest
	}
	return source
}

// managedLyricsPath reports whether relative, a path below a work folder,
// names a lyrics file inside one of the folder's language lyrics folders.
func managedLyricsPath(relative string) bool {
	first, _, nested := strings.Cut(relative, "/")
	_, managed := lyricsFolderLanguage(first)
	return managed && nested && mediaKindFromPath(relative) == "text"
}

// removeEmptyDirectoriesBelow removes directory and its parents below root
// while they are empty. Removing a directory that still holds something fails
// and ends the walk.
func removeEmptyDirectoriesBelow(root string, directory string) {
	for directory != "." && directory != "/" && directory != "" {
		if os.Remove(filepath.Join(root, filepath.FromSlash(directory))) != nil {
			return
		}
		directory = path.Dir(directory)
	}
}

// followMovedLyricsItem points the lyrics assignments and personal lyrics
// choices of a moved file at the media item of its new path. An item that
// still has a file, such as the same path in another folder of the work, keeps
// its references.
func followMovedLyricsItem(ctx context.Context, tx *sql.Tx, previousID int64, currentID int64) error {
	if previousID == currentID || previousID <= 0 {
		return nil
	}
	var stillAvailable bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM media_file_location
			WHERE media_item_id = ? AND availability = 'available'
		)
	`, previousID).Scan(&stillAvailable); err != nil || stillAvailable {
		return err
	}
	for _, table := range []string{"media_lyrics_assignment", "user_media_lyrics_preference"} {
		if _, err := tx.ExecContext(ctx,
			"UPDATE "+table+" SET lyrics_media_item_id = ? WHERE lyrics_media_item_id = ?", currentID, previousID,
		); err != nil {
			return err
		}
	}
	return nil
}

// redeclareLyricsAssignments moves the assignments that use a lyrics file to
// its declared language. A track that already has lyrics in that language
// keeps them, and its assignment of this file in another language is removed.
// A track that used the file in several languages keeps one assignment.
func redeclareLyricsAssignments(ctx context.Context, tx *sql.Tx, lyricsID int64, language string) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE OR IGNORE media_lyrics_assignment
		SET language = ?, updated_at = CURRENT_TIMESTAMP
		WHERE lyrics_media_item_id = ? AND language <> ?
			AND NOT EXISTS (
				SELECT 1 FROM media_lyrics_assignment AS declared
				WHERE declared.audio_media_item_id = media_lyrics_assignment.audio_media_item_id
					AND declared.language = ?
			)
	`, language, lyricsID, language, language); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx,
		"DELETE FROM media_lyrics_assignment WHERE lyrics_media_item_id = ? AND language <> ?", lyricsID, language)
	return err
}
