// Package textvalue holds small string helpers shared across packages. It must
// not import any application package.
package textvalue

import "strings"

// FirstNonBlankRaw returns the first value that is not blank, exactly as
// written, surrounding whitespace included. It returns "" when every value is
// blank.
func FirstNonBlankRaw(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

// FirstNonBlankTrimmed returns the first value that is not blank, without its
// surrounding whitespace. It returns "" when every value is blank. Use cmp.Or
// only when whitespace-only values cannot occur.
func FirstNonBlankTrimmed(values ...string) string {
	return strings.TrimSpace(FirstNonBlankRaw(values...))
}
