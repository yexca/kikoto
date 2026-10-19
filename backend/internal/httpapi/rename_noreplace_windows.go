//go:build windows

package httpapi

import (
	"os"

	"golang.org/x/sys/windows"
)

// renameNoReplace renames from to to and fails with an error matching
// os.ErrExist when to already exists. Without MOVEFILE_REPLACE_EXISTING the
// move never replaces an existing file or folder.
func renameNoReplace(from, to string) error {
	fromPtr, err := windows.UTF16PtrFromString(from)
	if err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	toPtr, err := windows.UTF16PtrFromString(to)
	if err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	if err := windows.MoveFileEx(fromPtr, toPtr, 0); err != nil {
		return &os.LinkError{Op: "rename", Old: from, New: to, Err: err}
	}
	return nil
}
