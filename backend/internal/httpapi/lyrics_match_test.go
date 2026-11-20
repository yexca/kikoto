package httpapi

import (
	"strings"
	"testing"
)

func TestLyricsCandidateMatchesTrack(t *testing.T) {
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
		"work/track.ass": true, "work/track.ssa": true, "work/track.txt": true,
		// A CUE sheet describes tracks of a disc image; it is never lyrics.
		"work/track.cue": false,
		"work/notes.md":  false, "work/track.json": false, "work/track.mp3": false,
	} {
		if got := isLyricsMatchPath(path); got != want {
			t.Errorf("isLyricsMatchPath(%q) = %v, want %v", path, got, want)
		}
	}
}

func TestRankLyricsMatchesOrdersTheChoices(t *testing.T) {
	cases := []struct {
		name   string
		track  string
		lyrics []string
		want   []string
	}{
		{"the track's folder before another", "work/main/01_abc.wav", []string{"work/bonus/01_abc.vtt", "work/main/01_abc.srt"}, []string{"work/main/01_abc.srt", "work/bonus/01_abc.vtt"}},
		{"a shared lyrics file only in the track's folder", "work/main/01_abc.wav", []string{"work/lyrics.vtt", "work/main/字幕.vtt"}, []string{"work/main/字幕.vtt"}},
		{"the track's own sound effect variant first", "work/本編_SEあり.wav", []string{"work/本編_SEなし.lrc", "work/本編_SEあり.lrc"}, []string{"work/本編_SEあり.lrc", "work/本編_SEなし.lrc"}},
		{"never a CUE sheet", "work/01_abc.wav", []string{"work/01_abc.cue", "work/01_abc.lrc"}, []string{"work/01_abc.lrc"}},
		{"the preferred format among equal names", "work/01_abc.wav", []string{"work/01_abc.srt", "work/01_abc.vtt"}, []string{"work/01_abc.vtt", "work/01_abc.srt"}},
		{"natural path order among equal matches", "work/01_abc.wav", []string{"work/subs10/01_abc.lrc", "work/subs2/01_abc.lrc"}, []string{"work/subs2/01_abc.lrc", "work/subs10/01_abc.lrc"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			candidates := []lyricsMatchCandidate{}
			for _, path := range testCase.lyrics {
				if isLyricsMatchPath(path) {
					candidates = append(candidates, newLyricsMatchCandidate(path))
				}
			}
			got := []string{}
			for _, match := range rankLyricsMatches(testCase.track, candidates) {
				got = append(got, candidates[match.index].path)
			}
			if strings.Join(got, "|") != strings.Join(testCase.want, "|") {
				t.Fatalf("ranked = %v, want %v", got, testCase.want)
			}
		})
	}
}

func TestNaturalNameCompareReadsNumbers(t *testing.T) {
	for _, pair := range [][2]string{
		{"Track2.mp3", "Track10.mp3"},
		{"a.lrc", "B.lrc"},
		{"第二話.mp3", "第十話.mp3"},
		{"第九話.mp3", "第二十一話.mp3"},
	} {
		if naturalNameCompare(pair[0], pair[1]) >= 0 || naturalNameCompare(pair[1], pair[0]) <= 0 {
			t.Errorf("%q does not come before %q", pair[0], pair[1])
		}
	}
}
