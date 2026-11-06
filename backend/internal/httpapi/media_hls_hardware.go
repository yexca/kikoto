package httpapi

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Transcoded video can be encoded by an Intel GPU through Quick Sync Video or
// VA-API instead of libx264. Decoding, scaling, and audio stay on the CPU, so
// the hardware encode produces the same 720p picture bound, segment grid, and
// timeline as the software encode, and a failing GPU only ever costs a
// software encode of the same revision.
const (
	videoHardwareAccelerationSetting = "video_hardware_acceleration"
	videoHardwareDeviceSetting       = "video_hardware_device"
	videoHardwareNone                = "none"
	videoHardwareQSV                 = "qsv"
	videoHardwareVAAPI               = "vaapi"
	defaultVideoHardwareDevice       = "/dev/dri/renderD128"
	videoHardwareHLSProfileVersion   = "hls-hw-v1-720p"
	// A hardware encode that fails sends that file revision to the software
	// encode for this long; the GPU is the likelier cause than the file.
	videoHardwareFailureTTL = time.Hour
	// The startup check encodes a short clip and must finish within this.
	videoHardwareProbeTimeout = time.Minute
	// The check clip is long enough for keyframes placed by a fixed GOP
	// instead of the forced ones to drift more than a frame off the grid.
	videoHardwareProbeSeconds = 42
	// A settings update waits this long for the check before it responds.
	videoHardwareResponseWait = 20 * time.Second
)

// A render node is the only device a hardware encode opens.
var videoHardwareDevicePattern = regexp.MustCompile(`^/dev/dri/renderD[0-9]{1,4}$`)

// videoHardwareStatus is the outcome of the check of the configured
// acceleration, as the settings response reports it.
type videoHardwareStatus struct {
	// State is "disabled", "checking", "ready", or "unavailable".
	State string `json:"state"`
	// Reason says why acceleration is unavailable: "device_missing",
	// "encoder_missing", "encode_failed", or "keyframes_unaligned".
	Reason string `json:"reason,omitempty"`
	// LowPower says the encoder works only in its low-power mode.
	LowPower bool `json:"lowPower,omitempty"`
}

// videoHardwareEncoder is a checked hardware encoder configuration.
type videoHardwareEncoder struct {
	mode     string
	device   string
	lowPower bool
}

type videoHardwareState struct {
	mu         sync.Mutex
	mode       string
	device     string
	status     videoHardwareStatus
	generation int
	// probe checks a configuration; tests replace it.
	probe func(ctx context.Context, mode string, device string) videoHardwareStatus
}

func parseVideoHardwareMode(value string) (string, bool) {
	switch mode := strings.ToLower(strings.TrimSpace(value)); mode {
	case videoHardwareNone, videoHardwareQSV, videoHardwareVAAPI:
		return mode, true
	}
	return "", false
}

func validVideoHardwareDevice(value string) bool {
	return videoHardwareDevicePattern.MatchString(value)
}

func applyVideoHardwareSettings(r *http.Request, tx *sql.Tx, payload settingsUpdatePayload) error {
	if payload.VideoHardwareAcceleration != nil {
		mode, ok := parseVideoHardwareMode(*payload.VideoHardwareAcceleration)
		if !ok {
			return invalidSettings("videoHardwareAcceleration must be none, qsv, or vaapi")
		}
		if err := upsertSetting(r, tx, videoHardwareAccelerationSetting, mode); err != nil {
			return err
		}
	}
	if payload.VideoHardwareDevice != nil {
		device := strings.TrimSpace(*payload.VideoHardwareDevice)
		if device == "" {
			device = defaultVideoHardwareDevice
		}
		if !validVideoHardwareDevice(device) {
			return invalidSettings("videoHardwareDevice must be a render node such as " + defaultVideoHardwareDevice)
		}
		if err := upsertSetting(r, tx, videoHardwareDeviceSetting, device); err != nil {
			return err
		}
	}
	return nil
}

// refreshVideoHardwareForResponse checks a changed configuration and waits a
// bounded time for the result, so the settings response usually reports it;
// a longer check finishes in the background.
func (s *Server) refreshVideoHardwareForResponse(ctx context.Context) {
	done := make(chan struct{})
	if !s.Go(func(lifetime context.Context) {
		defer close(done)
		s.RefreshVideoHardware(lifetime)
	}) {
		return
	}
	timer := time.NewTimer(videoHardwareResponseWait)
	defer timer.Stop()
	select {
	case <-done:
	case <-timer.C:
	case <-ctx.Done():
	}
}

func (s *Server) videoHardwareSettings(ctx context.Context) (string, string) {
	mode, ok := parseVideoHardwareMode(s.settingStringContext(ctx, videoHardwareAccelerationSetting, videoHardwareNone))
	if !ok {
		mode = videoHardwareNone
	}
	device := s.settingStringContext(ctx, videoHardwareDeviceSetting, defaultVideoHardwareDevice)
	if !validVideoHardwareDevice(device) {
		device = defaultVideoHardwareDevice
	}
	return mode, device
}

