package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
)

// localTrack is the available local file of an audio track and the work folder
// whose lyrics receive the lyrics generated for it.
type localTrack struct {
	WorkID          int64
	AudioID         int64
	LocationID      int64
	FileSourceID    int64
	FolderID        int64
	Path            string
	RootPath        string
	Version         string
	DurationSeconds int64
}

var errLocalTrackUnavailable = errors.New("the audio track has no available local file in a work folder")

// loadLocalTrack resolves an audio item to its available local file and the
// active work folder that holds it.
func (s *Server) loadLocalTrack(ctx context.Context, audioID int64) (localTrack, error) {
	source := localTrack{AudioID: audioID}
	var fileVersion string
	var size int64
	err := s.db.QueryRowContext(ctx, `
		SELECT item.work_id, location.id, location.file_source_id, location.path, location.file_version,
			COALESCE(location.size_bytes, 0), COALESCE(location.duration_seconds, item.duration_seconds, 0)
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.id = ? AND item.kind = 'audio' AND location.location_type = 'local' AND location.availability = 'available'
		ORDER BY location.id LIMIT 1
	`, audioID).Scan(&source.WorkID, &source.LocationID, &source.FileSourceID, &source.Path, &fileVersion, &size, &source.DurationSeconds)
	if errors.Is(err, sql.ErrNoRows) {
		return source, errLocalTrackUnavailable
	}
	if err != nil {
		return source, err
	}
	source.Version = fmt.Sprintf("%s:%d", fileVersion, size)
	rows, err := s.db.QueryContext(ctx, `
		SELECT folder.id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS file_source ON file_source.id = folder.file_source_id
		WHERE folder.work_id = ? AND folder.file_source_id = ? AND folder.state = 'active' AND file_source.source_type = 'local_folder'
	`, source.WorkID, source.FileSourceID)
	if err != nil {
		return source, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var id int64
		var root string
		if err := rows.Scan(&id, &root); err != nil {
			return source, err
		}
		root = path.Clean(root)
		// The deepest folder holding the file is the one its lyrics belong to.
		if strings.HasPrefix(source.Path, root+"/") && len(root) > len(source.RootPath) {
			source.FolderID, source.RootPath = id, root
		}
	}
	if err := rows.Err(); err != nil {
		return source, err
	}
	if source.FolderID == 0 {
		return source, errLocalTrackUnavailable
	}
	return source, nil
}

// trackLyricsNameAttempts bounds the names tried when the language's lyrics
// folder already holds a different file under the track's name.
const trackLyricsNameAttempts = 5

// publishTrackLyrics saves generated lyrics of one track in the language's
// lyrics folder of the track's work folder, under the track's own path with
// the given extension, indexes the work folder, and assigns the file to the
// track in that language with the given origin. The lyrics keep the track's
// place inside the work folder, so tracks of the same name in different
// folders keep separate lyrics. An identical file already at the name counts
// as published, so an interrupted publication completes when it runs again.
func (s *Server) publishTrackLyrics(ctx context.Context, userID, workID, audioID, folderID int64, language, audioPath, extension, text, origin string) (string, int64, error) {
	return s.publishTrackLyricsWith(ctx, userID, workID, audioID, folderID, language, audioPath, extension, text, origin, nil)
}

// publishTrackLyricsWith publishes like publishTrackLyrics and runs finish in
// the transaction that assigns the file, before the assignment, so what the
// caller records commits with it; an error from finish leaves the track's
// assignments unchanged.
func (s *Server) publishTrackLyricsWith(ctx context.Context, userID, workID, audioID, folderID int64, language, audioPath, extension, text, origin string,
	finish func(tx *sql.Tx, lyricsPath string, lyricsID int64) error) (string, int64, error) {
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return "", 0, err
	}
	target, err := s.lyricsFetchTarget(ctx, family, folderID)
	if err != nil {
		return "", 0, err
	}
	if err := s.validateLyricsFetchAudio(ctx, target.WorkID, map[int64]string{audioID: origin}); err != nil {
		return "", 0, err
	}
	relative := strings.TrimPrefix(path.Clean(audioPath), target.RootPath+"/")
	stem := strings.TrimSuffix(relative, path.Ext(relative))
	if stem == "" || path.IsAbs(stem) || stem == ".." || strings.HasPrefix(stem, "../") {
		return "", 0, lyricsFetchBadRequest("the audio track is outside its work folder")
	}
	rootAbsolute, err := safeDataPath(s.cfg.DataRoot, target.RootPath)
	if err != nil {
		return "", 0, err
	}
	folderName := lyricsLanguageFolderPath(language)
	folderAbsolute := filepath.Join(rootAbsolute, filepath.FromSlash(folderName))
	if err := checkLyricsRootWritable(rootAbsolute); err != nil {
		return "", 0, err
	}
	if _, blocked := blockingPathEntry(rootAbsolute, path.Join(folderName, stem+extension)); blocked {
		return "", 0, errLyricsFolderBlocked
	}
	file, published, err := trackLyricsFileName(folderAbsolute, stem, extension, text)
	if err != nil {
		return "", 0, err
	}
	destination := filepath.Join(folderAbsolute, filepath.FromSlash(file))
	cleanupPublishedFile := false
	commitAttempted := false
	var indexedLyricsID int64
	var indexedLyrics bool
	defer func() {
		if !cleanupPublishedFile || commitAttempted {
			return
		}
		if indexedLyrics {
			_ = s.removeUnassignedLyricsItem(context.WithoutCancel(ctx), target.FileSourceID, indexedLyricsID, path.Join(target.RootPath, folderName, file))
		}
		removePublishedLyricsFile(destination, text)
	}()
	if !published {
		cleanupPublishedFile = true
		if err := s.stageTrackLyrics(ctx, target.RootPath, rootAbsolute, destination, extension, text); err != nil {
			return "", 0, err
		}
	}
	if err := s.indexLocalMediaForWork(ctx, target.WorkID, target.FileSourceID, target.RootPath); err != nil {
		return "", 0, err
	}
	lyricsPath := path.Join(target.RootPath, folderName, file)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", 0, err
	}
	defer func() { _ = tx.Rollback() }()
	lyricsID, indexed, err := lyricsEditLyricsItem(ctx, tx, target, lyricsPath)
	if err != nil {
		return "", 0, err
	}
	indexedLyricsID, indexedLyrics = lyricsID, indexed
	if finish != nil {
		if err := finish(tx, lyricsPath, lyricsID); err != nil {
			return "", 0, err
		}
	}
	// A file the rescan did not index is published but cannot be assigned.
	if indexed {
		if err := upsertLyricsAssignment(ctx, tx, audioID, language, lyricsID, origin, userID); err != nil {
			return "", 0, err
		}
	}
	commitAttempted = true
	if err := tx.Commit(); err != nil {
		return "", 0, err
	}
	cleanupPublishedFile = false
	return lyricsPath, lyricsID, nil
}

