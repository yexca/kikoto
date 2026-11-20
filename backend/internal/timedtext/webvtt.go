package timedtext

import (
	"fmt"
	"regexp"
	"sort"
	"strings"
)

// Cue is a timed block of subtitle text: its start, its end when the source
// gives one, and its text lines in WebVTT cue text.
type Cue struct {
	StartMS int64
	// EndMS is meaningful only when HasEnd is set.
	EndMS  int64
	HasEnd bool
	Lines  []string
}

// A cue timestamp has an hour field of any width, two-digit minutes and
// seconds, and an optional fraction; a timing line starts with the cue's start.
// A timestamp only matches whole, so `100:00:00.000` is 100 hours.
const cueTimestampSource = `(?:\d+:)?\d{1,2}:\d{2}(?:[,.]\d{1,3})?`

var (
	cueTimingStartPattern = regexp.MustCompile(`^[` + jsSpaceClass + `]*(` + cueTimestampSource + `)[` + jsSpaceClass + `]*-->`)
	cueTimingEndPattern   = regexp.MustCompile(`^[` + jsSpaceClass + `]*(` + cueTimestampSource + `)`)
	webVTTHeaderPattern   = regexp.MustCompile(`^WEBVTT(?:[ \t]|\r?\n|$)`)
	assFilePattern        = regexp.MustCompile(`(?mi)^[ \t]*\[(?:Script Info|Events)\][ \t]*\r?$`)
	sharedTagPattern      = regexp.MustCompile(`(?i)^<(/?)([ibu])>$`)
)

// cueTiming reads a cue timing line: its start and, when a complete timestamp
// follows `-->`, its end.
func cueTiming(line string) (start, end int64, hasEnd, ok bool) {
	match := cueTimingStartPattern.FindStringSubmatchIndex(line)
	if match == nil {
		return 0, 0, false, false
	}
	start = cueTimestampMS(line[match[2]:match[3]])
	rest := line[match[1]:]
	if endMatch := cueTimingEndPattern.FindStringSubmatchIndex(rest); endMatch != nil {
		// A timestamp that runs on into more digits, colons, or dots is not an end.
		if endMatch[1] == len(rest) || !strings.ContainsRune("0123456789:,.", rune(rest[endMatch[1]])) {
			return start, cueTimestampMS(rest[endMatch[2]:endMatch[3]]), true, true
		}
	}
	return start, 0, false, true
}

// cueTimestampMS reads `[hh:]mm:ss[.fff]`, with `,` allowed before the fraction.
func cueTimestampMS(value string) int64 {
	value = strings.Replace(value, ",", ".", 1)
	seconds, fraction, _ := strings.Cut(value, ".")
	parts := strings.Split(seconds, ":")
	var hours, minutes string
	switch len(parts) {
	case 3:
		hours, minutes, seconds = parts[0], parts[1], parts[2]
	default:
		minutes, seconds = parts[0], parts[1]
	}
	ms := number(minutes)*60_000 + number(seconds)*1000
	if hours != "" {
		ms += number(hours) * 3_600_000
	}
	for len(fraction) < 3 {
		fraction += "0"
	}
	return ms + number(fraction[:3])
}

// cueTimingOutnumbersLrc reports whether complete cue timing lines are at
// least as many as lines that start with LRC timestamps, and there is one.
func cueTimingOutnumbersLrc(sourceLines []string) bool {
	cueTimings, lrcLines := 0, 0
	for _, line := range sourceLines {
		if _, _, hasEnd, ok := cueTiming(line); ok && hasEnd {
			cueTimings++
		} else if lrcLineStartPattern.MatchString(trim(line)) {
			lrcLines++
		}
	}
	return cueTimings > 0 && cueTimings >= lrcLines
}

// parseCueBlocks reads the cues of a WebVTT or SubRip file in file order. A
// cue runs from its timing line to the next blank line, so cue identifiers,
// numbers, notes, and settings after the timing are not text.
func parseCueBlocks(sourceLines []string) []Cue {
	var cues []Cue
	for index := 0; index < len(sourceLines); index++ {
		start, end, hasEnd, ok := cueTiming(sourceLines[index])
		if !ok {
			continue
		}
		var lines []string
		for index++; index < len(sourceLines) && trim(sourceLines[index]) != ""; index++ {
			lines = append(lines, trim(sourceLines[index]))
		}
		cues = append(cues, Cue{StartMS: start, EndMS: end, HasEnd: hasEnd, Lines: lines})
	}
	return cues
}

