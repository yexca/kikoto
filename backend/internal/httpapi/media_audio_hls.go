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

// Audio HLS segments come from one continuous FFmpeg encode instead of one
// process per segment: AAC frames that cross a segment boundary stay intact,
// so playback has no gap or click at every boundary. A session starts at the
// requested segment, which makes the first segment of a long file available
// in well under a second, and it restarts only when the listener seeks
// outside what it has produced or is about to produce.
const (
	audioHLSProfileVersion = "hls-audio-v1-aac192"
	// A session stops this many segments ahead of the furthest segment the
	// listener asked for, releasing its transcode slot.
	audioHLSAheadSegments = 300
	// Listening within this many segments of a missing segment starts the
	// next session in the background.
	audioHLSRefillLeadSegments = 100
	// A missing segment this close to a running session's output waits for it
	// instead of restarting the encoder.
	audioHLSWaitWindowSegments = 20
	// Every session also stops after this many segments, which bounds its
	// cache quota reservation.
	audioHLSSessionMaximumSegments = audioHLSAheadSegments + audioHLSRefillLeadSegments
	// A 192 kbit/s six-second segment is about 170 KiB in MPEG-TS.
	audioHLSSegmentReservationBytes int64 = 256 << 10
	audioHLSSegmentWait                   = 45 * time.Second
	audioHLSSessionTimeout                = 20 * time.Minute
	audioHLSPollInterval                  = 40 * time.Millisecond
	audioHLSModTimeMargin                 = 2 * time.Second
	// FFmpeg's HLS muxer needs a playlist output; the server publishes its own.
	audioHLSSessionPlaylist = ".audio-hls-session.m3u8"
)

var (
	errHLSSegmentNotFound     = errors.New("HLS segment was not found")
	errAudioHLSSessionStopped = errors.New("audio HLS session stopped")
)

type audioHLSSessionState uint8

const (
	audioHLSSessionRunning audioHLSSessionState = iota
	// FFmpeg reached the end of the input.
	audioHLSSessionFinished
	// The session was ahead of the listener, replaced, timed out, or shut down.
	audioHLSSessionStopped
	audioHLSSessionFailed
)

type audioHLSSession struct {
	key       string
	dir       string
	start     int
	startedAt time.Time
	cancel    context.CancelFunc
	exited    chan struct{}

	mu sync.Mutex
	// next is the first segment this session has not completed.
	next int
	// requested is the furthest segment the listener asked for.
	requested int
	state     audioHLSSessionState
	err       error
	// changed is closed and replaced whenever next or state changes.
	changed chan struct{}
}

// audioHLSSessions holds at most one session per source revision.
type audioHLSSessions struct {
	mu       sync.Mutex
	sessions map[string]*audioHLSSession
	starts   cachePathLocker
}

func (sessions *audioHLSSessions) get(key string) *audioHLSSession {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	return sessions.sessions[key]
}

func (sessions *audioHLSSessions) put(session *audioHLSSession) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.sessions == nil {
		sessions.sessions = map[string]*audioHLSSession{}
	}
	sessions.sessions[session.key] = session
}

func (sessions *audioHLSSessions) remove(session *audioHLSSession) {
	sessions.mu.Lock()
	defer sessions.mu.Unlock()
	if sessions.sessions[session.key] == session {
		delete(sessions.sessions, session.key)
	}
}

// stopAll stops every session and waits for their encoders to exit.
func (sessions *audioHLSSessions) stopAll() {
	sessions.mu.Lock()
	running := make([]*audioHLSSession, 0, len(sessions.sessions))
	for _, session := range sessions.sessions {
		running = append(running, session)
	}
	sessions.mu.Unlock()
	for _, session := range running {
		session.stop()
	}
}

func (session *audioHLSSession) stop() {
	session.cancel()
	<-session.exited
}

func (session *audioHLSSession) observe(index int) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if index > session.requested {
		session.requested = index
	}
}

// covers reports whether the running encoder will produce index soon.
func (session *audioHLSSession) covers(index int) bool {
	session.mu.Lock()
	defer session.mu.Unlock()
	return session.state == audioHLSSessionRunning && index >= session.next && index < session.next+audioHLSWaitWindowSegments
}

func (session *audioHLSSession) setNext(next int) {
	session.mu.Lock()
	defer session.mu.Unlock()
	if next > session.next {
		session.next = next
		session.broadcastLocked()
	}
}

func (session *audioHLSSession) finish(state audioHLSSessionState, err error) {
	session.mu.Lock()
	defer session.mu.Unlock()
	session.state = state
	session.err = err
	session.broadcastLocked()
}

func (session *audioHLSSession) broadcastLocked() {
	close(session.changed)
	session.changed = make(chan struct{})
}

