// Package timedtext reads timed text: the lyrics and subtitle files of a work,
// in LRC, WebVTT, SubRip, and ASS or SSA form. It is the one reader the API
// uses to give clients the timed lines of a lyrics file and the WebVTT of a
// subtitle file, so the browser never parses either format.
//
// It keeps the leniency of the files in real libraries: a WebVTT file may be
// named .txt, an LRC file may carry hour fields, a cue file may lack its
// header, and a stray line of the other format does not decide a file's
// format. Format is read from the content, never from the file name.
package timedtext

import (
	"regexp"
	"sort"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Line is one timed line of lyrics: where it starts, in milliseconds, and its
// text as a viewer reads it, on one line with markup dropped. A start before
// zero is kept, because an LRC offset can move a line before the track starts.
type Line struct {
	TimeMS int64
	Text   string
}

// Tag is a header tag of an LRC file that names the song, such as `[ti:...]`.
type Tag struct {
	Key   string
	Value string
}

// Lyrics is a lyrics file read as timed lines.
type Lyrics struct {
	// Timed is false when the text holds no timed line, so it is plain text.
	Timed bool
	// Lines are in start order; lines that start together keep file order.
	Lines []Line
	// Tags are the displayable header tags of an LRC file, in file order.
	Tags []Tag
	// Sparse reports that some lines start with LRC timestamps but fewer than
	// 60% of the text lines do, as in a script that quotes a few time marks.
	// Viewers that show a file as lyrics treat it as plain text.
	Sparse bool
}

// jsSpaceClass lists the white space a character class matches. It is the set
// JavaScript's `\s` and `trim` use, which also holds the ideographic space of
// Japanese text, so lines read the same as when the browser read them.
const jsSpaceClass = `\t\n\x0b\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

func isSpace(r rune) bool {
	switch {
	case r == '\t', r == '\n', r == '\v', r == '\f', r == '\r', r == ' ',
		r == 0xa0, r == 0x1680, r >= 0x2000 && r <= 0x200a,
		r == 0x2028, r == 0x2029, r == 0x202f, r == 0x205f, r == 0x3000, r == 0xfeff:
		return true
	}
	return false
}

func trim(text string) string { return strings.TrimFunc(text, isSpace) }

// collapse joins the words of text with single spaces.
func collapse(text string) string { return strings.Join(strings.FieldsFunc(text, isSpace), " ") }

// An LRC tag is `[mm:ss]` with an optional fraction after `.` or `:`, where the
// minute count is unbounded so a track longer than 99 minutes stays timed. A
// tag with an hour field is `[hh:mm:ss.fff]`; its fraction must follow a `.`
// so that `[mm:ss:ff]` keeps meaning minutes, seconds, and a fraction.
const lrcTimestampSource = `\[(?:(\d+):(\d{1,2}):(\d{2})\.(\d{1,3})|(\d+):(\d{2})(?:[.:](\d{1,3}))?)\]`

var (
	lrcTimestampPattern = regexp.MustCompile(lrcTimestampSource)
	lrcLineStartPattern = regexp.MustCompile(`^` + lrcTimestampSource)
	// The run of timestamp tags a timed LRC line starts with; header tags such
	// as `[ar:...]` or `[offset:...]` are not timestamps, so they carry no time.
	lrcLeadingPattern = regexp.MustCompile(`^(?:` + lrcTimestampSource + `[` + jsSpaceClass + `]*)+`)
	// The LRC `[offset:+/-ms]` header tag, in milliseconds.
	lrcOffsetPattern = regexp.MustCompile(`(?i)^\[offset:[` + jsSpaceClass + `]*([+-]?\d+)[` + jsSpaceClass + `]*\]`)
	lrcTagPattern    = regexp.MustCompile(`^\[([A-Za-z]+):(.*)\]$`)
)

// An inline timestamp tag: a WebVTT `<00:00:01.000>` karaoke stamp or an
// enhanced-LRC `<00:12.25>` word stamp.
const inlineTimestampTagSource = `\d+(?:[:]\d{2}){1,2}(?:[.:]\d{1,3})?`

var (
	inlineTimestampTagPattern = regexp.MustCompile(`<` + inlineTimestampTagSource + `>`)
	// A tag in WebVTT or SubRip cue text: a span such as `<i>`, `</b>`,
	// `<font color="...">`, `<v Speaker>`, or `<c.class>`, or an inline timestamp.
	cueTextTagPattern = regexp.MustCompile(`</?(?:[a-zA-Z][^<>]*|` + inlineTimestampTagSource + `)>`)
	characterRefs     = regexp.MustCompile(`&(?:#(\d+)|#[xX]([0-9a-fA-F]+)|([a-zA-Z]+));`)
)

// Header tags worth showing; offset, length, and tool tags only describe the file.
var displayedTagKeys = map[string]bool{"ti": true, "ar": true, "al": true, "au": true, "by": true}

// minimumStampedShare is the share of text lines that must start with an LRC
// timestamp for a file with any such line to count as LRC lyrics.
const minimumStampedShare = 0.6

var namedCharacterReferences = map[string]string{
	"amp": "&", "lt": "<", "gt": ">", "quot": `"`, "apos": "'", "nbsp": " ",
	"lrm": "\u200e", "rlm": "\u200f",
}

// ParseLyrics reads LRC, WebVTT, SubRip, and ASS or SSA text as timed lines.
// A `WEBVTT` header makes the text a cue file. Otherwise it is a cue file when
// its complete cue timing lines (`start --> end`) are at least as many as its
// lines that start with LRC timestamp tags, so a stray line of either kind does
// not decide the format; else LRC tags make it LRC, and then ASS dialogue.
func ParseLyrics(text string) Lyrics {
	text = strings.TrimPrefix(text, "\ufeff")
	sourceLines := splitLines(text)
	var lines []Line
	if !isWebVTTHeaderLine(sourceLines[0]) && !cueTimingOutnumbersLrc(sourceLines) {
		if lines = parseLRCLines(sourceLines); len(lines) == 0 {
			lines = parseASSLines(sourceLines)
		}
	}
	if len(lines) == 0 {
		for _, cue := range parseCueBlocks(sourceLines) {
			lines = append(lines, Line{TimeMS: cue.StartMS, Text: collapse(cuePlainText(cue.Lines))})
		}
	}
	if len(lines) == 0 {
		return Lyrics{}
	}
	sort.SliceStable(lines, func(i, j int) bool { return lines[i].TimeMS < lines[j].TimeMS })
	tags, sparse := lrcDetails(sourceLines)
	return Lyrics{Timed: true, Lines: lines, Tags: tags, Sparse: sparse}
}

// splitLines splits text at `\n`, dropping the `\r` before it, so a lone `\r`
// stays inside its line.
func splitLines(text string) []string {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		lines[i] = strings.TrimSuffix(line, "\r")
	}
	return lines
}

