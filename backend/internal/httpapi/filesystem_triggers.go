package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

const (
	filesystemTriggerSettleDelay = 5 * time.Second
	filesystemTriggerRetryDelay  = 5 * time.Second
	filesystemTriggerErrorPrefix = "filesystem watcher: "
)

var errFilesystemWatcherReconfigure = errors.New("filesystem watcher configuration changed")

type filesystemTriggerRecord struct {
	ID               int64
	Enabled          bool
	LastErrorMessage string
}

type filesystemWatcherConfig struct {
	ScanDepth     int
	ExcludedRoots []string
}

type filesystemWatcher interface {
	Changes() <-chan struct{}
	Invalidated() <-chan struct{}
	Errors() <-chan error
	WatchedDirectoryCount() int
}

func (s *Server) runFilesystemTriggerCoordinator(ctx context.Context) {
	for {
		watchConfig, err := s.loadFilesystemWatcherConfig(ctx)
		if err != nil {
			_ = s.recordFilesystemWatcherError(ctx, err)
			if !waitForFilesystemTrigger(ctx, filesystemTriggerRetryDelay) {
				return
			}
			continue
		}
		watcher, err := localfs.NewDirectoryWatcher(s.cfg.DataRoot, watchConfig.ScanDepth, watchConfig.ExcludedRoots...)
		if err != nil {
			_ = s.recordFilesystemWatcherError(ctx, err)
			if !waitForFilesystemTrigger(ctx, filesystemTriggerRetryDelay) {
				return
			}
			continue
		}
		err = s.runFilesystemWatcherSession(ctx, watcher, watchConfig, filesystemTriggerSettleDelay, filesystemTriggerRetryDelay)
		_ = watcher.Close()
		if errors.Is(err, context.Canceled) || ctx.Err() != nil {
			return
		}
		if errors.Is(err, errFilesystemWatcherReconfigure) {
			continue
		}
		if err != nil && !isDatabaseBusyError(err) {
			slog.Error("filesystem workflow watcher stopped", "error", err)
		}
		if !waitForFilesystemTrigger(ctx, filesystemTriggerRetryDelay) {
			return
		}
	}
}

func (s *Server) runFilesystemWatcherSession(ctx context.Context, watcher filesystemWatcher, watchConfig filesystemWatcherConfig, settleDelay, retryDelay time.Duration) error {
	if err := s.recordFilesystemWatcherReady(ctx, watcher.WatchedDirectoryCount()); err != nil && !isDatabaseBusyError(err) {
		return err
	}
	trigger, ok, err := s.loadFixedFilesystemTrigger(ctx)
	if err != nil {
		return err
	}
	enabled := ok && trigger.Enabled
	var timer *time.Timer
	var timerC <-chan time.Time
	pending := false
	lastEventAt := time.Time{}
	stopTimer := func() {
		if timer != nil && !timer.Stop() {
			select {
			case <-timer.C:
			default:
			}
		}
		timerC = nil
	}
	schedule := func(delay time.Duration) {
		if timer == nil {
			timer = time.NewTimer(delay)
		} else {
			stopTimer()
			timer.Reset(delay)
		}
		timerC = timer.C
	}
	defer stopTimer()

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case _, ok := <-watcher.Changes():
			if !ok {
				return errors.New("filesystem watcher closed")
			}
			if !enabled {
				continue
			}
			pending = true
			lastEventAt = time.Now().UTC()
			schedule(settleDelay)
		case _, ok := <-watcher.Invalidated():
			if !ok {
				return errors.New("filesystem watcher closed")
			}
			return errors.New("filesystem watch root was removed or renamed")
		case watchErr, ok := <-watcher.Errors():
			if !ok {
				return errors.New("filesystem watcher closed")
			}
			_ = s.recordFilesystemWatcherError(ctx, watchErr)
			if !enabled {
				continue
			}
			pending = true
			lastEventAt = time.Now().UTC()
			schedule(settleDelay)
		case <-s.filesystemTriggerConfigChanged:
			nextConfig, err := s.loadFilesystemWatcherConfig(ctx)
			if err != nil {
				return err
			}
			if !sameFilesystemWatcherConfig(watchConfig, nextConfig) {
				return errFilesystemWatcherReconfigure
			}
			trigger, ok, err := s.loadFixedFilesystemTrigger(ctx)
			if err != nil {
				return err
			}
			enabled = ok && trigger.Enabled
			if !enabled {
				pending = false
				stopTimer()
			}
		case <-timerC:
			timerC = nil
			if !pending {
				continue
			}
			queued, blocked, err := s.dispatchFilesystemTriggeredLocalScan(ctx, watcher.WatchedDirectoryCount(), lastEventAt)
			if queued {
				pending = false
			}
			if err != nil {
				if ctx.Err() != nil {
					return ctx.Err()
				}
				if queued {
					slog.Error("record filesystem workflow dispatch", "error", err)
					continue
				}
				schedule(retryDelay)
				continue
			}
			if blocked {
				schedule(retryDelay)
				continue
			}
			if !queued {
				pending = false
			}
		}
	}
}

