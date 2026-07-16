//go:build windows

package httpapi

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func queryDiskSpace(path string) (diskSpaceSnapshot, error) {
	existing, err := nearestExistingPath(path)
	if err != nil {
		return diskSpaceSnapshot{}, err
	}
	pathPtr, err := windows.UTF16PtrFromString(existing)
	if err != nil {
		return diskSpaceSnapshot{}, err
	}
	volumeBuffer := make([]uint16, windows.MAX_PATH+1)
	if err := windows.GetVolumePathName(pathPtr, &volumeBuffer[0], uint32(len(volumeBuffer))); err != nil {
		return diskSpaceSnapshot{}, err
	}
	volumePath := windows.UTF16ToString(volumeBuffer)
	volumePtr, err := windows.UTF16PtrFromString(volumePath)
	if err != nil {
		return diskSpaceSnapshot{}, err
	}
	var available uint64
	if err := windows.GetDiskFreeSpaceEx(volumePtr, &available, nil, nil); err != nil {
		return diskSpaceSnapshot{}, err
	}
	return diskSpaceSnapshot{Identity: strings.ToLower(filepath.Clean(volumePath)), Available: available}, nil
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