// waitFor waits until the session publishes segment index at segmentPath.
func (session *audioHLSSession) waitFor(ctx context.Context, index int, segmentPath string) error {
	timer := time.NewTimer(audioHLSSegmentWait)
	defer timer.Stop()
	for {
		session.mu.Lock()
		changed, state, next, err := session.changed, session.state, session.next, session.err
		session.mu.Unlock()
		if validCachedHLSSegment(segmentPath) {
			return nil
		}
		switch state {
		case audioHLSSessionRunning:
		case audioHLSSessionFinished:
			if index >= next {
				return errHLSSegmentNotFound
			}
			// Produced and already evicted: encode it again.
			return errAudioHLSSessionStopped
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

func audioHLSSessionKey(source hlsPlaybackSource) string {
	return strconv.FormatInt(source.LocationID, 10) + "/" + source.Revision
}

func audioHLSRelativeDir(source hlsPlaybackSource) string {
	return path.Join(transcodeCacheRootRelative, "hls-audio", strconv.FormatInt(source.LocationID, 10), source.Revision)
}

func hlsSegmentName(index int) string {
	return fmt.Sprintf("segment-%06d.ts", index)
}

func (s *Server) serveAudioHLSSegment(w http.ResponseWriter, r *http.Request, source hlsPlaybackSource, index int) error {
	relDir := audioHLSRelativeDir(source)
	relPath := path.Join(relDir, hlsSegmentName(index))
	dir, err := safeCachePath(s.cfg.CacheRoot, relDir)
	if err != nil {
		return err
	}
	if session := s.audioHLS.get(audioHLSSessionKey(source)); session != nil {
		session.observe(index)
	}
	served, err := s.serveCachedAudioHLSSegment(w, r, relPath)
	if served {
		s.refillAudioHLS(source, dir, index)
	}
	if served || err != nil {
		return err
	}
	// A session that stops while this request waits, or a segment evicted
	// right after it was published, gets one more encoder start.
	for attempt := 0; attempt < 2; attempt++ {
		session, err := s.ensureAudioHLSSession(r.Context(), source, dir, index)
		if err != nil {
			return err
		}
		err = session.waitFor(r.Context(), index, filepath.Join(dir, hlsSegmentName(index)))
		if errors.Is(err, errAudioHLSSessionStopped) {
			continue
		}
		if err != nil {
			return err
		}
		served, err := s.serveCachedAudioHLSSegment(w, r, relPath)
		if served || err != nil {
			return err
		}
	}
	return errRealtimeResourceBusy
}

func (s *Server) serveCachedAudioHLSSegment(w http.ResponseWriter, r *http.Request, relPath string) (bool, error) {
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

// ensureAudioHLSSession returns the session that produces index next,
// replacing a session that would not reach it soon.
func (s *Server) ensureAudioHLSSession(ctx context.Context, source hlsPlaybackSource, dir string, index int) (*audioHLSSession, error) {
	key := audioHLSSessionKey(source)
	release, err := s.audioHLS.starts.acquire(ctx, key)
	if err != nil {
		return nil, err
	}
	defer release()
	if current := s.audioHLS.get(key); current != nil {
		if current.covers(index) {
			current.observe(index)
			return current, nil
		}
		current.stop()
	}
	return s.startAudioHLSSession(ctx, source, dir, index)
}

// refillAudioHLS starts the next session in the background when the
// listener, at index, nears a segment no session has produced.
func (s *Server) refillAudioHLS(source hlsPlaybackSource, dir string, index int) {
	if s.audioHLS.get(audioHLSSessionKey(source)) != nil {
		return
	}
	count := hlsSegmentCount(source.Duration)
	missing := -1
	for candidate := index + 1; candidate < count && candidate <= index+audioHLSRefillLeadSegments; candidate++ {
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
		if session, err := s.ensureAudioHLSSession(ctx, source, dir, missing); err == nil {
			session.observe(index)
		}
	})
}

func (s *Server) startAudioHLSSession(ctx context.Context, source hlsPlaybackSource, dir string, index int) (*audioHLSSession, error) {
	info, err := os.Stat(source.Path)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errHLSMediaNotFound
	}
	failureKey := mediaPreparationFailureKey("audio-hls", source.Path, info)
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
	releaseReservation, err := s.reserveTranscodeCache(ctx, int64(audioHLSSessionMaximumSegments)*audioHLSSegmentReservationBytes)
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
	removeAudioHLSPartials(dir)

	sessionContext, cancel := context.WithTimeout(s.lifetime.ctx, audioHLSSessionTimeout)
	command := exec.CommandContext(sessionContext, ffmpegPath, audioHLSFFmpegArgs(source.Path, dir, index)...)
	command.Stdout = io.Discard
	diagnostics := &transcodeDiagnosticOutput{}
	command.Stderr = diagnostics
	session := &audioHLSSession{
		key:       audioHLSSessionKey(source),
		dir:       dir,
		start:     index,
		startedAt: time.Now(),
		cancel:    cancel,
		exited:    make(chan struct{}),
		next:      index,
		requested: index,
		changed:   make(chan struct{}),
	}
	if err := command.Start(); err != nil {
		cancel()
		releaseResources()
		return nil, fmt.Errorf("%w: command failed to start", errHLSTranscodeUnavailable)
	}
	s.audioHLS.put(session)
	if !s.goTracked(func() {
		s.runAudioHLSSession(sessionContext, session, command, diagnostics, failureKey, releaseResources)
	}) {
		cancel()
		_ = command.Wait()
		removeAudioHLSPartials(dir)
		s.audioHLS.remove(session)
		releaseResources()
		session.finish(audioHLSSessionStopped, errAudioHLSSessionStopped)
		close(session.exited)
		return nil, ErrShuttingDown
	}
	return session, nil
}

func (s *Server) runAudioHLSSession(
	ctx context.Context,
	session *audioHLSSession,
	command *exec.Cmd,
	diagnostics *transcodeDiagnosticOutput,
	failureKey string,
	releaseResources func(),
) {
	waitResult := make(chan error, 1)
	go func() { waitResult <- command.Wait() }()
	ticker := time.NewTicker(audioHLSPollInterval)
	var waitErr error
wait:
	for {
		select {
		case waitErr = <-waitResult:
			break wait
		case <-ticker.C:
			if advanceAudioHLSSession(session) {
				session.cancel()
			}
		}
	}
	ticker.Stop()
	advanceAudioHLSSession(session)

	state, err := audioHLSSessionFinished, error(nil)
	switch {
	case ctx.Err() != nil:
		state, err = audioHLSSessionStopped, errAudioHLSSessionStopped
	case waitErr != nil:
		state = audioHLSSessionFailed
		err = fmt.Errorf("%w: command failed: %s", errHLSTranscodeUnavailable, diagnostics.String())
		session.mu.Lock()
		producedNothing := session.next == session.start
		session.mu.Unlock()
		if producedNothing {
			s.mediaPreparationFailures.remember(failureKey)
		}
	}
	session.cancel()
	removeAudioHLSPartials(session.dir)
	s.audioHLS.remove(session)
	// Release before reporting the exit, so a replacing session finds the slot free.
	releaseResources()
	session.finish(state, err)
	close(session.exited)
}

// advanceAudioHLSSession records the segments FFmpeg has published and
// reports whether the session should stop. FFmpeg writes each segment beside
// its final name and renames it into place once complete, so a segment file
// that exists is complete.
func advanceAudioHLSSession(session *audioHLSSession) bool {
	session.mu.Lock()
	next, requested := session.next, session.requested
	session.mu.Unlock()
	defer func() { session.setNext(next) }()
	for {
		if next-session.start >= audioHLSSessionMaximumSegments || next >= requested+audioHLSAheadSegments {
			return true
		}
		info, err := os.Stat(filepath.Join(session.dir, hlsSegmentName(next)))
		if err != nil {
			return false
		}
		// An earlier session already produced what follows. The margin covers
		// filesystems with coarse modification times.
		if info.ModTime().Before(session.startedAt.Add(-audioHLSModTimeMargin)) {
			return true
		}
		next++
	}
}

// removeAudioHLSPartials removes the session playlist and unfinished segments,
// which only the session's own FFmpeg process writes.
func removeAudioHLSPartials(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.Type().IsRegular() && (strings.HasPrefix(name, audioHLSSessionPlaylist) || strings.HasSuffix(name, ".ts.tmp")) {
			_ = os.Remove(filepath.Join(dir, name))
		}
	}
}

func audioHLSFFmpegArgs(input string, outputDir string, startIndex int) []string {
	start := strconv.FormatFloat(float64(startIndex)*hlsSegmentDurationSeconds, 'f', 3, 64)
	// The segment name is an FFmpeg pattern, so a literal % in the cache path is doubled.
	segmentPattern := filepath.Join(strings.ReplaceAll(outputDir, "%", "%%"), "segment-%06d.ts")
	return []string{
		"-nostdin", "-hide_banner", "-loglevel", "error", "-y",
		"-threads", "1", "-filter_threads", "1", "-max_alloc", "268435456",
		"-protocol_whitelist", "file,pipe",
		"-ss", start, "-i", input,
		"-map", "0:a:0", "-map_metadata", "-1", "-vn", "-sn", "-dn",
		"-c:a", "aac", "-threads:a", "1", "-b:a", "192k", "-ac", "2", "-ar", "48000",
		// Every session writes the timestamps of one shared timeline.
		"-output_ts_offset", start,
		"-muxdelay", "0", "-muxpreload", "0",
		"-f", "hls",
		"-hls_time", strconv.FormatFloat(hlsSegmentDurationSeconds, 'f', -1, 64),
		"-hls_list_size", "0",
		// Segments and the playlist are written beside their final name and renamed when complete.
		"-hls_flags", "temp_file",
		"-hls_segment_type", "mpegts",
		"-start_number", strconv.Itoa(startIndex),
		"-hls_segment_filename", segmentPattern,
		filepath.Join(outputDir, audioHLSSessionPlaylist),
	}
}