func (s *Server) loadFilesystemWatcherConfig(ctx context.Context) (filesystemWatcherConfig, error) {
	roots, err := s.configuredRemoteFetchWatchRoots(ctx)
	if err != nil {
		return filesystemWatcherConfig{}, err
	}
	return filesystemWatcherConfig{ScanDepth: s.configuredLocalScanDepth(ctx), ExcludedRoots: roots}, nil
}

func sameFilesystemWatcherConfig(left filesystemWatcherConfig, right filesystemWatcherConfig) bool {
	if left.ScanDepth != right.ScanDepth || len(left.ExcludedRoots) != len(right.ExcludedRoots) {
		return false
	}
	for index := range left.ExcludedRoots {
		if !strings.EqualFold(left.ExcludedRoots[index], right.ExcludedRoots[index]) {
			return false
		}
	}
	return true
}

func (s *Server) dispatchFilesystemTriggeredLocalScan(ctx context.Context, watchedDirectories int, eventAt time.Time) (bool, bool, error) {
	trigger, ok, err := s.loadFixedFilesystemTrigger(ctx)
	if err != nil || !ok || !trigger.Enabled {
		return false, false, err
	}
	var active int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM workflow_run WHERE trigger_id = ? AND status IN ('queued', 'running')", trigger.ID).Scan(&active); err != nil {
		return false, false, err
	}
	if active > 0 {
		return false, true, nil
	}
	observedAt := eventAt
	if observedAt.IsZero() {
		observedAt = time.Now().UTC()
	}
	_, err = s.enqueueLocalScanWithPayload(ctx, "filesystem_event", "data_directories_changed", trigger.ID, localScanJobPayload{
		Root: s.cfg.DataRoot, ScanDepth: s.configuredLocalScanDepth(ctx),
		DirectoryEventAt: formatWorkflowTimestamp(observedAt), ObservedDirectories: watchedDirectories,
	})
	if err != nil {
		message := filesystemTriggerErrorPrefix + "could not queue local scan"
		_, _ = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", message, trigger.ID)
		return false, false, err
	}
	_, triggerErr := s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_run_at = ?, last_error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?", formatWorkflowTimestamp(observedAt), trigger.ID)
	_, stateErr := s.db.ExecContext(ctx, "UPDATE filesystem_trigger_state SET watched_directory_count = ?, last_event_at = ?, updated_at = CURRENT_TIMESTAMP WHERE trigger_id = ?", watchedDirectories, formatWorkflowTimestamp(observedAt), trigger.ID)
	return true, false, errors.Join(triggerErr, stateErr)
}

func (s *Server) loadFixedFilesystemTrigger(ctx context.Context) (filesystemTriggerRecord, bool, error) {
	var trigger filesystemTriggerRecord
	err := s.db.QueryRowContext(ctx, "SELECT trigger.id, trigger.enabled, trigger.last_error_message FROM workflow_trigger AS trigger INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id WHERE trigger.trigger_type = 'filesystem_event' AND definition.code = 'local_library_scan' ORDER BY trigger.id LIMIT 1").Scan(&trigger.ID, &trigger.Enabled, &trigger.LastErrorMessage)
	if errors.Is(err, sql.ErrNoRows) {
		return trigger, false, nil
	}
	return trigger, err == nil, err
}

func (s *Server) recordFilesystemWatcherReady(ctx context.Context, watchedDirectories int) error {
	trigger, ok, err := s.loadFixedFilesystemTrigger(ctx)
	if err != nil || !ok {
		return err
	}
	if _, err := s.db.ExecContext(ctx, "INSERT INTO filesystem_trigger_state (trigger_id, watched_directory_count) VALUES (?, ?) ON CONFLICT(trigger_id) DO UPDATE SET watched_directory_count = excluded.watched_directory_count, updated_at = CURRENT_TIMESTAMP", trigger.ID, watchedDirectories); err != nil {
		return err
	}
	if strings.HasPrefix(trigger.LastErrorMessage, filesystemTriggerErrorPrefix) {
		return s.clearFilesystemTriggerError(ctx, trigger.ID)
	}
	return nil
}

func (s *Server) recordFilesystemWatcherError(ctx context.Context, watchErr error) error {
	trigger, ok, err := s.loadFixedFilesystemTrigger(ctx)
	if err != nil || !ok || !trigger.Enabled {
		return err
	}
	message := filesystemTriggerErrorPrefix + watchErr.Error()
	_, err = s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?", message, trigger.ID)
	return err
}

func (s *Server) clearFilesystemTriggerError(ctx context.Context, triggerID int64) error {
	_, err := s.db.ExecContext(ctx, "UPDATE workflow_trigger SET last_error_message = CASE WHEN last_error_message LIKE ? THEN '' ELSE last_error_message END, updated_at = CURRENT_TIMESTAMP WHERE id = ?", strings.ReplaceAll(filesystemTriggerErrorPrefix, "%", "\\%")+"%", triggerID)
	return err
}

func (s *Server) notifyFilesystemTriggerConfigChanged() {
	select {
	case s.filesystemTriggerConfigChanged <- struct{}{}:
	default:
	}
}

func waitForFilesystemTrigger(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}