// videoHardwareStatusFor returns the check result of a configuration, or
// "checking" while the check of a changed configuration has not finished.
func (s *Server) videoHardwareStatusFor(mode string, device string) videoHardwareStatus {
	if mode == videoHardwareNone {
		return videoHardwareStatus{State: "disabled"}
	}
	state := &s.videoHardware
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.mode != mode || state.device != device {
		return videoHardwareStatus{State: "checking"}
	}
	return state.status
}

// videoHardwareConfigurationKnown reports whether the last check, finished or
// running, was of this configuration.
func (s *Server) videoHardwareConfigurationKnown(mode string, device string) bool {
	state := &s.videoHardware
	state.mu.Lock()
	defer state.mu.Unlock()
	return state.mode == mode && state.device == device
}

// RefreshVideoHardware checks the configured acceleration: at startup and
// after its settings change. Playback uses the hardware encoder only after a
// check of the current configuration succeeded.
func (s *Server) RefreshVideoHardware(ctx context.Context) {
	mode, device := s.videoHardwareSettings(ctx)
	state := &s.videoHardware
	state.mu.Lock()
	state.generation++
	generation := state.generation
	state.mode, state.device = mode, device
	state.status = videoHardwareStatus{State: "checking"}
	if mode == videoHardwareNone {
		state.status = videoHardwareStatus{State: "disabled"}
		state.mu.Unlock()
		return
	}
	probe := state.probe
	state.mu.Unlock()
	if probe == nil {
		probe = probeVideoHardware
	}
	status := probe(ctx, mode, device)
	if ctx.Err() != nil {
		return
	}
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.generation == generation {
		state.status = status
	}
	slog.Info("video hardware acceleration checked", "mode", mode, "device", device, "state", status.State, "reason", status.Reason, "low_power", status.LowPower)
}

// readyVideoHardwareEncoder returns the encoder playback uses, if the check of
// the current configuration succeeded.
func (s *Server) readyVideoHardwareEncoder() (videoHardwareEncoder, bool) {
	state := &s.videoHardware
	state.mu.Lock()
	defer state.mu.Unlock()
	if state.mode == videoHardwareNone || state.mode == "" || state.status.State != "ready" {
		return videoHardwareEncoder{}, false
	}
	return videoHardwareEncoder{mode: state.mode, device: state.device, lowPower: state.status.LowPower}, true
}

// videoHardwareRevision names the hardware-encoded playlist of a source
// revision; each mode has its own.
func videoHardwareRevision(source hlsPlaybackSource, mode string) string {
	revision := sha256.Sum256([]byte(videoHardwareHLSProfileVersion + "\x00" + mode + "\x00" + source.Revision))
	return fmt.Sprintf("%x", revision[:12])
}

// videoHardwareHLSProfile encodes like the software video profile, in its own
// cache directory and with its own failure memory.
func videoHardwareHLSProfile(encoder videoHardwareEncoder) *hlsEncodeProfile {
	profile := videoHLSProfile
	profile.name = "video-hls-" + encoder.mode
	profile.cacheDir = "hls-hw"
	profile.failureTTL = videoHardwareFailureTTL
	profile.args = func(source hlsPlaybackSource, outputDir string, startIndex int) []string {
		return withVideoAudioTrack(videoHLSEncodeArgs(&encoder, source.Path, outputDir, startIndex, source.Duration), source.AudioTrack)
	}
	return &profile
}

// videoHardwareFailedRecently reports whether a hardware encode of the file
// revision failed, so its playback uses the software encode.
func (s *Server) videoHardwareFailedRecently(encoder videoHardwareEncoder, path string) bool {
	info, err := os.Stat(path)
	return err == nil && s.mediaPreparationFailures.failedRecently(mediaPreparationFailureKey(videoHardwareHLSProfile(encoder).name, path, info))
}

// hardwareArgs returns the options that open the device, the filters that
// move the scaled CPU frames to it, and the encoder options. Rate control
// targets 2000 kbit/s under the software encode's 2800 kbit/s cap, because
// these encoders have no rate factor comparable to x264's.
func (encoder *videoHardwareEncoder) hardwareArgs() ([]string, string, []string) {
	var lowPower []string
	if encoder.lowPower {
		lowPower = []string{"-low_power", "1"}
	}
	rate := []string{"-b:v", "2000k", "-maxrate", "2800k", "-bufsize", "5600k"}
	if encoder.mode == videoHardwareQSV {
		device := []string{
			"-init_hw_device", "vaapi=va:" + encoder.device,
			"-init_hw_device", "qsv=qs@va",
			"-filter_hw_device", "qs",
		}
		// QSV turns forced keyframes into IDR frames only when asked.
		codec := slices.Concat([]string{"-c:v", "h264_qsv", "-preset", "veryfast", "-forced_idr", "1"}, lowPower, rate)
		return device, ",format=nv12,hwupload=extra_hw_frames=64", codec
	}
	device := []string{"-init_hw_device", "vaapi=va:" + encoder.device, "-filter_hw_device", "va"}
	codec := slices.Concat([]string{"-c:v", "h264_vaapi", "-rc_mode", "VBR"}, lowPower, rate)
	return device, ",format=nv12,hwupload", codec
}

