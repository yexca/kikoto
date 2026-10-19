//go:build !windows

package httpapi

import (
	"os"
)

// renameAfterExistenceCheck is renameNoReplace on a filesystem without an
// exclusive rename: a target that appears between the check and the rename
// is replaced.
func renameAfterExistenceCheck(from, to string) error {
	if _, err := os.Lstat(to); err == nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: os.ErrExist}
	} else if !os.IsNotExist(err) {
		return err
	}
	return os.Rename(from, to)
}
