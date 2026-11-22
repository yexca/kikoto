package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/record"
)

// Record videos and audio files play through the same pipeline as library
// media: playback info chooses direct playback, a remux, or a transcode, and
// the HLS, subtitle, and transcode cache rules are those of library media.
// Their cache directories and URLs are their own, so a record asset never
// shares a revision with a library location.

const recordPlaybackRevisionTag = "record"

// loadRecordPlaybackSource loads an available record video or audio file for
// requestedProfile: empty for its own kind, or "audio" for the audio of a
// video.
func (s *Server) loadRecordPlaybackSource(ctx context.Context, id int64, requestedProfile string) (hlsPlaybackSource, error) {
	path, asset, err := s.recordStore.AssetPath(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	if err != nil {
		return hlsPlaybackSource{}, err
	}
	if (asset.Kind != "video" && asset.Kind != "audio") || asset.Availability != "available" {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	probe, err := s.probePlaybackFile(ctx, path)
	if err != nil {
		return hlsPlaybackSource{}, err
	}
	// Playback has read the file in full, so a file the probe workflow has not
	// reached yet keeps its length, dimensions, and codecs from this read.
	if output, err := json.Marshal(probe); err == nil {
		if err := s.recordStore.RecordProbe(ctx, id, info.Size(), info.ModTime().UnixNano(), output); err != nil && ctx.Err() == nil {
			slog.Warn("record playback could not keep the media details it read", "asset_id", id, "error", err)
		}
	}
	profile, encode, profileVersion, ok := hlsPlaybackProfile(asset.Kind, requestedProfile)
	if !ok {
		return hlsPlaybackSource{}, errHLSMediaNotFound
	}
	if firstPlaybackStream(probe, profile) == nil {
		return hlsPlaybackSource{}, errHLSMediaUnsupported
	}
	duration, _ := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64)
	if duration <= 0 && asset.DurationSeconds != nil {
		duration = *asset.DurationSeconds
	}
	if duration <= 0 || duration > hlsMaximumDurationSeconds || math.IsNaN(duration) || math.IsInf(duration, 0) {
		return hlsPlaybackSource{}, errHLSMediaUnsupported
	}
	revisionInput := fmt.Sprintf("%s\x00%s\x00%d\x00%s\x00%d\x00%d", profileVersion, recordPlaybackRevisionTag, id,
		filepath.ToSlash(asset.RelativePath), info.Size(), info.ModTime().UnixNano())
	revision := sha256.Sum256([]byte(revisionInput))
	return hlsPlaybackSource{
		Path:     path,
		Profile:  profile,
		Encode:   encode,
		Revision: fmt.Sprintf("%x", revision[:12]),
		Duration: duration,
		Probe:    probe,
		CacheKey: recordPlaybackCacheKey(id),
		Route:    "/api/records/assets/" + strconv.FormatInt(id, 10),
	}, nil
}

// prefetchRecordVideoKeyframes queues the videos of an opened record folder
// for a keyframe scan, as opening a work does for its videos, so a video that
// needs a remux, such as an MPEG-TS recording, finds its index ready.
func (s *Server) prefetchRecordVideoKeyframes(assets []record.Asset) {
	var videos []videoKeyframePrefetchItem
	for _, asset := range assets {
		if asset.Kind != "video" || asset.Availability != "available" {
			continue
		}
		id := asset.ID
		videos = append(videos, videoKeyframePrefetchItem{
			key: recordPlaybackCacheKey(id),
			load: func(ctx context.Context) (hlsPlaybackSource, error) {
				return s.loadRecordPlaybackSource(ctx, id, "")
			},
		})
	}
	s.queueVideoKeyframePrefetch(videos)
}

func recordPlaybackCacheKey(id int64) string { return "record-" + strconv.FormatInt(id, 10) }

// getRecordPlaybackInfo answers how a record video or audio file plays. The
// profile query "audio" plays only the audio of a video. Audio, a video's
// included, plays directly when the client decodes its first audio stream, and
// otherwise as an audio HLS encode.
func (s *Server) getRecordPlaybackInfo(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	requestedProfile, ok := parseRequestedPlaybackProfile(w, r)
	if !ok {
		return
	}
	source, err := s.loadRecordPlaybackSource(r.Context(), id, requestedProfile)
	if err != nil {
		s.writeHLSPlaybackError(w, err, "media")
		return
	}
	if source.Profile == playbackProfileVideo {
		s.writeVideoPlaybackInfo(w, r, source)
		return
	}
	if source.Profile == playbackProfileAudio && !forcePlaybackTranscode(r) {
		if _, direct := directPlaybackContentType(source.Probe, playbackProfileAudio, playbackCapabilities(r)); direct {
			writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
				Delivery: "direct", Conversion: "none", URL: source.route() + "/stream",
				DurationSeconds: source.Duration, Seekable: true,
			})
			return
		}
	}
	writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
		Delivery:        "hls",
		Conversion:      "transcode",
		URL:             fmt.Sprintf("%s/hls/index.m3u8?v=%s&profile=%s", source.route(), source.Revision, playbackProfileAudio),
		DurationSeconds: source.Duration,
		Seekable:        true,
	})
}

// serveRecordHLS serves the HLS playlist and segments of a record video or
// audio file, as serveMediaHLS does for library media.
func (s *Server) serveRecordHLS(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	file, segmentMatch, ok := parseHLSResourceFile(w, r)
	if !ok {
		return
	}
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	requestedProfile, ok := parseRequestedPlaybackProfile(w, r)
	if !ok {
		return
	}
	source, err := s.loadRecordPlaybackSource(r.Context(), id, requestedProfile)
	if err != nil {
		s.writeHLSPlaybackError(w, err, "media")
		return
	}
	s.serveHLSResource(w, r, source, file, segmentMatch, requestedProfile)
}

// serveRecordEmbeddedSubtitle serves an embedded text subtitle stream of a
// record video as WebVTT, as serveVideoSubtitle does for library media.
func (s *Server) serveRecordEmbeddedSubtitle(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	match := videoSubtitleFilePattern.FindStringSubmatch(strings.TrimSpace(r.PathValue("file")))
	if match == nil {
		writeAPIError(w, http.StatusNotFound, "subtitle_not_found", "subtitle was not found", false)
		return
	}
	stream, _ := strconv.Atoi(match[1])
	id, ok := parseRecordID(r)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_asset_id", "Invalid record asset.", false)
		return
	}
	source, err := s.loadRecordPlaybackSource(r.Context(), id, "")
	if err == nil && source.Profile != playbackProfileVideo {
		err = errHLSMediaNotFound
	}
	if err != nil {
		s.writeHLSPlaybackError(w, err, playbackProfileVideo)
		return
	}
	s.serveVideoSubtitleStream(w, r, source, stream)
}

// downloadRecordAsset sends any available record file as an attachment.
func (s *Server) downloadRecordAsset(w http.ResponseWriter, r *http.Request) {
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
	if err != nil || asset.Availability != "available" {
		writeAPIError(w, http.StatusNotFound, "record_asset_unavailable", "The record file is unavailable.", false)
		return
	}
	file, err := os.Open(path)
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "record_asset_unavailable", "The record file is unavailable.", false)
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		writeAPIError(w, http.StatusNotFound, "record_asset_unavailable", "The record file is unavailable.", false)
		return
	}
	setUntrustedFileHeaders(w)
	setAttachmentHeaders(w, asset.Name)
	w.Header().Set("Cache-Control", "private, no-cache")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
