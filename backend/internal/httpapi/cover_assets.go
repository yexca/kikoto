package httpapi

import (
	"io"
	"net/http"
	"os"
	"path/filepath"
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
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}
