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
	"sync"
	"time"
)

// ProbeFunc reads a media file's ffprobe JSON. The store's probe pass injects
// FFprobe; tests inject a fake.
type ProbeFunc func(ctx context.Context, path string) ([]byte, error)

// ErrProbeUnavailable means no prober can run, such as when ffprobe is not
// installed. Pending assets stay pending instead of failing.
var ErrProbeUnavailable = errors.New("record media probe is unavailable")

// ErrMediaToolTimedOut means ffprobe or ffmpeg ran past its timeout, as on a
// disk spinning up or a busy host. Nothing about the file is remembered, so
// the next scan or request tries it again.
var ErrMediaToolTimedOut = errors.New("record media tool timed out")

const (
	probeTimeout     = 20 * time.Second
	probeOutputLimit = 256 << 10
	// probeReadBytes and probeAnalyzeMicros keep a probe to the container
	// header: the length and streams a header declares, without decoding
	// frames to analyze them.
	probeReadBytes     = "1048576"
	probeAnalyzeMicros = "1000000"
	// DefaultProbeConcurrency bounds concurrent ffprobe processes.
	DefaultProbeConcurrency = 2
)

// ProbeResult reports one probe pass.
type ProbeResult struct {
	Probed      int  `json:"probed"`
	Failed      int  `json:"failed"`
	Remaining   int  `json:"remaining"`
	Unavailable bool `json:"unavailable,omitempty"`
	// TimedOut counts files whose probe timed out; they stay pending for a
	// later pass.
	TimedOut int `json:"timedOut,omitempty"`
	// TimedOutIDs are the assets whose probe timed out, which the pass does
	// not try again.
	TimedOutIDs []int64 `json:"-"`
}

// Done counts the files a pass has finished with.
func (r ProbeResult) Done() int { return r.Probed + r.Failed + r.TimedOut }

// ProbeOptions shapes one probe pass.
type ProbeOptions struct {
	// Concurrency bounds concurrent probes; DefaultProbeConcurrency when zero.
	Concurrency int
	// Skip lists assets the pass leaves alone, such as those an earlier part
	// of the same pass timed out on.
	Skip []int64
	// Between runs after each group of probes with the pass so far. An error
	// stops the pass at that safe point and is returned with the result.
	Between func(ProbeResult) error
}

// MediaInfo is what a probe stores for a video, audio file, or image.
type MediaInfo struct {
	DurationSeconds *float64
	Width           *int
	Height          *int
	VideoCodec      string
	AudioCodec      string
	HasAudio        *bool
	// HasCover reports cover art embedded in an audio file; it is set for audio only.
	HasCover *bool
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

// FFprobe reads one local file's container header with a timeout, one thread,
// the file protocol only, a small read budget, and a bounded output.
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
		"-probesize", probeReadBytes,
		"-analyzeduration", probeAnalyzeMicros,
		"-show_entries", "format=duration:stream=codec_type,codec_name,width,height:stream_disposition=attached_pic",
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
			return nil, ErrMediaToolTimedOut
		}
		return nil, fmt.Errorf("record media probe failed: %w", err)
	}
	return output.buffer.Bytes(), nil
}

type ffprobeOutput struct {
	Streams []struct {
		CodecType   string `json:"codec_type"`
		CodecName   string `json:"codec_name"`
		Width       int    `json:"width"`
		Height      int    `json:"height"`
		Disposition struct {
			AttachedPic int `json:"attached_pic"`
		} `json:"disposition"`
	} `json:"streams"`
	Format struct {
		Duration string `json:"duration"`
	} `json:"format"`
}

