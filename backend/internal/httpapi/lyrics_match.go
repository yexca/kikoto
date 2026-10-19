package httpapi

import (
	"regexp"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"
)

// Automatic lyrics matching by file name. This is the server copy of the
// player's rule in frontend/src/player/lyricsMatching.ts: both must accept the
// same track and lyrics pairs, so change them together.

var (
	lyricsMatchExtensions      = []string{".lrc", ".vtt", ".srt", ".ass", ".txt", ".cue"}
	lyricsMatchAudioExtensions = []string{".mp3", ".m4a", ".flac", ".wav", ".wma", ".ogg", ".opus", ".aac"}
	// sharedLyricsNames are the names of a lyrics file that serves every track
	// of its folder.
	sharedLyricsNames = map[string]bool{
		"lyrics": true, "lyric": true, "subtitle": true, "subtitles": true,
		"字幕": true, "翻译": true, "翻譯": true,
	}
)

// lyricsNameSpace is the whitespace class of the player's regular
// expressions, which is wider than RE2's ASCII-only \s.
const lyricsNameSpace = `\t\n\v\f\r\p{Z}\x{FEFF}`

var (
	// lyricsNameVariantPattern finds a sound effect or music switch, such as
	// "SEあり", "SE無し", or "BGM OFF". One lyrics file serves every variant.
	lyricsNameVariantPattern   = regexp.MustCompile(`(^|[^a-z0-9])(?:se|bgm|効果音)[` + lyricsNameSpace + `_.\-]*(?:あり|有り|有|なし|無し|無|on|off)([^a-z0-9]|$)`)
	lyricsNameDigitsPattern    = regexp.MustCompile(`[0-9]+`)
	lyricsNameBracketPattern   = regexp.MustCompile(`\[[^\]]*\]|\([^)]*\)`)
	lyricsNamePrefixPattern    = regexp.MustCompile(`^(track|tr|disc|cd)[` + lyricsNameSpace + `_.\-]*`)
	lyricsNameNumberPattern    = regexp.MustCompile(`^[0-9]+[` + lyricsNameSpace + `_.\-]*`)
	lyricsNameSeparatorPattern = regexp.MustCompile(`[` + lyricsNameSpace + `_.\-()\[\]【】「」『』]+`)
)

// lyricsTrackName is the name of an audio or video file prepared for matching.
type lyricsTrackName struct {
	directory  string
	name       string
	stem       string
	normalized string
	numbers    string
}

// lyricsCandidateName is the name of a lyrics file prepared for matching.
type lyricsCandidateName struct {
	directory string
	// base is the file name without its lyrics extension.
	base string
	// stem is base without an audio extension, as in "track.mp3.vtt".
	stem       string
	normalized string
	numbers    string
}

func isLyricsMatchPath(path string) bool {
	lower := strings.ToLower(path)
	for _, extension := range lyricsMatchExtensions {
		if strings.HasSuffix(lower, extension) {
			return true
		}
	}
	return false
}

func newLyricsTrackName(path string) lyricsTrackName {
	name := lyricsMatchFileName(path)
	stem := name
	if index := strings.LastIndex(name, "."); index > 0 {
		stem = name[:index]
	}
	return lyricsTrackName{
		directory:  lyricsMatchDirectory(path),
		name:       name,
		stem:       stem,
		normalized: normalizeLyricsMatchName(stem),
		numbers:    lyricsMatchNumbers(stem),
	}
}

func newLyricsCandidateName(path string) lyricsCandidateName {
	base := stripLyricsMatchExtension(lyricsMatchFileName(path), lyricsMatchExtensions)
	stem := stripLyricsMatchExtension(base, lyricsMatchAudioExtensions)
	return lyricsCandidateName{
		directory:  lyricsMatchDirectory(path),
		base:       base,
		stem:       stem,
		normalized: normalizeLyricsMatchName(stem),
		numbers:    lyricsMatchNumbers(stem),
	}
}

// matches reports whether the player picks this lyrics file for the track
// automatically: a sidecar or shared lyrics file in the track's folder, or a
// file with the same or the same normalized name in any folder. Names whose
// normalized forms agree but whose numbers differ, such as "01_abc" and
// "02_abc", name different tracks.
func (candidate lyricsCandidateName) matches(track lyricsTrackName) bool {
	sameDirectory := candidate.directory == track.directory
	switch {
	case sameDirectory && candidate.base == track.name:
		return true
	case candidate.stem == track.stem:
		return true
	case candidate.normalized == track.normalized && len(utf16.Encode([]rune(track.normalized))) >= 2 &&
		(candidate.numbers == "" || track.numbers == "" || candidate.numbers == track.numbers):
		return true
	default:
		return sameDirectory && sharedLyricsNames[candidate.normalized]
	}
}

func normalizeLyricsMatchName(value string) string {
	value = strings.ToLower(value)
	// Twice, so adjacent switches that share one separator both fold away.
	value = lyricsNameVariantPattern.ReplaceAllString(value, "$1$2")
	value = lyricsNameVariantPattern.ReplaceAllString(value, "$1$2")
	value = lyricsNameBracketPattern.ReplaceAllString(value, "")
	value = lyricsNamePrefixPattern.ReplaceAllString(value, "")
	value = lyricsNameNumberPattern.ReplaceAllString(value, "")
	return lyricsNameSeparatorPattern.ReplaceAllString(value, "")
}

// lyricsMatchNumbers lists the numbers of a name outside brackets without
// leading zeros, so "track 1" and "01" carry the same number.
func lyricsMatchNumbers(value string) string {
	numbers := lyricsNameDigitsPattern.FindAllString(lyricsNameBracketPattern.ReplaceAllString(value, ""), -1)
	for index, number := range numbers {
		if trimmed := strings.TrimLeft(number, "0"); trimmed != "" {
			numbers[index] = trimmed
		} else {
			numbers[index] = "0"
		}
	}
	return strings.Join(numbers, ",")
}

func stripLyricsMatchExtension(name string, extensions []string) string {
	for _, extension := range extensions {
		if strings.HasSuffix(name, extension) {
			return strings.TrimSuffix(name, extension)
		}
	}
	return name
}

// lyricsMatchKey is the form a path is compared in: slash-separated,
// composed (NFC), and lowercased, so a name macOS stored decomposed matches its
// composed form. Stored paths keep their own form.
func lyricsMatchKey(path string) string {
	return strings.ToLower(norm.NFC.String(strings.ReplaceAll(path, `\`, "/")))
}

// lyricsMatchFileName returns the last segment of path as a match key.
func lyricsMatchFileName(path string) string {
	normalized := lyricsMatchKey(path)
	parts := strings.FieldsFunc(normalized, func(char rune) bool { return char == '/' })
	if len(parts) == 0 {
		return normalized
	}
	return parts[len(parts)-1]
}

// lyricsMatchDirectory returns the folder of path as a match key.
func lyricsMatchDirectory(path string) string {
	normalized := lyricsMatchKey(path)
	if index := strings.LastIndex(normalized, "/"); index >= 0 {
		return normalized[:index]
	}
	return ""
}
