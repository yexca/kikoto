package httpapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

// HLS segments come from one continuous FFmpeg encode per source revision
// instead of one process per segment. Audio frames that cross a segment
// boundary stay intact, so playback has no gap or click at every boundary, and
// process startup, seeking, and encoder warm-up are paid once per encode
// instead of once per segment. An encode starts at the requested segment and
// restarts only when playback asks for a segment outside what it has produced
// or is about to produce.
const (
	hlsSessionTimeout       = 20 * time.Minute
	hlsSegmentWait          = 45 * time.Second
	hlsSessionPollInterval  = 40 * time.Millisecond
	hlsSessionModTimeMargin = 2 * time.Second
)

var (
	errHLSSegmentNotFound = errors.New("HLS segment was not found")
	errHLSSessionStopped  = errors.New("HLS session stopped")
)

// hlsEncodeProfile describes the continuous encodes of one media kind.
type hlsEncodeProfile struct {
	// name keys failure memory.
	name string
	// cacheDir holds the segments under the transcode cache root.
	cacheDir string
	// playlist is the session playlist FFmpeg's HLS muxer requires; the server
	// publishes its own.
	playlist string
	// A session stops this many segments ahead of the furthest segment
	// requested, releasing its transcode slot.
	aheadSegments int
	// Serving a segment while no session runs starts one in the background
	// when a segment within this many is missing.
	refillLeadSegments int
	// A missing segment this close to a running session's output waits for
	// it instead of restarting the encoder.
	waitWindowSegments int
	// Every session also stops after this many segments, which bounds its
	// cache quota reservation.
	maximumSegments         int
	segmentReservationBytes int64
	// A session that no request has asked or waited for in this long stops;
	// zero leaves only the other limits.
	idleTimeout time.Duration
	args        func(source hlsPlaybackSource, outputDir string, startIndex int) []string
}

func (profile *hlsEncodeProfile) reservationBytes() int64 {
	return int64(profile.maximumSegments) * profile.segmentReservationBytes
}

type hlsSessionState uint8

const (
	hlsSessionRunning hlsSessionState = iota
	// FFmpeg reached the end of the input.
	hlsSessionFinished
	// The session was ahead of playback, idle, replaced, timed out, or shut down.
	hlsSessionStopped
	hlsSessionFailed
)

type hlsSession struct {
	profile   *hlsEncodeProfile
	key       string
	dir       string
	start     int
	startedAt time.Time
	cancel    context.CancelFunc
	exited    chan struct{}

	mu sync.Mutex
	// next is the first segment this session has not completed.
	next int
	// written counts the bytes of the segments this session completed.
	written int64
	// requested is the furthest segment playback asked for.
	requested int
	// requestedAt is when playback last asked for a segment, and waiting
	// counts the requests waiting for this session.
	requestedAt time.Time
	waiting     int
	state       hlsSessionState
	err         error
	// changed is closed and replaced whenever next or state changes.
	changed chan struct{}
}

// hlsSessions holds at most one session per source revision.
type hlsSessions struct {
	mu       sync.Mutex
	sessions map[string]*hlsSession
	starts   cachePathLocker
}

func (sessions *hlsSessions) get(key string) *hlsSession {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	return sessions.sessions[key]
}

func (sessions *hlsSessions) put(session *hlsSession) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.sessions == nil {
		sessions.sessions = map[string]*hlsSession{}
	}
	sessions.sessions[session.key] = session
}

func (sessions *hlsSessions) remove(session *hlsSession) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.sessions[session.key] == session {
		delete(sessions.sessions, session.key)
	}
}

// stopAll stops every session and waits for their encoders to exit.
func (sessions *hlsSessions) stopAll() {
	sessions.mu.Lock()
	running := make([]*hlsSession, 0, len(sessions.sessions))
	for _, session := range sessions.sessions {
		running = append(running, session)
	}
	sessions.mu.Unlock()
	for _, session := range running {
		session.stop()
	}
}

func (session *hlsSession) stop() {
	session.cancel()
	<-session.exited
}

func (session *hlsSession) observe(index int) {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.requestedAt = time.Now()
	if index > session.requested {
		session.requested = index
	}
}

// covers reports whether the running encoder will produce index soon.
func (session *hlsSession) covers(index int) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.state == hlsSessionRunning && index >= session.next && index < session.next+session.profile.waitWindowSegments
}

