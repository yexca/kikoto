package timedtext

import (
	"reflect"
	"strings"
	"testing"
)

type row struct {
	ms   int64
	text string
}

func rows(text string) []row {
	var result []row
	for _, line := range ParseLyrics(text).Lines {
		result = append(result, row{line.TimeMS, line.Text})
	}
	return result
}

func TestParseLyricsReadsEveryLibraryFormat(t *testing.T) {
	ass := strings.Join([]string{
		"[Script Info]",
		"Title: Synthetic",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown",
		`Dialogue: 0,0:00:05.50,0:00:07.00,Default,,0,0,0,,{\an8}second, with a comma`,
		`Dialogue: 0,0:00:01.25,0:00:03.00,Default,,0,0,0,,first\Nline`,
		`Dialogue: 0,1:02:03.00,1:02:04.00,Default,,0,0,0,,{\i1}{\i0}`,
	}, "\n")
	vtt := strings.Join([]string{
		"WEBVTT",
		"",
		"00:00:01.000 --> 00:00:02.000",
		"<v Example Voice>Example</v> <i>line</i> <c.loud>one</c>",
		"",
		"00:00:03.000 --> 00:00:04.000",
		"<00:00:03.000>Example <00:00:03.500><b>line</b> <u>two</u>",
		"",
		"00:00:05.000 --> 00:00:06.000",
		"Example &amp; line &lt;3&gt; &#39;three&#x27;&nbsp;&lt;i&gt;",
	}, "\n")
	lrcWithStrayCue := "[00:01.00] Example line 1\n0:05 --> 0:06\n[00:10.00] Example line 2\n[00:20.00] Example line 3"
	lrcHeaders := strings.Join([]string{
		"[ti:Example Title]",
		"[offset:+120]",
		"[00:01.00]Example [chorus] line 1",
		"[00:02.00] [00:04.00] Example line 2 [x]",
		"[00:03.00]<00:03.00>Example <00:03.50>line 3",
		"Example line [00:09.00] without a leading stamp",
	}, "\n")
	cases := []struct {
		name  string
		input string
		want  []row
	}{
		{"LRC minute tags", "[00:01.50]first\n[01:02]second\n[01:02:50]third\n[02:03.5][02:04.250]repeated",
			[]row{{1500, "first"}, {62000, "second"}, {62500, "third"}, {123500, "repeated"}, {124250, "repeated"}}},
		{"past 99 minutes", "[99:59.00]before\n[100:00.00]after\n[125:30.25]later",
			[]row{{5_999_000, "before"}, {6_000_000, "after"}, {7_530_250, "later"}}},
		{"LRC hour field", "[00:59:59.00]before\n[01:02:03.50]after", []row{{3_599_000, "before"}, {3_723_500, "after"}}},
		{"header tags carry no time", "[ar:Example Voice]\n[al:Example Work]\n[00:01.00]line", []row{{1000, "line"}}},
		{"ASS in declared order", ass, []row{{1250, "first line"}, {5500, "second, with a comma"}}},
		{"ASS reordered fields", "Format: Start, End, Style, Text\nDialogue: 0:00:02.00,0:00:03.00,Default,reordered", []row{{2000, "reordered"}}},
		{"WebVTT and SRT cues", "WEBVTT\n\n00:01.000 --> 00:02.000\nfirst\n\n01:00:03.500 --> 01:00:04.000\nsecond\nline",
			[]row{{1000, "first"}, {3_603_500, "second line"}}},
		{"SRT", "1\n00:00:05,250 --> 00:00:06,000\ncue", []row{{5250, "cue"}}},
		{"LRC offset and bracketed text", lrcHeaders,
			[]row{{880, "Example [chorus] line 1"}, {1880, "Example line 2 [x]"}, {2880, "Example line 3"}, {3880, "Example line 2 [x]"}}},
		{"cue file keeps an LRC-looking text", "\ufeffWEBVTT\n\n00:00:01.000 --> 00:00:02.000\n[00:30.00] Example line 1",
			[]row{{1000, "[00:30.00] Example line 1"}}},
		{"SRT keeps an LRC-looking text", "1\n00:00:03,000 --> 00:00:04,000\nExample line 2 [00:40.00]\n",
			[]row{{3000, "Example line 2 [00:40.00]"}}},
		{"LRC with one stray cue timing", lrcWithStrayCue,
			[]row{{1000, "Example line 1"}, {10_000, "Example line 2"}, {20_000, "Example line 3"}}},
		{"SRT outnumbers one LRC line", "1\n00:00:03,000 --> 00:00:04,000\n[00:40.00] Example line 2\n",
			[]row{{3000, "[00:40.00] Example line 2"}}},
		{"cue markup and character references", vtt,
			[]row{{1000, "Example line one"}, {3000, "Example line two"}, {5000, "Example & line <3> 'three' <i>"}}},
		{"SRT font markup", "1\n00:00:07,000 --> 00:00:08,000\n<font color=\"#ffffff\">Example line four</font>",
			[]row{{7000, "Example line four"}}},
		{"cue hours past 99, partly matching timing skipped",
			"WEBVTT\n\n100:00:00.000 --> 100:00:01.000\nExample line 1\n\n1:000:00.000 --> 1:000:01.000\nExample line 2",
			[]row{{360_000_000, "Example line 1"}}},
		{"LRC repeated stamps, offset, and word timing",
			"[ti:Example Work]\r\n[ar:Example Voice]\r\n[offset:+120]\r\n[00:05.50]Second line\r\n[00:01.00][00:10]Chorus\r\n[00:12.25]<00:12.25>Word <00:13.00>timed\r\n",
			[]row{{880, "Chorus"}, {5380, "Second line"}, {9880, "Chorus"}, {12_130, "Word timed"}}},
		{"cues drop identifiers, settings, and voice markup",
			"WEBVTT\n\n1\n00:00:19.941 --> 00:00:21.133\nFirst cue\n\n2\n00:01:02.500 --> 00:01:05.000 align:start\n<v Example Voice>Second</v> cue",
			[]row{{19_941, "First cue"}, {62_500, "Second cue"}}},
		{"LRC hour field past 99 minutes", "[99:59.00]before\n[100:00.00]after\n[01:45:00.50]with hours",
			[]row{{5_999_000, "before"}, {6_000_000, "after"}, {6_300_500, "with hours"}}},
		{"ideographic space collapses", "[00:01.00]\u3000Example\u3000\u3000line\u3000", []row{{1000, "Example line"}}},
		{"cues are in start order", "WEBVTT\n\n00:05.000 --> 00:06.000\nlate\n\n00:01.000 --> 00:02.000\nearly",
			[]row{{1000, "early"}, {5000, "late"}}},
		{"CRLF text", "WEBVTT\r\n\r\n00:01.000 --> 00:02.000\r\nline\r\n", []row{{1000, "line"}}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := rows(c.input); !reflect.DeepEqual(got, c.want) {
				t.Fatalf("lines = %v, want %v", got, c.want)
			}
		})
	}
}

