package httpapi

import (
	"context"
	"strings"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// localAvailabilityOffline is the availability a response reports for a local
// file, folder, or presence that the index holds as available but whose
// storage pool is offline now. It is never stored: the indexed state stays as
// the last scan saw it, and the item reads as available again once its pool
// is back, without a scan.
const localAvailabilityOffline = "offline"

// libraryAvailability is which storage pools can be read now. It is taken once
// per request. In standard mode the data root is the only pool.
type libraryAvailability struct {
	mode   string
	online map[string]bool
}

func (s *Server) loadLibraryAvailability(ctx context.Context) (libraryAvailability, error) {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return libraryAvailability{}, err
	}
	states, err := s.libraryPoolStates(ctx, s.cfg.DataRoot, layout)
	if err != nil {
		return libraryAvailability{}, err
	}
	availability := libraryAvailability{mode: layout.effectiveMode(), online: make(map[string]bool, len(states))}
	for _, state := range states {
		availability.online[strings.ToLower(state.Pool.Path)] = state.Online
	}
	return availability, nil
}

// readable reports whether rel, a path relative to the data root, lies on an
// online pool. A path outside every registered pool is not readable.
func (availability libraryAvailability) readable(rel string) bool {
	poolPath, _ := storagepool.Split(availability.mode, rel)
	return availability.online[strings.ToLower(poolPath)]
}

// check returns the error for reading or changing rel while its pool is
// offline, or nil when it is readable.
func (availability libraryAvailability) check(rel string) error {
	if availability.readable(rel) {
		return nil
	}
	if availability.mode == storagepool.ModePools {
		return errStoragePoolOffline
	}
	return errLibraryOffline
}

// localAvailability is the availability to report for a local item the index
// holds with stored availability at rel.
func (availability libraryAvailability) localAvailability(rel string, stored string) string {
	if stored == "available" && !availability.readable(rel) {
		return localAvailabilityOffline
	}
	return stored
}

// ensureMediaLocationReadable checks that a stored media location can be read
// now: a local file only while its pool is online. A cached copy lives in the
// cache, outside every pool.
func (s *Server) ensureMediaLocationReadable(ctx context.Context, locationType string, rel string) error {
	if locationType != "local" {
		return nil
	}
	return s.ensureLibraryPathOnline(ctx, rel)
}

// removeLibraryFile deletes one library file only while its pool is online,
// so a deletion never reaches another disk at the pool's mount point or
// reports a file of an unmounted pool as deleted.
func (s *Server) removeLibraryFile(ctx context.Context, rel string) (bool, error) {
	if err := s.ensureLibraryPathOnline(ctx, rel); err != nil {
		return false, err
	}
	deleted, _, err := removeDestructiveFile(s.cfg.DataRoot, rel)
	return deleted, err
}

// ensureLibraryPathOnline checks that the pool holding rel, a path relative to
// the data root, is online before Kikoto reads, writes, or deletes there. On
// an offline pool the path may be an empty mount point or another disk, so
// nothing there is the folder the index describes.
func (s *Server) ensureLibraryPathOnline(ctx context.Context, rel string) error {
	availability, err := s.loadLibraryAvailability(ctx)
	if err != nil {
		return err
	}
	return availability.check(rel)
}
