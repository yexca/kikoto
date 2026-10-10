package httpapi

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

// Lyrics are small text files. These bounds keep one request from turning a
// remote tree into an unbounded download or a long write transaction.
const (
	maxLyricsFetchFiles       = 200
	maxLyricsFetchFileBytes   = 2 << 20
	maxLyricsFetchTotalBytes  = 32 << 20
	lyricsFetchRequestTimeout = 2 * time.Minute
	lyricsFetchFileTimeout    = 30 * time.Second
	lyricsFetchFolderAttempts = 5
)

var lyricsFolderComponentPattern = regexp.MustCompile(`[^A-Za-z0-9_-]+`)

type lyricsFetchRequest struct {
	SourceID    int64                     `json:"sourceId"`
	RemoteCode  string                    `json:"remoteCode"`
	FolderID    int64                     `json:"folderId"`
	Files       []string                  `json:"files"`
	Assignments []lyricsFetchAssignmentIn `json:"assignments"`
}

// lyricsFetchAssignmentIn names a downloaded file, by its remote path, as the
// library lyrics of a local audio file.
type lyricsFetchAssignmentIn struct {
	AudioMediaItemID int64  `json:"audioMediaItemId"`
	Path             string `json:"path"`
}

type lyricsFetchResult struct {
	WorkID     int64  `json:"workId"`
	Folder     string `json:"folder"`
	Downloaded int    `json:"downloaded"`
	Assigned   int    `json:"assigned"`
}

// lyricsFetchTarget is the existing local work folder that receives the new
// lyrics folder.
type lyricsFetchTarget struct {
	WorkID       int64
	FileSourceID int64
	RootPath     string
}

type lyricsFetchFile struct {
	RemotePath string
	URL        string
}

type lyricsFetchRequestError struct {
	status  int
	message string
}

func (err lyricsFetchRequestError) Error() string { return err.message }

func lyricsFetchBadRequest(message string) error {
	return lyricsFetchRequestError{status: http.StatusBadRequest, message: message}
}

