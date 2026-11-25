package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/record"
)

const (
	recordThumbnailCacheDir         = "record-thumbs"
	recordThumbnailConcurrency      = 2
	recordThumbnailRequestTimeout   = 45 * time.Second
	recordContinueDefaultLimit      = 12
	recordThumbnailImmutableControl = "private, max-age=31536000, immutable"
)

// newRecordThumbnailer caches record thumbnails in the transcode cache, so
// they share its quota, least-recently-used eviction, overview, and clear
// action; without a cache root, thumbnails are unavailable. ffmpeg writes
// into the temporary directory and only finished thumbnails enter the cache.
func (s *Server) newRecordThumbnailer(run record.FFmpegFunc) *record.Thumbnailer {
	if strings.TrimSpace(s.cfg.CacheRoot) == "" {
		return nil
	}
	dir := filepath.Join(s.cfg.CacheRoot, transcodeCacheRootRelative, recordThumbnailCacheDir)
	return record.NewThumbnailer(dir, run, recordThumbnailConcurrency,
		record.WithThumbnailWorkDir(s.cfg.TempDir), record.WithThumbnailGuard(s.guardRecordThumbnailWrite),
		record.WithThumbnailProbe(s.recordThumbnailProbe),
		// A thumbnail is made only from an online root, whose files are the
		// catalog's; the store is read on each request, as tests replace it.
		record.WithThumbnailSourceCheck(func(ctx context.Context) error { return s.recordStore.RequireOnline(ctx) }))
}

// recordThumbnailProbe reads the media details of a file whose details are
// still pending, and keeps them, so a video's thumbnail is taken a tenth of
// the way in, an audio file without cover art is known to have no thumbnail,
// and the listing shows the length.
func (s *Server) recordThumbnailProbe(ctx context.Context, assetID int64) record.ThumbnailDetails {
	asset, err := s.recordStore.ProbeIfPending(ctx, assetID)
	if err != nil || asset.ProbePending {
		return record.ThumbnailDetails{}
	}
	details := record.ThumbnailDetails{Read: true, HasCover: asset.HasCover}
	if asset.DurationSeconds != nil {
		details.DurationSeconds = *asset.DurationSeconds
	}
	return details
}

// guardRecordThumbnailWrite holds the transcode cache open and reserves bytes
// under its quota, evicting the least recently used cache files first, while a
// thumbnail is stored or pruned.
func (s *Server) guardRecordThumbnailWrite(ctx context.Context, bytes int64) (func(), error) {
	s.transcodeCacheActivityMu.RLock()
	releaseReservation, err := s.reserveTranscodeCache(ctx, bytes)
	if err != nil {
		s.transcodeCacheActivityMu.RUnlock()
		return nil, err
	}
	return func() {
		releaseReservation()
		s.transcodeCacheActivityMu.RUnlock()
	}, nil
}

// pruneRecordThumbnails removes the cached thumbnails of record assets that
// are no longer available videos or images.
func (s *Server) pruneRecordThumbnails(ctx context.Context) (int, error) {
	if s.recordThumbnails == nil {
		return 0, nil
	}
	keep, err := s.recordStore.ThumbnailAssetIDs(ctx)
	if err != nil {
		return 0, err
	}
	return s.recordThumbnails.Prune(ctx, func(assetID int64) bool {
		_, ok := keep[assetID]
		return ok
	})
}

// hasRecordThumbnail reports the assets a thumbnail is made of: videos,
// images, and audio files with embedded cover art, or whose media details are
// still to be read, as a thumbnail request reads them first.
func hasRecordThumbnail(a record.Asset) bool {
	return a.Kind == "video" || a.Kind == "image" || (a.Kind == "audio" && (a.HasCover || a.ProbePending))
}

func recordThumbnailSource(a record.Asset) record.ThumbnailSource {
	source := record.ThumbnailSource{AssetID: a.ID, Kind: a.Kind, CoverUnknown: a.Kind == "audio" && a.ProbePending}
	if a.SizeBytes != nil {
		source.SizeBytes = *a.SizeBytes
	}
	if a.MtimeNs != nil {
		source.MtimeNs = *a.MtimeNs
	}
	if a.DurationSeconds != nil {
		source.DurationSeconds = *a.DurationSeconds
	}
	return source
}

