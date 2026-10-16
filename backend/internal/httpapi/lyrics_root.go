package httpapi

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/localfs"
)

// The lyrics Kikoto manages live in one folder inside a work folder, which
// Kikoto marks as its own when it creates it. Only a marked folder is Kikoto's:
// a work can ship a folder of the same name, and Kikoto never writes into,
// deletes from, or reorganizes a folder it did not create.

const lyricsRootMarkerMaxBytes = 4096

type lyricsRootMarker struct {
	Version   int    `json:"version"`
	ManagedBy string `json:"managedBy"`
	Purpose   string `json:"purpose"`
}

type lyricsRootStatus int

const (
	// lyricsRootStatusAbsent: nothing is where the lyrics folder belongs.
	lyricsRootStatusAbsent lyricsRootStatus = iota
	// lyricsRootStatusOwned: the lyrics folder is a plain folder Kikoto marked.
	lyricsRootStatusOwned
	// lyricsRootStatusBlocked: a file, a link, an unmarked folder, or a folder
	// whose name differs only in case is where the lyrics folder belongs.
	lyricsRootStatusBlocked
)

// lyricsRootStatusOf reports what holds the lyrics folder's place in the work
// folder at workRoot, an absolute path. A name that differs only in case
// blocks the folder, since a case-insensitive filesystem would write into it
// under a path the index does not know.
func lyricsRootStatusOf(workRoot string) (lyricsRootStatus, error) {
	entries, err := os.ReadDir(workRoot)
	if err != nil {
		return lyricsRootStatusBlocked, err
	}
	found := false
	for _, entry := range entries {
		if !strings.EqualFold(entry.Name(), localfs.LyricsRootName) {
			continue
		}
		if entry.Name() != localfs.LyricsRootName {
			return lyricsRootStatusBlocked, nil
		}
		found = true
	}
	if !found {
		return lyricsRootStatusAbsent, nil
	}
	folder := filepath.Join(workRoot, localfs.LyricsRootName)
	info, err := os.Lstat(folder)
	if errors.Is(err, os.ErrNotExist) {
		return lyricsRootStatusAbsent, nil
	}
	if err != nil {
		return lyricsRootStatusBlocked, err
	}
	if unsafeFetchStagingEntry(info) || !info.IsDir() || !lyricsRootMarked(folder) {
		return lyricsRootStatusBlocked, nil
	}
	return lyricsRootStatusOwned, nil
}

// lyricsRootMarked reports whether folder holds a valid ownership marker.
func lyricsRootMarked(folder string) bool {
	marker := filepath.Join(folder, localfs.LyricsRootMarkerName)
	info, err := os.Lstat(marker)
	if err != nil || unsafeFetchStagingEntry(info) || !info.Mode().IsRegular() || info.Size() > lyricsRootMarkerMaxBytes {
		return false
	}
	file, err := os.Open(marker)
	if err != nil {
		return false
	}
	defer func() { _ = file.Close() }()
	data, err := io.ReadAll(io.LimitReader(file, lyricsRootMarkerMaxBytes+1))
	if err != nil || len(data) > lyricsRootMarkerMaxBytes {
		return false
	}
	var value lyricsRootMarker
	if json.Unmarshal(data, &value) != nil {
		return false
	}
	return value.Version == localfs.LyricsRootMarkerVersion && value.ManagedBy == "kikoto" && value.Purpose == "lyrics"
}

// lyricsRootOwned reports whether the work folder at workRoot holds a lyrics
// folder Kikoto created.
func lyricsRootOwned(workRoot string) bool {
	status, err := lyricsRootStatusOf(workRoot)
	return err == nil && status == lyricsRootStatusOwned
}

// checkLyricsRootWritable refuses lyrics for a work folder whose lyrics folder
// place holds something Kikoto did not create. It changes nothing.
func checkLyricsRootWritable(workRoot string) error {
	status, err := lyricsRootStatusOf(workRoot)
	if err != nil {
		return err
	}
	if status == lyricsRootStatusBlocked {
		return errLyricsFolderBlocked
	}
	return nil
}

// ensureLyricsRoot creates and marks the lyrics folder of the work folder at
// workRoot when it is absent, and refuses one Kikoto did not create.
func ensureLyricsRoot(workRoot string) error {
	status, err := lyricsRootStatusOf(workRoot)
	if err != nil {
		return err
	}
	switch status {
	case lyricsRootStatusOwned:
		return nil
	case lyricsRootStatusBlocked:
		return errLyricsFolderBlocked
	}
	folder := filepath.Join(workRoot, localfs.LyricsRootName)
	if err := os.Mkdir(folder, 0o755); err != nil {
		if errors.Is(err, os.ErrExist) {
			// Another publication created it first.
			return checkLyricsRootOwnedNow(workRoot)
		}
		return err
	}
	data, err := json.MarshalIndent(lyricsRootMarker{Version: localfs.LyricsRootMarkerVersion, ManagedBy: "kikoto", Purpose: "lyrics"}, "", "  ")
	if err == nil {
		err = writeNewLyricsRootMarker(filepath.Join(folder, localfs.LyricsRootMarkerName), append(data, '\n'))
	}
	if err != nil {
		_ = os.Remove(folder)
		return err
	}
	return nil
}

func checkLyricsRootOwnedNow(workRoot string) error {
	if lyricsRootOwned(workRoot) {
		return nil
	}
	return errLyricsFolderBlocked
}

func writeNewLyricsRootMarker(path string, data []byte) error {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		_ = os.Remove(path)
		return err
	}
	return nil
}

// removeEmptyLyricsRoot removes the lyrics folder Kikoto created once it holds
// nothing but its marker, so a work folder without managed lyrics keeps no
// trace of them.
func removeEmptyLyricsRoot(workRoot string) {
	if !lyricsRootOwned(workRoot) {
		return
	}
	folder := filepath.Join(workRoot, localfs.LyricsRootName)
	entries, err := os.ReadDir(folder)
	if err != nil || len(entries) != 1 || entries[0].Name() != localfs.LyricsRootMarkerName {
		return
	}
	if os.Remove(filepath.Join(folder, localfs.LyricsRootMarkerName)) == nil {
		_ = os.Remove(folder)
	}
}

// removeLyricsRootMarker deletes the marker file of the lyrics folder in the
// work folder at rootPath, a path relative to the data root, when the lyrics
// folder is a plain folder and the marker a regular file. Anything else is
// left for the caller's own checks.
func (s *Server) removeLyricsRootMarker(rootPath string) error {
	folder, err := safeDataPath(s.cfg.DataRoot, path.Join(rootPath, localfs.LyricsRootName))
	if err != nil {
		return err
	}
	if info, err := os.Lstat(folder); err != nil || unsafeFetchStagingEntry(info) || !info.IsDir() {
		return nil
	}
	if info, err := os.Lstat(filepath.Join(folder, localfs.LyricsRootMarkerName)); err != nil || !info.Mode().IsRegular() {
		return nil
	}
	_, _, err = removeDestructiveFile(s.cfg.DataRoot, path.Join(rootPath, localfs.LyricsRootName, localfs.LyricsRootMarkerName))
	return err
}
