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
	"github.com/yexca/kikoto/backend/internal/textdecode"
)

// kikoeruClientForSource asks in the request viewer's languages.
func (s *Server) kikoeruClientForSource(ctx context.Context, source remoteSourceForUse) *kikoeru.Client {
	return s.kikoeruClientForSourceClass(ctx, source, sourceRequestInteractive)
}

// kikoeruCrawlClientForSource asks in the instance default languages: crawl
// results are stored for every user.
func (s *Server) kikoeruCrawlClientForSource(ctx context.Context, source remoteSourceForUse) *kikoeru.Client {
	return s.kikoeruClientForSourceClass(ctx, source, sourceRequestCrawl)
}

func (s *Server) kikoeruClientForSourceClass(ctx context.Context, source remoteSourceForUse, class sourceRequestClass) *kikoeru.Client {
	languages := s.viewerMetadataLanguages(ctx)
	if class == sourceRequestCrawl {
		languages = s.instanceMetadataLanguages(ctx)
	}
	return s.kikoeruClientForSourceWithLanguages(source, class, languages)
}

func (s *Server) kikoeruClientForSourceWithLanguages(source remoteSourceForUse, class sourceRequestClass, languages []string) *kikoeru.Client {
	acceptLanguage := remoteAcceptLanguage(remoteSourceLanguageList(languages, source.Config.RequestLanguage))
	var httpClient *http.Client
	switch class {
	case sourceRequestCrawl:
		httpClient = s.sourceCrawlHTTPClient(source, 20*time.Second)
	case sourceRequestDownload:
		httpClient = s.sourceDownloadHTTPClient(source, 20*time.Second)
	default:
		httpClient = s.sourceHTTPClient(source, 20*time.Second)
	}
	if source.SourceType == sourceTypeKikoeruCompatible178 {
		return kikoeru.NewNumber178Client(source.Endpoint.APIURL, httpClient).WithAcceptLanguage(acceptLanguage)
	}
	return kikoeru.NewClient(source.Endpoint.APIURL, httpClient).WithAcceptLanguage(acceptLanguage)
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
	content, contentType, err := s.readRemoteText(r.Context(), source, parsed.String())
	if err != nil {
		writeRemoteTextError(w, err)
		return
	}
	decoded, err := textdecode.Decode(r.Context(), content, contentType)
	if err != nil {
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(decoded))
}

// maxTextPreviewBytes bounds a text file read for preview, wherever it is stored.
const maxTextPreviewBytes = 512 * 1024

var errTextPreviewTooLarge = invalidRequestError("text file is too large to preview")

// remoteTextError is a remote text read the source did not complete. Its
// message names no URL and is safe to return.
type remoteTextError struct{ message string }

func (err remoteTextError) Error() string { return err.message }

func writeRemoteTextError(w http.ResponseWriter, err error) {
	var textErr remoteTextError
	if errors.As(err, &textErr) {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": textErr.message})
		return
	}
	writeUpstreamError(w, err)
}

// readRemoteText reads a bounded text file from a URL that the caller has
// already checked against the source's allowed origins. It returns the bytes
// and the upstream content type for decoding.
func (s *Server) readRemoteText(ctx context.Context, source remoteSourceForUse, remoteURL string) ([]byte, string, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, remoteURL, nil)
	if err != nil {
		return nil, "", remoteTextError{message: "remote text request could not be created"}
	}
	request.Header.Set("Accept", "text/plain,text/*")
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	request.Header.Set("Accept-Language", s.remoteSourceAcceptLanguage(ctx, source))
	response, err := s.sourceHTTPClient(source, 20*time.Second).Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", remoteTextError{message: fmt.Sprintf("remote text returned HTTP %d", response.StatusCode)}
	}
	content, err := io.ReadAll(io.LimitReader(response.Body, maxTextPreviewBytes+1))
	if err != nil {
		return nil, "", remoteTextError{message: "remote text could not be read"}
	}
	if len(content) > maxTextPreviewBytes {
		return nil, "", errTextPreviewTooLarge
	}
	return content, response.Header.Get("Content-Type"), nil
}

func remoteTextTrackURL(nodes []kikoeru.Track, targetPath string, basePath string) (string, bool) {
	for index, node := range nodes {
		path := remoteTrackPath(basePath, remoteTrackName(node.Title, index))
		if len(node.Children) > 0 || remoteTrackKindForPath(node.Type, path) == "folder" {
			if value, ok := remoteTextTrackURL(node.Children, targetPath, path); ok {
				return value, true
			}
			continue
		}
		if path == targetPath && isTextPreviewFile(remoteTrackKindForPath(node.Type, path), path) {
			return firstNonEmpty(node.MediaStreamURL, node.MediaDownloadURL, node.StreamLowQualityURL), true
		}
	}
	return "", false
}

func remotePreviewURLAllowed(value *url.URL, source remoteSourceForUse) bool {
	policy, err := sourceOutboundPolicy(source, nil)
	return err == nil && policy.ValidateURL(value) == nil
}

func (s *Server) downloadRemoteCover(ctx context.Context, source remoteSourceForUse, workCode string, coverURL string) error {
	coverURL = strings.TrimSpace(coverURL)
	if coverURL == "" {
		return nil
	}
	workCode = strings.ToUpper(strings.TrimSpace(workCode))
	if normalizeWorkCode(workCode) == "" {
		return fmt.Errorf("invalid cover work code")
	}
	if exists, err := s.hasCachedWorkCover(workCode); err != nil {
		return err
	} else if exists {
		return nil
	}
	targetPath := filepath.Join(s.cfg.CacheRoot, "cover", filepath.FromSlash(coverAssetRelativePath(workCode, "")))
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, coverURL, nil)
	if err != nil {
		return err
	}
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	request.Header.Set("Accept-Language", s.instanceRemoteSourceAcceptLanguage(ctx, source))
	response, err := s.sourceHTTPClient(source, 2*time.Minute).Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("cover download returned HTTP %d", response.StatusCode)
	}
	// Stage next to the final cover and publish without replacing an existing
	// file. A provider cover learned during the request must still win.
	staging, err := os.MkdirTemp(filepath.Dir(targetPath), ".remote-cover-")
	if err != nil {
		return err
	}
	defer func() { _ = os.RemoveAll(staging) }()
	if err := download.WriteImage(response.Body, response.ContentLength, filepath.Join(staging, workCode)); err != nil {
		return err
	}
	if exists, err := s.hasCachedWorkCover(workCode); err != nil {
		return err
	} else if exists {
		return nil
	}
	entries, err := os.ReadDir(staging)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		return download.PublishCover(ctx, filepath.Join(staging, entry.Name()), targetPath+filepath.Ext(entry.Name()), false)
	}
	return fmt.Errorf("cover staging file missing")
}
