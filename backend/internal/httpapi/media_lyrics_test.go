package httpapi

import "testing"

func TestLocalFileKindRecognizesSupportedLyrics(t *testing.T) {
	for _, path := range []string{"01_track.lrc", "01_track.srt", "01_track.mp3.vtt", "字幕.ass"} {
		if got := localFileKind(path); got != "text" {
			t.Fatalf("localFileKind(%q) = %q, want text", path, got)
		}
		if !isTextFile(path) {
			t.Fatalf("isTextFile(%q) = false", path)
		}
	}
}
