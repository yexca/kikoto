package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

func (s *Server) ensureLocalMediaIndexed(ctx context.Context, workID int64) error {
	if s.cfg.IsDemo() {
		return nil
	}
	var existing int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM media_item AS item
		INNER JOIN media_file_location AS location ON location.media_item_id = item.id
		WHERE item.work_id = ?
			AND location.location_type = 'local'
			AND location.availability = 'available'
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
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	if relPath == "" {
		return nil
	}
	indexKey := fmt.Sprintf("%d:%d:%s", workID, fileSourceID, relPath)
	s.localMediaIndexMu.Lock()
	if s.localMediaIndexes == nil {
		s.localMediaIndexes = map[string]*localMediaIndexCall{}
	}
	if call, ok := s.localMediaIndexes[indexKey]; ok {
		s.localMediaIndexMu.Unlock()
		select {
		case <-call.done:
			return call.err
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	call := &localMediaIndexCall{done: make(chan struct{})}
	s.localMediaIndexes[indexKey] = call
	s.localMediaIndexMu.Unlock()

	call.err = s.indexLocalMediaForWorkOnce(ctx, workID, fileSourceID, relPath)
	s.localMediaIndexMu.Lock()
	delete(s.localMediaIndexes, indexKey)
	close(call.done)
	s.localMediaIndexMu.Unlock()
	return call.err
}

func (s *Server) indexLocalMediaForWorkOnce(ctx context.Context, workID int64, fileSourceID int64, relPath string) error {
	startedAt := time.Now()
	relPath = filepath.ToSlash(strings.TrimSpace(relPath))
	if relPath == "" {
		return nil
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
	if _, err := markMissingLocalLocationsForWork(ctx, tx, workID, fileSourceID, seenPaths); err != nil {
		return err
	}
	return tx.Commit()
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
