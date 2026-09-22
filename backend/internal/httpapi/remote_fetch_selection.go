package httpapi

import (
	"context"
	"fmt"
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
			title := strings.TrimSpace(node.Title)
			if title == "" {
				title = fmt.Sprintf("Track %d", index+1)
			}
			path := cleanRemoteRelativePath(joinRemotePath(basePath, title))
			kind := remoteTrackKindForPath(node.Type, path)
			if len(node.Children) > 0 || kind == "folder" {
				walk(path, node.Children)
				continue
			}
			sourceURL := firstNonEmpty(node.MediaDownloadURL, node.MediaStreamURL, node.StreamLowQualityURL)
			if sourceURL == "" {
				continue
			}
			var size *int64
			if node.Size > 0 {
				value := node.Size
				size = &value
			}
			files = append(files, remoteSaveFile{
				Path:        path,
				Kind:        kind,
				StreamURL:   firstNonEmpty(node.MediaStreamURL, node.StreamLowQualityURL),
				DownloadURL: node.MediaDownloadURL,
				SizeBytes:   size,
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

func (s *Server) findRemoteCacheFile(ctx context.Context, sourceID int64, sourceCode string, workCode string, remotePath string, expectedSize *int64) (string, bool) {
	cacheRelPath := cacheMediaRelPath(sourceCode, workCode, remotePath)
	rows, err := s.db.QueryContext(ctx, `
		SELECT path
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
		if err := rows.Scan(&path); err != nil {
			continue
		}
		cachePath, err := safeCachePath(s.cfg.CacheRoot, path)
		if err != nil {
			continue
		}
		if existingFileMatches(cachePath, expectedSize) {
			return path, true
		}
	}
	return "", false
}
