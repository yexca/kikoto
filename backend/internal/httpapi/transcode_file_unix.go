//go:build !windows

package httpapi

import "os"

func openTranscodeCacheFile(path string) (*os.File, error) {
	return os.Open(path)
}
