package httpapi

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Stat through an open handle captures the file identity on Windows as well
// as Unix; a path-based FileInfo can defer that lookup until after the rename.
func lyricsEditFileIdentity(filePath string) (os.FileInfo, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return nil, err
	}
	info, statErr := file.Stat()
	return info, errors.Join(statErr, file.Close())
}

// The manifest stays beside retained files on the target pool so a failed
// rollback can be reviewed without guessing the source of a numbered item.
func writeLyricsEditRecovery(plan lyricsEditPlan, stagingRoot string) error {
	type entry struct {
		Staged string `json:"staged"`
		Source string `json:"source"`
		Target string `json:"target"`
	}
	entries := []entry{}
	for index, item := range plan.Items {
		if item.Action == "move_local" {
			entries = append(entries, entry{filepath.Base(lyricsEditStagedPath(stagingRoot, index)), item.Path, item.TargetPath})
		}
	}
	return os.WriteFile(filepath.Join(stagingRoot, "recovery.json"), []byte(mustJSON(map[string]any{"workRoot": plan.target.RootPath, "moves": entries})), 0o600)
}

func restoreLyricsEdit(plan lyricsEditPlan, stagingRoot string, lifted []int, published map[int]os.FileInfo) error {
	var failures []error
	// Retract every publication first: a published target can occupy another
	// moved file's original path, including in a cycle of renames.
	for index := len(plan.Items) - 1; index >= 0; index-- {
		original, ok := published[index]
		if !ok {
			continue
		}
		relative, err := fetchPathRelativeToRoot(plan.target.RootPath, plan.Items[index].TargetPath)
		if err != nil {
			failures = append(failures, err)
			continue
		}
		destination := filepath.Join(plan.rootAbsolute, filepath.FromSlash(relative))
		current, err := os.Lstat(destination)
		if err != nil || !os.SameFile(original, current) {
			failures = append(failures, fmt.Errorf("published lyrics item %d changed during rollback", index))
			continue
		}
		if err := os.Rename(destination, lyricsEditStagedPath(stagingRoot, index)); err != nil {
			failures = append(failures, err)
		}
	}
	for position := len(lifted) - 1; position >= 0; position-- {
		index := lifted[position]
		source := plan.Items[index].sourceAbsolute
		if _, err := os.Lstat(source); !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, fmt.Errorf("lyrics source %d is occupied or unavailable during rollback", index))
			continue
		}
		if err := os.Rename(lyricsEditStagedPath(stagingRoot, index), source); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