// ASS and SSA

// The [Events] fields of an ASS or SSA subtitle when the file declares no
// Format line; Text is always last and may itself contain commas.
var defaultASSEventFields = []string{"layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"}

var (
	assTimePattern     = regexp.MustCompile(`^(\d+):(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$`)
	assOverridePattern = regexp.MustCompile(`\{[^}]*\}`)
	assLineBreak       = regexp.MustCompile(`\\[Nn]`)
)

type assDialogue struct {
	startMS int64
	endMS   int64
	hasEnd  bool
	text    string
}

// parseASSEvents reads the Dialogue events of an ASS or SSA subtitle in file
// order, with the raw text of each, which may still hold override tags.
func parseASSEvents(sourceLines []string) []assDialogue {
	fields := defaultASSEventFields
	var events []assDialogue
	for _, raw := range sourceLines {
		line := trim(raw)
		separator := strings.Index(line, ":")
		if separator < 0 {
			continue
		}
		kind := strings.ToLower(trim(line[:separator]))
		body := trim(line[separator+1:])
		if kind == "format" {
			declared := strings.Split(body, ",")
			for i, field := range declared {
				declared[i] = strings.ToLower(trim(field))
			}
			if indexOf(declared, "start") >= 0 && declared[len(declared)-1] == "text" {
				fields = declared
			}
			continue
		}
		if kind != "dialogue" {
			continue
		}
		values := strings.Split(body, ",")
		if len(values) < len(fields) {
			continue
		}
		startMS, ok := assTimestampMS(trim(values[indexOf(fields, "start")]))
		if !ok {
			continue
		}
		event := assDialogue{startMS: startMS, text: strings.Join(values[len(fields)-1:], ",")}
		if endIndex := indexOf(fields, "end"); endIndex >= 0 {
			event.endMS, event.hasEnd = assTimestampMS(trim(values[endIndex]))
		}
		events = append(events, event)
	}
	return events
}

func indexOf(values []string, want string) int {
	for i, value := range values {
		if value == want {
			return i
		}
	}
	return -1
}

func assTimestampMS(value string) (int64, bool) {
	match := assTimePattern.FindStringSubmatch(value)
	if match == nil {
		return 0, false
	}
	return number(match[1])*3_600_000 + clockMS(match[2], match[3], match[4]), true
}

