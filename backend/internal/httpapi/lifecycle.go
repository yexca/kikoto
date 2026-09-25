package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/workflow"
)

// ErrShuttingDown is the cancellation cause of work interrupted by a service
// stop. Durable work interrupted with this cause is released for the next
// start instead of being recorded as a failure.
var ErrShuttingDown = errors.New("service is shutting down")

const interruptedJobReleaseTimeout = 5 * time.Second

func shutdownInterrupted(ctx context.Context) bool {
	return errors.Is(context.Cause(ctx), ErrShuttingDown)
}

type serverLifetime struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelCauseFunc
	tasks    sync.WaitGroup
	stopping bool
}

func newServerLifetime() *serverLifetime {
	ctx, cancel := context.WithCancelCause(context.Background())
	return &serverLifetime{ctx: ctx, cancel: cancel}
}

// Go runs fn in the background with the server lifetime context, which is
// cancelled with ErrShuttingDown when Shutdown begins. Shutdown waits for fn
// to return. Work offered after shutdown begins is not started.
func (s *Server) Go(fn func(context.Context)) bool {
	ctx := s.lifetime.ctx
	return s.goTracked(func() { fn(ctx) })
}

// goTracked runs fn in the background and makes Shutdown wait for it without
// changing the context fn already uses.
func (s *Server) goTracked(fn func()) bool {
	s.lifetime.mu.Lock()
	defer s.lifetime.mu.Unlock()
	if s.lifetime.stopping {
		return false
	}
	s.lifetime.tasks.Go(fn)
	return true
}

// Shutdown stops background work with ErrShuttingDown and waits until it
// returns or ctx ends. Running workflow jobs release their leases as they
// stop, so a later start resumes them from their checkpoints.
func (s *Server) Shutdown(ctx context.Context) error {
	s.lifetime.mu.Lock()
	s.lifetime.stopping = true
	s.lifetime.mu.Unlock()
	s.lifetime.cancel(ErrShuttingDown)
	done := make(chan struct{})
	go func() {
		s.lifetime.tasks.Wait()
		close(done)
	}()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// releaseShutdownInterruptedJob settles a job whose context was cancelled by
// a service stop. It reports false when the job had already left the running
// state, so the caller keeps its normal completion handling.
func (s *Server) releaseShutdownInterruptedJob(ctx context.Context, job workflowJobRecord) bool {
	releaseCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), interruptedJobReleaseTimeout)
	defer cancel()
	released, err := s.workflowStore.ReleaseInterruptedJob(releaseCtx, workflow.JobLease{
		JobID: job.ID, RunID: job.RunID, NodeRunID: job.NodeRunID, LockedBy: job.LockedBy,
	}, "interrupted by service stop")
	if err != nil {
		// Startup recovery still settles the job from its expired lease.
		slog.Error("release interrupted workflow job", "run_id", job.RunID, "job_id", job.ID, "error", err)
		return false
	}
	if released {
		slog.Info("workflow job interrupted by service stop", "run_id", job.RunID, "job_id", job.ID, "worker_type", job.WorkerType)
	}
	return released
}
