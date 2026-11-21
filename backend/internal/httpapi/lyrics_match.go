package httpapi

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"golang.org/x/text/unicode/norm"

	"github.com/yexca/kikoto/backend/internal/naturalorder"
)

// Automatic lyrics matching by file name. It ranks the lyrics choices of the
// work media and remote track responses, decides the lyrics indicator of work
// cards, and pairs added files with tracks in a lyrics edit, so every surface
// accepts the same track and lyrics pairs.

// The reasons a lyrics file is a choice of a track, strongest first.
const (
	lyricsReasonAssigned     = "assigned"
	lyricsReasonSidecar      = "exact_sidecar"
	lyricsReasonSameStem     = "same_stem"
	lyricsReasonNormalized   = "normalized_name"
	lyricsReasonSharedFolder = "shared_folder"
)

var (
	lyricsMatchExtensions      = []string{".lrc", ".vtt", ".srt", ".ass", ".ssa", ".txt"}
	lyricsMatchAudioExtensions = audioFileExtensions
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
	// format ranks the lyrics formats, so of two equal names LRC wins.
	format int
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
	name := lyricsMatchFileName(path)
	base := stripLyricsMatchExtension(name, lyricsMatchExtensions)
	stem := stripLyricsMatchExtension(base, lyricsMatchAudioExtensions)
	return lyricsCandidateName{
		directory:  lyricsMatchDirectory(path),
		base:       base,
		stem:       stem,
		normalized: normalizeLyricsMatchName(stem),
		numbers:    lyricsMatchNumbers(stem),
		format:     lyricsFormatPreference(name),
	}
}

func lyricsFormatPreference(name string) int {
	switch {
	case strings.HasSuffix(name, ".lrc"):
		return 6
	case strings.HasSuffix(name, ".vtt"):
		return 5
	case strings.HasSuffix(name, ".srt"):
		return 4
	case strings.HasSuffix(name, ".ass"), strings.HasSuffix(name, ".ssa"):
		return 3
	case strings.HasSuffix(name, ".txt"):
		return 2
	default:
		return 1
	}
}

// score reports how strongly name matching picks this lyrics file for the
// track, and why: a sidecar or shared lyrics file in the track's folder, or a
// file with the same or the same normalized name in any folder, where a file
// in the track's folder ranks above one elsewhere. Names whose normalized
// forms agree but whose numbers differ, such as "01_abc" and "02_abc", name
// different tracks. The reason is empty when the file is no match.
func (candidate lyricsCandidateName) score(track lyricsTrackName) (int, string) {
	sameDirectory := candidate.directory == track.directory
	score := 0
	if sameDirectory {
		score = 1000
	}
	var reason string
	switch {
	case sameDirectory && candidate.base == track.name:
		score, reason = score+10000, lyricsReasonSidecar
	case candidate.stem == track.stem:
		score, reason = score+7000, lyricsReasonSameStem
	case candidate.normalized == track.normalized && len(utf16.Encode([]rune(track.normalized))) >= 2 &&
		(candidate.numbers == "" || track.numbers == "" || candidate.numbers == track.numbers):
		score, reason = score+4000, lyricsReasonNormalized
	case sameDirectory && sharedLyricsNames[candidate.normalized]:
		score, reason = score+500, lyricsReasonSharedFolder
	default:
		return 0, ""
	}
	return score + candidate.format, reason
}

// matches reports whether name matching picks this lyrics file for the track.
func (candidate lyricsCandidateName) matches(track lyricsTrackName) bool {
	_, reason := candidate.score(track)
	return reason != ""
}

// lyricsMatchCandidate is a lyrics file name matching can choose, at its
// path as stored.
type lyricsMatchCandidate struct {
	path string
	name lyricsCandidateName
}

func newLyricsMatchCandidate(path string) lyricsMatchCandidate {
	return lyricsMatchCandidate{path: path, name: newLyricsCandidateName(path)}
}

// lyricsRankedMatch is one lyrics file name matching picks for a track: the
// index of its candidate and the reason.
type lyricsRankedMatch struct {
	index  int
	reason string
}

// rankLyricsMatches lists the candidates name matching picks for the track at
// trackPath, best first. Equal matches follow the natural order of their paths.
func rankLyricsMatches(trackPath string, candidates []lyricsMatchCandidate) []lyricsRankedMatch {
	track := newLyricsTrackName(trackPath)
	type scored struct {
		lyricsRankedMatch
		score int
	}
	matches := []scored{}
	for index, candidate := range candidates {
		if score, reason := candidate.name.score(track); reason != "" {
			matches = append(matches, scored{lyricsRankedMatch{index: index, reason: reason}, score})
		}
	}
	sort.SliceStable(matches, func(i, j int) bool {
		if matches[i].score != matches[j].score {
			return matches[i].score > matches[j].score
		}
		return naturalorder.Compare(candidates[matches[i].index].path, candidates[matches[j].index].path) < 0
	})
	ranked := make([]lyricsRankedMatch, len(matches))
	for index, match := range matches {
		ranked[index] = match.lyricsRankedMatch
	}
	return ranked
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
