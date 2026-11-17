package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"path"
	"time"

	"github.com/yexca/kikoto/backend/internal/record"
)

// recordPlaybackCacheDirs are the transcode cache directories that keep files
// under a record asset's cache key.
var recordPlaybackCacheDirs = []string{
	videoHLSProfile.cacheDir,
	audioHLSProfile.cacheDir,
	videoRemuxHLSProfile.cacheDir,
	videoKeyframeIndexCacheDir,
}

// deleteRecordAsset moves one record file into the record root's trash. The
// file's running encodes stop first, and its playback cache and thumbnails go
// with it, as do every viewer's progress and state.
func (s *Server) deleteRecordAsset(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	cacheKey := recordPlaybackCacheKey(id)
	// An encoder holds the file open, which keeps it from moving on some
	// systems; one that starts during the move is stopped afterwards.
	s.hlsSessions.stopSource(cacheKey)
	trashed, err := s.recordStore.TrashAsset(r.Context(), id, time.Now())
	switch {
	case errors.Is(err, sql.ErrNoRows):
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	case errors.Is(err, record.ErrRootOffline):
		writeAPIError(w, http.StatusConflict, "record_root_unavailable", "The record library is unavailable.", true)
		return
	case errors.Is(err, record.ErrAssetNotDeletable):
		writeAPIError(w, http.StatusConflict, "record_asset_not_deletable", "This record file cannot be deleted.", false)
		return
	case err != nil:
		slog.Error("record file deletion failed", "asset_id", id, "error", err)
		writeAPIError(w, http.StatusInternalServerError, "record_delete_failed", "The record file could not be deleted.", true)
		return
	}
	slog.Info("record file moved to trash", "asset_id", id, "user_id", user.ID, "trash_path", trashed.TrashPath)
	s.hlsSessions.stopSource(cacheKey)
	s.removeRecordCaches(r.Context(), id)
	writeJSON(w, http.StatusOK, map[string]any{"trashPath": trashed.TrashPath})
}

// deleteRecordFolder moves one record folder, other than the root, into the
// record root's trash with everything in it. Its files' encodes stop first,
// and their playback caches and thumbnails go with them, as do every
// viewer's progress and state. The answer names the files it held, so a
// client can let go of them.
func (s *Server) deleteRecordFolder(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "downloads:manage")
	if !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_folder_id", "Invalid record folder.", false)
		return
	}
	// Encoders hold files open, which keeps the folder from moving on some
	// systems; one that starts during the move is stopped afterwards.
	trashed, err := s.recordStore.TrashFolder(r.Context(), id, time.Now(), s.stopRecordSessions)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		writeAPIError(w, http.StatusNotFound, "record_folder_not_found", "Record folder not found.", false)
		return
	case errors.Is(err, record.ErrRootOffline):
		writeAPIError(w, http.StatusConflict, "record_root_unavailable", "The record library is unavailable.", true)
		return
	case errors.Is(err, record.ErrFolderNotDeletable):
		writeAPIError(w, http.StatusConflict, "record_folder_not_deletable", "This record folder cannot be deleted.", false)
		return
	case err != nil:
		slog.Error("record folder deletion failed", "folder_id", id, "error", err)
		writeAPIError(w, http.StatusInternalServerError, "record_delete_failed", "The record folder could not be deleted.", true)
		return
	}
	slog.Info("record folder moved to trash", "folder_id", id, "user_id", user.ID, "files", len(trashed.AssetIDs), "trash_path", trashed.TrashPath)
	s.stopRecordSessions(trashed.AssetIDs)
	for _, assetID := range trashed.AssetIDs {
		s.removeRecordCaches(r.Context(), assetID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"trashPath": trashed.TrashPath, "assetIds": trashed.AssetIDs})
}

func (s *Server) stopRecordSessions(assetIDs []int64) {
	for _, assetID := range assetIDs {
		s.hlsSessions.stopSource(recordPlaybackCacheKey(assetID))
	}
}

// removeRecordCaches removes a record asset's playback cache and thumbnails.
// What stays behind is evicted with the rest of the transcode cache.
func (s *Server) removeRecordCaches(ctx context.Context, id int64) {
	if s.cfg.CacheRoot == "" {
		return
	}
	cacheKey := recordPlaybackCacheKey(id)
	s.transcodeCacheActivityMu.RLock()
	for _, dir := range recordPlaybackCacheDirs {
		if _, err := removeDestructiveTree(s.cfg.CacheRoot, path.Join(transcodeCacheRootRelative, dir, cacheKey)); err != nil {
			slog.Warn("record playback cache cleanup failed", "asset_id", id, "error", err)
		}
	}
	s.transcodeCacheActivityMu.RUnlock()
	if s.recordThumbnails != nil {
		if err := s.recordThumbnails.Remove(ctx, id); err != nil {
			slog.Warn("record thumbnail cleanup failed", "asset_id", id, "error", err)
		}
	}
}
