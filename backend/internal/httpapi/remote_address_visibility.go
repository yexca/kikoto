package httpapi

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/download"
)

// hideRemoteSourceAddressesSetting hides every remote source address from
// accounts without sources:write and from anonymous readers. It is on unless
// an administrator turns it off.
const hideRemoteSourceAddressesSetting = "hide_remote_source_addresses"

const hiddenRemoteAddress = "[remote address hidden]"

// remoteAddressesHidden reports whether this request must not receive
// anything that reveals a configured remote source's address. Demo mode
// serves synthetic sources and keeps its showcase unchanged.
func (s *Server) remoteAddressesHidden(ctx context.Context) bool {
	if s.cfg.IsDemo() {
		return false
	}
	if user, ok := userFromContext(ctx); ok && userHasPermission(user, "sources:write") {
		return false
	}
	return s.settingBoolContext(ctx, hideRemoteSourceAddressesSetting, true)
}

// remoteImageTokenSealer encrypts source-returned image URLs into opaque
// tokens for the image proxy, so a viewer gets a server path and never the
// upstream address. The key lives only in this process: tokens stop working
// after a restart, when the pages that hold them have been reloaded anyway.
type remoteImageTokenSealer struct {
	once sync.Once
	aead cipher.AEAD
	err  error
}

type remoteImageTokenClaims struct {
	URL string `json:"u"`
}

func (sealer *remoteImageTokenSealer) cipher() (cipher.AEAD, error) {
	sealer.once.Do(func() {
		key := make([]byte, 32)
		if _, err := rand.Read(key); err != nil {
			sealer.err = err
			return
		}
		block, err := aes.NewCipher(key)
		if err != nil {
			sealer.err = err
			return
		}
		sealer.aead, sealer.err = cipher.NewGCM(block)
	})
	return sealer.aead, sealer.err
}

func remoteImageTokenAdditionalData(sourceID int64) []byte {
	return []byte("remote-image:" + strconv.FormatInt(sourceID, 10))
}

func (sealer *remoteImageTokenSealer) seal(sourceID int64, rawURL string) (string, error) {
	aead, err := sealer.cipher()
	if err != nil {
		return "", err
	}
	plaintext, err := json.Marshal(remoteImageTokenClaims{URL: rawURL})
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, plaintext, remoteImageTokenAdditionalData(sourceID))
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func (sealer *remoteImageTokenSealer) open(sourceID int64, token string) (string, bool) {
	aead, err := sealer.cipher()
	if err != nil {
		return "", false
	}
	sealed, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(sealed) < aead.NonceSize() {
		return "", false
	}
	plaintext, err := aead.Open(nil, sealed[:aead.NonceSize()], sealed[aead.NonceSize():], remoteImageTokenAdditionalData(sourceID))
	if err != nil {
		return "", false
	}
	var claims remoteImageTokenClaims
	if err := json.Unmarshal(plaintext, &claims); err != nil || strings.TrimSpace(claims.URL) == "" {
		return "", false
	}
	return claims.URL, true
}

// remoteImageProxyURL returns the server path that serves a source-returned
// image without naming its address, or "" when there is no image.
func (s *Server) remoteImageProxyURL(sourceID int64, rawURL string) string {
	rawURL = strings.TrimSpace(rawURL)
	if sourceID <= 0 || rawURL == "" {
		return ""
	}
	token, err := s.remoteImageTokens.seal(sourceID, rawURL)
	if err != nil {
		slog.Warn("remote image token could not be sealed", "source_id", sourceID, "error", err)
		return ""
	}
	return "/api/remote-sources/" + strconv.FormatInt(sourceID, 10) + "/images/" + token
}

// visibleRemoteImageURL keeps a source-returned image usable for a viewer:
// the upstream URL when addresses are visible, the proxy path otherwise.
func (s *Server) visibleRemoteImageURL(ctx context.Context, sourceID int64, rawURL string) string {
	if !s.remoteAddressesHidden(ctx) {
		return rawURL
	}
	return s.remoteImageProxyURL(sourceID, rawURL)
}

const remoteImageProxyTimeout = 30 * time.Second

