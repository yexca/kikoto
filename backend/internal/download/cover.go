package download

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

var coverPublication struct {
	sync.Mutex
	entries map[string]*coverGate
}

type coverGate struct {
	slot  chan struct{}
	users int
}

// PublishCover serializes the rename for all extensions of a work, across the
// built-in provider, remote fallback and legacy migration writers. The source
// is already complete and on the target filesystem. No hard-link support is
// needed, and readers can only observe complete final files.
func PublishCover(ctx context.Context, source, target string, replace bool) error {
	stem := strings.TrimSuffix(target, filepath.Ext(target))
	key, err := filepath.Abs(stem)
	if err != nil {
		return err
	}
	if runtime.GOOS == "windows" {
		key = strings.ToLower(key)
	}
	coverPublication.Lock()
	if coverPublication.entries == nil {
		coverPublication.entries = map[string]*coverGate{}
	}
	gate := coverPublication.entries[key]
	if gate == nil {
		gate = &coverGate{slot: make(chan struct{}, 1)}
		gate.slot <- struct{}{}
		coverPublication.entries[key] = gate
	}
	gate.users++
	coverPublication.Unlock()
	release := func() {
		coverPublication.Lock()
		gate.users--
		if gate.users == 0 {
			delete(coverPublication.entries, key)
		}
		coverPublication.Unlock()
	}
	select {
	case <-ctx.Done():
		release()
		return ctx.Err()
	case <-gate.slot:
	}
	defer func() { gate.slot <- struct{}{}; release() }()
	if err := ctx.Err(); err != nil {
		return err
	}
	extensions := []string{".jpg", ".jpeg", ".png", ".webp"}
	if !replace {
		for _, ext := range extensions {
			info, err := os.Lstat(stem + ext)
			if err == nil {
				if !info.Mode().IsRegular() {
					return errors.New("cover destination is not a regular file")
				}
				return nil
			}
			if !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	if err := retryCoverFilesystem(ctx, func() error { return os.Rename(source, target) }); err != nil {
		return err
	}
	if replace {
		for _, ext := range extensions {
			other := stem + ext
			if other == target {
				continue
			}
			if err := retryCoverFilesystem(ctx, func() error { return os.Remove(other) }); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
	}
	return nil
}

// Windows readers can briefly hold handles without delete sharing. Retry only
// these filesystem conflicts, for at most one second and under the same gate.
// Completed staging files are never copied into a reader-visible destination.
func retryCoverFilesystem(ctx context.Context, run func() error) error {
	deadline := time.Now().Add(time.Second)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		err := run()
		if runtime.GOOS != "windows" || (!errors.Is(err, syscall.Errno(32)) && !errors.Is(err, syscall.Errno(33)) && !errors.Is(err, syscall.Errno(5))) || !time.Now().Before(deadline) {
			return err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		case <-timer.C:
		}
	}
}
