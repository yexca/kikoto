package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/download"
)

const (
	defaultRemoteDownloadLimitGB = 100
	minimumRemoteDownloadLimitGB = 1
	maximumRemoteDownloadLimitGB = 2048
)

type remoteDownloadOptions struct {
	MaxBytes      int64
	ExpectedBytes *int64
	OnProgress    func(written int64)
}

func (s *Server) remoteMediaDownloadLimitBytes(ctx context.Context) int64 {
	limitGB := s.settingIntContext(ctx, "remote_download_limit_gb", defaultRemoteDownloadLimitGB)
	if limitGB < minimumRemoteDownloadLimitGB || limitGB > maximumRemoteDownloadLimitGB {
		limitGB = defaultRemoteDownloadLimitGB
	}
	return int64(limitGB) << 30
}

func (s *Server) downloadToFile(ctx context.Context, sourceURL string, targetPath string, options remoteDownloadOptions) (int64, error) {
	if strings.TrimSpace(sourceURL) == "" {
		return 0, fmt.Errorf("remote media has no download URL")
	}
	if options.MaxBytes <= 0 {
		options.MaxBytes = s.remoteMediaDownloadLimitBytes(ctx)
	}
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := s.waitRemoteDownloadDelay(ctx); err != nil {
			return 0, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, sourceURL, nil)
		if err != nil {
			return 0, err
		}
		request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
		response, err := s.sourceDownloadHTTPClient(0).Do(request)
		if err != nil {
			downloadErr := remoteDownloadError{Err: err, Retryable: true}
			lastErr = downloadErr
			if attempt < 2 {
				if sleepErr := sleepContext(ctx, s.remoteBackoffDuration(ctx, nil, attempt)); sleepErr != nil {
					return 0, sleepErr
				}
				continue
			}
			return 0, downloadErr
		}
		if response.StatusCode >= 200 && response.StatusCode < 300 {
			written, writeErr := download.WriteFile(response.Body, response.ContentLength, targetPath, download.Options{
				MaxBytes:      options.MaxBytes,
				ExpectedBytes: options.ExpectedBytes,
				OnProgress:    options.OnProgress,
			})
			_ = response.Body.Close()
			return written, writeErr
		}
		statusErr := remoteDownloadError{StatusCode: response.StatusCode, Retryable: isRetryableRemoteStatus(response.StatusCode)}
		lastErr = statusErr
		retryable := isRetryableRemoteStatus(response.StatusCode)
		backoff := s.remoteBackoffDuration(ctx, response, attempt)
		_ = response.Body.Close()
		if !retryable || attempt >= 2 {
			return 0, statusErr
		}
		if err := sleepContext(ctx, backoff); err != nil {
			return 0, err
		}
	}
	return 0, lastErr
}

type remoteDownloadError struct {
	Err        error
	StatusCode int
	Retryable  bool
}

func (e remoteDownloadError) Error() string {
	if e.Err != nil {
		return e.Err.Error()
	}
	return fmt.Sprintf("remote media download returned HTTP %d", e.StatusCode)
}

func (e remoteDownloadError) Unwrap() error { return e.Err }
