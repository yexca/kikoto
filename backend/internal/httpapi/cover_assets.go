package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/download"
)

// Check legacy cached covers too: older versions could persist arbitrary
// upstream content. Serve the same open file that was checked, without sniffing
// or allowing an active document even when a URL is opened directly.
func serveCoverFile(w http.ResponseWriter, r *http.Request, filePath, identity string) {
	switch strings.ToLower(filepath.Ext(filePath)) {
	case ".jpg", ".jpeg", ".png", ".webp":
	default:
		http.NotFound(w, r)
		return
	}
	file, err := os.Open(filePath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() { _ = file.Close() }()
	prefix := make([]byte, 512)
	n, err := file.Read(prefix)
	if err != nil && err != io.EOF {
		http.NotFound(w, r)
		return
	}
	contentType, _, err := download.ImageType(prefix[:n])
	if err != nil {
		http.NotFound(w, r)
		return
	}
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		http.NotFound(w, r)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	setAssetRevisionHeaders(w, info, identity)
	if r.URL.Query().Get("v") == coverRevision(info) {
		// A versioned URL names this exact file revision; a replaced cover gets a new URL.
		w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	}
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

// coverRevision is the version token cover URLs carry, derived from the cached file's size and modification time.
func coverRevision(info os.FileInfo) string {
	return strconv.FormatInt(info.Size(), 36) + "-" + strconv.FormatInt(info.ModTime().UnixNano(), 36)
}

func (s *Server) getCoverAsset(w http.ResponseWriter, r *http.Request) {
	relPath := strings.TrimPrefix(r.URL.Path, "/api/assets/covers/")
	if relPath == "" || strings.Contains(relPath, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid cover file"})
		return
	}
	if eligible, err := s.demoCoverEligible(r.Context(), relPath); err != nil || !eligible {
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			writeError(w, err)
			return
		}
		http.NotFound(w, r)
		return
	}
	path, err := safeCachePath(filepath.Join(s.cfg.CacheRoot, "cover"), relPath)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid cover file"})
		return
	}
	serveCoverFile(w, r, path, relPath)
}

func (s *Server) getManualAsset(w http.ResponseWriter, r *http.Request) {
	file := filepath.Base(r.PathValue("file"))
	if file == "." || file == string(filepath.Separator) || strings.Contains(file, "..") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid manual asset file"})
		return
	}
	if eligible, err := s.demoManualAssetEligible(r.Context(), file); err != nil || !eligible {
		if err != nil {
			writeError(w, err)
			return
		}
		http.NotFound(w, r)
		return
	}
	path := filepath.Join(s.cfg.CacheRoot, "manual", file)
	http.ServeFile(w, r, path)
}

func (s *Server) coverURL(primaryCode string) string {
	code := strings.ToUpper(strings.TrimSpace(primaryCode))
	if code == "" {
		return ""
	}
	if manualURL := s.manualCoverURL(code); manualURL != "" {
		return manualURL
	}
	for _, extension := range []string{".jpg", ".jpeg", ".png", ".webp"} {
		file := coverAssetRelativePath(code, extension)
		path := filepath.Join(s.cfg.CacheRoot, "cover", filepath.FromSlash(file))
		if info, err := os.Stat(path); err == nil {
			return "/api/assets/covers/" + file + "?v=" + coverRevision(info)
		}
	}
	return ""
}

func (s *Server) workCoverURL(ctx context.Context, workID int64, primaryCode string) (string, error) {
	if coverURL := s.coverURL(primaryCode); coverURL != "" {
		return coverURL, nil
	}
	var canonicalCode string
	if err := s.db.QueryRowContext(ctx, `
		SELECT canonical.primary_code
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		INNER JOIN work AS canonical ON canonical.id = logical.canonical_work_id
		WHERE edition.work_id = ?
	`, workID).Scan(&canonicalCode); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", err
	}
	if strings.EqualFold(strings.TrimSpace(canonicalCode), strings.TrimSpace(primaryCode)) {
		return "", nil
	}
	return s.coverURL(canonicalCode), nil
}

func coverAssetRelativePath(code string, extension string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	prefix := code
	if len(prefix) > 2 {
		prefix = prefix[:2]
	}
	group := "misc"
	digits := ""
	for _, char := range code {
		if char >= '0' && char <= '9' {
			digits += string(char)
		}
	}
	if len(digits) >= 3 {
		group = digits[:3]
	}
	return filepath.ToSlash(filepath.Join(prefix, group, code+extension))
}

func (s *Server) manualCoverURL(primaryCode string) string {
	var assetPath string
	if err := s.db.QueryRowContext(context.Background(), `
		SELECT override.asset_path
		FROM work_manual_override AS override
		INNER JOIN work ON work.id = override.work_id
		WHERE work.primary_code = ?
			AND override.field_name = 'cover'
			AND override.asset_path <> ''
	`, primaryCode).Scan(&assetPath); err != nil {
		return ""
	}
	file := filepath.Base(assetPath)
	if file == "." || file == string(filepath.Separator) || strings.Contains(file, "..") {
		return ""
	}
	if _, err := os.Stat(filepath.Join(s.cfg.CacheRoot, "manual", file)); err != nil {
		return ""
	}
	return "/api/assets/manual/" + file
}