func (session *hlsSession) setProgress(next int, written int64) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if next > session.next {
		session.next = next
		session.written = written
		session.broadcastLocked()
	}
}

func (session *hlsSession) finish(state hlsSessionState, err error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.state = state
	session.err = err
	session.broadcastLocked()
}

func (session *hlsSession) broadcastLocked() {
	close(session.changed)
	session.changed = make(chan struct{})
}

// waitFor waits until the session publishes segment index at segmentPath.
func (session *hlsSession) waitFor(ctx context.Context, index int, segmentPath string) error {
	session.mu.Lock()
	session.waiting++
	session.mu.Unlock()
	defer func() {
		session.mu.Lock()
		session.waiting--
		session.requestedAt = time.Now()
		session.mu.Unlock()
	}()
	timer := time.NewTimer(hlsSegmentWait)
	defer timer.Stop()
	for {
		session.mu.Lock()
		changed, state, next, err := session.changed, session.state, session.next, session.err
		session.mu.Unlock()
		if validCachedHLSSegment(segmentPath) {
			return nil
		}
		switch state {
		case hlsSessionRunning:
		case hlsSessionFinished:
			if index >= next {
				return errHLSSegmentNotFound
			}
			// Produced and already evicted: encode it again.
			return errHLSSessionStopped
		default:
			return err
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return errRealtimeResourceBusy
		}
	}
}

func hlsSessionRelativeDir(profile *hlsEncodeProfile, source hlsPlaybackSource) string {
	return path.Join(transcodeCacheRootRelative, profile.cacheDir, strconv.FormatInt(source.LocationID, 10), source.Revision)
}

func hlsSegmentName(index int) string {
	return fmt.Sprintf("segment-%06d.ts", index)
}

func (s *Server) serveHLSSessionSegment(w http.ResponseWriter, r *http.Request, profile *hlsEncodeProfile, source hlsPlaybackSource, index int) error {
	relDir := hlsSessionRelativeDir(profile, source)
	relPath := path.Join(relDir, hlsSegmentName(index))
	dir, err := safeCachePath(s.cfg.CacheRoot, relDir)
	if err != nil {
		return err
	}
	if session := s.hlsSessions.get(relDir); session != nil {
		session.observe(index)
	}
	served, err := s.serveCachedHLSSessionSegment(w, r, relPath)
	if served {
		s.refillHLSSession(profile, source, relDir, dir, index)
	}
	if served || err != nil {
		return err
	}
	// A session that stops while this request waits, or a segment evicted
	// right after it was published, gets one more encoder start.
	for attempt := 0; attempt < 2; attempt++ {
		session, err := s.ensureHLSSession(r.Context(), profile, source, relDir, dir, index)
		if err != nil {
			return err
		}
		err = session.waitFor(r.Context(), index, filepath.Join(dir, hlsSegmentName(index)))
		if errors.Is(err, errHLSSessionStopped) {
			continue
		}
		if err != nil {
			return err
		}
		served, err := s.serveCachedHLSSessionSegment(w, r, relPath)
		if served || err != nil {
			return err
		}
	}
	return errRealtimeResourceBusy
}

func (s *Server) serveCachedHLSSessionSegment(w http.ResponseWriter, r *http.Request, relPath string) (bool, error) {
	absolutePath, err := safeCachePath(s.cfg.CacheRoot, relPath)
	if err != nil {
		return false, err
	}
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	releasePath, err := s.acquireCachePathLock(r.Context(), relPath)
	if err != nil {
		return false, err
	}
	defer releasePath()
	if !validCachedHLSSegment(absolutePath) {
		return false, nil
	}
	return true, serveCachedHLSSegment(w, r, absolutePath)
}

// ensureHLSSession returns the session that produces index next, replacing a
// session that would not reach it soon.
func (s *Server) ensureHLSSession(ctx context.Context, profile *hlsEncodeProfile, source hlsPlaybackSource, key string, dir string, index int) (*hlsSession, error) {
	release, err := s.hlsSessions.starts.acquire(ctx, key)
	if err != nil {
		return nil, err
	}
	defer release()
	if current := s.hlsSessions.get(key); current != nil {
		if current.covers(index) {
			current.observe(index)
			return current, nil
		}
		current.stop()
	}
	return s.startHLSSession(ctx, profile, source, key, dir, index)
}

