//go:build !linux && !darwin && !windows

package httpapi

func renameNoReplace(from, to string) error {
	return renameAfterExistenceCheck(from, to)
}
