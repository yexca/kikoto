package httpapi

import (
	"context"
	"errors"
	"net/http"
	"path"
	"strings"

	"github.com/yexca/kikoto/backend/internal/storagepool"
)

// fetchDestinationError explains why Fetch cannot write into the library now.
// Its code lets the interface point the user at the setting that fixes it.
type fetchDestinationError struct {
	Code    string
	Message string
}

func (err fetchDestinationError) Error() string { return err.Message }

var (
	errFetchLibraryNotConfigured = fetchDestinationError{
		Code:    "library_not_configured",
		Message: "Set up the library before fetching works.",
	}
	errFetchPoolRequired = fetchDestinationError{
		Code:    "fetch_pool_required",
		Message: "Choose a Fetch storage pool in Settings -> Library before fetching works.",
	}
	errFetchPoolOffline = fetchDestinationError{
		Code:    "fetch_pool_offline",
		Message: "The storage pool Fetch saves to is offline. Check that its disk is mounted.",
	}
	errFetchLibraryOffline = fetchDestinationError{
		Code:    "library_offline",
		Message: "The library folder is unavailable. Check that the data directory is mounted.",
	}
)

// writeFetchDestinationError writes err when it is a destination error and
// reports whether it did.
func writeFetchDestinationError(w http.ResponseWriter, err error) bool {
	var destination fetchDestinationError
	if !errors.As(err, &destination) {
		return false
	}
	writeAPIError(w, http.StatusConflict, destination.Code, destination.Message, false)
	return true
}

// fetchPoolPath is the configured Fetch pool's directory, or empty in
// standard mode. It does not check that the pool is online.
func (s *Server) fetchPoolPath(ctx context.Context) (string, error) {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return "", err
	}
	if !layout.configured() {
		return "", errFetchLibraryNotConfigured
	}
	if !layout.poolsMode() {
		return "", nil
	}
	pool, ok := layout.pool(layout.FetchPool)
	if !ok {
		return "", errFetchPoolRequired
	}
	return pool.Path, nil
}

// ensureFetchTargetWritable checks that the pool holding targetRoot, a path
// relative to the data root, is configured and online before Fetch plans to
// write there. Writing into an unmounted pool would fill the empty mount point
// on the wrong disk.
func (s *Server) ensureFetchTargetWritable(ctx context.Context, targetRoot string) error {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return err
	}
	if !layout.configured() {
		return errFetchLibraryNotConfigured
	}
	pool, _, ok := layout.poolOf(targetRoot)
	if !ok {
		return errFetchPoolRequired
	}
	states, err := s.libraryPoolStates(ctx, s.cfg.DataRoot, libraryLayout{Mode: layout.Mode, Pools: []storagepool.Pool{pool}})
	if err != nil {
		return err
	}
	if len(states) == 1 && states[0].Online {
		return nil
	}
	if layout.poolsMode() {
		return errFetchPoolOffline
	}
	return errFetchLibraryOffline
}

// fetchTransactionPool returns the pool whose root holds the staging, backup,
// and trash entries for a Fetch into targetRoot. Publication and rollback
// rename between those entries and the target, so they must share its pool
// and filesystem. The standard pool keeps the data-root directories of
// earlier releases.
func (s *Server) fetchTransactionPool(ctx context.Context, targetRoot string) (string, error) {
	layout, err := s.loadLibraryLayout(ctx)
	if err != nil {
		return "", err
	}
	poolPath, _ := storagepool.Split(layout.effectiveMode(), targetRoot)
	return poolPath, nil
}

// fetchTrashArchivePattern reports whether archive is inside a Fetch trash
// area: .kikoto-trash/fetch at the data root or at a pool root.
func fetchTrashArchiveAllowed(archive string) bool {
	archive = path.Clean(strings.Trim(archive, "/"))
	if strings.HasPrefix(archive, ".kikoto-trash/fetch/") {
		return true
	}
	poolPath, rest, found := strings.Cut(archive, "/")
	return found && storagepool.ValidName(poolPath) && strings.HasPrefix(rest, ".kikoto-trash/fetch/")
}
