package httpapi

import "testing"

func TestLyricsCandidateMatchesTrackLikeThePlayer(t *testing.T) {
	cases := []struct {
		name   string
		track  string
		lyrics string
		want   bool
	}{
		{"sidecar keeping the audio extension", "work/MP3/01_abc.mp3", "work/MP3/01_abc.mp3.vtt", true},
		{"same stem in the same folder", "work/main/01_abc.wav", "work/main/01_abc.srt", true},
		{"same stem in another folder", "work/main/01_abc.wav", "work/bonus/01_abc.vtt", true},
		{"same stem ignoring case and separators", `Work\Main\Track01.FLAC`, "work/main/track01.LRC", true},
		{"normalized name without track number", "work/01. Opening (v2).mp3", "work/subs/opening.vtt", true},
		{"normalized name across wide spaces", "work/01　はじまり.mp3", "work/subs/はじまり.txt", true},
		{"shared lyrics file in the track folder", "work/main/01_abc.wav", "work/main/字幕.vtt", true},
		{"shared lyrics file in another folder", "work/main/01_abc.wav", "work/lyrics.vtt", false},
		{"unrelated text file beside the track", "work/01_abc.mp3", "work/readme.txt", false},
		{"script beside the track", "work/01_abc.mp3", "work/台本.txt", false},
		{"single-character normalized name", "work/01_a.mp3", "work/subs/02_a.txt", false},
		{"different track", "work/01_abc.mp3", "work/02_def.vtt", false},
		{"same name with another track number", "work/01_abc.wav", "work/02_abc.lrc", false},
		{"same name with another part number", "work/abc 1.wav", "work/abc 2.lrc", false},
		{"sidecar keeping the AIFF extension", "work/01_abc.aiff", "work/01_abc.aiff.lrc", true},
		{"Matroska audio sidecar in another folder", "work/01_abc.mka", "work/subs/01_abc.mka.vtt", true},
		{"same track number written differently", "work/track 1 abc.wav", "work/01_abc.lrc", true},
		{"sound effect variant", "work/本編_SEあり.wav", "work/本編_SEなし.lrc", true},
		{"sound effect variant in kanji", "work/02 本編 SE有.flac", "work/subs/本編(SE無し).vtt", true},
		{"sound effect switch", "work/abc_se_on.mp3", "work/abc_SE OFF.srt", true},
		{"decomposed kana", "work/01_がっこう.mp3", "work/01_がっこう.lrc", true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := newLyricsCandidateName(testCase.lyrics).matches(newLyricsTrackName(testCase.track))
			if got != testCase.want {
				t.Fatalf("match(%q, %q) = %v, want %v", testCase.track, testCase.lyrics, got, testCase.want)
			}
		})
	}
}

func TestLyricsMatchPathAcceptsOnlyLyricsFormats(t *testing.T) {
	for path, want := range map[string]bool{
		"work/track.LRC": true, "work/track.vtt": true, "work/track.srt": true,
		"work/track.ass": true, "work/track.txt": true, "work/track.cue": true,
		"work/notes.md": false, "work/track.json": false, "work/track.mp3": false,
	} {
		if got := isLyricsMatchPath(path); got != want {
			t.Errorf("isLyricsMatchPath(%q) = %v, want %v", path, got, want)
		}
	}
}
