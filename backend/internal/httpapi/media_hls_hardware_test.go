package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yexca/kikoto/backend/internal/config"
)

func TestVideoHardwareEncodeArgsKeepTheSoftwarePictureAndGrid(t *testing.T) {
	software := videoHLSEncodeArgs(nil, "input.avi", "cache", 2, 14)
	argValue := func(args []string, key string) string {
		if position := slices.Index(args, key); position >= 0 && position+1 < len(args) {
			return args[position+1]
		}
		return ""
	}
	for _, test := range []struct {
		encoder videoHardwareEncoder
		device  []string
		codec   string
		upload  string
	}{
		{
			videoHardwareEncoder{mode: videoHardwareVAAPI, device: "/dev/dri/renderD128"},
			[]string{"-init_hw_device", "vaapi=va:/dev/dri/renderD128", "-filter_hw_device", "va"},
			"h264_vaapi", ",format=nv12,hwupload",
		},
		{
			videoHardwareEncoder{mode: videoHardwareQSV, device: "/dev/dri/renderD129", lowPower: true},
			[]string{"-init_hw_device", "vaapi=va:/dev/dri/renderD129", "-init_hw_device", "qsv=qs@va", "-filter_hw_device", "qs"},
			"h264_qsv", ",format=nv12,hwupload=extra_hw_frames=64",
		},
	} {
		t.Run(test.encoder.mode, func(t *testing.T) {
			args := videoHLSEncodeArgs(&test.encoder, "input.avi", "cache", 2, 14)
			// The device is opened before the input, which the CPU decodes.
			input := slices.Index(args, "-i")
			if position := slices.Index(args, test.device[0]); position < 0 || position > input ||
				!slices.Equal(args[position:position+len(test.device)], test.device) {
				t.Fatalf("device args %v missing before the input: %v", test.device, args)
			}
			if slices.Contains(args, "-hwaccel") {
				t.Fatalf("decoding moved to the GPU: %v", args)
			}
			if filter := argValue(args, "-vf"); filter != argValue(software, "-vf")+test.upload {
				t.Fatalf("filter = %q, want the software chain followed by %q", filter, test.upload)
			}
			for _, key := range []string{"-ss", "-t", "-fps_mode", "-fpsmax", "-g", "-force_key_frames", "-c:a", "-b:a", "-output_ts_offset", "-max_interleave_delta", "-f", "-hls_time", "-start_number"} {
				if argValue(args, key) != argValue(software, key) {
					t.Fatalf("%s = %q, software %q", key, argValue(args, key), argValue(software, key))
				}
			}
			if argValue(args, "-c:v") != test.codec || argValue(args, "-maxrate") != "2800k" || argValue(args, "-b:v") != "2000k" {
				t.Fatalf("encoder args = %v", args)
			}
			for _, softwareOnly := range []string{"libx264", "-crf", "-pix_fmt", "-threads:v", "-sc_threshold"} {
				if slices.Contains(args, softwareOnly) {
					t.Fatalf("hardware args contain %s: %v", softwareOnly, args)
				}
			}
			if (argValue(args, "-low_power") == "1") != test.encoder.lowPower {
				t.Fatalf("low power = %q, want %t", argValue(args, "-low_power"), test.encoder.lowPower)
			}
			if test.encoder.mode == videoHardwareQSV && argValue(args, "-forced_idr") != "1" {
				t.Fatalf("QSV forced keyframes are not IDR frames: %v", args)
			}
		})
	}
}

