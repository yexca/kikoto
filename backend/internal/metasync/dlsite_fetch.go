package metasync

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

func (s *DLsiteSyncer) fetchProduct(ctx context.Context, workno string) (dlsite.Product, error) {
	return s.fetchProductWithLanguages(ctx, workno, s.languages)
}

// fetchProductForEdition first discovers the provider-declared edition and
// then retries that same code with the locale mapped to the edition. DLsite
// often returns a successful but mixed-language response for a mismatched
// locale, so the second exact request is intentional.
func (s *DLsiteSyncer) fetchProductForEdition(ctx context.Context, workno string) (dlsite.Product, error) {
	product, err := s.fetchProduct(ctx, workno)
	if err != nil {
		return dlsite.Product{}, err
	}
	editionLanguage := productEditionLanguage(product)
	exactLocale := dlsite.LocaleForMetadataLanguage(editionLanguage)
	if exactLocale == "" {
		return product, nil
	}
	requestedLocale := strings.ToLower(strings.TrimSpace(strings.ReplaceAll(firstNonEmptyText(product.RequestLocale, product.Language), "_", "-")))
	if requestedLocale == exactLocale {
		product.RequestLocale = exactLocale
		return product, nil
	}
	if _, supportsLocale := s.client.(DLsiteClientWithLocale); supportsLocale {
		exact, exactErr := s.fetchProductWithExactLocale(ctx, workno, exactLocale)
		if exactErr != nil {
			return dlsite.Product{}, fmt.Errorf("fetch %s metadata for %s: %w", exactLocale, workno, exactErr)
		}
		return exact, nil
	} else if _, supportsOptions := s.client.(DLsiteClientWithOptions); supportsOptions {
		exact, exactErr := s.fetchProductWithLanguages(ctx, workno, []string{exactLocale})
		if exactErr != nil {
			return dlsite.Product{}, fmt.Errorf("fetch %s metadata for %s: %w", exactLocale, workno, exactErr)
		}
		exact.RequestLocale = exactLocale
		exact.Language = exactLocale
		return exact, nil
	}
	return product, nil
}

func (s *DLsiteSyncer) fetchProductWithExactLocale(ctx context.Context, workno string, locale string) (dlsite.Product, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := s.waitRequestDelay(ctx); err != nil {
			return dlsite.Product{}, err
		}
		client, ok := s.client.(DLsiteClientWithLocale)
		if !ok {
			return dlsite.Product{}, fmt.Errorf("DLsite client does not support exact locale requests")
		}
		product, err := client.FetchProductWithLocale(ctx, workno, locale)
		if err == nil {
			product.RequestLocale = locale
			product.Language = locale
			return product, nil
		}
		lastErr = err
		if ctx.Err() != nil || errors.Is(err, dlsite.ErrNoProduct) || (!dlsite.IsRetryableHTTPError(err) && !dlsite.IsTimeout(err)) || attempt >= 2 {
			return dlsite.Product{}, err
		}
		if err := sleepWithContext(ctx, s.retryBackoff(err, attempt)); err != nil {
			return dlsite.Product{}, err
		}
	}
	return dlsite.Product{}, lastErr
}

func (s *DLsiteSyncer) fetchProductWithLanguages(ctx context.Context, workno string, languages []string) (dlsite.Product, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		if err := s.waitRequestDelay(ctx); err != nil {
			return dlsite.Product{}, err
		}
		var product dlsite.Product
		var err error
		if client, ok := s.client.(DLsiteClientWithOptions); ok {
			product, err = client.FetchProductWithOptions(ctx, workno, dlsite.ProductOptions{Languages: languages})
		} else {
			product, err = s.client.FetchProduct(ctx, workno)
		}
		if err == nil {
			return product, nil
		}
		lastErr = err
		if ctx.Err() != nil || errors.Is(err, dlsite.ErrNoProduct) || (!dlsite.IsRetryableHTTPError(err) && !dlsite.IsTimeout(err)) || attempt >= 2 {
			return dlsite.Product{}, err
		}
		if err := sleepWithContext(ctx, s.retryBackoff(err, attempt)); err != nil {
			return dlsite.Product{}, err
		}
	}
	return dlsite.Product{}, lastErr
}

func (s *DLsiteSyncer) fetchOriginProduct(ctx context.Context, workno string) (dlsite.Product, error) {
	product, err := s.fetchProductForEdition(ctx, workno)
	if err != nil {
		return dlsite.Product{}, err
	}
	// Provider responses sometimes omit language_editions. Probe the Japanese
	// origin in that case so a localized discovery
	// response cannot overwrite the canonical title.
	if productEditionLanguage(product) == "" &&
		strings.TrimSpace(product.TranslationInfo.Lang) == "" &&
		!originResponseLanguage(product.Language) {
		if japanese, japaneseErr := s.fetchProductWithLanguages(ctx, workno, []string{"ja-jp", ""}); japaneseErr == nil {
			japanese.RequestLocale = "ja-jp"
			japanese.Language = "ja-jp"
			return japanese, nil
		}
	}
	return product, nil
}

func (s *DLsiteSyncer) downloadCover(ctx context.Context, product dlsite.Product) (string, error) {
	release, err := s.coordinator.acquireProduct(ctx, dlsiteProductCode(product))
	if err != nil {
		return "", err
	}
	defer release()
	ctx, err = s.beginAttempt(ctx)
	if err != nil {
		return "", err
	}
	var newer bool
	if err := s.db.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM work_metadata_sync_state AS state
		JOIN work ON work.id = state.work_id JOIN metadata_provider AS provider ON provider.id = state.provider_id
		WHERE work.primary_code = ? AND provider.code = 'dlsite' AND state.last_success_attempt_id > ?)`,
		dlsiteProductCode(product), attemptID(ctx)).Scan(&newer); err != nil {
		return "", err
	}
	if newer {
		return "", nil
	}
	if err := s.waitRequestDelay(ctx); err != nil {
		return "", err
	}
	var path string
	var coverErr error
	for attempt := 0; attempt < 3; attempt++ {
		path, coverErr = s.client.DownloadCover(ctx, product, s.cacheRoot)
		if ctx.Err() != nil || !dlsite.IsTimeout(coverErr) || attempt == 2 {
			break
		}
		if err := sleepWithContext(ctx, s.retryBackoff(coverErr, attempt)); err != nil {
			return "", err
		}
	}
	if err := s.recordCodeOutcome(ctx, dlsiteProductCode(product), "cover", coverErr); err != nil {
		return "", err
	}
	return path, coverErr
}

func (s *DLsiteSyncer) waitRequestDelay(ctx context.Context) error {
	return sleepWithContext(ctx, s.requestDelay)
}

func (s *DLsiteSyncer) retryBackoff(err error, attempt int) time.Duration {
	var statusErr dlsite.HTTPStatusError
	if errors.As(err, &statusErr) {
		if retryAfter := outbound.RetryAfter(statusErr.RetryAfter, time.Now()); retryAfter > 0 {
			return s.clampBackoff(retryAfter)
		}
	}
	delay := s.backoff * time.Duration(attempt+1)
	return s.clampBackoff(delay)
}

func (s *DLsiteSyncer) clampBackoff(delay time.Duration) time.Duration {
	if delay <= 0 {
		return 0
	}
	if s.maxBackoff > 0 && delay > s.maxBackoff {
		return s.maxBackoff
	}
	return delay
}

func sleepWithContext(ctx context.Context, delay time.Duration) error {
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
