package dlsite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/download"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

var ErrNoProduct = errors.New("dlsite product not found")

// IsTimeout distinguishes an exhausted request deadline from user cancellation.
func IsTimeout(err error) bool {
	var networkErr net.Error
	return errors.Is(err, context.DeadlineExceeded) || errors.Is(err, outbound.ErrResponseReadTimeout) || (errors.As(err, &networkErr) && networkErr.Timeout())
}

const maxDLsiteJSONBytes int64 = 8 << 20

type HTTPStatusError struct {
	Operation  string
	Status     string
	StatusCode int
	RetryAfter string
}

func (e HTTPStatusError) Error() string {
	if e.Operation != "" {
		return fmt.Sprintf("%s returned %s", e.Operation, e.Status)
	}
	return fmt.Sprintf("dlsite returned %s", e.Status)
}

func IsRetryableHTTPError(err error) bool {
	var statusErr HTTPStatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.StatusCode == http.StatusTooManyRequests ||
		statusErr.StatusCode == http.StatusBadGateway ||
		statusErr.StatusCode == http.StatusServiceUnavailable ||
		statusErr.StatusCode == http.StatusGatewayTimeout
}

type Client struct {
	httpClient *http.Client
	endpoints  Endpoints
	userAgent  string
}

type ProductOptions struct {
	Languages []string
}

func NewClient(httpClient *http.Client) *Client { return DefaultEndpoints().NewClient(httpClient) }

func (c *Client) FetchProduct(ctx context.Context, workno string) (Product, error) {
	return c.FetchProductWithOptions(ctx, workno, ProductOptions{})
}

// FetchProductWithLocale performs one request with the exact locale selected
// for an edition. Keeping this as a separate method lets the sync layer use
// exact matching without changing the compatibility fallback API.
func (c *Client) FetchProductWithLocale(ctx context.Context, workno string, locale string) (Product, error) {
	product, err := c.FetchProductWithOptions(ctx, workno, ProductOptions{Languages: []string{locale}})
	if err != nil {
		return Product{}, err
	}
	product.RequestLocale = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(locale, "_", "-")))
	product.Language = product.RequestLocale
	return product, nil
}

func (c *Client) FetchProductWithOptions(ctx context.Context, workno string, options ProductOptions) (Product, error) {
	workno = strings.ToUpper(strings.TrimSpace(workno))
	if workno == "" {
		return Product{}, fmt.Errorf("empty workno")
	}

	// ErrNoProduct is a durable observation: callers stop refreshing the work.
	// Report it only when every candidate site and locale answered with an
	// empty product list. A failed request proves nothing about the product, so
	// it outranks absence reported by a candidate that was never its home site.
	var lastErr, lastFailure error
	for _, site := range candidateSites(workno) {
		for _, language := range normalizeLanguages(options.Languages) {
			product, err := c.fetchProductFromSite(ctx, site, workno, language)
			if err == nil {
				product.Language = language
				product.RequestLocale = language
				return product, nil
			}
			lastErr = err
			if !errors.Is(err, ErrNoProduct) {
				lastFailure = err
			}
			if ctx.Err() != nil || IsTimeout(err) {
				return Product{}, err
			}
		}
	}

	if lastFailure != nil {
		return Product{}, lastFailure
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no candidate sites for %s", workno)
	}
	return Product{}, lastErr
}

func (c *Client) DownloadCover(ctx context.Context, product Product, cacheRoot string) (string, error) {
	coverURL := product.CoverURL()
	if coverURL == "" {
		return "", nil
	}

	parsedURL, err := url.Parse(coverURL)
	if err != nil {
		return "", err
	}
	extension := filepath.Ext(parsedURL.Path)
	if extension == "" || len(extension) > 6 {
		extension = ".jpg"
	}
	relativePath := coverCacheRelativePath(product.WorkNo, extension)
	targetPath := filepath.Join(cacheRoot, filepath.FromSlash(relativePath))
	if err := os.MkdirAll(filepath.Dir(targetPath), 0o755); err != nil {
		return "", err
	}

	request, err := http.NewRequestWithContext(ctx, http.MethodGet, coverURL, nil)
	if err != nil {
		return "", err
	}
	request.Header.Set("User-Agent", c.userAgent)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", HTTPStatusError{Operation: "cover download", Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}

	staging, err := os.MkdirTemp(filepath.Dir(targetPath), ".provider-cover-")
	if err != nil {
		return "", err
	}
	defer func() { _ = os.RemoveAll(staging) }()
	staged := filepath.Join(staging, filepath.Base(targetPath))
	if _, err := download.WriteFile(response.Body, response.ContentLength, staged, download.Options{MaxBytes: download.CoverMaxBytes}); err != nil {
		return "", err
	}
	if err := download.PublishCover(ctx, staged, targetPath, true); err != nil {
		return "", err
	}
	return relativePath, nil
}