func TestParseLyricsReportsUntimedText(t *testing.T) {
	for _, text := range []string{"", "plain text\nwithout tags", "WEBVTT\n\n[00:30.00] Example line 1", "[ar:Example Voice]"} {
		if got := ParseLyrics(text); got.Timed || len(got.Lines) != 0 {
			t.Fatalf("%q read as %+v", text, got)
		}
	}
}

func TestParseLyricsAppliesTheFileOffsetTag(t *testing.T) {
	if got := rows("[offset:+500]\n[00:01.00]first\n[00:05.00]second"); !reflect.DeepEqual(got, []row{{500, "first"}, {4500, "second"}}) {
		t.Fatalf("positive offset = %v", got)
	}
	if got := rows("[00:01.00]first\n[OFFSET: -250]"); !reflect.DeepEqual(got, []row{{1250, "first"}}) {
		t.Fatalf("negative offset = %v", got)
	}
	if got := rows("[offset:5000]\n[00:01.00]first"); !reflect.DeepEqual(got, []row{{-4000, "first"}}) {
		t.Fatalf("line moved before the start = %v", got)
	}
}

func TestParseLyricsReadsTagsAndSparseStamps(t *testing.T) {
	got := ParseLyrics("[ti:Example Title]\n[ar:Example Voice]\n[offset:100]\n[tool:x]\n[by:]\n[00:01.00]line")
	if want := []Tag{{"ti", "Example Title"}, {"ar", "Example Voice"}}; !reflect.DeepEqual(got.Tags, want) || got.Sparse {
		t.Fatalf("tags = %v, sparse = %v", got.Tags, got.Sparse)
	}
	script := "one\ntwo\nthree\nfour\n[00:30.00] a stray time mark\nfive"
	if got := ParseLyrics(script); !got.Timed || !got.Sparse {
		t.Fatalf("script = %+v", got)
	}
	if got := ParseLyrics("WEBVTT\n\n00:01.000 --> 00:02.000\ntext"); got.Sparse {
		t.Fatalf("cue file is sparse: %+v", got)
	}
}

