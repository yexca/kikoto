package httpapi

import "testing"

func TestLocalAndRemoteMediaKindsRecognizeVideo(t *testing.T) {
	for _, path := range []string{"movie.mp4", "movie.m4v", "movie.webm", "movie.mkv", "movie.mov", "movie.avi"} {
		if kind := localFileKind(path); kind != "video" {
			t.Fatalf("localFileKind(%q) = %q, want video", path, kind)
		}
		if kind := mediaKindFromPath(path); kind != "video" {
			t.Fatalf("mediaKindFromPath(%q) = %q, want video", path, kind)
		}
	}
	if kind := remoteTrackKindForPath("video", "stream.bin"); kind != "video" {
		t.Fatalf("remote video kind = %q", kind)
	}
	if kind := remoteTrackKindForPath("file", "bonus/movie.mp4"); kind != "video" {
		t.Fatalf("remote extension kind = %q", kind)
	}
}

func TestParseMediaProbeOutputFindsDurationAndAudioStream(t *testing.T) {
	duration, hasAudio, ok := parseMediaProbeOutput([]byte(`{
		"streams":[{"codec_type":"video"},{"codec_type":"audio"}],
		"format":{"duration":"61.6"}
	}`))
	if !ok || !hasAudio || duration != 62 {
		t.Fatalf("probe result = duration %d, hasAudio %t, ok %t", duration, hasAudio, ok)
	}

	duration, hasAudio, ok = parseMediaProbeOutput([]byte(`{
		"streams":[{"codec_type":"video"}],
		"format":{"duration":"12.1"}
	}`))
	if !ok || hasAudio || duration != 12 {
		t.Fatalf("silent probe result = duration %d, hasAudio %t, ok %t", duration, hasAudio, ok)
	}
}
