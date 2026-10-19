package llm

import (
	"errors"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
)

const LyricsLimit = 128 << 10
const LyricsChunkLines = 128

type LyricsLine struct {
	Prefix       string
	Text         string
	Translatable bool
}
type LyricsDocument struct {
	Format  string
	Lines   []LyricsLine
	Newline string
}

var lrcTimestamp = regexp.MustCompile(`^(?:\[\d+:\d+(?:[.:]\d+)?\])+`)
var cueTimestamp = regexp.MustCompile(`^\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}\s+-->\s+\d{1,2}:\d{2}(?::\d{2})?[.,]\d{3}`)
var lrcControlMarker = regexp.MustCompile(`\[(?:[0-9]+:|offset:|ar:|ti:|al:|by:)`)

// ParseLyrics keeps all timing, cue identifiers and metadata in the template.
// Only explicit text slots are translated; the original file is never edited.
func ParseLyrics(name, text string) (LyricsDocument, error) {
	d := LyricsDocument{Newline: "\n"}
	if len(text) > LyricsLimit {
		return d, errors.New("lyrics exceed the text limit")
	}
	if strings.Contains(text, "\r\n") {
		d.Newline = "\r\n"
	}
	lines := strings.Split(strings.ReplaceAll(strings.TrimPrefix(text, "\ufeff"), "\r\n", "\n"), "\n")
	if len(lines) > 4000 {
		return d, errors.New("lyrics have too many lines")
	}
	ext := strings.ToLower(filepath.Ext(name))
	if ext == ".txt" {
		for _, line := range lines {
			if lrcTimestamp.MatchString(line) {
				ext = ".lrc"
				break
			}
			if cueTimestamp.MatchString(strings.TrimSpace(line)) {
				ext = ".vtt"
				break
			}
		}
	}
	d.Format = ext
	if ext != ".lrc" && ext != ".srt" && ext != ".vtt" && ext != ".ass" && ext != ".ssa" && ext != ".txt" {
		return d, errors.New("unsupported lyrics format")
	}
	active := false
	for i, line := range lines {
		slot := LyricsLine{Prefix: line}
		switch ext {
		case ".lrc":
			if prefix := lrcTimestamp.FindString(line); prefix != "" {
				slot = LyricsLine{Prefix: prefix, Text: strings.TrimPrefix(line, prefix), Translatable: true}
			}
		case ".ass", ".ssa":
			if strings.HasPrefix(strings.TrimSpace(line), "Dialogue:") {
				parts := strings.SplitN(line, ",", 10)
				if len(parts) != 10 {
					return d, errors.New("invalid ASS dialogue")
				}
				slot = LyricsLine{Prefix: strings.Join(parts[:9], ",") + ",", Text: parts[9], Translatable: true}
			}
		case ".srt", ".vtt":
			if strings.TrimSpace(line) == "" {
				active = false
			} else if cueTimestamp.MatchString(strings.TrimSpace(line)) {
				active = true
			} else if active {
				slot = LyricsLine{Text: line, Translatable: true}
			}
			// A cue identifier belongs to the timeline, including numeric SRT IDs.
			if i+1 < len(lines) && cueTimestamp.MatchString(strings.TrimSpace(lines[i+1])) {
				slot = LyricsLine{Prefix: line}
			}
		case ".txt":
			slot = LyricsLine{Text: line, Translatable: true}
		}
		if strings.TrimSpace(slot.Text) == "" {
			slot = LyricsLine{Prefix: line}
		}
		if len(slot.Text) > 4096 {
			return d, errors.New("a lyrics line exceeds the text limit")
		}
		d.Lines = append(d.Lines, slot)
	}
	if len(d.Text()) == 0 {
		return d, errors.New("lyrics have no translatable text")
	}
	return d, nil
}
func (d LyricsDocument) Text() []string {
	result := []string{}
	for _, line := range d.Lines {
		if line.Translatable {
			result = append(result, line.Text)
		}
	}
	return result
}
func (d LyricsDocument) Render(translated []string) (string, error) {
	if len(translated) != len(d.Text()) {
		return "", errors.New("translation changed lyrics order")
	}
	result := make([]string, len(d.Lines))
	index := 0
	for i, line := range d.Lines {
		result[i] = line.Prefix
		if line.Translatable {
			text := translated[index]
			index++
			if strings.TrimSpace(text) == "" || strings.ContainsAny(text, "\r\n") || len(text) > 4096 {
				return "", errors.New("invalid translated lyrics line " + strconv.Itoa(index))
			}
			if d.Format == ".lrc" && lrcControlMarker.MatchString(strings.ToLower(text)) || (d.Format == ".srt" || d.Format == ".vtt") && strings.Contains(text, "-->") {
				return "", errors.New("translation introduced a timing or metadata marker")
			}
			result[i] += text
		}
	}
	text := strings.Join(result, d.Newline)
	if len(text) > LyricsLimit {
		return "", errors.New("translated lyrics exceed the text limit")
	}
	return text, nil
}
