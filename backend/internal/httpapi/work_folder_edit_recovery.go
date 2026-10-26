package httpapi

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

type workFolderEditStagedFile struct {
	SizeBytes int64  `json:"size_bytes"`
	Version   string `json:"version"`
	SHA256    string `json:"sha256"`
}

// fingerprintWorkFolderEditFile reads a plain file through a root-bound handle.
// Parent links are refused, and a file that changes during the read has no proof.
func fingerprintWorkFolderEditFile(ctx context.Context, base, relative string) (workFolderEditStagedFile, error) {
	if _, err := localFolderFileSize(base, filepath.ToSlash(relative)); err != nil {
		return workFolderEditStagedFile{}, err
	}
	root, err := os.OpenRoot(base)
	if err != nil {
		return workFolderEditStagedFile{}, err
	}
	defer func() { _ = root.Close() }()
	file, err := root.Open(relative)
	if err != nil {
		return workFolderEditStagedFile{}, err
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil {
		return workFolderEditStagedFile{}, err
	}
	if !info.Mode().IsRegular() {
		return workFolderEditStagedFile{}, errors.New("the collected file is not a regular file")
	}
	version := localfs.FileVersion(info)
	hash := sha256.New()
	buffer := make([]byte, 1<<20)
	for {
		if err := ctx.Err(); err != nil {
			return workFolderEditStagedFile{}, err
		}
		n, err := file.Read(buffer)
		if n > 0 {
			_, _ = hash.Write(buffer[:n])
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return workFolderEditStagedFile{}, err
		}
	}
	current, err := root.Lstat(relative)
	if err != nil {
		return workFolderEditStagedFile{}, err
	}
	if unsafeFetchStagingEntry(current) || !current.Mode().IsRegular() ||
		!os.SameFile(info, current) || localfs.FileVersion(current) != version {
		return workFolderEditStagedFile{}, errors.New("the collected file changed while it was verified")
	}
	return workFolderEditStagedFile{SizeBytes: info.Size(), Version: version, SHA256: hex.EncodeToString(hash.Sum(nil))}, nil
}

func (e *workFolderEditExecution) recordStagedFile(ctx context.Context, index int, item workFolderEditItem) error {
	proof, err := e.stagedFileFingerprint(ctx, index)
	if err != nil {
		return err
	}
	if item.SizeBytes != nil && proof.SizeBytes != *item.SizeBytes {
		return fmt.Errorf("the collected copy of %s changed before it was recorded", item.Path)
	}
	if e.checkpoint.StagedFiles == nil {
		e.checkpoint.StagedFiles = map[string]workFolderEditStagedFile{}
	}
	e.checkpoint.StagedFiles[item.ItemKey] = proof
	return nil
}

func (e *workFolderEditExecution) verifyStagedFile(ctx context.Context, index int, item workFolderEditItem) error {
	proof, known := e.checkpoint.StagedFiles[item.ItemKey]
	if !known {
		return fmt.Errorf("the collected copy of %s has no publication proof; retry the edit", item.Path)
	}
	current, err := e.stagedFileFingerprint(ctx, index)
	if err != nil {
		return err
	}
	if current != proof {
		return fmt.Errorf("the collected copy of %s changed before publication", item.Path)
	}
	return nil
}

func (e *workFolderEditExecution) stagedFileFingerprint(ctx context.Context, index int) (workFolderEditStagedFile, error) {
	root, err := filepath.Abs(e.server.cfg.DataRoot)
	if err != nil {
		return workFolderEditStagedFile{}, err
	}
	relative, err := filepath.Rel(root, e.stagedPath(index))
	if err != nil {
		return workFolderEditStagedFile{}, err
	}
	return fingerprintWorkFolderEditFile(ctx, root, relative)
}

// recoverPublishedItem reconciles only a missing collected file. A destination
// is this run's publication only while its version and content match the proof
// committed before the rename; another same-sized file is never adopted.
func (e *workFolderEditExecution) recoverPublishedItem(ctx context.Context, index int, item workFolderEditItem) (bool, error) {
	if _, err := os.Lstat(e.stagedPath(index)); err == nil {
		return false, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	relative, err := fetchPathRelativeToRoot(e.payload.TargetRoot, item.TargetPath)
	if err != nil {
		return false, err
	}
	if _, err := os.Lstat(filepath.Join(e.targetAbs, filepath.FromSlash(relative))); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return false, err
	}
	proof, known := e.checkpoint.StagedFiles[item.ItemKey]
	if !known || proof.SHA256 == "" || proof.Version == "" {
		return false, fmt.Errorf("the collected copy of %s is missing and its target cannot be verified; review the edit again", item.Path)
	}
	current, err := fingerprintWorkFolderEditFile(ctx, e.server.cfg.DataRoot, filepath.FromSlash(item.TargetPath))
	if err != nil {
		return false, err
	}
	if current != proof {
		return false, fmt.Errorf("%s changed after publication; review the edit again", relative)
	}
	return true, nil
}
