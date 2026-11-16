package record

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os/exec"
	"strconv"
	"strings"
	"time"
)

// ProbeFunc reads a media file's ffprobe JSON. The scan injects FFprobe; tests
// inject a fake.
type ProbeFunc func(ctx context.Context, path string) ([]byte, error)

// ErrProbeUnavailable means no prober can run, such as when ffprobe is not
// installed. Pending assets stay pending instead of failing.
var ErrProbeUnavailable = errors.New("record media probe is unavailable")

const (
	probeTimeout     = 20 * time.Second
	probeOutputLimit = 256 << 10
	// DefaultProbeLimit bounds how many assets one scan probes; the rest stay
	// pending for the next scan.
	DefaultProbeLimit = 2000
	// DefaultProbeConcurrency bounds concurrent ffprobe processes.
	DefaultProbeConcurrency = 2
)

// ProbeResult reports one probe pass.
type ProbeResult struct {
	Probed      int  `json:"probed"`
	Failed      int  `json:"failed"`
	Remaining   int  `json:"remaining"`
	Unavailable bool `json:"unavailable,omitempty"`
}

// MediaInfo is what a probe stores for a video, audio file, or image.
type MediaInfo struct {
	DurationSeconds *float64
	Width           *int
	Height          *int
	VideoCodec      string
	AudioCodec      string
	HasAudio        *bool
}

type limitedBuffer struct {
	buffer   bytes.Buffer
	limit    int
	exceeded bool
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > b.limit {
		b.exceeded = true
		return 0, errors.New("probe output exceeded limit")
	}
	return b.buffer.Write(p)
}

// FFprobe runs ffprobe on one local file with a timeout, one thread, the file
// protocol only, and a bounded output.
func FFprobe(ctx context.Context, path string) ([]byte, error) {
	binary, err := exec.LookPath("ffprobe")
	if err != nil {
		return nil, ErrProbeUnavailable
	}
	probeContext, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()
	command := exec.CommandContext(probeContext, binary,
		"-v", "error",
		"-threads", "1",
		"-protocol_whitelist", "file",
		"-probesize", "32M",
		"-analyzeduration", "10M",
		"-show_entries", "format=duration:stream=codec_type,codec_name,width,height",
		"-of", "json",
		"file:"+path,
	)
	command.Stderr = io.Discard
	output := &limitedBuffer{limit: probeOutputLimit}
	command.Stdout = output
	if err := command.Run(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, ctxErr
		}
		if errors.Is(probeContext.Err(), context.DeadlineExceeded) {
			return nil, errors.New("record media probe timed out")
		}
		return nil, fmt.Errorf("record media probe failed: %w", err)
	}
	return output.buffer.Bytes(), nil
}

