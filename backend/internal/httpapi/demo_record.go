package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os/exec"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/account"
	"github.com/yexca/kikoto/backend/internal/demorecord"
	"github.com/yexca/kikoto/backend/internal/record"
)

// demoRecordProgress is the Demo account's simulated watching: the files it
// left part way appear under Continue watching, and the finished one shows
// as watched. The server rejects every Demo write, so without it the picker
// would stay empty. The entries were played a minute apart, the last most
// recently.
var demoRecordProgress = []demoRecordProgressEntry{
	{path: "Sample trip/Day 1/Harbor walk.mp4", position: 14, completed: true},
	{path: "Sample audio/Morning tone.mp3", position: 8},
	{path: "Sample trip/Day 2/Night market.mkv", position: 6.5},
}

// prepareDemoRecordLibrary gives Demo its Record library: it generates the
// sample files in the isolated cache, initializes that root, scans it, and
// reads its media details, all before the server answers a request. Record is
// on only when every step succeeds; otherwise it stays off and Demo starts
// without it.
func (s *Server) prepareDemoRecordLibrary(ctx context.Context) (err error) {
	if !s.cfg.IsDemo() {
		return errors.New("the demo record library is only available in demo mode")
	}
	ready := false
	defer func() {
		if saveErr := s.saveSettingValue(context.WithoutCancel(ctx), recordLibraryEnabledSetting, ready); saveErr != nil && err == nil {
			err = saveErr
		}
	}()
	if _, err := demorecord.Ensure(ctx, s.cfg.RecordRoot, s.demoRecordFFmpeg); err != nil {
		return fmt.Errorf("generate demo record samples: %w", err)
	}
	root, err := s.recordStore.InitializeRoot(ctx, false)
	if errors.Is(err, record.ErrRootFreshRequired) {
		// A regenerated root that lost its marker starts a new catalog.
		root, err = s.recordStore.InitializeRoot(ctx, true)
	}
	if err != nil {
		return fmt.Errorf("initialize demo record root: %w", err)
	}
	if root.State != "online" {
		return fmt.Errorf("demo record root is %s", root.State)
	}
	if _, err := s.runRecordScan(ctx, nil); err != nil {
		return fmt.Errorf("scan demo record root: %w", err)
	}
	probe, err := s.recordStore.ProbePending(ctx, record.ProbeOptions{})
	if err != nil {
		return fmt.Errorf("read demo record media details: %w", err)
	}
	if probe.Unavailable || probe.Failed > 0 {
		slog.Warn("demo record media details incomplete", "probed", probe.Probed, "failed", probe.Failed, "unavailable", probe.Unavailable)
	}
	if err := s.seedDemoRecordProgress(ctx, demoRecordProgress); err != nil {
		return fmt.Errorf("seed demo record progress: %w", err)
	}
	ready = true
	return nil
}

type demoRecordProgressEntry struct {
	path      string
	position  float64
	completed bool
}

// seedDemoRecordProgress saves entries as the Demo account's progress, each
// played a minute after the one before it.
func (s *Server) seedDemoRecordProgress(ctx context.Context, entries []demoRecordProgressEntry) error {
	user, err := s.accountStore.LoadByUsername(ctx, account.DemoUsername)
	if err != nil {
		return fmt.Errorf("find demo account: %w", err)
	}
	// Each start's saves are later than the last start's, so they replace them.
	now := time.Now()
	order := now.UnixMilli()
	for index, item := range entries {
		asset, err := s.recordStore.AssetByPath(ctx, item.path)
		if err != nil {
			return fmt.Errorf("find %s: %w", item.path, err)
		}
		position := item.position
		if asset.DurationSeconds != nil && position > *asset.DurationSeconds {
			position = *asset.DurationSeconds
		}
		if _, err := s.recordStore.SaveProgress(ctx, user.ID, asset.ID, record.Progress{
			PositionSeconds: position,
			DurationSeconds: asset.DurationSeconds,
			Completed:       item.completed,
			Order:           order + int64(index),
		}); err != nil {
			return err
		}
		// The saves share a second, so their play times are set apart.
		playedAt := now.Add(-time.Duration(len(entries)-1-index) * time.Minute)
		if err := s.recordStore.SetLastPlayedAt(ctx, user.ID, asset.ID, playedAt); err != nil {
			return err
		}
	}
	return nil
}

// demoRecordSampleTimeout bounds one sample's ffmpeg run.
const demoRecordSampleTimeout = 2 * time.Minute

const demoRecordStderrTailLimit = 2048

// runDemoRecordFFmpeg runs ffmpeg for one Demo sample. A failure carries the
// end of ffmpeg's error output, so the startup warning names the missing
// encoder or filter.
func runDemoRecordFFmpeg(ctx context.Context, args []string) error {
	binary, err := exec.LookPath("ffmpeg")
	if err != nil {
		return fmt.Errorf("ffmpeg is not installed: %w", err)
	}
	runContext, cancel := context.WithTimeout(ctx, demoRecordSampleTimeout)
	defer cancel()
	stderr := &tailBuffer{limit: demoRecordStderrTailLimit}
	command := exec.CommandContext(runContext, binary, args...)
	command.Stdout = io.Discard
	command.Stderr = stderr
	err = command.Run()
	if err == nil {
		return nil
	}
	if ctx.Err() == nil && errors.Is(runContext.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("ffmpeg ran longer than %s", demoRecordSampleTimeout)
	}
	if output := strings.Join(strings.Fields(stderr.String()), " "); output != "" {
		return fmt.Errorf("%w: %s", err, output)
	}
	return err
}