// serveRemoteSourceImage proxies one source-returned image named by a token
// the server issued. The decrypted URL must still pass the source's outbound
// policy; the response must be an inert raster image within the cover limit.
func (s *Server) serveRemoteSourceImage(w http.ResponseWriter, r *http.Request) {
	sourceID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	rawURL, ok := s.remoteImageTokens.open(sourceID, r.PathValue("token"))
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "remote image not found"})
		return
	}
	source, err := s.loadRemotePlaybackSource(r.Context(), sourceID)
	if err != nil {
		if writeRemotePlaybackSourceError(w, err) {
			return
		}
		writeError(w, err)
		return
	}
	parsed, err := remotePlaybackURLAllowed(rawURL, source)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "remote_image_blocked", "remote image source is not allowed", true)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), remoteImageProxyTimeout)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "remote_image_unavailable", "remote image could not be read", true)
		return
	}
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	request.Header.Set("Accept", "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8")
	request.Header.Set("Accept-Language", s.remoteSourceAcceptLanguage(r.Context(), source))
	response, err := s.sourceHTTPClient(source, remoteImageProxyTimeout).Do(request)
	if err != nil {
		slog.Warn("remote image proxy request failed", "source_id", sourceID, "error", err)
		writeAPIError(w, http.StatusBadGateway, "remote_image_unavailable", "remote image could not be read", true)
		return
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		writeAPIError(w, http.StatusBadGateway, "remote_image_unavailable", "remote image could not be read", true)
		return
	}
	if response.ContentLength > download.CoverMaxBytes {
		writeAPIError(w, http.StatusRequestEntityTooLarge, "remote_image_too_large", "remote image is too large", false)
		return
	}
	prefix := make([]byte, 512)
	read, err := io.ReadFull(response.Body, prefix)
	if err != nil && !errors.Is(err, io.EOF) && !errors.Is(err, io.ErrUnexpectedEOF) {
		writeAPIError(w, http.StatusBadGateway, "remote_image_unavailable", "remote image could not be read", true)
		return
	}
	prefix = prefix[:read]
	contentType, _, err := download.ImageType(prefix)
	if err != nil {
		writeAPIError(w, http.StatusBadGateway, "remote_image_type_unsupported", "remote image type is not supported", false)
		return
	}
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Security-Policy", "default-src 'none'; sandbox")
	w.Header().Set("Cache-Control", "private, max-age=3600")
	if response.ContentLength >= 0 {
		w.Header().Set("Content-Length", strconv.FormatInt(response.ContentLength, 10))
	}
	w.WriteHeader(http.StatusOK)
	if _, err := w.Write(prefix); err != nil {
		return
	}
	limited := &io.LimitedReader{R: response.Body, N: download.CoverMaxBytes - int64(len(prefix)) + 1}
	written, err := io.Copy(w, limited)
	if err == nil && int64(len(prefix))+written > download.CoverMaxBytes {
		// Headers are sent; stopping the body is the only bound left.
		slog.Warn("remote image proxy stopped at the image limit", "source_id", sourceID)
	}
}

var (
	remoteAddressURLPattern  = regexp.MustCompile(`(?i)\b[a-z][a-z0-9+.\-]*://[^\s"'<>\\]+`)
	remoteAddressIPv4Pattern = regexp.MustCompile(`\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b`)
	remoteAddressIPv6Pattern = regexp.MustCompile(`\[[0-9A-Fa-f:.%]+\](?::\d{1,5})?`)
)

// remoteAddressRedactor removes remote source addresses from free text such
// as stored workflow errors, which can carry an upstream URL, a resolved
// address, or a configured host name. It is a no-op for viewers who may see
// addresses.
type remoteAddressRedactor struct {
	hosts []string
}

func (redactor *remoteAddressRedactor) text(value string) string {
	if redactor == nil || value == "" {
		return value
	}
	value = remoteAddressURLPattern.ReplaceAllString(value, hiddenRemoteAddress)
	value = remoteAddressIPv6Pattern.ReplaceAllString(value, hiddenRemoteAddress)
	value = remoteAddressIPv4Pattern.ReplaceAllString(value, hiddenRemoteAddress)
	for _, host := range redactor.hosts {
		value = replaceFoldedHost(value, host)
	}
	return value
}

// json redacts every string inside a JSON document and keeps its shape.
func (redactor *remoteAddressRedactor) json(document string) string {
	if redactor == nil || strings.TrimSpace(document) == "" {
		return document
	}
	var value any
	if err := json.Unmarshal([]byte(document), &value); err != nil {
		return redactor.text(document)
	}
	encoded, err := json.Marshal(redactor.value(value))
	if err != nil {
		return redactor.text(document)
	}
	return string(encoded)
}

func (redactor *remoteAddressRedactor) value(value any) any {
	switch typed := value.(type) {
	case string:
		return redactor.text(typed)
	case []any:
		for index := range typed {
			typed[index] = redactor.value(typed[index])
		}
		return typed
	case map[string]any:
		for key, item := range typed {
			typed[key] = redactor.value(item)
		}
		return typed
	default:
		return value
	}
}

// replaceFoldedHost replaces a configured host name wherever it stands as a
// whole host, so a short LAN name does not remove part of an ordinary word.
func replaceFoldedHost(value string, host string) string {
	if host == "" {
		return value
	}
	lowerValue := strings.ToLower(value)
	var builder strings.Builder
	start, copied := 0, 0
	for {
		index := strings.Index(lowerValue[start:], host)
		if index < 0 {
			break
		}
		index += start
		end := index + len(host)
		followedByHost := end < len(lowerValue) && isHostNameByte(lowerValue[end]) &&
			// A sentence's closing period does not continue the host.
			(lowerValue[end] != '.' || (end+1 < len(lowerValue) && isHostNameByte(lowerValue[end+1])))
		if (index > 0 && isHostNameByte(lowerValue[index-1])) || followedByHost {
			start = index + 1
			continue
		}
		builder.WriteString(value[copied:index])
		builder.WriteString(hiddenRemoteAddress)
		start, copied = end, end
	}
	if copied == 0 {
		return value
	}
	builder.WriteString(value[copied:])
	return builder.String()
}