// decorateRecordAsset sets the authenticated URLs an asset is read through:
// the download of any file, the stream and a revision-keyed thumbnail for
// videos and images, the stream of audio files and the thumbnail of their
// embedded cover art, offered while it is unknown whether they have any, and
// the WebVTT route for WebVTT and SubRip sidecars.
func decorateRecordAsset(a *record.Asset) {
	if a.Availability != "available" {
		return
	}
	id := strconv.FormatInt(a.ID, 10)
	a.DownloadURL = "/api/records/assets/" + id + "/download"
	switch a.Kind {
	case "video", "image":
		a.StreamURL = "/api/records/assets/" + id + "/stream"
		a.ThumbnailURL = "/api/records/assets/" + id + "/thumbnail?v=" + recordThumbnailSource(*a).Revision()
	case "audio":
		a.StreamURL = "/api/records/assets/" + id + "/stream"
		if hasRecordThumbnail(*a) {
			a.ThumbnailURL = "/api/records/assets/" + id + "/thumbnail?v=" + recordThumbnailSource(*a).Revision()
		}
	case "subtitle":
		if record.ServesSubtitle(a.Name) {
			a.StreamURL = "/api/records/assets/" + id + "/subtitle"
		}
	}
	if a.Subtitle != nil {
		decorateRecordAsset(a.Subtitle)
	}
}

// serveRecordThumbnail serves a JPEG thumbnail of a record video, image, or
// audio file with cover art, made on first request. Thumbnails are made on demand rather than during the
// scan, so a scan stays a quick walk, and only the folders someone opens pay
// for ffmpeg; the revision in the URL lets browsers keep them.
func (s *Server) serveRecordThumbnail(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	if s.recordThumbnails == nil {
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
		return
	}
	path, asset, err := s.recordStore.AssetPath(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	}
	if err != nil || !hasRecordThumbnail(asset) || asset.Availability != "available" {
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
		return
	}
	if asset.Kind == "image" && record.ValidateImageFile(path, asset.MimeType) != nil {
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), recordThumbnailRequestTimeout)
	defer cancel()
	source := recordThumbnailSource(asset)
	file, err := s.recordThumbnails.Thumbnail(ctx, path, source)
	switch {
	case errors.Is(err, record.ErrThumbnailUnavailable):
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
		return
	case errors.Is(err, record.ErrRootOffline):
		// Nothing is made while another disk or an empty mount point may sit
		// at the root's path; the answer is not kept, so the thumbnail loads
		// once the disk is back.
		w.Header().Set("Cache-Control", "no-store")
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
		return
	case err != nil:
		// Busy generation, a timeout, and a cache that cannot make room are
		// all worth retrying.
		writeAPIError(w, http.StatusServiceUnavailable, "record_thumbnail_busy", "The record thumbnail is not ready yet.", true)
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Reading a thumbnail updates its modification time for eviction, so the
	// revision, not that time, validates a cached copy.
	w.Header().Set("ETag", strconv.Quote(source.Revision()))
	if r.URL.Query().Get("v") == source.Revision() {
		w.Header().Set("Cache-Control", recordThumbnailImmutableControl)
	} else {
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	http.ServeContent(w, r, "thumbnail.jpg", time.Time{}, file)
}

// serveRecordSubtitle serves a WebVTT or SubRip sidecar as WebVTT.
func (s *Server) serveRecordSubtitle(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	path, asset, err := s.recordStore.AssetPath(r.Context(), id)
	if errors.Is(err, sql.ErrNoRows) {
		writeAPIError(w, http.StatusNotFound, "record_asset_not_found", "Record asset not found.", false)
		return
	}
	if err != nil || asset.Kind != "subtitle" || asset.Availability != "available" || !record.ServesSubtitle(asset.Name) {
		writeAPIError(w, http.StatusNotFound, "record_subtitle_unavailable", "The record subtitle is unavailable.", false)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "record_subtitle_unavailable", "The record subtitle is unavailable.", false)
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeAPIError(w, http.StatusNotFound, "record_subtitle_unavailable", "The record subtitle is unavailable.", false)
		return
	}
	data, err := io.ReadAll(io.LimitReader(file, record.SubtitleMaxBytes+1))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "record_subtitle_unavailable", "The record subtitle is unavailable.", false)
		return
	}
	vtt, err := record.SubtitleToWebVTT(asset.Name, data)
	if err != nil {
		writeAPIError(w, http.StatusUnprocessableEntity, "record_subtitle_unsupported", "The record subtitle format is not supported.", false)
		return
	}
	w.Header().Set("Content-Type", "text/vtt; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, "subtitle.vtt", info.ModTime(), strings.NewReader(string(vtt)))
}

// listRecordContinue lists the viewer's unfinished record videos, most
// recently played first.
func (s *Server) listRecordContinue(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	limit := recordContinueDefaultLimit
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		parsed, err := strconv.Atoi(value)
		if err != nil || parsed <= 0 || parsed > record.ContinueLimitMax {
			writeAPIError(w, http.StatusBadRequest, "invalid_limit", "Invalid limit.", false)
			return
		}
		limit = parsed
	}
	assets, err := s.recordStore.ContinueWatching(r.Context(), user.ID, limit)
	if err != nil {
		writeAPIError(w, http.StatusInternalServerError, "record_continue_failed", "Continue watching could not be read.", true)
		return
	}
	for i := range assets {
		decorateRecordAsset(&assets[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"assets": assets})
}
