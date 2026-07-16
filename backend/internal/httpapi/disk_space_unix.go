//go:build !windows

package httpapi

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"

	"golang.org/x/sys/unix"
)

func queryDiskSpace(path string) (diskSpaceSnapshot, error) {
	existing, err := nearestExistingPath(path)
	if err != nil {
		return diskSpaceSnapshot{}, err
	}
	var stat unix.Statfs_t
	if err := unix.Statfs(existing, &stat); err != nil {
		return diskSpaceSnapshot{}, err
	}
	blockSize := uint64(stat.Bsize)
	availableBlocks := uint64(stat.Bavail)
	if blockSize > 0 && availableBlocks > math.MaxUint64/blockSize {
		return diskSpaceSnapshot{}, errors.New("available disk space exceeds supported range")
	}
	return diskSpaceSnapshot{
		Identity:  fmt.Sprintf("%v", stat.Fsid),
		Available: availableBlocks * blockSize,
	}, nil
}

func nearestExistingPath(path string) (string, error) {
	current, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(current); err == nil {
			return current, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent := filepath.Dir(current)
		if parent == current {
			return "", os.ErrNotExist
		}
		current = parent
	}
}