// ParseMediaInfo reads ffprobe JSON for a video, audio file, or image. A video
// needs a picture stream other than cover art and an audio file an audio
// stream; both take their duration from the container, and a video keeps the
// dimensions its header declares, when it declares them. An image needs a
// decodable picture with dimensions.
func ParseMediaInfo(data []byte, kind string) (MediaInfo, error) {
	var probe ffprobeOutput
	if err := json.Unmarshal(data, &probe); err != nil {
		return MediaInfo{}, fmt.Errorf("decode probe output: %w", err)
	}
	var info MediaInfo
	hasAudio, hasCover, hasPicture := false, false, false
	for _, stream := range probe.Streams {
		switch strings.ToLower(stream.CodecType) {
		case "video":
			if stream.Disposition.AttachedPic == 1 {
				hasCover = true
				continue
			}
			hasPicture = true
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
		// Cover art reads as a video stream marked as an attached picture; an
		// audio file keeps only its sound and whether it carries a cover.
		if !hasAudio {
			return MediaInfo{}, errors.New("probe found no audio")
		}
		info = MediaInfo{AudioCodec: info.AudioCodec, HasAudio: &hasAudio, HasCover: &hasCover}
		if duration, err := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64); err == nil && duration > 0 && !math.IsInf(duration, 0) && !math.IsNaN(duration) {
			info.DurationSeconds = &duration
		}
		return info, nil
	}
	if kind == "video" {
		if !hasPicture {
			return MediaInfo{}, errors.New("probe found no picture")
		}
		info.HasAudio = &hasAudio
		if duration, err := strconv.ParseFloat(strings.TrimSpace(probe.Format.Duration), 64); err == nil && duration > 0 && !math.IsInf(duration, 0) && !math.IsNaN(duration) {
			info.DurationSeconds = &duration
		}
		return info, nil
	}
	if info.Width == nil {
		return MediaInfo{}, errors.New("probe found no picture")
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

// probeKinds are the kinds a probe reads: their length, and an audio file's
// cover art, are what a folder listing shows. An image's listing needs nothing
// a probe reads.
const probeKinds = `('video','audio')`

type probeCandidate struct {
	id           int64
	relativePath string
	kind         string
	sizeBytes    sql.NullInt64
	mtimeNs      sql.NullInt64
}

type probeOutcome struct {
	candidate probeCandidate
	info      MediaInfo
	err       error
}

// ProbePending reads the length of available videos and audio files whose
// probe is pending, and whether an audio file carries cover art, a group of
// options.Concurrency files at a time in id order, until none is left. A file
// the prober cannot read is marked failed and never fails the pass; a file
// whose probe timed out stays pending and the pass does not try it again.
// Between each group the pass calls options.Between, which may stop it; a
// cancelled context stops it too. Either way finished files keep their result
// and the rest stay pending.
func (s *Store) ProbePending(ctx context.Context, options ProbeOptions) (ProbeResult, error) {
	result := ProbeResult{TimedOutIDs: append([]int64(nil), options.Skip...)}
	if s.probe == nil {
		result.Unavailable = true
		return result, s.countPendingProbes(ctx, &result)
	}
	concurrency := options.Concurrency
	if concurrency <= 0 {
		concurrency = DefaultProbeConcurrency
	}
	for {
		candidates, err := s.pendingProbes(ctx, result.TimedOutIDs, concurrency)
		if err != nil {
			return result, err
		}
		if len(candidates) == 0 {
			break
		}
		outcomes := make([]probeOutcome, len(candidates))
		var wait sync.WaitGroup
		for index, candidate := range candidates {
			wait.Add(1)
			go func() {
				defer wait.Done()
				outcomes[index] = s.probeOne(ctx, s.probe, candidate)
			}()
		}
		wait.Wait()
		if err := ctx.Err(); err != nil {
			return result, err
		}
		for _, outcome := range outcomes {
			switch {
			case outcome.err == nil:
				if err := s.saveProbe(ctx, outcome.candidate, outcome.info); err != nil {
					return result, err
				}
				result.Probed++
			case errors.Is(outcome.err, ErrProbeUnavailable):
				result.Unavailable = true
			case errors.Is(outcome.err, ErrMediaToolTimedOut):
				result.TimedOut++
				result.TimedOutIDs = append(result.TimedOutIDs, outcome.candidate.id)
			default:
				if err := s.markProbeFailed(ctx, outcome.candidate); err != nil {
					return result, err
				}
				result.Failed++
			}
		}
		if result.Unavailable {
			break
		}
		if options.Between != nil {
			if err := options.Between(result); err != nil {
				return result, err
			}
		}
	}
	return result, s.countPendingProbes(context.WithoutCancel(ctx), &result)
}

// PendingProbes counts the files a probe pass would read, leaving out skip.
func (s *Store) PendingProbes(ctx context.Context, skip []int64) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM record_asset WHERE root_id=1 AND availability='available' AND kind IN `+probeKinds+` AND probe_state='pending' AND id NOT IN (SELECT value FROM json_each(?))`, idsJSON(skip)).Scan(&count)
	return count, err
}

func (s *Store) countPendingProbes(ctx context.Context, result *ProbeResult) error {
	remaining, err := s.PendingProbes(ctx, nil)
	result.Remaining = remaining
	return err
}

func (s *Store) pendingProbes(ctx context.Context, skip []int64, limit int) ([]probeCandidate, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, relative_path, kind, size_bytes, mtime_ns FROM record_asset WHERE root_id=1 AND availability='available' AND kind IN `+probeKinds+` AND probe_state='pending' AND id NOT IN (SELECT value FROM json_each(?)) ORDER BY id LIMIT ?`, idsJSON(skip), limit)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	candidates := []probeCandidate{}
	for rows.Next() {
		var candidate probeCandidate
		if err := rows.Scan(&candidate.id, &candidate.relativePath, &candidate.kind, &candidate.sizeBytes, &candidate.mtimeNs); err != nil {
			return nil, err
		}
		candidates = append(candidates, candidate)
	}
	return candidates, rows.Err()
}

