package httpapi

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/textdecode"
)

func (s *Server) streamMedia(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media location id"})
		return
	}
	target, cached, err := s.loadMediaStreamTarget(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "media location not found"})
			return
		}
		writeError(w, err)
		return
	}

	if target.LocationType == "remote_stream" {
		remoteURL := firstNonEmpty(target.StreamURL, target.DownloadURL)
		if (target.Availability != "available" && target.Availability != "remote") ||
			target.FileSourceID <= 0 || strings.TrimSpace(remoteURL) == "" {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "remote media location is not available"})
			return
		}
		source, sourceErr := s.loadRemotePlaybackSource(r.Context(), target.FileSourceID)
		if sourceErr != nil {
			if writeRemotePlaybackSourceError(w, sourceErr) {
				return
			}
			writeUpstreamError(w, sourceErr)
			return
		}
		s.streamRemoteURL(w, r, source, remoteURL, target.RelativePath, effectiveMediaKind(target.Kind, target.RelativePath))
		return
	}
	if (target.LocationType != "local" && target.LocationType != "cache") || target.Availability != "available" {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media location is not available"})
		return
	}

	root := s.cfg.DataRoot
	if target.LocationType == "cache" {
		root = s.cfg.CacheRoot
	}
	path, err := safeDataPath(root, target.RelativePath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid media path"})
		return
	}
	if !s.cfg.IsDemo() && target.LocationType == "cache" && !cached {
		if _, statErr := os.Stat(path); statErr == nil {
			s.execBestEffort(r.Context(), "touch cache location check time", `UPDATE media_file_location SET last_checked_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_checked_at IS NULL OR last_checked_at < datetime('now', '-10 minutes'))`, id)
		}
	}
	target.Kind = effectiveMediaKind(target.Kind, target.RelativePath)
	s.serveAutomaticLocalPlayback(w, r, target, path)
}

func (s *Server) serveMediaAsset(w http.ResponseWriter, r *http.Request) {
	path, relPath, err := s.localMediaPath(r, r.PathValue("id"))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
		return
	}
	serveRevalidatedFile(w, r, path, relPath)
}

func serveRevalidatedFile(w http.ResponseWriter, r *http.Request, filePath string, identity string) {
	if info, err := os.Stat(filePath); err == nil {
		setAssetRevisionHeaders(w, info, identity)
	}
	http.ServeFile(w, r, filePath)
}

func setAssetRevisionHeaders(w http.ResponseWriter, info os.FileInfo, identity string) {
	revision := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d", filepath.ToSlash(identity), info.Size(), info.ModTime().UnixNano())))
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", fmt.Sprintf("\"%x\"", revision[:16]))
}

func (s *Server) serveMediaText(w http.ResponseWriter, r *http.Request) {
	path, relPath, err := s.localMediaPath(r, r.PathValue("id"))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
		return
	}
	if !isTextFile(relPath) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "media location is not a text file"})
		return
	}
	info, err := os.Stat(path)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "media file is not available"})
		return
	}
	if info.Size() > 512*1024 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text file is too large to preview"})
		return
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		writeError(w, err)
		return
	}
	content, err := textdecode.Decode(r.Context(), bytes, "")
	if err != nil {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    filepath.ToSlash(relPath),
		"content": content,
	})
}

func (s *Server) downloadMedia(w http.ResponseWriter, r *http.Request) {
	path, relPath, err := s.mediaDownloadPath(r, r.PathValue("id"))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
		return
	}
	filename := filepath.Base(filepath.FromSlash(relPath))
	if filename == "." || filename == string(filepath.Separator) || strings.TrimSpace(filename) == "" {
		filename = "media-file"
	}
	w.Header().Set("Content-Disposition", fmt.Sprintf("attachment; filename=%q", filename))
	http.ServeFile(w, r, path)
}

func (s *Server) localMediaPath(r *http.Request, idValue string) (string, string, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(idValue), 10, 64)
	if err != nil || id <= 0 {
		return "", "", fmt.Errorf("invalid media location id")
	}
	if eligible, err := s.demoMediaLocationEligible(r.Context(), id); err != nil || !eligible {
		return "", "", fmt.Errorf("media location not found")
	}
	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, id).Scan(&locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("media location not found")
		}
		return "", "", err
	}
	if locationType != "local" || availability != "available" {
		return "", "", fmt.Errorf("media location is not available")
	}
	path, err := safeDataPath(s.cfg.DataRoot, relPath)
	if err != nil {
		return "", "", fmt.Errorf("invalid media path")
	}
	return path, relPath, nil
}

func (s *Server) mediaDownloadPath(r *http.Request, idValue string) (string, string, error) {
	id, err := strconv.ParseInt(strings.TrimSpace(idValue), 10, 64)
	if err != nil || id <= 0 {
		return "", "", fmt.Errorf("invalid media location id")
	}
	if eligible, err := s.demoMediaLocationEligible(r.Context(), id); err != nil || !eligible {
		return "", "", fmt.Errorf("media location not found")
	}
	var locationType string
	var relPath string
	var availability string
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT location_type, path, availability
		FROM media_file_location
		WHERE id = ?
	`, id).Scan(&locationType, &relPath, &availability); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", fmt.Errorf("media location not found")
		}
		return "", "", err
	}
	if (locationType != "local" && locationType != "cache") || availability != "available" {
		return "", "", fmt.Errorf("media location is not available for download")
	}
	root := s.cfg.DataRoot
	if locationType == "cache" {
		root = s.cfg.CacheRoot
	}
	path, err := safeDataPath(root, relPath)
	if err != nil {
		return "", "", fmt.Errorf("invalid media path")
	}
	return path, relPath, nil
}