type ffprobeOutput struct {
	Streams []struct {
		CodecType string `json:"codec_type"`
		CodecName string `json:"codec_name"`
		Width     int    `json:"width"`
		Height    int    `json:"height"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ParseMediaInfo reads ffprobe JSON for a video, audio file, or image. A video
// needs a video stream and an audio file an audio stream; both take their
// duration from the container. An image needs a decodable picture with
// dimensions.
func ParseMediaInfo(data []byte, kind string) (MediaInfo, error) {
	var probe ffprobeOutput
	if err := json.Unmarshal(data, &probe); err != nil {
		return MediaInfo{}, fmt.Errorf("decode probe output: %w", err)
	}
	var info MediaInfo
	hasAudio := false
	for _, stream := range probe.Streams {
		switch strings.ToLower(stream.CodecType) {
		case "video":
			if info.Width == nil && stream.Width > 0 && stream.Height > 0 {
				width, height := stream.Width, stream.Height
				info.Width, info.Height = &width, &height
				info.VideoCodec = boundedCodec(stream.CodecName)
			}
		case "audio":
			if !hasAudio {
				info.AudioCodec = boundedCodec(stream.CodecName)
			}
			hasAudio = true
		}
	}
	if kind == "audio" {
		// Cover art reads as a video stream; an audio file keeps only its sound.
		if !hasAudio {
			return MediaInfo{}, errors.New("probe found no audio")
		}
		info = MediaInfo{AudioCodec: info.AudioCodec, HasAudio: &hasAudio}
		if duration, err := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64); err == nil && duration > 0 && !math.IsInf(duration, 0) && !math.IsNaN(duration) {
			info.DurationSeconds = &duration
		}
		return info, nil
	}
	if info.Width == nil {
		return MediaInfo{}, errors.New("probe found no picture")
	}
	if kind == "video" {
		info.HasAudio = &hasAudio
		if duration, err := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64); err == nil && duration > 0 && !math.IsInf(duration, 0) && !math.IsNaN(duration) {
			info.DurationSeconds = &duration
		}
	}
	return info, nil
}

func boundedCodec(name string) string {
	name = strings.TrimSpace(name)
	if len(name) > 32 {
		name = name[:32]
	}
	return name
}

type probeCandidate struct {
	id           int64
	relativePath string
	kind         string
}

type probeOutcome struct {
	candidate probeCandidate
	info      MediaInfo
	err       error
}

// ProbePending fills duration and dimensions for available videos, audio
// files, and images whose probe is pending, at most limit of them, with
// concurrency probes at a time. A file the prober cannot read is marked failed
// and never fails the pass; a cancelled context stops it and leaves the rest
// pending.
func (s *Store) ProbePending(ctx context.Context, probe ProbeFunc, limit, concurrency int) (ProbeResult, error) {
	if probe == nil {
		return ProbeResult{Unavailable: true}, nil
	}
	if limit <= 0 {
		limit = DefaultProbeLimit
	}
	if concurrency <= 0 {
		concurrency = DefaultProbeConcurrency
	}
	candidates, err := s.pendingProbes(ctx, limit)
	if err != nil {
		return ProbeResult{}, err
	}
	result := ProbeResult{}
	jobs := make(chan probeCandidate)
	// Buffered for every candidate, so a worker never blocks on a result the
	// loop below stopped reading.
	outcomes := make(chan probeOutcome, len(candidates))
	workerContext, cancelWorkers := context.WithCancel(ctx)
	defer cancelWorkers()
	for range concurrency {
		go func() {
			for candidate := range jobs {
				outcomes <- s.probeOne(workerContext, probe, candidate)
			}
		}()
	}
	go func() {
		defer close(jobs)
		for _, candidate := range candidates {
			select {
			case jobs <- candidate:
			case <-workerContext.Done():
				return
			}
		}
	}()
	var stopErr error
	for received := 0; received < len(candidates); received++ {
		var outcome probeOutcome
		select {
		case outcome = <-outcomes:
		case <-ctx.Done():
			stopErr = ctx.Err()
		}
		if stopErr != nil {
			break
		}
		switch {
		case outcome.err == nil:
			if err := s.saveProbe(ctx, outcome.candidate.id, outcome.info); err != nil {
				return result, err
			}
			result.Probed++
		case errors.Is(outcome.err, ErrProbeUnavailable):
			result.Unavailable = true
			stopErr = outcome.err
		case ctx.Err() != nil:
			stopErr = ctx.Err()
		default:
			if _, err := s.db.ExecContext(ctx, `UPDATE record_asset SET probe_state='failed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND probe_state='pending'`, outcome.candidate.id); err != nil {
				return result, err
			}
			result.Failed++
		}
		if stopErr != nil {
			break
		}
	}
	cancelWorkers()
	if stopErr != nil && !errors.Is(stopErr, ErrProbeUnavailable) {
		return result, stopErr
	}
	countContext := context.WithoutCancel(ctx)
	if err := s.db.QueryRowContext(countContext, `SELECT COUNT(*) FROM record_asset WHERE root_id=1 AND availability='available' AND kind IN ('video','audio','image') AND probe_state='pending'`).Scan(&result.Remaining); err != nil {
		return result, err
	}
	return result, nil
}

func (s *Store) pendingProbes(ctx context.Context, limit int) ([]probeCandidate, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, relative_path, kind FROM record_asset WHERE root_id=1 AND availability='available' AND kind IN ('video','audio','image') AND probe_state='pending' ORDER BY id LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	candidates := []probeCandidate{}
	for rows.Next() {
		var candidate probeCandidate
		if err := rows.Scan(&candidate.id, &candidate.relativePath, &candidate.kind); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

func (s *Store) probeOne(ctx context.Context, probe ProbeFunc, candidate probeCandidate) probeOutcome {
	path, err := s.safePath(candidate.relativePath)
	if err != nil {
		return probeOutcome{candidate: candidate, err: err}
	}
	data, err := probe(ctx, path)
	if err != nil {
		return probeOutcome{candidate: candidate, err: err}
	}
	info, err := ParseMediaInfo(data, candidate.kind)
	return probeOutcome{candidate: candidate, info: info, err: err}
}

func (s *Store) saveProbe(ctx context.Context, id int64, info MediaInfo) error {
	var hasAudio sql.NullInt64
	if info.HasAudio != nil {
		hasAudio.Valid = true
		if *info.HasAudio {
			hasAudio.Int64 = 1
		}
	}
	_, err := s.db.ExecContext(ctx, `UPDATE record_asset SET probe_state='ready', duration_seconds=?, width=?, height=?, video_codec=?, audio_codec=?, has_audio=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND probe_state='pending'`,
		info.DurationSeconds, info.Width, info.Height, info.VideoCodec, info.AudioCodec, hasAudio, id)
	return err
}
