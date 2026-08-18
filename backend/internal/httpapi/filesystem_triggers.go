package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

const (
	filesystemTriggerSettleDelay = 5 * time.Second
	filesystemTriggerRetryDelay  = 5 * time.Second
	filesystemTriggerErrorPrefix = "filesystem watcher: "
	filesystemTriggerMaxPaths    = 1024
)

var (
	errFilesystemWatcherReconfigure   = errors.New("filesystem watcher configuration changed")
	errFilesystemWatchRootInvalidated = errors.New("filesystem watch root was removed or renamed")
)

type filesystemTriggerRecord struct {
	ID               int64
	Enabled          bool
	LastErrorMessage string
	ConfigJSON       string
}

type filesystemWatcherConfig struct {
	ScanDepth     int
	ExcludedRoots []string
}

type filesystemWatcher interface {
	Changes() <-chan localfs.DirectoryChange
	Invalidated() <-chan struct{}
	Errors() <-chan error
	WatchedDirectoryCount() int
}

func (s *Server) runFilesystemTriggerCoordinator(ctx context.Context) {
	recoveryFullScan := false
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
		err = s.runFilesystemWatcherSession(ctx, watcher, watchConfig, filesystemTriggerSettleDelay, filesystemTriggerRetryDelay, &recoveryFullScan)
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

func (s *Server) runFilesystemWatcherSession(ctx context.Context, watcher filesystemWatcher, watchConfig filesystemWatcherConfig, settleDelay, retryDelay time.Duration, recoveryFullScan ...*bool) error {
	if err := s.recordFilesystemWatcherReady(ctx, watcher.WatchedDirectoryCount()); err != nil && !isDatabaseBusyError(err) {
		return err
	}
	trigger, ok, err := s.loadFixedFilesystemTrigger(ctx)
	if err != nil {
		return err
	}
	session := filesystemWatcherSession{
		server: s, watcher: watcher, config: watchConfig,
		settleDelay: settleDelay, retryDelay: retryDelay, enabled: ok && trigger.Enabled,
	}
	if len(recoveryFullScan) > 0 {
		session.recoveryFullScan = recoveryFullScan[0]
		if session.recoveryFullScan != nil && !session.enabled {
			*session.recoveryFullScan = false
		} else if session.recoveryFullScan != nil && *session.recoveryFullScan {
			session.scheduleFullScan(settleDelay)
		}
	}
	defer session.stopTimer()
	return session.run(ctx)
}

type filesystemWatcherSession struct {
	server           *Server
	watcher          filesystemWatcher
	config           filesystemWatcherConfig
	settleDelay      time.Duration
	retryDelay       time.Duration
	enabled          bool
	pending          bool
	forceFull        bool
	changedPaths     map[string]struct{}
	recoveryFullScan *bool
	lastEventAt      time.Time
	timer            *time.Timer
	timerC           <-chan time.Time
}

func (session *filesystemWatcherSession) run(ctx context.Context) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case change, ok := <-session.watcher.Changes():
			if !ok {
				session.retainFullScanRecovery()
				return errors.New("filesystem watcher closed")
			}
			session.scheduleEvent(change, session.settleDelay)
		case _, ok := <-session.watcher.Invalidated():
			if !ok {
				session.retainFullScanRecovery()
				return errors.New("filesystem watcher closed")
			}
			session.retainFullScanRecovery()
			return errFilesystemWatchRootInvalidated
		case watchErr, ok := <-session.watcher.Errors():
			if !ok {
				session.retainFullScanRecovery()
				return errors.New("filesystem watcher closed")
			}
			_ = session.server.recordFilesystemWatcherError(ctx, watchErr)
			session.scheduleFullScan(session.settleDelay)
		case <-session.server.filesystemTriggerConfigChanged:
			if err := session.reload(ctx); err != nil {
				return err
			}
		case <-session.timerC:
			if err := session.dispatch(ctx); err != nil {
				return err
			}
		}
	}
}

func (session *filesystemWatcherSession) retainFullScanRecovery() {
	if session.enabled && session.recoveryFullScan != nil {
		*session.recoveryFullScan = true
	}
}

func (session *filesystemWatcherSession) scheduleEvent(change localfs.DirectoryChange, delay time.Duration) {
	if !session.enabled {
		return
	}
	if session.changedPaths == nil {
		session.changedPaths = map[string]struct{}{}
	}
	path := filepath.Clean(strings.TrimSpace(change.Path))
	if path != "." && path != "" {
		if !session.forceFull {
			if _, exists := session.changedPaths[path]; !exists {
				if len(session.changedPaths) >= filesystemTriggerMaxPaths {
					session.forceFull = true
					session.changedPaths = nil
				} else {
					session.changedPaths[path] = struct{}{}
				}
			}
		}
	}
	session.pending = true
	session.lastEventAt = time.Now().UTC()
	session.schedule(delay)
}

func (session *filesystemWatcherSession) scheduleFullScan(delay time.Duration) {
	if !session.enabled {
		return
	}
	session.pending = true
	session.forceFull = true
	session.changedPaths = nil
	session.lastEventAt = time.Now().UTC()
	session.schedule(delay)
}

