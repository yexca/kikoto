// Package languageedition reads the parts of a provider's language_editions
// value that the dlsite and kikoeru decoders share.
package languageedition

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseIndex reads a key of the numeric-keyed object form of
// language_editions, which stands for the entry's position.
func ParseIndex(key string) (uint64, error) {
	if key == "" || strings.IndexFunc(key, func(value rune) bool { return value < '0' || value > '9' }) >= 0 {
		return 0, fmt.Errorf("language_editions object contains a non-numeric key")
	}
	index, err := strconv.ParseUint(key, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("language_editions object contains an invalid numeric key")
	}
	return index, nil
}