// refillHLSSession starts the next session in the background when playback,
// at index, nears a segment no session has produced.
func (s *Server) refillHLSSession(profile *hlsEncodeProfile, source hlsPlaybackSource, key string, dir string, index int) {
	if s.hlsSessions.get(key) != nil {
		return
	}
	count := hlsSegmentCount(source.Duration)
	missing := -1
	for candidate := index + 1; candidate < count && candidate <= index+profile.refillLeadSegments; candidate++ {
		if !validCachedHLSSegment(filepath.Join(dir, hlsSegmentName(candidate))) {
			missing = candidate
			break
		}
	}
	if missing < 0 {
		return
	}
	s.Go(func(ctx context.Context) {
		// A busy transcode slot leaves the refill to a later request.
		if session, err := s.ensureHLSSession(ctx, profile, source, key, dir, missing); err == nil {
			session.observe(index)
		}
	})
}

func (s *Server) startHLSSession(ctx context.Context, profile *hlsEncodeProfile, source hlsPlaybackSource, key string, dir string, index int) (*hlsSession, error) {
	info, err := os.Stat(source.Path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errHLSMediaNotFound
	}
	failureKey := mediaPreparationFailureKey(profile.name, source.Path, info)
	if s.mediaPreparationFailures.failedRecently(failureKey) {
		return nil, fmt.Errorf("%w: preparation failed recently", errHLSTranscodeUnavailable)
	}
	ffmpegPath, err := exec.LookPath("ffmpeg")
	if err != nil {
		return nil, fmt.Errorf("%w: ffmpeg executable was not found", errHLSTranscodeUnavailable)
	}
	releaseSlot, err := s.acquireRealtimeTranscode(ctx)
	if err != nil {
		return nil, err
	}
	s.transcodeCacheActivityMu.RLock()
	defer s.transcodeCacheActivityMu.RUnlock()
	releaseReservation, err := s.reserveTranscodeCache(ctx, profile.reservationBytes())
	if err != nil {
		releaseSlot()
		return nil, err
	}
	releaseResources := func() {
		releaseReservation()
		releaseSlot()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		releaseResources()
		return nil, err
	}
	// A playlist left by an interrupted process would misreport progress.
	removeHLSSessionPartials(profile, dir)

	sessionContext, cancel := context.WithTimeout(s.lifetime.ctx, hlsSessionTimeout)
	command := exec.CommandContext(sessionContext, ffmpegPath, profile.args(source, dir, index)...)
	command.Stdout = io.Discard
	diagnostics := &transcodeDiagnosticOutput{}
	command.Stderr = diagnostics
	now := time.Now()
	session := &hlsSession{
		profile:     profile,
		key:         key,
		dir:         dir,
		start:       index,
		startedAt:   now,
		cancel:      cancel,
		exited:      make(chan struct{}),
		next:        index,
		requested:   index,
		requestedAt: now,
		changed:     make(chan struct{}),
	}
	if err := command.Start(); err != nil {
		cancel()
		releaseResources()
		return nil, fmt.Errorf("%w: command failed to start", errHLSTranscodeUnavailable)
	}
	s.hlsSessions.put(session)
	if !s.goTracked(func() {
		s.runHLSSession(sessionContext, session, command, diagnostics, failureKey, releaseResources)
	}) {
		cancel()
		_ = command.Wait()
		removeHLSSessionPartials(profile, dir)
		s.hlsSessions.remove(session)
		releaseResources()
		session.finish(hlsSessionStopped, errHLSSessionStopped)
		close(session.exited)
		return nil, ErrShuttingDown
	}
	return session, nil
}

