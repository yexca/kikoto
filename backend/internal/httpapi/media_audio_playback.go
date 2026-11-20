package httpapi

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
)

// audioPlaybackDeliveryPrepared is the delivery of a complete MP3 conversion,
// which a client that cannot play HLS loads as one file.
const audioPlaybackDeliveryPrepared = "prepared"

// writeAudioPlaybackInfo answers how the audio player plays a library
// location: its own file directly, an HLS playlist the server converts as it is
// played, or one complete MP3 conversion. A video location plays only its
// audio. The probed codecs and the capabilities the client declares decide;
// the file extension decides only when the probe could not run.
//
// A "forceTranscode" request, which is the player's compatibility mode,
// skips direct playback. A client that plays audio HLS declares the
// "audio-hls" capability; without it a converted track is prepared whole.
func (s *Server) writeAudioPlaybackInfo(w http.ResponseWriter, r *http.Request, locationID int64) {
	file, err := s.loadLocalPlaybackFile(r.Context(), locationID)
	if err != nil {
		s.writeHLSPlaybackError(w, err, playbackProfileAudio)
		return
	}
	route := fmt.Sprintf("/api/media/%d", locationID)
	capabilities := playbackCapabilities(r)
	duration := 0.0
	if file.target.Duration.Valid {
		duration = float64(file.target.Duration.Int64)
	}
	if !forcePlaybackTranscode(r) {
		probe, probeErr := s.probePlaybackFile(r.Context(), file.Path)
		if probeErr == nil {
			duration = playbackDurationSeconds(file.target, probe)
			if _, direct := directPlaybackContentType(probe, playbackProfileAudio, capabilities); direct {
				query := url.Values{"profile": []string{playbackProfileAudio}}
				if values := sortedStreamCapabilities(capabilities); len(values) > 0 {
					query.Set("capabilities", strings.Join(values, ","))
				}
				writeAudioPlaybackJSON(w, "direct", "none", route+"/stream?"+query.Encode(), duration)
				return
			}
		} else {
			if errors.Is(probeErr, context.Canceled) {
				return
			}
			// Nothing was probed, so the extension is all there is to go by. A
			// file the browser then cannot decode reaches the player's
			// compatibility offer.
			if _, direct := fallbackDirectPlaybackContentType(file.Path, playbackProfileAudio); direct {
				slog.Warn("media probe failed; audio playback info uses the extension", "path", file.Path, "error", probeErr)
				query := url.Values{"profile": []string{playbackProfileAudio}, "forceDirect": []string{"1"}}
				writeAudioPlaybackJSON(w, "direct", "none", route+"/stream?"+query.Encode(), duration)
				return
			}
		}
	}
	if capabilities[capAudioHLS] {
		source, err := s.loadHLSPlaybackSourceProfile(r.Context(), locationID, playbackProfileAudio)
		if err == nil {
			writeAudioPlaybackJSON(w, "hls", "transcode",
				fmt.Sprintf("%s/hls/index.m3u8?v=%s&profile=%s", route, source.Revision, playbackProfileAudio), source.Duration)
			return
		}
		// A file that cannot be segmented can still be converted as one file.
		if !errors.Is(err, errHLSMediaUnsupported) {
			s.writeHLSPlaybackError(w, err, playbackProfileAudio)
			return
		}
	}
	query := url.Values{"profile": []string{playbackProfileAudio}, "forceTranscode": []string{"1"}}
	writeAudioPlaybackJSON(w, audioPlaybackDeliveryPrepared, "transcode", route+"/stream?"+query.Encode(), duration)
}

func writeAudioPlaybackJSON(w http.ResponseWriter, delivery string, conversion string, playURL string, duration float64) {
	writeJSON(w, http.StatusOK, videoPlaybackInfoResponse{
		Delivery: delivery, Conversion: conversion, URL: playURL,
		DurationSeconds: duration, Seekable: true,
	})
}

// sortedStreamCapabilities lists the declared capabilities that a stream
// request needs: the audio and video formats the client decodes, but not how
// it plays HLS.
func sortedStreamCapabilities(capabilities map[string]bool) []string {
	values := sortedPlaybackCapabilities(capabilities)
	kept := values[:0]
	for _, value := range values {
		if value != capAudioHLS {
			kept = append(kept, value)
		}
	}
	return kept
}
