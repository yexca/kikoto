//go:build darwin

package httpapi

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

// renameNoReplace renames from to to and fails with an error matching
// os.ErrExist when to already exists, in one step where the filesystem
// supports it.
func renameNoReplace(from, to string) error {
	err := unix.RenameatxNp(unix.AT_FDCWD, from, unix.AT_FDCWD, to, unix.RENAME_EXCL)
	if errors.Is(err, unix.ENOTSUP) || errors.Is(err, unix.EINVAL) {
		// The filesystem offers no exclusive rename.
		return renameAfterExistenceCheck(from, to)
	}
	if err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	return nil
}
