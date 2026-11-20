package asr

import (
	"encoding/binary"
	"math"
	"strings"

	"github.com/yexca/kikoto/backend/internal/timedtext"
)

// Cue is one timed line of a transcript on the track's timeline.
type Cue struct {
	StartMS int64  `json:"s"`
	EndMS   int64  `json:"e"`
	Text    string `json:"t"`
}

// ChunkCues places the segments of one chunk on the track's timeline. Times
// outside the chunk are clamped to it, and empty passages are dropped.
func ChunkCues(segments []Segment, offsetMS int64, durationMS int64) []Cue {
	cues := []Cue{}
	for _, segment := range segments {
		text := strings.Join(strings.Fields(segment.Text), " ")
		// A cue line may not hold the timing arrow.
		text = strings.ReplaceAll(text, "-->", "->")
		if text == "" || math.IsNaN(segment.Start) || math.IsNaN(segment.End) {
			continue
		}
		start := clampMS(segment.Start, durationMS)
		end := clampMS(segment.End, durationMS)
		if start >= durationMS {
			continue
		}
		if end <= start {
			end = min(start+1000, durationMS)
		}
		cues = append(cues, Cue{StartMS: offsetMS + start, EndMS: offsetMS + end, Text: text})
	}
	return cues
}

func clampMS(seconds float64, durationMS int64) int64 {
	ms := int64(math.Round(seconds * 1000))
	return max(0, min(ms, durationMS))
}

// RenderVTT writes cues as a WebVTT document.
func RenderVTT(cues []Cue) string {
	timed := make([]timedtext.Cue, len(cues))
	for i, cue := range cues {
		timed[i] = timedtext.Cue{StartMS: cue.StartMS, EndMS: cue.EndMS, HasEnd: true, Lines: []string{cue.Text}}
	}
	vtt, _ := timedtext.RenderWebVTT(timed)
	return vtt
}

// quietWindowFrames is the length, in 100 ms frames, of the quiet stretch a
// chunk is cut in.
const quietWindowFrames = 3

// QuietCut returns how many bytes of a chunk of 16 kHz mono 16-bit PCM to
// send: up to the middle of the quietest 300 ms within its last searchSeconds,
// so a cut between chunks falls between words rather than inside one.
func QuietCut(pcm []byte, searchSeconds int) int {
	const frameSamples = SampleRate / 10
	frames := len(pcm) / 2 / frameSamples
	if frames < quietWindowFrames {
		return len(pcm) - len(pcm)%2
	}
	energy := make([]int64, frames)
	for frame := range energy {
		for sample := frame * frameSamples; sample < (frame+1)*frameSamples; sample++ {
			value := int64(int16(binary.LittleEndian.Uint16(pcm[sample*2:])))
			energy[frame] += max(value, -value)
		}
	}
	first := max(0, frames-searchSeconds*10)
	best, bestFrame := int64(math.MaxInt64), frames-quietWindowFrames
	for frame := first; frame+quietWindowFrames <= frames; frame++ {
		var sum int64
		for offset := range quietWindowFrames {
			sum += energy[frame+offset]
		}
		// Ties keep the later window, so a chunk sends as much as it can.
		if sum <= best {
			best, bestFrame = sum, frame
		}
	}
	middle := bestFrame*frameSamples + quietWindowFrames*frameSamples/2
	return middle * 2
}