func TestSubtitleToWebVTT(t *testing.T) {
	ass := strings.Join([]string{
		"\ufeff[Script Info]",
		"Title: Synthetic",
		"",
		"[V4+ Styles]",
		"Format: Name, Fontname, Fontsize",
		"Style: Default,Arial,20",
		"",
		"[Events]",
		"Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
		"Comment: 0,0:00:00.00,0:00:01.00,Default,,0,0,0,,not shown",
		`Dialogue: 0,0:00:05.50,0:00:07.00,Default,,0,0,0,,{\an8}second, with a comma`,
		`Dialogue: 0,0:00:01.25,0:00:03.00,Default,,0,0,0,,{\i1}first{\i0}\Nline\nthree\hwords`,
		"Dialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,a < b & c --> d",
		`Dialogue: 0,1:02:03.00,1:02:04.00,Default,,0,0,0,,{\p1}{\p0}`,
	}, "\r\n")
	ssa := "[Script Info]\nFormat: Start, End, Style, Text\nDialogue: 0:00:02.00,0:00:03.00,Default,reordered {\\b1}text"
	vtt := "\ufeffWEBVTT\n\n00:01.000 --> 00:02.000 line:0\n<c.yellow>Hi</c>\n"
	cases := []struct {
		name, input, want string
		ok                bool
	}{
		{"SRT with line breaks",
			"1\r\n00:00:01,500 --> 00:00:04,000\r\n<i>Hello</i>\r\nthere\r\n\r\n2\r\n01:02:03,040 --> 01:02:05,000\r\nLater\r\n",
			"WEBVTT\n\n00:00:01.500 --> 00:00:04.000\n<i>Hello</i>\nthere\n\n01:02:03.040 --> 01:02:05.000\nLater\n", true},
		{"SRT shows text as written",
			"1\n00:00:01,000 --> 00:00:02,000\n<font color=\"#ffff00\">Tom & Jerry</font> <B>love</B> <3\nif a < b --> c > d\n",
			"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nTom &amp; Jerry <b>love</b> &lt;3\nif a &lt; b --&gt; c &gt; d\n", true},
		{"a cue without a usable end ends at the next cue",
			"1\n00:00:01,000 --> 00:00:00,000\nFirst\n\n2\n00:00:03,000 -->\nSecond\n\n3\n00:00:09,000 --> 00:00:10,000\n\n",
			"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nFirst\n\n00:00:03.000 --> 00:00:09.000\nSecond\n", true},
		{"the last cue without an end lasts five seconds", "1\n00:00:01,000 -->\nOnly\n",
			"WEBVTT\n\n00:00:01.000 --> 00:00:06.000\nOnly\n", true},
		{"a line that is only a dropped tag is left out", "1\n00:00:01,000 --> 00:00:02,000\n<font>\nText\n",
			"WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nText\n", true},
		{"WebVTT stays as written", vtt, vtt[len("\ufeff"):], true},
		{"no cues", "just some notes", "", false},
		{"ASS without dialogue", "[Script Info]\nTitle: Synthetic\n\n[Events]\n", "", false},
		{"SSA with a marked field",
			"[Events]\nFormat: Marked, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: Marked=0,0:00:02.00,0:00:04.50,Default,,0000,0000,0000,,old style",
			"WEBVTT\n\n00:00:02.000 --> 00:00:04.500\nold style\n", true},
		{"ASS keeps timing and text", ass,
			"WEBVTT\n\n00:00:01.250 --> 00:00:03.000\nfirst\nline\nthree words\n\n00:00:05.500 --> 00:00:07.000\nsecond, with a comma\n\n00:00:08.000 --> 00:00:09.000\na &lt; b &amp; c --&gt; d\n", true},
		{"SSA in declared order", ssa, "WEBVTT\n\n00:00:02.000 --> 00:00:03.000\nreordered text\n", true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := SubtitleToWebVTT(c.input)
			if ok != c.ok || (ok && got != c.want) {
				t.Fatalf("got %q, %v; want %q, %v", got, ok, c.want, c.ok)
			}
		})
	}
}
