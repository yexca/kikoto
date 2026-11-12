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

// newRecordThumbnailer caches record thumbnails under the disposable cache
// root; without one, thumbnails are unavailable.
func newRecordThumbnailer(cacheRoot string) *record.Thumbnailer {
	if strings.TrimSpace(cacheRoot) == "" {
		return nil
	}
	return record.NewThumbnailer(filepath.Join(cacheRoot, recordThumbnailCacheDir), record.FFmpeg, recordThumbnailConcurrency)
}

func recordThumbnailSource(a record.Asset) record.ThumbnailSource {
	source := record.ThumbnailSource{AssetID: a.ID, Kind: a.Kind}
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
// the stream and a revision-keyed thumbnail for videos and images, and the
// WebVTT route for WebVTT and SubRip sidecars.
func decorateRecordAsset(a *record.Asset) {
	if a.Availability != "available" {
		return
	}
	id := strconv.FormatInt(a.ID, 10)
	switch a.Kind {
	case "video", "image":
		a.StreamURL = "/api/records/assets/" + id + "/stream"
		a.ThumbnailURL = "/api/records/assets/" + id + "/thumbnail?v=" + recordThumbnailSource(*a).Revision()
	case "subtitle":
		if record.ServesSubtitle(a.Name) {
			a.StreamURL = "/api/records/assets/" + id + "/subtitle"
		}
	}
}

// serveRecordThumbnail serves a JPEG thumbnail of a record video or image,
// made on first request. Thumbnails are made on demand rather than during the
// scan, so a scan stays a quick walk and probe, and only the folders someone
// opens pay for ffmpeg; the revision in the URL lets browsers keep them.
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
	if err != nil || (asset.Kind != "video" && asset.Kind != "image") || asset.Availability != "available" {
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
	thumbnail, err := s.recordThumbnails.Thumbnail(ctx, path, source)
	switch {
	case errors.Is(err, record.ErrThumbnailBusy), errors.Is(err, context.DeadlineExceeded):
		writeAPIError(w, http.StatusServiceUnavailable, "record_thumbnail_busy", "The record thumbnail is not ready yet.", true)
		return
	case err != nil:
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
		return
	}
	file, err := os.Open(thumbnail)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "record_thumbnail_unavailable", "The record thumbnail is unavailable.", false)
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
	if r.URL.Query().Get("v") == source.Revision() {
		w.Header().Set("Cache-Control", recordThumbnailImmutableControl)
	} else {
		w.Header().Set("Cache-Control", "private, no-cache")
	}
	http.ServeContent(w, r, "thumbnail.jpg", info.ModTime(), file)
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
