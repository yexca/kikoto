// Package storagepool describes where local media lives below the data root.
//
// A library is either one standard pool, the data root itself, or several
// registered pools, each a first-level directory of the data root that may be a
// separate disk or mounted cloud drive. Every pool carries a marker file at its
// root. A pool whose marker is absent is offline: an unmounted disk usually
// leaves an empty mount point behind, and an empty directory must never be
// read as "every work was deleted".
//
// Paths stored in the database stay relative to the data root, so a pool is
// only the first segment of those paths in pool mode.
package storagepool

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode"
)

const (
	// ModeStandard keeps the whole data root as one pool.
	ModeStandard = "standard"
	// ModePools divides the data root into registered first-level pools.
	ModePools = "pools"

	// MarkerName is the file that identifies an online pool root.
	MarkerName = ".kikoto-pool"

	markerVersion  = 1
	markerMaxBytes = 4096
	maxNameLength  = 128
)

// Pool is one storage pool. Path is the first-level directory name below the
// data root, or empty for the standard pool, which is the data root itself.
type Pool struct {
	Path string `json:"path"`
	ID   string `json:"id"`
}

// Status reasons for an offline pool.
const (
	ReasonMissing       = "missing"
	ReasonNotDirectory  = "not_directory"
	ReasonMarkerMissing = "marker_missing"
	ReasonMarkerInvalid = "marker_invalid"
	ReasonMarkerOther   = "marker_mismatch"
	ReasonUnreadable    = "unreadable"
)

type marker struct {
	Version   int    `json:"version"`
	ManagedBy string `json:"managed_by"`
	Purpose   string `json:"purpose"`
	PoolID    string `json:"pool_id"`
}

// ValidName reports whether name can be a pool directory: one visible path
// segment without separators or control characters.
func ValidName(name string) bool {
	if name == "" || name != strings.TrimSpace(name) || len(name) > maxNameLength {
		return false
	}
	if strings.HasPrefix(name, ".") || strings.ContainsAny(name, `/\:*?"<>|`) {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// NewID returns a random pool identifier written into the pool's marker.
func NewID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(value[:]), nil
}

// Root returns the absolute directory of pool below dataRoot.
func Root(dataRoot string, pool Pool) string {
	if pool.Path == "" {
		return filepath.Clean(dataRoot)
	}
	return filepath.Join(dataRoot, pool.Path)
}

// ReadMarker returns the pool ID recorded at dir. It reports false when no
// marker exists and an error when one exists but is not a valid marker.
func ReadMarker(dir string) (string, bool, error) {
	path := filepath.Join(dir, MarkerName)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	if !info.Mode().IsRegular() || info.Size() > markerMaxBytes {
		return "", true, errors.New("storage pool marker is not a regular file")
	}
	file, err := os.Open(path)
	if err != nil {
		return "", true, err
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, markerMaxBytes+1))
	if err != nil {
		return "", true, err
	}
	var value marker
	if err := json.Unmarshal(data, &value); err != nil {
		return "", true, fmt.Errorf("storage pool marker is invalid: %w", err)
	}
	if value.Version != markerVersion || value.ManagedBy != "kikoto" || value.Purpose != "storage_pool" || strings.TrimSpace(value.PoolID) == "" {
		return "", true, errors.New("storage pool marker is invalid")
	}
	return value.PoolID, true, nil
}

// WriteMarker records id at dir. The marker is written beside its final name
// and renamed into place, so a reader sees either no marker or a whole one.
func WriteMarker(dir string, id string) error {
	if strings.TrimSpace(id) == "" {
		return errors.New("storage pool id is required")
	}
	data, err := json.MarshalIndent(marker{Version: markerVersion, ManagedBy: "kikoto", Purpose: "storage_pool", PoolID: id}, "", "  ")
	if err != nil {
		return err
	}
	temporary := filepath.Join(dir, MarkerName+".tmp")
	if err := os.WriteFile(temporary, append(data, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(temporary, filepath.Join(dir, MarkerName)); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return nil
}

// Check reports whether pool is online. A registered pool must carry its own
// marker; wantID is compared only when it is not empty.
func Check(dataRoot string, pool Pool, wantID string) (bool, string) {
	root := Root(dataRoot, pool)
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return false, ReasonMissing
	}
	if err != nil {
		return false, ReasonUnreadable
	}
	if !info.IsDir() {
		return false, ReasonNotDirectory
	}
	id, exists, err := ReadMarker(root)
	if err != nil {
		return false, ReasonMarkerInvalid
	}
	if !exists {
		return false, ReasonMarkerMissing
	}
	if wantID != "" && id != wantID {
		return false, ReasonMarkerOther
	}
	return true, ""
}

// HasVisibleEntries reports whether dir contains anything besides dot entries
// such as Kikoto's own transaction directories.
func HasVisibleEntries(dir string) (bool, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), ".") {
			return true, nil
		}
	}
	return false, nil
}

// CandidateDirectories lists the first-level directories of dataRoot that can
// be registered as pools, sorted by name. A mount point is a directory; a
// symbolic link is not listed, because scans do not follow it and Fetch
// refuses linked paths.
func CandidateDirectories(dataRoot string) ([]string, error) {
	entries, err := os.ReadDir(dataRoot)
	if err != nil {
		return nil, err
	}
	names := []string{}
	for _, entry := range entries {
		if ValidName(entry.Name()) && entry.IsDir() {
			names = append(names, entry.Name())
		}
	}
	sort.Strings(names)
	return names, nil
}

// IsDirectory reports whether path is a real directory, not a link to one.
func IsDirectory(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.IsDir() && info.Mode()&fs.ModeSymlink == 0
}

// ProbeRename verifies that files can be created and renamed inside dir, which
// Fetch publication and rollback require within one pool.
func ProbeRename(dir string) error {
	suffix, err := NewID()
	if err != nil {
		return err
	}
	source := filepath.Join(dir, ".kikoto-pool-probe-"+suffix)
	target := source + ".renamed"
	if err := os.WriteFile(source, []byte("kikoto"), 0o600); err != nil {
		return err
	}
	defer func() {
		_ = os.Remove(source)
		_ = os.Remove(target)
	}()
	return os.Rename(source, target)
}

// Split returns the pool path and the remainder of rel, a slash-separated path
// relative to the data root. In standard mode the pool path is always empty.
func Split(mode string, rel string) (string, string) {
	rel = strings.Trim(filepath.ToSlash(filepath.Clean(filepath.FromSlash(strings.TrimSpace(rel)))), "/")
	if rel == "." {
		rel = ""
	}
	if mode != ModePools {
		return "", rel
	}
	head, rest, _ := strings.Cut(rel, "/")
	return head, rest
}

// Depth returns the number of segments in rel, a slash-separated path.
func Depth(rel string) int {
	rel = strings.Trim(rel, "/")
	if rel == "" {
		return 0
	}
	return strings.Count(rel, "/") + 1
}

// Join prefixes rel with a pool path. The standard pool adds no prefix.
func Join(poolPath string, rel string) string {
	rel = strings.Trim(filepath.ToSlash(rel), "/")
	if poolPath == "" {
		return rel
	}
	if rel == "" {
		return poolPath
	}
	return poolPath + "/" + rel
}
