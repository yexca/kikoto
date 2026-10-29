package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

func (s *Server) ensureLocalMediaIndexed(ctx context.Context, workID int64) error {
	if s.cfg.IsDemo() {
		return nil
	}
	if err := s.ensurePresenceFolderIndexed(ctx, workID); err != nil {
		return err
	}
	return s.indexAdditionalLocalFolders(ctx, workID, false)
}

// localWorkFolder is one active local folder of a work.
type localWorkFolder struct {
	fileSourceID int64
	root         string
}

// additionalLocalFolders lists the active local folders of a work other than
// the one its presence names. A work has them when a scan found its code in
// several folders.
func (s *Server) additionalLocalFolders(ctx context.Context, workID int64) ([]localWorkFolder, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT folder.file_source_id, folder.root_path
		FROM work_folder_location AS folder
		INNER JOIN file_source AS source ON source.id = folder.file_source_id
		WHERE folder.work_id = ?
			AND folder.state = 'active'
			AND source.source_type = 'local_folder'
			AND NOT EXISTS (
				SELECT 1
				FROM work_source_presence AS presence
				WHERE presence.work_id = folder.work_id
					AND presence.file_source_id = folder.file_source_id
					AND presence.presence_type = 'local'
					AND presence.source_url = folder.root_path
			)
		ORDER BY folder.root_path
	`, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	folders := []localWorkFolder{}
	for rows.Next() {
		var folder localWorkFolder
		if err := rows.Scan(&folder.fileSourceID, &folder.root); err != nil {
			return nil, err
		}
		if folder.root = normalizeFolderRootPath(folder.root); folder.root != "" {
			folders = append(folders, folder)
		}
	}
	return folders, rows.Err()
}

// indexAdditionalLocalFolders indexes the work's other local folders. Unless
// refresh is set, a folder that already has indexed files is left alone. A
// folder that cannot be read, such as one in an offline pool, is skipped: its
// stored files keep their state.
func (s *Server) indexAdditionalLocalFolders(ctx context.Context, workID int64, refresh bool) error {
	folders, err := s.additionalLocalFolders(ctx, workID)
	if err != nil || len(folders) == 0 {
		return err
	}
	for _, folder := range folders {
		scope, err := s.localScanScope(ctx, s.cfg.DataRoot, s.effectiveLocalScanDepth(ctx))
		if err != nil {
			return err
		}
		if !scope.contains(folder.root) {
			continue
		}
		if !refresh {
			var indexed bool
			if err := s.db.QueryRowContext(ctx, `
				SELECT EXISTS (
					SELECT 1
					FROM media_file_location AS location
					INNER JOIN media_item AS item ON item.id = location.media_item_id
					WHERE item.work_id = ?
						AND location.file_source_id = ?
						AND location.location_type = 'local'
						AND location.availability = 'available'
						AND substr(location.path, 1, length(?) + 1) = ? || '/'
				)
			`, workID, folder.fileSourceID, folder.root, folder.root).Scan(&indexed); err != nil {
				return err
			}
			if indexed {
				continue
			}
		}
		absolute, err := safeDataPath(s.cfg.DataRoot, folder.root)
		if err != nil {
			continue
		}
		if info, err := os.Stat(absolute); err != nil || !info.IsDir() {
			continue
		}
		if err := s.indexLocalMediaForWork(ctx, workID, folder.fileSourceID, folder.root); err != nil {
			return err
		}
	}
	return nil
}

// ensurePresenceFolderIndexed indexes the folder the work's local presence
// names when its files have not been indexed yet.
func (s *Server) ensurePresenceFolderIndexed(ctx context.Context, workID int64) error {
	var existing int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		INNER JOIN work_source_presence AS presence
			ON presence.work_id = item.work_id AND presence.file_source_id = location.file_source_id
		WHERE item.work_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
			AND presence.presence_type = 'local' AND presence.availability = 'available'
			AND (location.path = presence.source_url
				OR substr(location.path, 1, length(presence.source_url) + 1) = presence.source_url || '/')
	`, workID).Scan(&existing); err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	var alreadyScanned int
	if err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1
			FROM work_source_presence AS presence
			INNER JOIN file_source AS source ON source.id = presence.file_source_id
			WHERE presence.work_id = ?
				AND presence.presence_type = 'local'
				AND presence.availability = 'available'
				AND source.source_type = 'local_folder'
				AND COALESCE(json_extract(presence.raw_json, '$.file_tree_scanned'), 0) = 1
		)
	`, workID).Scan(&alreadyScanned); err != nil {
		return err
	}
	if alreadyScanned != 0 {
		return nil
	}

	var targetWorkID int64
	var fileSourceID int64
	var relPath string
	if err := s.db.QueryRowContext(ctx, `
		SELECT presence.work_id, presence.file_source_id, presence.source_url
		FROM work_source_presence AS presence
		INNER JOIN file_source AS source ON source.id = presence.file_source_id
		WHERE presence.work_id = ?
			AND presence.presence_type = 'local'
			AND presence.availability = 'available'
			AND source.source_type = 'local_folder'
		ORDER BY source.priority ASC, presence.updated_at DESC
		LIMIT 1
	`, workID).Scan(&targetWorkID, &fileSourceID, &relPath); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	// A folder on an offline pool keeps what is indexed until the pool is back.
	if availability, err := s.loadLibraryAvailability(ctx); err != nil {
		return err
	} else if !availability.readable(relPath) {
		return nil
	}
	return s.indexLocalMediaForWork(ctx, targetWorkID, fileSourceID, relPath)
}

func (s *Server) ensureLocalMediaIndexedForRequest(ctx context.Context, workID int64) (int64, error) {
	targetWorkID, err := s.resolveLocalMediaIndexWorkIDForRequest(ctx, workID)
	if err != nil {
		return 0, err
	}
	if err := s.ensureLocalMediaIndexed(ctx, targetWorkID); err != nil {
		return 0, err
	}
	return targetWorkID, nil
}

func (s *Server) resolveLocalMediaIndexWorkIDForRequest(ctx context.Context, workID int64) (int64, error) {
	if available, err := s.workHasAvailableLocalMedia(ctx, workID); err != nil {
		return 0, err
	} else if available {
		return workID, nil
	}
	canonical, err := s.workIsCanonicalEdition(ctx, workID)
	if err != nil || !canonical {
		return workID, err
	}
	var primaryCode string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code FROM work WHERE id = ?", workID).Scan(&primaryCode); err != nil {
		return 0, err
	}
	translations, err := s.loadLogicalWorkTranslations(ctx, primaryCode)
	if err != nil {
		return 0, err
	}
	for _, translation := range translations {
		if translation.WorkID == nil || *translation.WorkID == workID {
			continue
		}
		if available, err := s.workHasAvailableLocalMedia(ctx, *translation.WorkID); err != nil {
			return 0, err
		} else if available {
			return *translation.WorkID, nil
		}
	}
	if present, err := s.workHasUnindexedAvailableLocalPresence(ctx, workID); err != nil {
		return 0, err
	} else if present {
		return workID, nil
	}
	for _, translation := range translations {
		if translation.WorkID == nil || *translation.WorkID == workID {
			continue
		}
		if present, err := s.workHasUnindexedAvailableLocalPresence(ctx, *translation.WorkID); err != nil {
			return 0, err
		} else if present {
			return *translation.WorkID, nil
		}
	}
	return workID, nil
}

func (s *Server) indexLocalMediaForWork(ctx context.Context, workID int64, fileSourceID int64, relPath string) error {
	return s.indexLocalMediaForWorkGuarded(ctx, workID, fileSourceID, relPath, nil)
}

func (s *Server) indexLocalMediaForWorkGuarded(ctx context.Context, workID int64, fileSourceID int64, relPath string, guard func(context.Context) error) error {
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	// A folder recorded in a metadata directory, such as Synology's @eaDir, is
	// never a work folder: its files are not indexed and it never becomes the
	// work's primary folder. The next scan that reaches it retires it.
	if relPath == "" || localfs.IsMetadataPath(relPath) {
		return nil
	}
	if guard != nil {
		if err := guard(ctx); err != nil {
			return err
		}
	}
	indexKey := fmt.Sprintf("%d:%d:%s", workID, fileSourceID, relPath)
	s.localMediaIndexMu.Lock()
	if s.localMediaIndexes == nil {
		s.localMediaIndexes = map[string]*localMediaIndexCall{}
	}
	if call, ok := s.localMediaIndexes[indexKey]; ok {
		if guard != nil {
			call.guards = append(call.guards, guard)
		}
		s.localMediaIndexMu.Unlock()
		select {
		case <-call.done:
			if call.err == nil && guard != nil {
				return guard(ctx)
			}
			return call.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	call := &localMediaIndexCall{done: make(chan struct{})}
	if guard != nil {
		call.guards = append(call.guards, guard)
	}
	s.localMediaIndexes[indexKey] = call
	s.localMediaIndexMu.Unlock()

	checkScope := func(ctx context.Context) error {
		s.localMediaIndexMu.Lock()
		guards := append([]func(context.Context) error(nil), call.guards...)
		s.localMediaIndexMu.Unlock()
		for _, guard := range guards {
			if err := guard(ctx); err != nil {
				return err
			}
		}
		return nil
	}
	call.err = s.indexLocalMediaForWorkOnce(ctx, workID, fileSourceID, relPath, checkScope)
	s.localMediaIndexMu.Lock()
	delete(s.localMediaIndexes, indexKey)
	close(call.done)
	s.localMediaIndexMu.Unlock()
	return call.err
}

func (s *Server) indexLocalMediaForWorkOnce(ctx context.Context, workID int64, fileSourceID int64, relPath string, guard func(context.Context) error) error {
	startedAt := time.Now()
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	if relPath == "" {
		return nil
	}
	if guard != nil {
		if err := guard(ctx); err != nil {
			return err
		}
	}
	folder, collectDuration, err := s.collectLocalWorkFolder(ctx, workID, relPath)
	if err != nil {
		return err
	}
	releaseWriteSlot, writeWaitDuration, err := s.acquireLocalMediaWriteSlot(ctx)
	if err != nil {
		return err
	}
	defer releaseWriteSlot()
	if guard != nil {
		if err := guard(ctx); err != nil {
			return err
		}
	}
	writeStartedAt := time.Now()
	if err := s.persistIndexedLocalWork(ctx, workID, fileSourceID, relPath, folder); err != nil {
		return err
	}
	writeDuration := time.Since(writeStartedAt)
	if elapsed := time.Since(startedAt); elapsed >= 250*time.Millisecond {
		slog.Info("indexed local work media",
			"work_id", workID,
			"file_count", len(folder.Files),
			"collect_duration", collectDuration,
			"write_wait_duration", writeWaitDuration,
			"write_duration", writeDuration,
			"elapsed", elapsed,
		)
	}

	s.requestLocalMediaProbe()
	return nil
}

func (s *Server) collectLocalWorkFolder(ctx context.Context, workID int64, relPath string) (localfs.WorkFolder, time.Duration, error) {
	root, err := filepath.Abs(s.cfg.DataRoot)
	if err != nil {
		return localfs.WorkFolder{}, 0, err
	}
	workPath, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(relPath)))
	if err != nil {
		return localfs.WorkFolder{}, 0, err
	}
	if !isPathWithinRoot(root, workPath) {
		return localfs.WorkFolder{}, 0, fmt.Errorf("local work path escapes data root")
	}
	collectStartedAt := time.Now()
	files, err := localfs.CollectWorkFiles(root, workPath)
	if err != nil {
		return localfs.WorkFolder{}, 0, err
	}
	var code, title string
	if err := s.db.QueryRowContext(ctx, "SELECT primary_code, title FROM work WHERE id = ?", workID).Scan(&code, &title); err != nil {
		return localfs.WorkFolder{}, 0, err
	}
	return localfs.WorkFolder{
		Code: strings.ToUpper(strings.TrimSpace(code)), Title: title,
		AbsPath: workPath, RelPath: relPath, Files: files,
	}, time.Since(collectStartedAt), nil
}

// localWorkFolderReadError marks a failure to read a work folder's file tree,
// as opposed to a database failure, so a scan can skip that one folder.
type localWorkFolderReadError struct{ err error }

func (e localWorkFolderReadError) Error() string { return e.err.Error() }

func (e localWorkFolderReadError) Unwrap() error { return e.err }

func (s *Server) acquireLocalMediaWriteSlot(ctx context.Context) (func(), time.Duration, error) {
	writeWaitStartedAt := time.Now()
	s.localMediaIndexMu.Lock()
	if s.localMediaWriteSlot == nil {
		s.localMediaWriteSlot = make(chan struct{}, 1)
	}
	writeSlot := s.localMediaWriteSlot
	s.localMediaIndexMu.Unlock()
	select {
	case writeSlot <- struct{}{}:
		return func() { <-writeSlot }, time.Since(writeWaitStartedAt), nil
	case <-ctx.Done():
		return nil, 0, ctx.Err()
	}
}

func (s *Server) persistIndexedLocalWork(ctx context.Context, workID, fileSourceID int64, relPath string, folder localfs.WorkFolder) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	// One of several folders of a work only contributes its files: the scan
	// records the folder, and the presence describes the folder it names.
	var presenceRoot string
	if err := tx.QueryRowContext(ctx, `
		SELECT source_url FROM work_source_presence
		WHERE work_id = ? AND file_source_id = ? AND presence_type = 'local'
	`, workID, fileSourceID).Scan(&presenceRoot); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if normalizeFolderRootPath(presenceRoot) != "" && !sameLocalRelativePath(presenceRoot, relPath) {
		seenPaths, err := persistIndexedLocalFiles(ctx, tx, workID, fileSourceID, folder)
		if err != nil {
			return err
		}
		if _, err := markMissingLocalLocationsForWork(ctx, tx, workID, fileSourceID, seenPaths, relPath); err != nil {
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
		s.refreshQueryPlannerStatistics(ctx)
		return nil
	}
	var managedFetchRootExists bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM work_folder_location
			WHERE work_id = ? AND file_source_id = ? AND role = 'managed_fetch'
		)
	`, workID, fileSourceID).Scan(&managedFetchRootExists); err != nil {
		return err
	}
	if !managedFetchRootExists {
		if err := upsertWorkFolderLocation(ctx, tx, workID, fileSourceID, relPath, "external", "active", true); err != nil {
			return err
		}
	}
	seenPaths, err := persistIndexedLocalFiles(ctx, tx, workID, fileSourceID, folder)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET raw_json = ?,
			last_checked_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
		WHERE work_id = ?
			AND file_source_id = ?
			AND presence_type = 'local'
	`, mustJSON(map[string]any{
		"code": folder.Code, "title": folder.Title, "rel_path": filepath.ToSlash(folder.RelPath),
		"files": len(folder.Files), "file_tree_scanned": true,
		"file_tree_scanned_at": time.Now().UTC().Format("2006-01-02 15:04:05"),
	}), workID, fileSourceID); err != nil {
		return err
	}
	if _, err := markMissingLocalLocationsForWork(ctx, tx, workID, fileSourceID, seenPaths, relPath); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	s.refreshQueryPlannerStatistics(ctx)
	return nil
}

func persistIndexedLocalFiles(ctx context.Context, tx *sql.Tx, workID, fileSourceID int64, folder localfs.WorkFolder) (map[string]bool, error) {
	playableTrackNo := 1
	seenPaths := map[string]bool{}
	for _, file := range folder.Files {
		seenPaths[file.RelPath] = true
		kind := localFileKind(file.WorkRelPath)
		trackNo := 0
		if kind == "audio" || kind == "video" {
			trackNo = playableTrackNo
			playableTrackNo++
		}
		if kind == "audio" {
			hasAudio := true
			file.HasAudio = &hasAudio
		}
		mediaItemID, err := upsertDetectedMediaItem(ctx, tx, workID, folder, file, kind, trackNo)
		if err != nil {
			return nil, err
		}
		if _, err := upsertDetectedLocation(ctx, tx, mediaItemID, fileSourceID, file); err != nil {
			return nil, err
		}
	}
	return seenPaths, nil
}