// fetchWorkLyrics downloads lyrics files of a family edition from a remote
// source into a new timestamped folder inside an existing local work folder.
// Nothing in the work folder is replaced: the new folder is claimed with an
// exclusive create before any file is moved into it.
func (s *Server) fetchWorkLyrics(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	var payload lyricsFetchRequest
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	files, assignments, err := normalizeLyricsFetchRequest(payload)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	if len(assignments) > 0 && !userHasPermission(actor, "library:write") {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "library:write permission is required to assign lyrics"})
		return
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), lyricsFetchRequestTimeout)
	defer cancel()
	result, err := s.runLyricsFetch(ctx, actor.ID, workID, payload, files, assignments)
	if err != nil {
		writeLyricsFetchError(w, workID, payload.SourceID, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// writeLyricsFetchError keeps upstream details in the server log; the response
// never carries a remote URL or a local path.
func writeLyricsFetchError(w http.ResponseWriter, workID int64, sourceID int64, err error) {
	var requestErr lyricsFetchRequestError
	if errors.As(err, &requestErr) {
		writeJSON(w, requestErr.status, map[string]string{"error": requestErr.message})
		return
	}
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		return
	}
	if writeFetchDestinationError(w, err) {
		return
	}
	slog.Warn("lyrics fetch failed", "work_id", workID, "source_id", sourceID, "error", err)
	writeJSON(w, http.StatusBadGateway, map[string]string{"error": "lyrics could not be downloaded"})
}

func normalizeLyricsFetchRequest(payload lyricsFetchRequest) ([]string, map[int64]string, error) {
	if payload.SourceID <= 0 || payload.FolderID <= 0 || normalizeWorkCode(payload.RemoteCode) == "" {
		return nil, nil, errors.New("sourceId, remoteCode, and folderId are required")
	}
	if len(payload.Files) == 0 || len(payload.Files) > maxLyricsFetchFiles {
		return nil, nil, fmt.Errorf("choose between 1 and %d lyrics files", maxLyricsFetchFiles)
	}
	files := make([]string, 0, len(payload.Files))
	seen := map[string]bool{}
	for _, raw := range payload.Files {
		clean := cleanRemoteRelativePath(raw)
		if clean == "" || mediaKindFromPath(clean) != "text" {
			return nil, nil, errors.New("only lyrics text files can be downloaded")
		}
		if !seen[clean] {
			seen[clean] = true
			files = append(files, clean)
		}
	}
	if len(payload.Assignments) > maxLyricsAssignmentChanges {
		return nil, nil, fmt.Errorf("at most %d assignments can be saved at once", maxLyricsAssignmentChanges)
	}
	assignments := map[int64]string{}
	for _, assignment := range payload.Assignments {
		clean := cleanRemoteRelativePath(assignment.Path)
		if assignment.AudioMediaItemID <= 0 || !seen[clean] {
			return nil, nil, errors.New("each assignment must name an audio item and one of the downloaded files")
		}
		if _, duplicate := assignments[assignment.AudioMediaItemID]; duplicate {
			return nil, nil, errors.New("each audio media item can be assigned only once")
		}
		assignments[assignment.AudioMediaItemID] = clean
	}
	return files, assignments, nil
}

func (s *Server) runLyricsFetch(ctx context.Context, userID int64, workID int64, payload lyricsFetchRequest, files []string, assignments map[int64]string) (lyricsFetchResult, error) {
	family, err := s.lyricsAssignmentFamily(ctx, workID)
	if err != nil {
		return lyricsFetchResult{}, err
	}
	remoteCode := normalizeWorkCode(payload.RemoteCode)
	language, err := s.lyricsFetchEditionLanguage(ctx, family, remoteCode)
	if err != nil {
		return lyricsFetchResult{}, err
	}
	target, err := s.lyricsFetchTarget(ctx, family, payload.FolderID)
	if err != nil {
		return lyricsFetchResult{}, err
	}
	if err := s.validateLyricsFetchAudio(ctx, target.WorkID, assignments); err != nil {
		return lyricsFetchResult{}, err
	}
	source, tracks, err := s.lyricsFetchRemoteTree(ctx, payload.SourceID, remoteCode)
	if err != nil {
		return lyricsFetchResult{}, err
	}
	remoteFiles, err := selectLyricsFetchFiles(tracks, files, source)
	if err != nil {
		return lyricsFetchResult{}, err
	}
	folder, err := s.downloadAndPublishLyrics(ctx, source, target, remoteFiles, lyricsFolderName(language, remoteCode, time.Now()))
	if err != nil {
		return lyricsFetchResult{}, err
	}
	if err := s.indexLocalMediaForWork(ctx, target.WorkID, target.FileSourceID, target.RootPath); err != nil {
		return lyricsFetchResult{}, err
	}
	assigned, err := s.assignFetchedLyrics(ctx, userID, target.WorkID, folder, assignments)
	if err != nil {
		return lyricsFetchResult{}, err
	}
	return lyricsFetchResult{WorkID: target.WorkID, Folder: folder, Downloaded: len(remoteFiles), Assigned: assigned}, nil
}

// lyricsFetchEditionLanguage confirms that the remote code is an edition of
// the requested work's family and returns its declared language.
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
	return language, err
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

// selectLyricsFetchFiles resolves each requested path in the remote tree and
// checks its URL against the source's outbound policy before any download.
func selectLyricsFetchFiles(tracks []kikoeru.Track, paths []string, source remoteSourceForUse) ([]lyricsFetchFile, error) {
	available := map[string]string{}
	collectLyricsTrackURLs(tracks, "", available)
	result := make([]lyricsFetchFile, 0, len(paths))
	for _, remotePath := range paths {
		rawURL, ok := available[remotePath]
		if !ok {
			return nil, lyricsFetchRequestError{status: http.StatusNotFound, message: "a selected lyrics file is no longer on the source"}
		}
		parsed, err := url.Parse(rawURL)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || !remotePreviewURLAllowed(parsed, source) {
			return nil, lyricsFetchRequestError{status: http.StatusBadGateway, message: "a lyrics file URL is not allowed by the source policy"}
		}
		result = append(result, lyricsFetchFile{RemotePath: remotePath, URL: parsed.String()})
	}
	return result, nil
}

func collectLyricsTrackURLs(nodes []kikoeru.Track, basePath string, result map[string]string) {
	for index, node := range nodes {
		nodePath := remoteTrackPath(basePath, remoteTrackName(node.Title, index))
		if len(node.Children) > 0 || remoteTrackKindForPath(node.Type, nodePath) == "folder" {
			collectLyricsTrackURLs(node.Children, nodePath, result)
			continue
		}
		if mediaKindFromPath(nodePath) != "text" {
			continue
		}
		if value := firstNonEmpty(node.MediaDownloadURL, node.MediaStreamURL); value != "" {
			result[nodePath] = value
		}
	}
}

// lyricsFolderName is unique per second and readable in a file manager, for
// example "Lyrics - CHI_HANS - RJ00000001 - 20261008-153012".
func lyricsFolderName(language string, code string, now time.Time) string {
	parts := []string{"Lyrics"}
	if value := lyricsFolderComponentPattern.ReplaceAllString(strings.ToUpper(strings.TrimSpace(language)), ""); value != "" {
		parts = append(parts, value)
	}
	if value := lyricsFolderComponentPattern.ReplaceAllString(strings.ToUpper(code), ""); value != "" {
		parts = append(parts, value)
	}
	parts = append(parts, now.Format("20060102-150405"))
	return strings.Join(parts, " - ")
}

// downloadAndPublishLyrics stages every file on the target's storage pool, then
// claims a new folder with an exclusive create and moves the staged files into
// it. It returns the published folder relative to the data root.
func (s *Server) downloadAndPublishLyrics(ctx context.Context, source remoteSourceForUse, target lyricsFetchTarget, files []lyricsFetchFile, folderName string) (string, error) {
	poolPath, err := s.fetchTransactionPool(ctx, target.RootPath)
	if err != nil {
		return "", err
	}
	stagingParent := path.Join(poolPath, ".kikoto-staging")
	stagingRoot, err := s.createLyricsStaging(stagingParent)
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(stagingRoot) }()

	total := int64(0)
	for _, file := range files {
		written, err := s.downloadLyricsFile(ctx, source, file.URL, filepath.Join(stagingRoot, filepath.FromSlash(file.RemotePath)))
		if err != nil {
			return "", err
		}
		total += written
		if total > maxLyricsFetchTotalBytes {
			return "", lyricsFetchBadRequest("the selected lyrics files are too large")
		}
	}
	return s.publishLyricsFolder(stagingRoot, target.RootPath, folderName, files)
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
	if err := os.MkdirAll(filepath.Dir(destination), 0o755); err != nil {
		return 0, err
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return 0, err
	}
	written, copyErr := io.Copy(output, io.LimitReader(response.Body, maxLyricsFetchFileBytes+1))
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

// publishLyricsFolder never replaces anything: os.Mkdir fails when any entry
// with the folder's name exists, so files are moved only into a folder this
// call created. A failed move removes what this call added.
func (s *Server) publishLyricsFolder(stagingRoot string, rootPath string, folderName string, files []lyricsFetchFile) (string, error) {
	rootAbsolute, err := safeDataPath(s.cfg.DataRoot, rootPath)
	if err != nil {
		return "", err
	}
	name, folderAbsolute, err := claimLyricsFolder(rootAbsolute, folderName)
	if err != nil {
		return "", err
	}
	moved := make([]string, 0, len(files))
	createdDirectories := []string{}
	rollback := func() {
		for index := len(moved) - 1; index >= 0; index-- {
			_ = os.Remove(moved[index])
		}
		for index := len(createdDirectories) - 1; index >= 0; index-- {
			_ = os.Remove(createdDirectories[index])
		}
		_ = os.Remove(folderAbsolute)
	}
	for _, file := range files {
		destination := filepath.Join(folderAbsolute, filepath.FromSlash(file.RemotePath))
		created, err := mkdirAllRecording(folderAbsolute, filepath.Dir(destination))
		createdDirectories = append(createdDirectories, created...)
		if err != nil {
			rollback()
			return "", err
		}
		if _, err := os.Lstat(destination); err == nil {
			rollback()
			return "", fmt.Errorf("lyrics file %q already exists in the new folder", file.RemotePath)
		}
		if err := os.Rename(filepath.Join(stagingRoot, filepath.FromSlash(file.RemotePath)), destination); err != nil {
			rollback()
			return "", err
		}
		moved = append(moved, destination)
	}
	return path.Join(rootPath, name), nil
}

func claimLyricsFolder(rootAbsolute string, folderName string) (string, string, error) {
	for attempt := 1; attempt <= lyricsFetchFolderAttempts; attempt++ {
		name := folderName
		if attempt > 1 {
			name = fmt.Sprintf("%s (%d)", folderName, attempt)
		}
		candidate := filepath.Join(rootAbsolute, name)
		err := os.Mkdir(candidate, 0o755)
		if err == nil {
			return name, candidate, nil
		}
		if !errors.Is(err, os.ErrExist) {
			return "", "", err
		}
	}
	return "", "", lyricsFetchRequestError{status: http.StatusConflict, message: "a lyrics folder with this name already exists"}
}

// mkdirAllRecording creates directory below base and returns the directories it
// created, outermost first, so a rollback removes only those.
func mkdirAllRecording(base string, directory string) ([]string, error) {
	relative, err := filepath.Rel(base, directory)
	if err != nil || relative == "." {
		return nil, err
	}
	created := []string{}
	current := base
	for _, part := range strings.Split(relative, string(filepath.Separator)) {
		current = filepath.Join(current, part)
		err := os.Mkdir(current, 0o755)
		if err == nil {
			created = append(created, current)
			continue
		}
		if !errors.Is(err, os.ErrExist) {
			return created, err
		}
	}
	return created, nil
}

// assignFetchedLyrics stores the requested assignments for the files the
// rescan indexed. A file the scan did not index is skipped, not an error: the
// download itself succeeded.
func (s *Server) assignFetchedLyrics(ctx context.Context, userID int64, workID int64, folder string, assignments map[int64]string) (int, error) {
	if len(assignments) == 0 {
		return 0, nil
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	assigned := 0
	for audioID, remotePath := range assignments {
		var lyricsID int64
		err := tx.QueryRowContext(ctx, `
			SELECT item.id
			FROM media_file_location AS location
			INNER JOIN media_item AS item ON item.id = location.media_item_id
			WHERE item.work_id = ?
				AND location.location_type = 'local'
				AND location.availability = 'available'
				AND location.path = ?
			ORDER BY location.id
			LIMIT 1
		`, workID, path.Join(folder, remotePath)).Scan(&lyricsID)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return 0, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO media_lyrics_assignment (audio_media_item_id, lyrics_media_item_id, origin, assigned_by_user_id)
			VALUES (?, ?, 'remote_fetch', ?)
			ON CONFLICT(audio_media_item_id) DO UPDATE SET
				lyrics_media_item_id = excluded.lyrics_media_item_id,
				origin = excluded.origin,
				assigned_by_user_id = excluded.assigned_by_user_id,
				updated_at = CURRENT_TIMESTAMP
		`, audioID, lyricsID, nullableUserID(userID)); err != nil {
			return 0, err
		}
		assigned++
	}
	return assigned, tx.Commit()
}
