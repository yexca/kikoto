//go:build windows

package httpapi

import (
	"os"
	"syscall"
)

const windowsFileAttributeReparsePoint = 0x400

func unsafeFetchStagingEntry(info os.FileInfo) bool {
	if info.Mode()&os.ModeSymlink != 0 {
		return true
	}
	data, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return ok && data.FileAttributes&windowsFileAttributeReparsePoint != 0
}
