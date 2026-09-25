package httpapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"strconv"
	"strings"
	"sync"
)

// workflowLeaseRegistry records every workflow job lease this process holds.
// The embedded runner is single-instance, so this registry, not heartbeat age,
// decides whether a running job still has an executor. A lease is reserved
// before the claim that writes it, so any running row carrying one of this
// process's leases is always found here until its executor releases it.
type workflowLeaseRegistry struct {
	mu       sync.Mutex
	instance string
	next     uint64
	leases   map[string]*workflowLease
}

type workflowLease struct {
	runID  int64
	jobID  int64
	cancel context.CancelFunc
}

func newWorkflowLeaseRegistry() *workflowLeaseRegistry {
	return &workflowLeaseRegistry{instance: workflowRunnerInstanceID(), leases: map[string]*workflowLease{}}
}

// reserve returns a new lease token and records it as live before any claim
// can write it to a job.
func (r *workflowLeaseRegistry) reserve() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.next++
	token := r.instance + ":" + strconv.FormatUint(r.next, 10)
	r.leases[token] = &workflowLease{}
	return token
}

// activate attaches the claimed job and its cancellation to a reserved lease.
func (r *workflowLeaseRegistry) activate(token string, runID, jobID int64, cancel context.CancelFunc) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if lease := r.leases[token]; lease != nil {
		lease.runID, lease.jobID, lease.cancel = runID, jobID, cancel
	}
}

// release forgets a lease once its executor has settled the job or the claim
// failed. A job still running under a released lease is an orphan.
func (r *workflowLeaseRegistry) release(token string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.leases, token)
}

// live returns a snapshot of the leases currently held.
func (r *workflowLeaseRegistry) live() map[string]bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	live := make(map[string]bool, len(r.leases))
	for token := range r.leases {
		live[token] = true
	}
	return live
}

// cancelRun cancels every executor working on the run.
func (r *workflowLeaseRegistry) cancelRun(runID int64) {
	r.mu.Lock()
	cancels := []context.CancelFunc{}
	for _, lease := range r.leases {
		if lease.runID == runID && lease.cancel != nil {
			cancels = append(cancels, lease.cancel)
		}
	}
	r.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
}

// workflowRunnerInstanceID identifies this process in job leases, so a lease
// left by an earlier process can never match a live one.
func workflowRunnerInstanceID() string {
	hostname, _ := os.Hostname()
	hostname = strings.TrimSpace(hostname)
	if hostname == "" {
		hostname = "unknown-host"
	}
	nonce := make([]byte, 8)
	_, _ = rand.Read(nonce)
	return hostname + ":" + hex.EncodeToString(nonce)
}