func isHostNameByte(value byte) bool {
	return value >= 'a' && value <= 'z' || value >= '0' && value <= '9' || value == '-' || value == '.' || value == '_'
}

// remoteAddressRedactorFor returns nil when the request may see addresses.
// Otherwise the redactor also knows every configured source host, so a host
// name an upstream error mentions without a scheme is removed as well.
func (s *Server) remoteAddressRedactorFor(ctx context.Context) *remoteAddressRedactor {
	if !s.remoteAddressesHidden(ctx) {
		return nil
	}
	redactor := &remoteAddressRedactor{}
	rows, err := s.db.QueryContext(ctx, `
		SELECT COALESCE(api_url, ''), COALESCE(base_url, ''), COALESCE(fallback_url, ''), COALESCE(allowed_host_patterns_json, '[]')
		FROM file_source_endpoint
	`)
	if err != nil {
		return redactor
	}
	defer func() { _ = rows.Close() }()
	seen := map[string]bool{}
	addHost := func(host string) {
		host = strings.ToLower(strings.Trim(strings.TrimSpace(host), "[]*."))
		if len(host) < 3 || seen[host] {
			return
		}
		seen[host] = true
		redactor.hosts = append(redactor.hosts, host)
	}
	for rows.Next() {
		var apiURL, baseURL, fallbackURL, patternsJSON string
		if err := rows.Scan(&apiURL, &baseURL, &fallbackURL, &patternsJSON); err != nil {
			return redactor
		}
		for _, raw := range []string{apiURL, baseURL, fallbackURL} {
			parsed, err := url.Parse(strings.TrimSpace(raw))
			if err != nil || parsed.Host == "" {
				continue
			}
			addHost(parsed.Host)
			if host, _, err := net.SplitHostPort(parsed.Host); err == nil {
				addHost(host)
			} else {
				addHost(parsed.Hostname())
			}
		}
		var patterns []string
		_ = json.Unmarshal([]byte(patternsJSON), &patterns)
		for _, pattern := range patterns {
			addHost(pattern)
		}
	}
	// Replace longer names first so a host:port is not split by its host.
	sort.Slice(redactor.hosts, func(i, j int) bool { return len(redactor.hosts[i]) > len(redactor.hosts[j]) })
	return redactor
}

// The workflow presenters below remove remote source addresses from stored
// run data before it reaches a viewer who may not see them. Upstream errors
// are recorded verbatim for administrators, so every free-text and JSON
// field is redacted rather than a fixed list of keys.

func (redactor *remoteAddressRedactor) runs(runs []workflowRunRecord) {
	if redactor == nil {
		return
	}
	for index := range runs {
		runs[index].SummaryJSON = redactor.json(runs[index].SummaryJSON)
	}
}

func (redactor *remoteAddressRedactor) runDetail(detail *workflowRunDetailRecord) {
	if redactor == nil {
		return
	}
	detail.SummaryJSON = redactor.json(detail.SummaryJSON)
	detail.GraphJSON = redactor.json(detail.GraphJSON)
	for index := range detail.NodeRuns {
		node := &detail.NodeRuns[index]
		node.InputJSON = redactor.json(node.InputJSON)
		node.OutputJSON = redactor.json(node.OutputJSON)
		node.ErrorMessage = redactor.text(node.ErrorMessage)
	}
}

func (redactor *remoteAddressRedactor) event(event *workflowEventRecord) {
	if redactor == nil {
		return
	}
	event.Message = redactor.text(event.Message)
	event.DetailJSON = redactor.json(event.DetailJSON)
}

func (redactor *remoteAddressRedactor) events(events []workflowEventRecord) {
	for index := range events {
		redactor.event(&events[index])
	}
}

func (redactor *remoteAddressRedactor) candidates(candidates []workflowCandidateRecord) {
	if redactor == nil {
		return
	}
	for index := range candidates {
		candidate := &candidates[index]
		candidate.ExternalKey = redactor.text(candidate.ExternalKey)
		candidate.PayloadJSON = redactor.json(candidate.PayloadJSON)
		candidate.DecisionJSON = redactor.json(candidate.DecisionJSON)
	}
}

func (redactor *remoteAddressRedactor) triggers(triggers []workflowTriggerRecord) {
	if redactor == nil {
		return
	}
	// A trigger's configuration names sources by id and is edited and saved
	// back as shown, so only its recorded error is redacted.
	for index := range triggers {
		triggers[index].LastErrorMessage = redactor.text(triggers[index].LastErrorMessage)
	}
}