func TestVideoHardwareSettingsAreValidatedAndChecked(t *testing.T) {
	server := NewServer(openMigratedTestDB(t), config.Config{})
	t.Cleanup(func() { _ = server.Shutdown(context.Background()) })
	var probes atomic.Int64
	server.videoHardware.probe = func(_ context.Context, mode string, device string) videoHardwareStatus {
		probes.Add(1)
		if device != "/dev/dri/renderD129" {
			return videoHardwareStatus{State: "unavailable", Reason: "device_missing"}
		}
		return videoHardwareStatus{State: "ready", LowPower: mode == videoHardwareQSV}
	}
	read := func(body []byte) appSettingsResponse {
		t.Helper()
		var settings appSettingsResponse
		if err := json.Unmarshal(body, &settings); err != nil {
			t.Fatal(err)
		}
		return settings
	}
	for body, want := range map[string]string{
		`{"videoHardwareAcceleration":"nvenc"}`:                 "videoHardwareAcceleration must be none, qsv, or vaapi",
		`{"videoHardwareDevice":"/dev/dri/card0"}`:              "videoHardwareDevice must be a render node such as /dev/dri/renderD128",
		`{"videoHardwareDevice":"/dev/dri/renderD128/../../x"}`: "videoHardwareDevice must be a render node such as /dev/dri/renderD128",
		`{"videoHardwareDevice":"/etc/passwd"}`:                 "videoHardwareDevice must be a render node such as /dev/dri/renderD128",
	} {
		response := patchSettingsAsSourceWriter(t, server, body)
		var result errorResponseBody
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if response.Code != http.StatusBadRequest || result.Error != want {
			t.Fatalf("PATCH %s = %d %q, want 400 %q", body, response.Code, result.Error, want)
		}
	}
	if probes.Load() != 0 {
		t.Fatal("a rejected setting was checked")
	}

	response := patchSettingsAsSourceWriter(t, server, `{"videoHardwareAcceleration":"vaapi"}`)
	settings := read(response.Body.Bytes())
	if response.Code != http.StatusOK || settings.VideoHardwareAcceleration != "vaapi" || settings.VideoHardwareDevice != defaultVideoHardwareDevice ||
		settings.VideoHardwareStatus != (videoHardwareStatus{State: "unavailable", Reason: "device_missing"}) {
		t.Fatalf("enabling VAAPI on the default device = %d %+v", response.Code, settings)
	}
	if _, ok := server.readyVideoHardwareEncoder(); ok {
		t.Fatal("an unavailable encoder is used")
	}
	response = patchSettingsAsSourceWriter(t, server, `{"videoHardwareAcceleration":"QSV","videoHardwareDevice":" /dev/dri/renderD129 "}`)
	settings = read(response.Body.Bytes())
	if response.Code != http.StatusOK || settings.VideoHardwareAcceleration != "qsv" || settings.VideoHardwareDevice != "/dev/dri/renderD129" ||
		settings.VideoHardwareStatus != (videoHardwareStatus{State: "ready", LowPower: true}) {
		t.Fatalf("enabling QSV on another device = %d %+v", response.Code, settings)
	}
	if encoder, ok := server.readyVideoHardwareEncoder(); !ok || encoder != (videoHardwareEncoder{mode: videoHardwareQSV, device: "/dev/dri/renderD129", lowPower: true}) {
		t.Fatalf("ready encoder = %+v, %t", encoder, ok)
	}
	response = patchSettingsAsSourceWriter(t, server, `{"videoHardwareAcceleration":"none"}`)
	settings = read(response.Body.Bytes())
	if settings.VideoHardwareStatus.State != "disabled" || probes.Load() != 2 {
		t.Fatalf("disabling = %+v after %d checks", settings, probes.Load())
	}
	if _, ok := server.readyVideoHardwareEncoder(); ok {
		t.Fatal("a disabled encoder is used")
	}
}

func TestVideoHardwareCheckReportsAMissingDevice(t *testing.T) {
	missing := filepath.Join(t.TempDir(), "renderD128")
	if status := probeVideoHardware(context.Background(), videoHardwareVAAPI, missing); status != (videoHardwareStatus{State: "unavailable", Reason: "device_missing"}) {
		t.Fatalf("status = %+v", status)
	}
}

