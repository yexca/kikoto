package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/download"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

func (s *Server) kikoeruClientForSource(source remoteSourceForUse) *kikoeru.Client {
	httpClient := s.sourceHTTPClient(source, 20*time.Second)
	if source.SourceType == sourceTypeKikoeruCompatible178 {
		return kikoeru.NewNumber178Client(source.Endpoint.APIURL, httpClient)
	}
	return kikoeru.NewClient(source.Endpoint.APIURL, httpClient)
}

func (s *Server) getRemoteSourceWorkText(w http.ResponseWriter, r *http.Request) {
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	code := remoteWorkCodeFromPath(r)
	targetPath := cleanRemoteRelativePath(r.URL.Query().Get("path"))
	if code == "" || targetPath == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "work code and text path are required"})
		return
	}
	source, _, tracks, err := s.loadRemoteWorkTracksCached(r.Context(), id, code)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeUpstreamError(w, err)
		return
	}
	remoteURL, ok := remoteTextTrackURL(tracks, targetPath, "")
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "remote text file was not found"})
		return
	}
	parsed, err := url.Parse(remoteURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || !remotePreviewURLAllowed(parsed, source) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "remote text URL is not allowed"})
		return
	}
	request, err := http.NewRequestWithContext(r.Context(), http.MethodGet, parsed.String(), nil)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "remote text request could not be created"})
		return
	}
	request.Header.Set("Accept", "text/plain,text/*")
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	response, err := s.sourceHTTPClient(source, 20*time.Second).Do(request)
	if err != nil {
		writeUpstreamError(w, err)
		return
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": fmt.Sprintf("remote text returned HTTP %d", response.StatusCode)})
		return
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, 512*1024+1))
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "remote text could not be read"})
		return
	}
	if len(content) > 512*1024 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text file is too large to preview"})
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(content)
}

func remoteTextTrackURL(nodes []kikoeru.Track, targetPath string, basePath string) (string, bool) {
	for _, node := range nodes {
		title := strings.TrimSpace(node.Title)
		if title == "" {
			continue
		}
		path := cleanRemoteRelativePath(joinRemotePath(basePath, title))
		if len(node.Children) > 0 || remoteTrackKindForPath(node.Type, path) == "folder" {
			if value, ok := remoteTextTrackURL(node.Children, targetPath, path); ok {
				return value, true
			}
			continue
		}
		if path == targetPath && mediaKindFromPath(path) == "text" {
			return firstNonEmpty(node.MediaStreamURL, node.MediaDownloadURL, node.StreamLowQualityURL), true
		}
	}
	return "", false
}

func remotePreviewURLAllowed(value *url.URL, source remoteSourceForUse) bool {
	policy, err := sourceOutboundPolicy(source)
	return err == nil && policy.ValidateURL(value) == nil
}

func (s *Server) downloadRemoteCover(ctx context.Context, source remoteSourceForUse, workCode string, coverURL string) error {
	coverURL = strings.TrimSpace(coverURL)
	if coverURL == "" {
		return nil
	}
	parsedURL, err := url.Parse(coverURL)
	if err != nil {
		return nil
	}
	extension := strings.ToLower(filepath.Ext(parsedURL.Path))
	if extension == "" || len(extension) > 6 {
		extension = ".jpg"
	}
	if err := os.MkdirAll(filepath.Join(s.cfg.CacheRoot, "cover"), 0o755); err != nil {
		return err
	}
	targetPath := filepath.Join(s.cfg.CacheRoot, "cover", strings.ToUpper(workCode)+extension)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, coverURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	response, err := s.sourceHTTPClient(source, 2*time.Minute).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("cover download returned HTTP %d", response.StatusCode)
	}
	_, err = download.WriteFile(response.Body, response.ContentLength, targetPath, download.Options{MaxBytes: download.CoverMaxBytes})
	return err
}