func idsJSON(ids []int64) string {
	if len(ids) == 0 {
		return "[]"
	}
	data, _ := json.Marshal(ids)
	return string(data)
}

// ProbeIfPending reads the length, and an audio file's cover art, of one
// available video or audio file whose probe is pending, as a thumbnail that
// needs the length does before the background pass reaches the file. It
// returns the asset as it stands afterwards. A file that is not pending, and
// a prober that cannot run, leave the asset as it is.
func (s *Store) ProbeIfPending(ctx context.Context, id int64) (Asset, error) {
	var candidate probeCandidate
	err := s.db.QueryRowContext(ctx, `SELECT id, relative_path, kind, size_bytes, mtime_ns FROM record_asset WHERE id=? AND root_id=1 AND availability='available' AND kind IN `+probeKinds+` AND probe_state='pending'`, id).
		Scan(&candidate.id, &candidate.relativePath, &candidate.kind, &candidate.sizeBytes, &candidate.mtimeNs)
	if err == nil && s.probe != nil {
		outcome := s.probeOne(ctx, s.probe, candidate)
		switch {
		case outcome.err == nil:
			if err := s.saveProbe(ctx, candidate, outcome.info); err != nil {
				return Asset{}, err
			}
		case ctx.Err() != nil:
			return Asset{}, ctx.Err()
		case errors.Is(outcome.err, ErrProbeUnavailable), errors.Is(outcome.err, ErrMediaToolTimedOut):
		default:
			if err := s.markProbeFailed(ctx, candidate); err != nil {
				return Asset{}, err
			}
		}
	} else if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return Asset{}, err
	}
	return s.Asset(ctx, id)
}

// RecordProbe stores ffprobe JSON that another reader of the file produced,
// such as playback, for an asset whose probe is pending. sizeBytes and
// mtimeNs name the file revision the output describes; output for another
// revision is ignored, as is output that does not describe the asset's kind.
func (s *Store) RecordProbe(ctx context.Context, id, sizeBytes, mtimeNs int64, output []byte) error {
	var candidate probeCandidate
	err := s.db.QueryRowContext(ctx, `SELECT id, relative_path, kind, size_bytes, mtime_ns FROM record_asset WHERE id=? AND root_id=1 AND kind IN `+probeKinds+` AND probe_state='pending'`, id).
		Scan(&candidate.id, &candidate.relativePath, &candidate.kind, &candidate.sizeBytes, &candidate.mtimeNs)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if candidate.sizeBytes.Int64 != sizeBytes || candidate.mtimeNs.Int64 != mtimeNs {
		return nil
	}
	info, err := ParseMediaInfo(output, candidate.kind)
	if err != nil {
		return nil
	}
	return s.saveProbe(ctx, candidate, info)
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

// saveProbe and markProbeFailed write only while the row still names the file
// revision that was probed, so a file a scan saw change in the meantime stays
// pending for its new revision.
func (s *Store) saveProbe(ctx context.Context, candidate probeCandidate, info MediaInfo) error {
	_, err := s.db.ExecContext(ctx, `UPDATE record_asset SET probe_state='ready', duration_seconds=?, width=?, height=?, video_codec=?, audio_codec=?, has_audio=?, has_cover=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND probe_state='pending' AND size_bytes IS ? AND mtime_ns IS ?`,
		info.DurationSeconds, info.Width, info.Height, info.VideoCodec, info.AudioCodec, nullableFlag(info.HasAudio), nullableFlag(info.HasCover), candidate.id, candidate.sizeBytes, candidate.mtimeNs)
	return err
}

func (s *Store) markProbeFailed(ctx context.Context, candidate probeCandidate) error {
	_, err := s.db.ExecContext(ctx, `UPDATE record_asset SET probe_state='failed', updated_at=CURRENT_TIMESTAMP WHERE id=? AND probe_state='pending' AND size_bytes IS ? AND mtime_ns IS ?`, candidate.id, candidate.sizeBytes, candidate.mtimeNs)
	return err
}

func nullableFlag(value *bool) sql.NullInt64 {
	var flag sql.NullInt64
	if value != nil {
		flag.Valid = true
		if *value {
			flag.Int64 = 1
		}
	}
	return flag
}
