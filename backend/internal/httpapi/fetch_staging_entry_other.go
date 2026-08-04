//go:build !windows

package httpapi

import "os"

func unsafeFetchStagingEntry(info os.FileInfo) bool {
	return info.Mode()&os.ModeSymlink != 0
}