func coverCacheRelativePath(workNo string, extension string) string {
	code := strings.ToUpper(strings.TrimSpace(workNo))
	if code == "" {
		code = "UNKNOWN"
	}
	if extension == "" {
		extension = ".jpg"
	}
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
	return filepath.ToSlash(filepath.Join("cover", prefix, group, code+extension))
}

func (p Product) CoverURL() string {
	for _, value := range []string{
		p.ImageMain.URL,
		p.ImageMain.ResizeURL,
		p.ImageThumb.URL,
		p.ImageThumb.ResizeURL,
		p.ImageThumbMini.URL,
		p.ImageThumbMini.ResizeURL,
	} {
		value = strings.TrimSpace(value)
		if value != "" {
			if strings.HasPrefix(value, "//") {
				return "https:" + value
			}
			return value
		}
	}
	return ""
}

func (c *Client) fetchProductFromSite(ctx context.Context, site string, workno string, language string) (Product, error) {
	endpoint := fmt.Sprintf("%s/%s/api/=/product.json?workno=%s", c.endpoints.webURL(), site, url.QueryEscape(workno))
	if language != "" {
		endpoint += "&locale=" + url.QueryEscape(language)
	}
	body, err := c.fetchProductBody(ctx, site, endpoint)
	if err != nil {
		return Product{}, err
	}
	product, err := decodeProductResponse(body, site, workno)
	if err != nil {
		return Product{}, err
	}
	if dynamicRaw, dynamic, err := c.fetchDynamic(ctx, product); err == nil {
		applyDynamicProductFields(&product, dynamicRaw, dynamic)
	} else if IsTimeout(err) || ctx.Err() != nil {
		return Product{}, err
	}
	return product, nil
}

func (c *Client) fetchProductBody(ctx context.Context, site, endpoint string) ([]byte, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", c.userAgent)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, HTTPStatusError{Operation: "dlsite " + site, Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}
	body, err := readLimitedBody(response.Body, maxDLsiteJSONBytes)
	if err != nil {
		return nil, err
	}
	return body, nil
}

func decodeProductResponse(body []byte, site, workno string) (Product, error) {
	var raws []json.RawMessage
	if err := json.Unmarshal(body, &raws); err != nil {
		return Product{}, err
	}
	if len(raws) == 0 {
		return Product{}, fmt.Errorf("%w: dlsite %s returned no product for %s", ErrNoProduct, site, workno)
	}

	var product Product
	if err := json.Unmarshal(raws[0], &product); err != nil {
		return Product{}, err
	}
	product.ProductRaw = raws[0]
	product.Raw = raws[0]
	if product.WorkNo == "" {
		product.WorkNo = product.ProductID
	}
	if product.WorkNo == "" {
		product.WorkNo = workno
	}
	if !strings.EqualFold(product.WorkNo, workno) {
		return Product{}, fmt.Errorf("dlsite %s returned %s for %s", site, product.WorkNo, workno)
	}
	return product, nil
}

func applyDynamicProductFields(product *Product, dynamicRaw json.RawMessage, dynamic dynamicProductMetadata) {
	product.DynamicRaw = dynamicRaw
	if dynamic.RateAverage2DP != nil {
		product.RateAverage2DP = dynamic.RateAverage2DP
	} else if dynamic.RateAverage != nil {
		product.RateAverage2DP = dynamic.RateAverage
	}
	if dynamic.SalesCount != nil {
		product.SalesCount = dynamic.SalesCount
	}
	if dynamic.RegularPrice != nil {
		product.RegularPrice = dynamic.RegularPrice
	}
	if dynamic.CurrentPrice != nil {
		product.CurrentPrice = dynamic.CurrentPrice
	}
	if dynamic.DiscountRate != nil {
		product.DiscountRate = dynamic.DiscountRate
	}
	if dynamic.IsDiscount != nil {
		product.IsDiscount = dynamic.IsDiscount
	}
	if dynamic.IsSale != nil {
		product.IsSale = dynamic.IsSale
	}
	if dynamic.IsFree != nil {
		product.IsFree = dynamic.IsFree
	}
	product.Raw = combinedRaw(product.ProductRaw, product.DynamicRaw)
}

