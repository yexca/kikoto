package httpapi

import (
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"mime"
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
	path, relPath, err := s.storedMediaPath(r, r.PathValue("id"))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
		return
	}
	serveRevalidatedFile(w, r, path, relPath)
}

func serveRevalidatedFile(w http.ResponseWriter, r *http.Request, filePath string, identity string) {
	file, err := os.Open(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = file.Close() }()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	// Source filenames and file contents are untrusted. Only passive raster
	// formats may render inline on the authenticated application origin.
	var prefix [512]byte
	n, err := file.Read(prefix[:])
	if err != nil && !errors.Is(err, io.EOF) {
		http.NotFound(w, r)
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		http.NotFound(w, r)
		return
	}
	contentType := http.DetectContentType(prefix[:n])
	setUntrustedFileHeaders(w)
	switch contentType {
	case "image/jpeg", "image/png", "image/gif", "image/webp", "image/bmp", "image/x-icon":
		w.Header().Set("Content-Type", contentType)
	default:
		setAttachmentHeaders(w, identity)
	}
	setAssetRevisionHeaders(w, info, identity)
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

func setUntrustedFileHeaders(w http.ResponseWriter) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
}

func setAttachmentHeaders(w http.ResponseWriter, identity string) {
	filename := filepath.Base(filepath.FromSlash(identity))
	if filename == "." || filename == string(filepath.Separator) || strings.TrimSpace(filename) == "" {
		filename = "media-file"
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": filename}))
}

func setAssetRevisionHeaders(w http.ResponseWriter, info os.FileInfo, identity string) {
	revision := sha256.Sum256([]byte(fmt.Sprintf("%s\x00%d\x00%d", filepath.ToSlash(identity), info.Size(), info.ModTime().UnixNano())))
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", fmt.Sprintf("\"%x\"", revision[:16]))
}

// serveMediaText returns one text file of a work as decoded text. Every kind of
// location is read where its bytes are: a local file from the library, a cached
// copy from the cache, and a remote file through its configured source.
func (s *Server) serveMediaText(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
		return
	}
	target, _, err := s.loadMediaStreamTarget(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
			return
		}
		writeError(w, err)
		return
	}
	if !isTextPreviewFile(target.Kind, target.RelativePath) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "media location is not a text file"})
		return
	}
	raw, contentType, err := s.readMediaLocationText(r, target)
	if err != nil {
		if target.LocationType == "remote_stream" {
			writeRemoteTextError(w, err)
		} else {
			writeError(w, err)
		}
		return
	}
	content, err := textdecode.Decode(r.Context(), raw, contentType)
	if err != nil {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"path":    filepath.ToSlash(target.RelativePath),
		"content": content,
	})
}

func (s *Server) readMediaLocationText(r *http.Request, target mediaStreamTarget) ([]byte, string, error) {
	notFound := notFoundError("media file was not found")
	switch target.LocationType {
	case "local", "cache":
		if target.Availability != "available" {
			return nil, "", notFound
		}
		root := s.cfg.DataRoot
		if target.LocationType == "cache" {
			root = s.cfg.CacheRoot
		}
		path, err := safeDataPath(root, target.RelativePath)
		if err != nil {
			return nil, "", notFound
		}
		info, err := os.Stat(path)
		if err != nil {
			return nil, "", notFoundError("media file is not available")
		}
		if info.Size() > maxTextPreviewBytes {
			return nil, "", errTextPreviewTooLarge
		}
		raw, err := os.ReadFile(path)
		return raw, "", err
	case "remote_stream":
		remoteURL := firstNonEmpty(target.StreamURL, target.DownloadURL)
		if (target.Availability != "available" && target.Availability != "remote") ||
			target.FileSourceID <= 0 || strings.TrimSpace(remoteURL) == "" {
			return nil, "", notFound
		}
		source, err := s.loadRemotePlaybackSource(r.Context(), target.FileSourceID)
		if err != nil {
			if errors.Is(err, errRemotePlaybackSourceUnavailable) {
				return nil, "", notFoundError("remote media source is not available")
			}
			return nil, "", err
		}
		// The stored URL came from the source's own listing, so it is checked
		// against the source's allowed origins again before it is requested.
		parsed, err := remotePlaybackURLAllowed(remoteURL, source)
		if err != nil {
			return nil, "", remoteTextError{message: "remote text URL is not allowed"}
		}
		return s.readRemoteText(r.Context(), source, parsed.String())
	default:
		return nil, "", notFound
	}
}

func (s *Server) downloadMedia(w http.ResponseWriter, r *http.Request) {
	path, relPath, err := s.storedMediaPath(r, r.PathValue("id"))
	if err != nil {
		writeAPIError(w, http.StatusNotFound, "not_found", "media file was not found", false)
		return
	}
	setUntrustedFileHeaders(w)
	setAttachmentHeaders(w, relPath)
	http.ServeFile(w, r, path)
}

// storedMediaPath resolves a location whose bytes this server holds: a local
// library file or a cached copy.
func (s *Server) storedMediaPath(r *http.Request, idValue string) (string, string, error) {
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
		return "", "", fmt.Errorf("media location is not stored on this server")
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