func isWebVTTHeaderLine(line string) bool {
	return line == "WEBVTT" || strings.HasPrefix(line, "WEBVTT ") || strings.HasPrefix(line, "WEBVTT\t")
}

// lrcDetails reads the header tags of an LRC file and whether its stamped
// lines are too few among its text lines for it to be LRC lyrics.
func lrcDetails(sourceLines []string) ([]Tag, bool) {
	var tags []Tag
	textLines, stampedLines := 0, 0
	for _, raw := range sourceLines {
		line := trim(raw)
		if line == "" {
			continue
		}
		if match := lrcTagPattern.FindStringSubmatch(line); match != nil {
			key, value := strings.ToLower(match[1]), trim(match[2])
			if displayedTagKeys[key] && value != "" {
				tags = append(tags, Tag{Key: key, Value: value})
			}
			continue
		}
		textLines++
		if lrcLineStartPattern.MatchString(line) {
			stampedLines++
		}
	}
	// Cue files carry their timing in structure, so only LRC needs the share check.
	return tags, stampedLines > 0 && float64(stampedLines) < float64(textLines)*minimumStampedShare
}

// parseLRCLines reads the timed lines of an LRC file. Only the timestamp tags
// a line starts with time it; other bracketed text stays in the lyric, and
// enhanced-LRC word stamps such as `<00:12.25>` are dropped.
//
// An `[offset:ms]` header tag moves every line as LRC defines it: a positive
// offset shows each line earlier, so it is subtracted from the timestamps. A
// line moved before the start keeps its negative time.
func parseLRCLines(sourceLines []string) []Line {
	var offsetMS int64
	for _, raw := range sourceLines {
		if match := lrcOffsetPattern.FindStringSubmatch(trim(raw)); match != nil {
			if value, err := strconv.ParseInt(match[1], 10, 64); err == nil {
				offsetMS = value
			}
		}
	}
	var lines []Line
	for _, raw := range sourceLines {
		line := trim(raw)
		leading := lrcLeadingPattern.FindString(line)
		if leading == "" {
			continue
		}
		// A stamp later in the line, such as the end time some karaoke tools
		// write, times nothing and is not lyric text.
		rest := lrcTimestampPattern.ReplaceAllString(line[len(leading):], "")
		text := collapse(inlineTimestampTagPattern.ReplaceAllString(rest, ""))
		for _, match := range lrcTimestampPattern.FindAllStringSubmatch(leading, -1) {
			var ms int64
			if match[1] != "" {
				ms = number(match[1])*3_600_000 + clockMS(match[2], match[3], match[4])
			} else {
				ms = clockMS(match[5], match[6], match[7])
			}
			lines = append(lines, Line{TimeMS: ms - offsetMS, Text: text})
		}
	}
	return lines
}

// number reads a run of digits, saturating so that an absurd count cannot
// overflow the millisecond arithmetic that follows.
func number(digits string) int64 {
	const limit = 1 << 31
	value, err := strconv.ParseInt(digits, 10, 64)
	if err != nil || value > limit {
		return limit
	}
	return value
}

// clockMS is minutes, seconds, and a decimal fraction as milliseconds. The
// fraction keeps its first three digits, padded on the right, so `.5` is 500.
func clockMS(minutes, seconds, fraction string) int64 {
	for len(fraction) < 3 {
		fraction += "0"
	}
	return number(minutes)*60_000 + number(seconds)*1000 + number(fraction[:3])
}

// cuePlainText is the text of WebVTT or SubRip cue lines as a viewer reads it,
// the lines joined by spaces: tags are dropped, so a voice span keeps its text
// but not its speaker, and character references such as `&amp;` or `&#39;` are
// decoded.
func cuePlainText(lines []string) string {
	plain := make([]string, len(lines))
	for i, line := range lines {
		line = cueTextTagPattern.ReplaceAllString(line, "")
		plain[i] = characterRefs.ReplaceAllStringFunc(line, decodeCharacterReference)
	}
	return strings.Join(plain, " ")
}

func decodeCharacterReference(reference string) string {
	match := characterRefs.FindStringSubmatch(reference)
	if match[3] != "" {
		if decoded, ok := namedCharacterReferences[match[3]]; ok {
			return decoded
		}
		return reference
	}
	var codePoint int64
	var err error
	if match[1] != "" {
		codePoint, err = strconv.ParseInt(match[1], 10, 64)
	} else {
		codePoint, err = strconv.ParseInt(match[2], 16, 64)
	}
	if err != nil || codePoint <= 0 || codePoint > 0x10ffff || !utf8.ValidRune(rune(codePoint)) {
		return reference
	}
	return string(rune(codePoint))
}
