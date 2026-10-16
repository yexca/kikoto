package localfs

import "strings"

// LyricsRootName is the folder inside a work folder that holds the lyrics
// Kikoto manages, one folder per language below it. LyricsRootMarkerName is
// the ownership marker Kikoto writes into that folder when it creates it: a
// folder of that name without the marker belongs to the work, not to Kikoto.
const (
	LyricsRootName          = "lyrics_kikoto"
	LyricsRootMarkerName    = ".kikoto-lyrics"
	LyricsRootMarkerVersion = 1
)

// IsLyricsRootMarker reports whether a path below a work folder names the
// lyrics folder's ownership marker. The marker is bookkeeping, not a file of
// the work, so it is never indexed.
func IsLyricsRootMarker(workRelPath string) bool {
	return strings.EqualFold(strings.ReplaceAll(workRelPath, "\\", "/"), LyricsRootName+"/"+LyricsRootMarkerName)
}