func (session *filesystemWatcherSession) stopTimer() {
	if session.timer != nil && !session.timer.Stop() {
		select {
		case <-session.timer.C:
		default:
		}
	}
	session.timerC = nil
}

func (session *filesystemWatcherSession) schedule(delay time.Duration) {
	if session.timer == nil {
		session.timer = time.NewTimer(delay)
	} else {
		session.stopTimer()
		session.timer.Reset(delay)
	}
	session.timerC = session.timer.C
}

func (session *filesystemWatcherSession) reload(ctx context.Context) error {
	nextConfig, err := session.server.loadFilesystemWatcherConfig(ctx)
	if err != nil {
		return err
	}
	if !sameFilesystemWatcherConfig(session.config, nextConfig) {
		return errFilesystemWatcherReconfigure
	}
	trigger, ok, err := session.server.loadFixedFilesystemTrigger(ctx)
	if err != nil {
		return err
	}
	wasEnabled := session.enabled
	session.enabled = ok && trigger.Enabled
	if !session.enabled {
		session.pending = false
		session.forceFull = false
		session.changedPaths = nil
		if session.recoveryFullScan != nil {
			*session.recoveryFullScan = false
		}
		session.stopTimer()
	} else if !wasEnabled && session.recoveryFullScan != nil && *session.recoveryFullScan {
		session.scheduleFullScan(session.settleDelay)
	}
	return nil
}

func (session *filesystemWatcherSession) dispatch(ctx context.Context) error {
	session.timerC = nil
	if !session.pending {
		return nil
	}
	paths := make([]string, 0, len(session.changedPaths))
	for path := range session.changedPaths {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	queued, blocked, err := session.server.dispatchFilesystemTriggeredLocalScan(ctx, session.watcher.WatchedDirectoryCount(), session.lastEventAt, paths, session.forceFull)
	if queued {
		session.pending = false
		if session.forceFull && session.recoveryFullScan != nil {
			*session.recoveryFullScan = false
		}
		session.forceFull = false
		session.changedPaths = nil
	}
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if queued {
			slog.Error("record filesystem workflow dispatch", "error", err)
			return nil
		}
		session.schedule(session.retryDelay)
		return nil
	}
	if blocked {
		session.schedule(session.retryDelay)
		return nil
	}
	if !queued {
		session.pending = false
		session.forceFull = false
		session.changedPaths = nil
	}
	return nil
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

func (s *Server) dispatchFilesystemTriggeredLocalScan(ctx context.Context, watchedDirectories int, eventAt time.Time, changedPaths []string, forceFull bool) (bool, bool, error) {
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
	config, err := normalizeLocalScanTriggerConfig(trigger.ConfigJSON)
	if err != nil {
		return false, false, err
	}
	scanMode := config.ScanMode
	fallbackReason := ""
	relativePaths := []string{}
	if scanMode == localScanModeIncremental && !forceFull {
		relativePaths, err = relativeFilesystemChangePaths(s.cfg.DataRoot, changedPaths)
		if err != nil || len(relativePaths) == 0 {
			scanMode = localScanModeFull
			fallbackReason = "changed_paths_unavailable"
		}
	} else if forceFull {
		scanMode = localScanModeFull
		fallbackReason = "watcher_recovery"
	}
	_, err = s.enqueueLocalScanWithPayload(ctx, "filesystem_event", "data_directories_changed", trigger.ID, localScanJobPayload{
		Root: s.cfg.DataRoot, ScanDepth: s.configuredLocalScanDepth(ctx), ScanMode: scanMode,
		ChangedPaths: relativePaths, FullFallbackReason: fallbackReason,
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
	err := s.db.QueryRowContext(ctx, "SELECT trigger.id, trigger.enabled, trigger.last_error_message, trigger.config_json FROM workflow_trigger AS trigger INNER JOIN workflow_definition AS definition ON definition.id = trigger.workflow_definition_id WHERE trigger.trigger_type = 'filesystem_event' AND definition.code = 'local_library_scan' ORDER BY trigger.id LIMIT 1").Scan(&trigger.ID, &trigger.Enabled, &trigger.LastErrorMessage, &trigger.ConfigJSON)
	if errors.Is(err, sql.ErrNoRows) {
		return trigger, false, nil
	}
	return trigger, err == nil, err
}

func relativeFilesystemChangePaths(root string, paths []string) ([]string, error) {
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return nil, err
	}
	result := make([]string, 0, len(paths))
	seen := map[string]bool{}
	for _, path := range paths {
		absPath, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		rel, err := filepath.Rel(absRoot, absPath)
		if err != nil || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return nil, errors.New("filesystem change path is outside the data root")
		}
		rel = filepath.ToSlash(rel)
		key := strings.ToLower(rel)
		if !seen[key] {
			seen[key] = true
			result = append(result, rel)
		}
	}
	sort.Strings(result)
	return result, nil
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