// A hardware encoder that cannot open its device fails before its first
// segment, like a GPU the driver rejects. The software encode serves the same
// request, and later playback of the revision uses it directly.
func TestVideoHardwareFailureFallsBackToSoftware(t *testing.T) {
	fixture := newVideoHLSTestServer(t, 30)
	server := fixture.server
	encoder := videoHardwareEncoder{mode: videoHardwareVAAPI, device: filepath.Join(t.TempDir(), "renderD128")}
	server.videoHardware.mode, server.videoHardware.device = encoder.mode, encoder.device
	server.videoHardware.status = videoHardwareStatus{State: "ready"}
	revision := fixture.coldRevision(t)
	source, err := server.loadHLSPlaybackSource(context.Background(), 834)
	if err != nil {
		t.Fatal(err)
	}
	playbackRevision := func() string {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/api/media/834/playback?forceTranscode=1", nil)
		request.SetPathValue("id", "834")
		response := httptest.NewRecorder()
		server.getVideoPlaybackInfo(response, request)
		var info videoPlaybackInfoResponse
		if err := json.Unmarshal(response.Body.Bytes(), &info); err != nil || info.Conversion != "transcode" {
			t.Fatalf("playback info = %d: %s", response.Code, response.Body.String())
		}
		parsed, err := url.Parse(info.URL)
		if err != nil {
			t.Fatal(err)
		}
		return parsed.Query().Get("v")
	}
	hardwareRevision := videoHardwareRevision(source, encoder.mode)
	if got := playbackRevision(); got != hardwareRevision {
		t.Fatalf("playback revision = %q, want the hardware revision %q", got, hardwareRevision)
	}
	playlistRequest := httptest.NewRequest(http.MethodGet, "/api/media/834/hls/index.m3u8?v="+hardwareRevision, nil)
	playlistRequest.SetPathValue("id", "834")
	playlistRequest.SetPathValue("file", "index.m3u8")
	playlist := httptest.NewRecorder()
	server.serveMediaHLS(playlist, playlistRequest)
	if playlist.Code != http.StatusOK || !strings.Contains(playlist.Body.String(), "segment-000004.ts?v="+hardwareRevision) {
		t.Fatalf("hardware playlist = %d:\n%s", playlist.Code, playlist.Body.String())
	}

	if response := fixture.serve(context.Background(), hardwareRevision, 0); response.Code != http.StatusOK || response.Body.Bytes()[0] != 0x47 {
		t.Fatalf("segment after the hardware failure = %d: %s", response.Code, response.Body.String())
	}
	if !server.videoHardwareFailedRecently(encoder, fixture.mediaPath) {
		t.Fatal("the hardware failure was not remembered")
	}
	if _, err := os.Stat(fixture.segmentPath(revision, 0)); err != nil {
		t.Fatalf("the software encode did not produce the segment: %v", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(fixture.cacheRoot, "transcodes", "hls-hw", "834", hardwareRevision)); len(entries) != 0 {
		t.Fatalf("the failed hardware encode left %d files", len(entries))
	}
	if got := playbackRevision(); got != revision {
		t.Fatalf("playback after the failure = %q, want the software revision %q", got, revision)
	}
	// A player still holding the hardware playlist gets software segments.
	if response := fixture.serve(context.Background(), hardwareRevision, 1); response.Code != http.StatusOK {
		t.Fatalf("hardware playlist segment = %d: %s", response.Code, response.Body.String())
	}
}

// The check accepts segments cut at forced keyframes and rejects an encoder
// that ignores them and places keyframes by a fixed GOP, which drifts off the
// grid at 29.97 fps.
func TestVideoHardwareCheckRequiresSegmentsOnTheGrid(t *testing.T) {
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		t.Skip("ffmpeg is not installed")
	}
	ffprobePath, err := exec.LookPath("ffprobe")
	if err != nil {
		t.Skip("ffprobe is not installed")
	}
	dir := t.TempDir()
	clip := filepath.Join(dir, "clip.mkv")
	if err := writeVideoHardwareProbeClip(context.Background(), ffmpegPath, clip); err != nil {
		t.Fatal(err)
	}
	encode := func(name string, edit func([]string) []string) string {
		output := filepath.Join(dir, name)
		if err := os.MkdirAll(output, 0o755); err != nil {
			t.Fatal(err)
		}
		args := edit(videoHLSEncodeArgs(nil, clip, output, 0, videoHardwareProbeSeconds))
		if combined, err := exec.Command(ffmpegPath, args...).CombinedOutput(); err != nil {
			t.Fatalf("%s encode: %v %s", name, err, combined)
		}
		return output
	}
	forced := encode("forced", func(args []string) []string { return args })
	if !videoHardwareSegmentsOnGrid(context.Background(), ffprobePath, forced) {
		t.Fatal("segments cut at forced keyframes were rejected")
	}
	fixed := encode("fixed-gop", func(args []string) []string {
		position := slices.Index(args, "-force_key_frames")
		args = slices.Delete(slices.Clone(args), position, position+2)
		args[slices.Index(args, "-g")+1] = "180"
		return args
	})
	if videoHardwareSegmentsOnGrid(context.Background(), ffprobePath, fixed) {
		t.Fatal("segments cut by a fixed GOP were accepted")
	}
}
