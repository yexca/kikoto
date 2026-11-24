package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"sync"

	"github.com/yexca/kikoto/backend/internal/record"
)

const (
	// recordMediaDetailsQueueSize bounds the files waiting for their details
	// behind opened folders; a folder opened while it is full is read when it
	// is opened again.
	recordMediaDetailsQueueSize = 512
	// recordMediaDetailsBatch is how many queued files one pass reads.
	recordMediaDetailsBatch = 64
)

// recordMediaDetails queues the pending videos and audio files of opened
// record folders and reads their media details behind the response, as
// opening a work indexes its files: a library needs no pass over every file
// for the folders someone opens to show lengths and cover art.
type recordMediaDetails struct {
	mu      sync.Mutex
	queue   []int64
	queued  map[int64]bool
	running bool
}

// queueRecordMediaDetails queues the listed files whose media details are
// pending, once each, and reports how many of them are waiting.
func (s *Server) queueRecordMediaDetails(assets []record.Asset) int {
	details := &s.recordMediaDetails
	details.mu.Lock()
	defer details.mu.Unlock()
	if details.queued == nil {
		details.queued = map[int64]bool{}
	}
	waiting := 0
	for _, asset := range assets {
		if !asset.ProbePending || asset.Availability != "available" {
			continue
		}
		if !details.queued[asset.ID] {
			if len(details.queue) >= recordMediaDetailsQueueSize {
				continue
			}
			details.queued[asset.ID] = true
			details.queue = append(details.queue, asset.ID)
		}
		waiting++
	}
	if details.running || len(details.queue) == 0 {
		return waiting
	}
	details.running = true
	if !s.Go(s.runRecordMediaDetails) {
		details.running = false
		details.queue, details.queued = nil, nil
		return 0
	}
	return waiting
}

func (s *Server) runRecordMediaDetails(lifetime context.Context) {
	details := &s.recordMediaDetails
	for {
		details.mu.Lock()
		if len(details.queue) == 0 || lifetime.Err() != nil {
			details.running = false
			details.queue, details.queued = nil, nil
			details.mu.Unlock()
			return
		}
		batch := append([]int64(nil), details.queue[:min(len(details.queue), recordMediaDetailsBatch)]...)
		details.queue = details.queue[len(batch):]
		details.mu.Unlock()

		_, err := s.recordStore.ProbeAssets(lifetime, batch, record.ProbeOptions{})
		details.mu.Lock()
		for _, id := range batch {
			delete(details.queued, id)
		}
		details.mu.Unlock()
		switch {
		case err == nil, lifetime.Err() != nil:
		case errors.Is(err, record.ErrRootOffline):
			// The files stay pending for the next time the folder opens.
			slog.Debug("record media details wait for the record root", "files", len(batch))
		default:
			slog.Warn("read record media details", "files", len(batch), "error", err)
		}
	}
}
