package httpapi

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type remoteSaveFile struct {
	Path        string
	Kind        string
	StreamURL   string
	DownloadURL string
	SizeBytes   *int64
	Hash        string
}

func normalizeSelectedRemotePaths(paths []string) map[string]bool {
	result := map[string]bool{}
	for _, path := range paths {
		path = cleanRemoteRelativePath(path)
		if path != "" {
			result[path] = true
		}
	}
	return result
}

func normalizeSelectedLocalPaths(paths []string) map[string]bool {
	result := map[string]bool{}
	for _, path := range paths {
		path = strings.Trim(filepath.ToSlash(strings.TrimSpace(path)), "/")
		if path != "" {
			result[path] = true
		}
	}
	return result
}

func selectedRemotePathMatches(selected map[string]bool, filePath string) bool {
	filePath = cleanRemoteRelativePath(filePath)
	for path := range selected {
		if path == filePath {
			return true
		}
		if strings.HasPrefix(filePath, path+"/") {
			return true
		}
	}
	return false
}

func selectedLocalPathMatches(selected map[string]bool, filePath string) bool {
	filePath = strings.Trim(filepath.ToSlash(strings.TrimSpace(filePath)), "/")
	for path := range selected {
		if path == filePath {
			return true
		}
		if strings.HasPrefix(filePath, path+"/") {
			return true
		}
	}
	return false
}

func flattenRemoteSaveFiles(tracks []kikoeru.Track) []remoteSaveFile {
	files := []remoteSaveFile{}
	var walk func(basePath string, nodes []kikoeru.Track)
	walk = func(basePath string, nodes []kikoeru.Track) {
		for index, node := range nodes {
			path := remoteTrackPath(basePath, remoteTrackName(node.Title, index))
			kind := remoteTrackKindForPath(node.Type, path)
			if len(node.Children) > 0 || kind == "folder" {
				walk(path, node.Children)
				continue
			}
			sourceURL := firstNonBlankTrimmed(node.MediaDownloadURL, node.MediaStreamURL, node.StreamLowQualityURL)
			if sourceURL == "" {
				continue
			}
			files = append(files, remoteSaveFile{
				Path:        path,
				Kind:        kind,
				StreamURL:   firstNonBlankTrimmed(node.MediaStreamURL, node.StreamLowQualityURL),
				DownloadURL: node.MediaDownloadURL,
				SizeBytes:   node.KnownSize(),
				Hash:        strings.TrimSpace(node.Hash),
			})
		}
	}
	walk("", tracks)
	return files
}

func cleanRemoteRelativePath(path string) string {
	parts := strings.Split(strings.ReplaceAll(path, "\\", "/"), "/")
	clean := []string{}
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" || part == "." || part == ".." {
			continue
		}
		clean = append(clean, filepath.Base(part))
	}
	return filepath.ToSlash(filepath.Join(clean...))
}

func existingFileMatches(path string, expectedSize *int64) bool {
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return false
	}
	return expectedSize == nil || info.Size() == *expectedSize
}

// fileMatchesKnownSize reports whether path is a file of the size the source
// declares or, when the source declares none, of the size Kikoto recorded
// when it wrote or indexed the file. A file with neither cannot be told apart
// from a partial or different copy, so it does not count as present and is
// downloaded again.
func fileMatchesKnownSize(path string, expectedSize *int64, recordedSize *int64) bool {
	known := expectedSize
	if known == nil {
		known = recordedSize
	}
	if known == nil || *known < 0 {
		return false
	}
	return existingFileMatches(path, known)
}

func nullInt64Pointer(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

// recordedFileSize is the size recorded for an available location of the
// given type and path, or nil when none records one.
func (s *Server) recordedFileSize(ctx context.Context, locationType string, sourceID int64, relativePath string) *int64 {
	var size sql.NullInt64
	query := `
		SELECT size_bytes FROM media_file_location
		WHERE location_type = ? AND path = ? AND availability = 'available' AND size_bytes IS NOT NULL`
	args := []any{locationType, relativePath}
	if sourceID > 0 {
		query += ` AND file_source_id = ?`
		args = append(args, sourceID)
	}
	query += ` ORDER BY id DESC LIMIT 1`
	if err := s.db.QueryRowContext(ctx, query, args...).Scan(&size); err != nil {
		return nil
	}
	return nullInt64Pointer(size)
}

func (s *Server) findRemoteCacheFile(ctx context.Context, sourceID int64, sourceCode string, workCode string, remotePath string, expectedSize *int64) (string, bool) {
	cacheRelPath := cacheMediaRelPath(sourceCode, workCode, remotePath)
	rows, err := s.db.QueryContext(ctx, `
		SELECT path, size_bytes
		FROM media_file_location
		WHERE file_source_id = ?
			AND location_type = 'cache'
			AND availability = 'available'
			AND path = ?
	`, sourceID, cacheRelPath)
	if err != nil {
		return "", false
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var path string
		var recorded sql.NullInt64
		if err := rows.Scan(&path, &recorded); err != nil {
			continue
		}
		cachePath, err := safeCachePath(s.cfg.CacheRoot, path)
		if err != nil {
			continue
		}
		if fileMatchesKnownSize(cachePath, expectedSize, nullInt64Pointer(recorded)) {
			return path, true
		}
	}
	return "", false
}