type dynamicProductMetadata struct {
	RateAverage2DP *float64 `json:"rate_average_2dp"`
	RateAverage    *float64 `json:"rate_average"`
	SalesCount     *int64   `json:"dl_count"`
	RegularPrice   *int64   `json:"official_price"`
	CurrentPrice   *int64   `json:"price"`
	DiscountRate   *int64   `json:"discount_rate"`
	IsDiscount     *bool    `json:"is_discount"`
	IsSale         *bool    `json:"is_sale"`
	IsFree         *bool    `json:"is_free"`
}

func (c *Client) fetchDynamic(ctx context.Context, product Product) (json.RawMessage, dynamicProductMetadata, error) {
	site := product.SiteID
	if site == "" {
		if strings.HasPrefix(product.WorkNo, "VJ") {
			site = "pro"
		} else {
			site = "maniax-touch"
		}
	}
	if site == "maniax" {
		site = "maniax-touch"
	}

	endpoint := fmt.Sprintf("%s/%s/product/info/ajax?product_id=%s", c.endpoints.webURL(), site, url.QueryEscape(product.WorkNo))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, dynamicProductMetadata{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", c.userAgent)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, dynamicProductMetadata{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, dynamicProductMetadata{}, HTTPStatusError{Operation: "dlsite dynamic", Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}

	body, err := readLimitedBody(response.Body, maxDLsiteJSONBytes)
	if err != nil {
		return nil, dynamicProductMetadata{}, err
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, dynamicProductMetadata{}, err
	}
	raw, ok := payload[product.WorkNo]
	if !ok {
		return nil, dynamicProductMetadata{}, fmt.Errorf("dynamic metadata missing %s", product.WorkNo)
	}

	var dynamic dynamicProductMetadata
	if err := json.Unmarshal(raw, &dynamic); err != nil {
		return nil, dynamicProductMetadata{}, err
	}
	return raw, dynamic, nil
}

func readLimitedBody(body io.Reader, maxBytes int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("response body exceeds %d bytes", maxBytes)
	}
	return data, nil
}

func combinedRaw(productRaw json.RawMessage, dynamicRaw json.RawMessage) json.RawMessage {
	value, err := json.Marshal(map[string]json.RawMessage{
		"product": productRaw,
		"dynamic": dynamicRaw,
	})
	if err != nil {
		return productRaw
	}
	return value
}

func candidateSites(workno string) []string {
	switch {
	case strings.HasPrefix(workno, "VJ"):
		return []string{"pro", "maniax"}
	case strings.HasPrefix(workno, "RJ"), strings.HasPrefix(workno, "BJ"):
		return []string{"maniax", "pro"}
	default:
		return []string{"maniax", "pro"}
	}
}

func normalizeLanguages(values []string) []string {
	seen := map[string]bool{}
	languages := []string{}
	includeDefault := false
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(strings.ReplaceAll(value, "_", "-")))
		if value == OriginMetadataLanguage {
			// `origin` is a display-priority token, not a DLsite locale.
			includeDefault = true
			continue
		}
		if value == "" {
			includeDefault = true
			continue
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		languages = append(languages, value)
	}
	if len(languages) == 0 {
		return []string{""}
	}
	if includeDefault {
		languages = append(languages, "")
	}
	return languages
}

// SplitWorkCode splits a DLsite work code such as RJ00000000 into its
// upper-case prefix and number.
func SplitWorkCode(code string) (string, int64, bool) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if len(code) < 3 {
		return "", 0, false
	}
	number, err := strconv.ParseInt(code[2:], 10, 64)
	if err != nil || number < 0 || code[0] < 'A' || code[0] > 'Z' || code[1] < 'A' || code[1] > 'Z' {
		return "", 0, false
	}
	return code[:2], number, true
}