func (s *Server) runHLSSession(
	ctx context.Context,
	session *hlsSession,
	command *exec.Cmd,
	diagnostics *transcodeDiagnosticOutput,
	failureKey string,
	releaseResources func(),
) {
	waitResult := make(chan error, 1)
	go func() { waitResult <- command.Wait() }()
	ticker := time.NewTicker(hlsSessionPollInterval)
	var waitErr, failure error
wait:
	for {
		select {
		case waitErr = <-waitResult:
			break wait
		case now := <-ticker.C:
			if stop, err := advanceHLSSession(session, now); stop {
				failure = err
				session.cancel()
			}
		}
	}
	ticker.Stop()
	if _, err := advanceHLSSession(session, time.Now()); failure == nil {
		failure = err
	}

	state, err := hlsSessionFinished, error(nil)
	switch {
	case failure != nil:
		state, err = hlsSessionFailed, failure
	case ctx.Err() != nil:
		state, err = hlsSessionStopped, errHLSSessionStopped
	case waitErr != nil:
		state = hlsSessionFailed
		err = fmt.Errorf("%w: command failed: %s", errHLSTranscodeUnavailable, diagnostics.String())
	}
	if state == hlsSessionFailed {
		session.mu.Lock()
		producedNothing := session.next == session.start
		session.mu.Unlock()
		if producedNothing {
			s.mediaPreparationFailures.remember(failureKey)
		}
	}
	session.cancel()
	removeHLSSessionPartials(session.profile, session.dir)
	s.hlsSessions.remove(session)
	// Release before reporting the exit, so a replacing session finds the slot free.
	releaseResources()
	session.finish(state, err)
	close(session.exited)
}

// advanceHLSSession records the segments FFmpeg has published and reports
// whether the session should stop, with the reason when it fails. FFmpeg
// writes each segment beside its final name and renames it into place once
// complete, so a segment file that exists is complete.
func advanceHLSSession(session *hlsSession, now time.Time) (bool, error) {
	profile := session.profile
	session.mu.Lock()
	next, written, requested := session.next, session.written, session.requested
	idle := session.waiting == 0 && now.Sub(session.requestedAt) >= profile.idleTimeout
	session.mu.Unlock()
	defer func() { session.setProgress(next, written) }()
	for {
		if next-session.start >= profile.maximumSegments || next >= requested+profile.aheadSegments || written > profile.reservationBytes() {
			return true, nil
		}
		segmentPath := filepath.Join(session.dir, hlsSegmentName(next))
		info, err := os.Stat(segmentPath)
		if err != nil {
			break
		}
		// An earlier session already produced what follows. The margin covers
		// filesystems with coarse modification times.
		if info.ModTime().Before(session.startedAt.Add(-hlsSessionModTimeMargin)) {
			return true, nil
		}
		if info.Size() > hlsSegmentMaximumBytes {
			_ = os.Remove(segmentPath)
			return true, fmt.Errorf("%w: segment exceeded its byte limit", errHLSTranscodeUnavailable)
		}
		written += info.Size()
		next++
	}
	if info, err := os.Stat(filepath.Join(session.dir, hlsSegmentName(next)+".tmp")); err == nil && info.Size() > hlsSegmentMaximumBytes {
		return true, fmt.Errorf("%w: segment exceeded its byte limit", errHLSTranscodeUnavailable)
	}
	return profile.idleTimeout > 0 && idle, nil
}

// removeHLSSessionPartials removes the session playlist and unfinished
// segments, which only the session's own FFmpeg process writes.
func removeHLSSessionPartials(profile *hlsEncodeProfile, dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type().IsRegular() && (strings.HasPrefix(name, profile.playlist) || strings.HasSuffix(name, ".ts.tmp")) {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
}

// isHLSSessionPartial reports whether name is a session playlist or an
// unfinished segment.
func isHLSSessionPartial(name string) bool {
	return strings.HasPrefix(name, audioHLSSessionPlaylist) || strings.HasPrefix(name, videoHLSSessionPlaylist) || strings.HasSuffix(name, ".ts.tmp")
}

// hlsSegmentFFmpegOutputArgs are the HLS muxer options every session uses:
// six-second segments numbered from startIndex, each written beside its final
// name and renamed when complete.
func hlsSegmentFFmpegOutputArgs(outputDir string, playlist string, startIndex int) []string {
	// The segment name is an FFmpeg pattern, so a literal % in the cache path is doubled.
	segmentPattern := filepath.Join(strings.ReplaceAll(outputDir, "%", "%%"), "segment-%06d.ts")
	return []string{
		"-f", "hls",
		"-hls_time", strconv.FormatFloat(hlsSegmentDurationSeconds, 'f', -1, 64),
		"-hls_list_size", "0",
		"-hls_flags", "temp_file",
		"-hls_segment_type", "mpegts",
		"-start_number", strconv.Itoa(startIndex),
		"-hls_segment_filename", segmentPattern,
		filepath.Join(outputDir, playlist),
	}
}
