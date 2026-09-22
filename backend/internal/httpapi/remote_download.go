package httpapi

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/download"
	"github.com/yexca/kikoto/backend/internal/outbound"
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
	if s.db == nil {
		return int64(defaultRemoteDownloadLimitGB) << 30
	}
	limitGB := s.settingIntContext(ctx, "remote_download_limit_gb", defaultRemoteDownloadLimitGB)
	if limitGB < minimumRemoteDownloadLimitGB || limitGB > maximumRemoteDownloadLimitGB {
		limitGB = defaultRemoteDownloadLimitGB
	}
	return int64(limitGB) << 30
}

func (s *Server) downloadToFile(ctx context.Context, source remoteSourceForUse, sourceURL string, targetPath string, options remoteDownloadOptions) (int64, error) {
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
		if source.Config.RequestLanguage != "" {
			request.Header.Set("Accept-Language", source.Config.RequestLanguage)
		}
		response, err := s.sourceDownloadHTTPClient(source, 0).Do(request)
		if err != nil {
			retryable := !errors.Is(err, outbound.ErrPolicyViolation)
			downloadErr := remoteDownloadError{Err: err, Retryable: retryable}
			lastErr = downloadErr
			if retryable && attempt < 2 {
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

func (s *Server) waitRemoteDownloadDelay(ctx context.Context) error {
	return nil
}

func (s *Server) remoteBackoffDuration(ctx context.Context, response *http.Response, attempt int) time.Duration {
	fallback := s.settingFloatContext(ctx, "remote_rate_limit_backoff_seconds", 30)
	maximum := s.settingFloatContext(ctx, "remote_max_backoff_seconds", 300)
	if fallback < 0 {
		fallback = 0
	}
	if maximum <= 0 {
		maximum = 300
	}
	delay := time.Duration(fallback*float64(time.Second)) * time.Duration(attempt+1)
	if response != nil {
		if retryAfter := retryAfterDuration(response.Header.Get("Retry-After")); retryAfter > 0 {
			delay = retryAfter
		}
	}
	maxDelay := time.Duration(maximum * float64(time.Second))
	if delay > maxDelay {
		delay = maxDelay
	}
	return delay
}

func retryAfterDuration(value string) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if seconds, err := strconv.ParseFloat(value, 64); err == nil && seconds > 0 {
		return time.Duration(seconds * float64(time.Second))
	}
	if at, err := http.ParseTime(value); err == nil {
		delay := time.Until(at)
		if delay > 0 {
			return delay
		}
	}
	return 0
}

func isRetryableRemoteStatus(status int) bool {
	return status == http.StatusTooManyRequests || status == http.StatusBadGateway || status == http.StatusServiceUnavailable || status == http.StatusGatewayTimeout
}

func sleepContext(ctx context.Context, delay time.Duration) error {
	if delay <= 0 {
		return nil
	}
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
