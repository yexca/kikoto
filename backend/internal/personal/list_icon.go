package personal

import (
	"regexp"
	"strings"
)

// A favorite-list icon is a short presentation key such as "moon" or
// "book-open". Clients map known keys to their own icon set and fall back to
// the default list icon, so the server bounds the format without owning the
// catalog.
var favoriteListIconPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,31}$`)

// NormalizeFavoriteListIcon trims an icon key and reports whether it is
// acceptable. An empty key selects the default icon.
func NormalizeFavoriteListIcon(icon string) (string, bool) {
	icon = strings.TrimSpace(icon)
	if icon == "" {
		return "", true
	}
	return icon, favoriteListIconPattern.MatchString(icon)
}