// probeVideoHardware checks that the device exists, FFmpeg has the encoder,
// and the transcode arguments encode a short clip into segments cut on the
// playlist grid: first in the encoder's normal mode, then in low-power mode,
// which is the only one some Intel GPUs and drivers offer.
func probeVideoHardware(ctx context.Context, mode string, device string) videoHardwareStatus {
	ctx, cancel := context.WithTimeout(ctx, videoHardwareProbeTimeout)
	defer cancel()
	if info, err := os.Stat(device); err != nil || info.IsDir() {
		return videoHardwareStatus{State: "unavailable", Reason: "device_missing"}
	}
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		return videoHardwareStatus{State: "unavailable", Reason: "encoder_missing"}
	}
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		return videoHardwareStatus{State: "unavailable", Reason: "encoder_missing"}
	}
	encoders, err := exec.CommandContext(ctx, ffmpegPath, "-hide_banner", "-encoders").Output()
	if err != nil || !bytes.Contains(encoders, []byte(" h264_"+mode+" ")) {
		return videoHardwareStatus{State: "unavailable", Reason: "encoder_missing"}
	}
	dir, err := os.MkdirTemp("", "kikoto-video-hardware-*")
	if err != nil {
		return videoHardwareStatus{State: "unavailable", Reason: "encode_failed"}
	}
	defer func() { _ = os.RemoveAll(dir) }()
	clip := filepath.Join(dir, "clip.mkv")
	if err := writeVideoHardwareProbeClip(ctx, ffmpegPath, clip); err != nil {
		slog.Warn("video hardware check could not create its clip", "error", err)
		return videoHardwareStatus{State: "unavailable", Reason: "encode_failed"}
	}
	status := videoHardwareStatus{State: "unavailable", Reason: "encode_failed"}
	for _, lowPower := range []bool{false, true} {
		encoder := videoHardwareEncoder{mode: mode, device: device, lowPower: lowPower}
		output := filepath.Join(dir, strconv.FormatBool(lowPower))
		if err := os.MkdirAll(output, 0o755); err != nil {
			return status
		}
		command := exec.CommandContext(ctx, ffmpegPath, videoHLSEncodeArgs(&encoder, clip, output, 0, videoHardwareProbeSeconds)...)
		if diagnostics, err := command.CombinedOutput(); err != nil {
			slog.Info("video hardware encode check failed", "mode", mode, "low_power", lowPower, "error", err, "output", strings.TrimSpace(string(diagnostics)))
			continue
		}
		if !videoHardwareSegmentsOnGrid(ctx, ffprobePath, output) {
			status.Reason = "keyframes_unaligned"
			continue
		}
		return videoHardwareStatus{State: "ready", LowPower: lowPower}
	}
	return status
}

// writeVideoHardwareProbeClip writes a 29.97 fps clip, which has no frame on
// most six-second boundaries: the case the forced keyframes must still cut on.
func writeVideoHardwareProbeClip(ctx context.Context, ffmpegPath string, clip string) error {
	output, err := exec.CommandContext(ctx, ffmpegPath, "-nostdin", "-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30000/1001",
		"-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
		"-t", strconv.Itoa(videoHardwareProbeSeconds), "-c:v", "mpeg4", "-c:a", "pcm_s16le", "-y", clip).CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

// videoHardwareSegmentsOnGrid reports whether the probe clip's segments start
// with a keyframe within one frame of their playlist positions.
func videoHardwareSegmentsOnGrid(ctx context.Context, ffprobePath string, dir string) bool {
	count := hlsSegmentCount(videoHardwareProbeSeconds)
	for index := range count {
		output, err := exec.CommandContext(ctx, ffprobePath, "-v", "error", "-select_streams", "v:0",
			"-show_entries", "packet=pts_time,flags", "-read_intervals", "%+#1", "-of", "csv=p=0",
			filepath.Join(dir, hlsSegmentName(index))).Output()
		if err != nil {
			return false
		}
		fields := strings.Split(strings.TrimSpace(strings.SplitN(string(output), "\n", 2)[0]), ",")
		start, err := strconv.ParseFloat(fields[0], 64)
		want := videoHLSTimelineOffsetSeconds + float64(index)*hlsSegmentDurationSeconds
		if err != nil || len(fields) < 2 || !strings.HasPrefix(fields[1], "K") || start < want-0.001 || start > want+1001.0/30000+0.001 {
			return false
		}
	}
	_, err := os.Stat(filepath.Join(dir, hlsSegmentName(count)))
	return os.IsNotExist(err)
}