// assTextLines is the lines of ASS dialogue text: override tags such as
// `{\an8}` are dropped, `\N` and `\n` break the line, and `\h` is a space.
func assTextLines(text string) []string {
	text = strings.ReplaceAll(assOverridePattern.ReplaceAllString(text, ""), `\h`, " ")
	var lines []string
	for _, line := range assLineBreak.Split(text, -1) {
		if line = collapse(line); line != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func parseASSLines(sourceLines []string) []Line {
	var lines []Line
	for _, event := range parseASSEvents(sourceLines) {
		if text := strings.Join(assTextLines(event.text), " "); text != "" {
			lines = append(lines, Line{TimeMS: event.startMS, Text: text})
		}
	}
	return lines
}

// parseASSCues reads the Dialogue lines of an ASS or SSA subtitle as cues in
// start order, keeping only their timing and text. Styles and positions are
// dropped, and the text is escaped so a `<` or `&` in it shows as written.
func parseASSCues(sourceLines []string) []Cue {
	var cues []Cue
	for _, event := range parseASSEvents(sourceLines) {
		lines := assTextLines(event.text)
		if len(lines) == 0 {
			continue
		}
		for i, line := range lines {
			lines[i] = escapeCueText(line)
		}
		cues = append(cues, Cue{StartMS: event.startMS, EndMS: event.endMS, HasEnd: event.hasEnd, Lines: lines})
	}
	sort.SliceStable(cues, func(i, j int) bool { return cues[i].StartMS < cues[j].StartMS })
	return cues
}

// WebVTT output

func escapeCueText(text string) string {
	return strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;").Replace(text)
}

// srtCueTextToWebVTT is one line of SubRip cue text as WebVTT cue text: the
// `<i>`, `<b>`, and `<u>` markup the formats share is kept, other tags such as
// `<font>` and inline timestamps are dropped, and every other `<`, `>`, and
// `&` is escaped so it shows as written.
func srtCueTextToWebVTT(line string) string {
	var out strings.Builder
	last := 0
	for _, tag := range cueTextTagPattern.FindAllStringIndex(line, -1) {
		out.WriteString(escapeCueText(line[last:tag[0]]))
		if shared := sharedTagPattern.FindStringSubmatch(line[tag[0]:tag[1]]); shared != nil {
			out.WriteString("<" + shared[1] + strings.ToLower(shared[2]) + ">")
		}
		last = tag[1]
	}
	out.WriteString(escapeCueText(line[last:]))
	return out.String()
}

// A cue whose timing line names no usable end shows until the next cue, or this long.
const fallbackCueMS = 5000

// RenderWebVTT writes cues as a WebVTT file, the one subtitle format every
// browser's `<track>` element reads. Cue lines are written as given, already
// in WebVTT cue text, and keep their line breaks; a cue with no text is left
// out. It reports whether any cue was written.
func RenderWebVTT(cues []Cue) (string, bool) {
	var out strings.Builder
	out.WriteString("WEBVTT")
	written := false
	for index, cue := range cues {
		var lines []string
		for _, line := range cue.Lines {
			if strings.TrimSpace(line) != "" {
				lines = append(lines, strings.ReplaceAll(line, "-->", "--&gt;"))
			}
		}
		if len(lines) == 0 {
			continue
		}
		end := cue.StartMS + fallbackCueMS
		if cue.HasEnd && cue.EndMS > cue.StartMS {
			end = cue.EndMS
		} else {
			for _, next := range cues[index+1:] {
				if next.StartMS > cue.StartMS {
					end = next.StartMS
					break
				}
			}
		}
		fmt.Fprintf(&out, "\n\n%s --> %s\n%s", webVTTTimestamp(cue.StartMS), webVTTTimestamp(end), strings.Join(lines, "\n"))
		written = true
	}
	out.WriteString("\n")
	return out.String(), written
}

func webVTTTimestamp(ms int64) string {
	ms = max(0, ms)
	return fmt.Sprintf("%02d:%02d:%02d.%03d", ms/3_600_000, ms/60_000%60, ms/1000%60, ms%1000)
}

// subRipCues reads SubRip text as cues, with the `<i>`, `<b>`, and `<u>`
// markup kept and every other tag dropped.
func subRipCues(sourceLines []string) []Cue {
	cues := parseCueBlocks(sourceLines)
	for i, cue := range cues {
		lines := make([]string, len(cue.Lines))
		for j, line := range cue.Lines {
			lines[j] = srtCueTextToWebVTT(line)
		}
		cues[i].Lines = lines
	}
	return cues
}

// SubtitleToWebVTT returns a WebVTT, SubRip, or ASS or SSA subtitle as WebVTT
// for a `<track>` element: a WebVTT file stays as it is, keeping its cue
// settings and styling, SubRip cues are rewritten, and ASS or SSA dialogue
// keeps only its timing and text. It reports false when the file holds no cue.
func SubtitleToWebVTT(text string) (string, bool) {
	text = strings.TrimPrefix(text, "\ufeff")
	if webVTTHeaderPattern.MatchString(text) {
		return text, true
	}
	lines := splitLines(text)
	if assFilePattern.MatchString(text) {
		return RenderWebVTT(parseASSCues(lines))
	}
	return RenderWebVTT(subRipCues(lines))
}

// SubRipToWebVTT converts SubRip text, already known to be SubRip, to WebVTT.
// A file with no cue becomes a header alone.
func SubRipToWebVTT(text string) string {
	rendered, _ := RenderWebVTT(subRipCues(splitLines(strings.TrimPrefix(text, "\ufeff"))))
	return rendered
}
