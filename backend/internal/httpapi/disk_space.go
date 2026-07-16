package httpapi

import (
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
)

type diskSpaceSnapshot struct {
	Identity  string
	Available uint64
}

type diskSpaceRequirement struct {
	Label    string
	Root     string
	Required uint64
}

func (s *Server) ensureRemoteWorkSaveDiskReserve(plan remoteWorkSavePlan, minFreeBytes int64) error {
	if minFreeBytes <= 0 {
		return nil
	}
	reserve := uint64(minFreeBytes)
	dataRequired, cacheRequired, err := remoteWorkSaveRequiredBytes(plan)
	if err != nil {
		return err
	}
	targetRoot, err := safeDataPath(s.cfg.DataRoot, plan.SaveRoot)
	if err != nil {
		return errors.New("fetch data target is invalid")
	}
	existingBytes, err := directoryTreeSize(targetRoot)
	if err != nil {
		return errors.New("fetch data usage could not be measured")
	}
	dataRequired, ok := checkedAddUint64(dataRequired, existingBytes)
	if !ok {
		return errors.New("fetch disk requirement exceeds supported range")
	}
	requirements := []diskSpaceRequirement{
		{Label: "data", Root: s.cfg.DataRoot, Required: dataRequired},
		{Label: "cache", Root: s.cfg.CacheRoot, Required: cacheRequired},
	}
	byFilesystem := map[string]diskSpaceRequirement{}
	availableByFilesystem := map[string]uint64{}
	for _, requirement := range requirements {
		if requirement.Required == 0 {
			continue
		}
		snapshot, err := queryDiskSpace(requirement.Root)
		if err != nil {
			return fmt.Errorf("fetch %s free space could not be measured", requirement.Label)
		}
		existing := byFilesystem[snapshot.Identity]
		if existing.Label == "" {
			existing = requirement
		} else {
			existing.Label += "/" + requirement.Label
			existing.Required, ok = checkedAddUint64(existing.Required, requirement.Required)
			if !ok {
				return errors.New("fetch disk requirement exceeds supported range")
			}
		}
		byFilesystem[snapshot.Identity] = existing
		availableByFilesystem[snapshot.Identity] = snapshot.Available
	}
	for identity, requirement := range byFilesystem {
		requiredWithReserve, ok := checkedAddUint64(requirement.Required, reserve)
		if !ok {
			return errors.New("fetch disk requirement exceeds supported range")
		}
		if availableByFilesystem[identity] < requiredWithReserve {
			return fmt.Errorf("insufficient free space on fetch %s volume", requirement.Label)
		}
	}
	return nil
}

func remoteWorkSaveRequiredBytes(plan remoteWorkSavePlan) (uint64, uint64, error) {
	var dataRequired uint64
	var cacheRequired uint64
	for _, item := range plan.Items {
		if item.Action == "skip" || item.Action == "exclude" {
			continue
		}
		if item.SizeBytes == nil || *item.SizeBytes < 0 {
			return 0, 0, errors.New("fetch disk reserve requires known file sizes")
		}
		size := uint64(*item.SizeBytes)
		var ok bool
		dataRequired, ok = checkedAddUint64(dataRequired, size)
		if !ok {
			return 0, 0, errors.New("fetch disk requirement exceeds supported range")
		}
		if item.Action == "cache_download" {
			cacheRequired, ok = checkedAddUint64(cacheRequired, size)
			if !ok {
				return 0, 0, errors.New("fetch disk requirement exceeds supported range")
			}
		}
	}
	return dataRequired, cacheRequired, nil
}

func directoryTreeSize(root string) (uint64, error) {
	info, err := os.Stat(root)
	if errors.Is(err, os.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, err
	}
	if !info.IsDir() {
		return uint64(info.Size()), nil
	}
	var total uint64
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		entryInfo, err := entry.Info()
		if err != nil {
			return err
		}
		if entryInfo.Size() < 0 || total > math.MaxUint64-uint64(entryInfo.Size()) {
			return errors.New("directory size exceeds supported range")
		}
		total += uint64(entryInfo.Size())
		return nil
	})
	return total, err
}

func checkedAddUint64(left, right uint64) (uint64, bool) {
	if left > math.MaxUint64-right {
		return 0, false
	}
	return left + right, true
}