// removePublishedLyricsFile removes only the file this call wrote, and only
// while it still has the exact content this call supplied. A concurrent file
// or a user's replacement is left alone.
func removePublishedLyricsFile(filePath, expected string) {
	info, err := os.Lstat(filePath)
	if err != nil || unsafeFetchStagingEntry(info) || !info.Mode().IsRegular() {
		return
	}
	content, err := os.ReadFile(filePath)
	if err != nil || string(content) != expected {
		return
	}
	_ = os.Remove(filePath)
}

// removeUnassignedLyricsItem retires the media row created while indexing a
// publication that failed before its assignment committed. Existing or
// concurrently assigned rows remain intact.
func (s *Server) removeUnassignedLyricsItem(ctx context.Context, fileSourceID, lyricsID int64, lyricsPath string) error {
	if lyricsID <= 0 {
		return nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM media_file_location
		WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'local' AND path = ?
			AND NOT EXISTS (SELECT 1 FROM media_lyrics_assignment WHERE lyrics_media_item_id = media_item_id)
	`, lyricsID, fileSourceID, lyricsPath); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		DELETE FROM media_item
		WHERE id = ? AND NOT EXISTS (SELECT 1 FROM media_file_location WHERE media_item_id = media_item.id)
			AND NOT EXISTS (SELECT 1 FROM media_lyrics_assignment WHERE lyrics_media_item_id = media_item.id)
	`, lyricsID); err != nil {
		return err
	}
	return tx.Commit()
}

// trackLyricsFileName picks the name generated lyrics take inside their lyrics
// folder: the track's name, then numbered names while a different file holds
// it. It reports whether that name already holds this exact text, as after an
// interrupted publication.
func trackLyricsFileName(folderAbsolute, stem, extension, text string) (string, bool, error) {
	for attempt := 1; attempt <= trackLyricsNameAttempts; attempt++ {
		file := stem + extension
		if attempt > 1 {
			file = fmt.Sprintf("%s (%d)%s", stem, attempt, extension)
		}
		destination := filepath.Join(folderAbsolute, filepath.FromSlash(file))
		if _, err := os.Lstat(destination); errors.Is(err, os.ErrNotExist) {
			return file, false, nil
		} else if err != nil {
			return "", false, err
		}
		if _, regular := regularFileBelow(folderAbsolute, file); regular {
			if existing, err := os.ReadFile(destination); err == nil && string(existing) == text {
				return file, true, nil
			}
		}
	}
	return "", false, lyricsFetchRequestError{status: http.StatusConflict, message: "the lyrics folder already holds different files under this track's names"}
}

// stageTrackLyrics writes the text in staging on the work folder's storage
// pool and renames it into place, so a lyrics file is never seen half written
// and never replaces another file.
func (s *Server) stageTrackLyrics(ctx context.Context, rootPath, rootAbsolute, destination, extension, text string) error {
	pool, err := s.fetchTransactionPool(ctx, rootPath)
	if err != nil {
		return err
	}
	stagingRoot, err := s.createLyricsStaging(path.Join(pool, ".kikoto-staging"))
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(stagingRoot) }()
	staged := filepath.Join(stagingRoot, "lyrics"+extension)
	if _, err := writeLyricsStagingFile(strings.NewReader(text), staged); err != nil {
		return err
	}
	if err := ensureLyricsRoot(rootAbsolute); err != nil {
		return err
	}
	if err := mkdirPlainDirectories(rootAbsolute, filepath.Dir(destination)); err != nil {
		return err
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return lyricsFetchRequestError{status: http.StatusConflict, message: "the lyrics folder changed; publish the lyrics again"}
	}
	return os.Rename(staged, destination)
}
