package dlsite

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
)

var ErrNoProduct = errors.New("dlsite product not found")

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

func RetryAfterDuration(value string) time.Duration {
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

type Client struct {
	httpClient *http.Client
	baseURL    string
	userAgent  string
}

type Product struct {
	WorkNo            string            `json:"workno"`
	ProductID         string            `json:"product_id"`
	SiteID            string            `json:"site_id"`
	SiteIDTouch       string            `json:"site_id_touch"`
	MakerID           string            `json:"maker_id"`
	MakerName         string            `json:"maker_name"`
	ProductName       string            `json:"product_name"`
	WorkName          string            `json:"work_name"`
	WorkNameKana      string            `json:"work_name_kana"`
	Intro             string            `json:"intro"`
	IntroShort        string            `json:"intro_s"`
	RegistDate        string            `json:"regist_date"`
	AgeCategoryString string            `json:"age_category_string"`
	WorkType          string            `json:"work_type"`
	WorkTypeString    string            `json:"work_type_string"`
	ImageMain         Image             `json:"image_main"`
	ImageThumb        Image             `json:"image_thum"`
	ImageThumbMini    Image             `json:"image_thum_mini"`
	Genres            []Genre           `json:"genres"`
	Creators          Creators          `json:"creaters"`
	TranslationInfo   TranslationInfo   `json:"translation_info"`
	LanguageEditions  []LanguageEdition `json:"language_editions"`
	Raw               json.RawMessage   `json:"-"`
	ProductRaw        json.RawMessage   `json:"-"`
	DynamicRaw        json.RawMessage   `json:"-"`
	RateAverage2DP    *float64          `json:"-"`
	Language          string            `json:"-"`
}

type TranslationInfo struct {
	OriginalWorkNo string `json:"original_workno"`
	ParentWorkNo   string `json:"parent_workno"`
	Lang           string `json:"lang"`
}

type LanguageEdition struct {
	WorkNo       string `json:"workno"`
	EditionID    int64  `json:"edition_id"`
	EditionType  string `json:"edition_type"`
	DisplayOrder int    `json:"display_order"`
	Label        string `json:"label"`
	Lang         string `json:"lang"`
}

type ProductOptions struct {
	Languages []string
}

type Image struct {
	URL         string `json:"url"`
	ResizeURL   string `json:"resize_url"`
	RelativeURL string `json:"relative_url"`
}

type Genre struct {
	Name     string `json:"name"`
	NameBase string `json:"name_base"`
}

type Creator struct {
	Name           string `json:"name"`
	Classification string `json:"classification"`
}

type Creators map[string][]Creator

func (c *Creators) UnmarshalJSON(data []byte) error {
	var grouped map[string][]Creator
	if err := json.Unmarshal(data, &grouped); err == nil {
		*c = grouped
		return nil
	}
	var flat []Creator
	if err := json.Unmarshal(data, &flat); err != nil {
		return err
	}
	grouped = map[string][]Creator{}
	for _, creator := range flat {
		classification := strings.TrimSpace(creator.Classification)
		if classification == "" {
			classification = "unknown"
		}
		grouped[classification] = append(grouped[classification], creator)
	}
	*c = grouped
	return nil
}

type MakerProfile struct {
	MakerID      string        `json:"maker_id"`
	MakerName    string        `json:"maker_name"`
	SiteID       string        `json:"site_id"`
	URL          string        `json:"url"`
	WorkCodes    []string      `json:"work_codes"`
	Series       []MakerSeries `json:"series"`
	RawHTML      string        `json:"raw_html"`
	PagesFetched int           `json:"pages_fetched"`
	ReachedEnd   bool          `json:"reached_end"`
	TotalWorks   int           `json:"total_works"`
}

type MakerSeries struct {
	TitleID   string   `json:"title_id"`
	Name      string   `json:"name"`
	URL       string   `json:"url"`
	WorkCount int      `json:"work_count"`
	WorkCodes []string `json:"work_codes"`
}

type MakerCatalogOptions struct {
	Mode           string
	MaxPages       int
	KnownWorkCodes map[string]bool
	Delay          time.Duration
	Languages      []string
}

type RankingOptions struct {
	Period        string
	ReleaseWindow string
	Year          int
}

type RankingResult struct {
	Period        string   `json:"period"`
	ReleaseWindow string   `json:"releaseWindow"`
	Year          int      `json:"year"`
	WorkCodes     []string `json:"workCodes"`
}

func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{
		httpClient: httpClient,
		baseURL:    "https://www.dlsite.com",
		userAgent:  buildinfo.UserAgent,
	}
}

func (c *Client) FetchProduct(ctx context.Context, workno string) (Product, error) {
	return c.FetchProductWithOptions(ctx, workno, ProductOptions{})
}

func (c *Client) FetchProductWithOptions(ctx context.Context, workno string, options ProductOptions) (Product, error) {
	workno = strings.ToUpper(strings.TrimSpace(workno))
	if workno == "" {
		return Product{}, fmt.Errorf("empty workno")
	}

	var lastErr error
	for _, site := range candidateSites(workno) {
		for _, language := range normalizeLanguages(options.Languages) {
			product, err := c.fetchProductFromSite(ctx, site, workno, language)
			if err == nil {
				product.Language = language
				return product, nil
			}
			lastErr = err
		}
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("no candidate sites for %s", workno)
	}
	return Product{}, lastErr
}

func (c *Client) FetchMakerProfile(ctx context.Context, makerID string) (MakerProfile, error) {
	return c.FetchMakerCatalog(ctx, makerID, MakerCatalogOptions{Mode: "incremental"})
}

func (c *Client) FetchVoiceRanking(ctx context.Context, options RankingOptions) (RankingResult, error) {
	period := strings.ToLower(strings.TrimSpace(options.Period))
	switch period {
	case "day", "week", "month", "year":
	default:
		return RankingResult{}, fmt.Errorf("unsupported DLsite ranking period %q", options.Period)
	}
	releaseWindow := strings.ToLower(strings.TrimSpace(options.ReleaseWindow))
	if period == "year" {
		releaseWindow = ""
	} else if releaseWindow != "" && releaseWindow != "30d" {
		return RankingResult{}, fmt.Errorf("unsupported DLsite ranking release window %q", options.ReleaseWindow)
	}
	if period == "year" {
		currentYear := time.Now().UTC().Year()
		if options.Year < 2000 || options.Year > currentYear {
			return RankingResult{}, fmt.Errorf("DLsite ranking year must be between 2000 and %d", currentYear)
		}
	} else if options.Year != 0 {
		return RankingResult{}, fmt.Errorf("DLsite ranking year is only valid for annual rankings")
	}

	params := url.Values{"category": []string{"voice"}}
	if releaseWindow != "" {
		params.Set("date", releaseWindow)
	}
	if period == "year" {
		params.Set("year", strconv.Itoa(options.Year))
	}
	endpoint := fmt.Sprintf("%s/maniax/ranking/%s?%s", strings.TrimRight(c.baseURL, "/"), period, params.Encode())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return RankingResult{}, err
	}
	request.Header.Set("Accept", "text/html")
	request.Header.Set("Accept-Language", "ja,en;q=0.8")
	request.Header.Set("User-Agent", c.userAgent)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return RankingResult{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return RankingResult{}, HTTPStatusError{Operation: "dlsite ranking", Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return RankingResult{}, err
	}
	codes := parseRankingWorkCodes(string(body))
	if len(codes) == 0 {
		return RankingResult{}, fmt.Errorf("DLsite ranking returned no voice works")
	}
	return RankingResult{Period: period, ReleaseWindow: releaseWindow, Year: options.Year, WorkCodes: codes}, nil
}

func (c *Client) FetchMakerCatalog(ctx context.Context, makerID string, options MakerCatalogOptions) (MakerProfile, error) {
	makerID = strings.ToUpper(strings.TrimSpace(makerID))
	if makerID == "" {
		return MakerProfile{}, fmt.Errorf("empty maker id")
	}
	if options.MaxPages <= 0 {
		options.MaxPages = 1
	}
	if strings.ToLower(strings.TrimSpace(options.Mode)) == "full" && options.MaxPages < 1000 {
		options.MaxPages = 100
	}
	var lastErr error
	for _, site := range candidateMakerSites(makerID) {
		profile, err := c.fetchMakerCatalogFromSite(ctx, site, makerID, options)
		if err == nil {
			return profile, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no candidate sites for %s", makerID)
	}
	return MakerProfile{}, lastErr
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

	file, err := os.Create(targetPath)
	if err != nil {
		return "", err
	}
	defer file.Close()

	if _, err := io.Copy(file, response.Body); err != nil {
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
	endpoint := fmt.Sprintf("%s/%s/api/=/product.json?workno=%s", strings.TrimRight(c.baseURL, "/"), site, url.QueryEscape(workno))
	if language != "" {
		endpoint += "&locale=" + url.QueryEscape(language)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return Product{}, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", c.userAgent)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return Product{}, err
	}
	defer response.Body.Close()

	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return Product{}, HTTPStatusError{Operation: "dlsite " + site, Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}

	body, err := readLimitedBody(response.Body, maxDLsiteJSONBytes)
	if err != nil {
		return Product{}, err
	}

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
	if dynamicRaw, rating, err := c.fetchDynamic(ctx, product); err == nil {
		product.DynamicRaw = dynamicRaw
		product.RateAverage2DP = rating
		product.Raw = combinedRaw(product.ProductRaw, product.DynamicRaw)
	}
	return product, nil
}

func (c *Client) fetchMakerCatalogFromSite(ctx context.Context, site string, makerID string, options MakerCatalogOptions) (MakerProfile, error) {
	allCodes := []string{}
	seenCodes := map[string]bool{}
	var firstProfile MakerProfile
	var firstRaw string
	pagesFetched := 0
	reachedEnd := false
	knownCodes := normalizeCodeSet(options.KnownWorkCodes)
	mode := strings.ToLower(strings.TrimSpace(options.Mode))
	if mode == "" {
		mode = "incremental"
	}
	maxPages := options.MaxPages
	languages := normalizeMakerCatalogLanguages(options.Languages)
	for page := 1; page <= maxPages; page++ {
		if page > 1 && options.Delay > 0 {
			timer := time.NewTimer(options.Delay)
			select {
			case <-ctx.Done():
				timer.Stop()
				return MakerProfile{}, ctx.Err()
			case <-timer.C:
			}
		}
		profile, err := c.fetchMakerProfilePageCandidates(ctx, site, makerID, page, languages)
		if err != nil {
			if page > 1 && len(allCodes) > 0 {
				reachedEnd = true
				break
			}
			return MakerProfile{}, err
		}
		if page == 1 {
			firstProfile = profile
			firstRaw = profile.RawHTML
			if mode == "full" {
				pageTotal := pagesFromTotal(profile.TotalWorks, 50)
				pageNoTotal := parsePageNoMax(profile.RawHTML)
				if pageNoTotal > pageTotal {
					pageTotal = pageNoTotal
				}
				if pageTotal > 0 && pageTotal < maxPages {
					maxPages = pageTotal
				}
			}
		}
		pagesFetched++
		pageNew := 0
		pageCodes := profile.WorkCodes
		if mode != "full" {
			if beforeKnown, foundKnown := codesBeforeFirstKnown(pageCodes, knownCodes); foundKnown {
				pageCodes = beforeKnown
				reachedEnd = true
			}
		}
		for _, code := range pageCodes {
			if seenCodes[code] {
				continue
			}
			seenCodes[code] = true
			allCodes = append(allCodes, code)
			pageNew++
		}
		if len(profile.WorkCodes) == 0 || pageNew == 0 {
			reachedEnd = true
			break
		}
		if reachedEnd {
			break
		}
	}
	if pagesFetched == 0 {
		return MakerProfile{}, fmt.Errorf("dlsite maker returned no pages")
	}
	firstProfile.WorkCodes = allCodes
	firstProfile.RawHTML = firstRaw
	firstProfile.PagesFetched = pagesFetched
	firstProfile.ReachedEnd = reachedEnd
	firstProfile.Series = c.fetchMakerSeriesCatalogs(ctx, firstProfile.Series, languages)
	return firstProfile, nil
}

func (c *Client) fetchMakerProfilePageCandidates(ctx context.Context, site string, makerID string, page int, languages []string) (MakerProfile, error) {
	var lastErr error
	for _, endpoint := range makerProfileURLs(c.baseURL, site, makerID, page, languages) {
		profile, err := c.fetchMakerProfilePage(ctx, site, makerID, endpoint)
		if err == nil {
			return profile, nil
		}
		lastErr = err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("no maker profile URL candidates")
	}
	return MakerProfile{}, lastErr
}

func (c *Client) fetchMakerProfilePage(ctx context.Context, site string, makerID string, endpoint string) (MakerProfile, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return MakerProfile{}, err
	}
	request.Header.Set("Accept", "text/html")
	request.Header.Set("User-Agent", c.userAgent)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return MakerProfile{}, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return MakerProfile{}, HTTPStatusError{Operation: "dlsite maker " + site, Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return MakerProfile{}, err
	}
	rawHTML := string(body)
	return MakerProfile{
		MakerID:      makerID,
		MakerName:    parseMakerName(rawHTML),
		SiteID:       site,
		URL:          endpoint,
		WorkCodes:    parseWorkCodes(rawHTML),
		Series:       parseMakerSeries(rawHTML),
		RawHTML:      rawHTML,
		PagesFetched: 1,
		TotalWorks:   parsePageTotal(rawHTML),
	}, nil
}

func (c *Client) fetchDynamic(ctx context.Context, product Product) (json.RawMessage, *float64, error) {
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

	endpoint := fmt.Sprintf("%s/%s/product/info/ajax?product_id=%s", strings.TrimRight(c.baseURL, "/"), site, url.QueryEscape(product.WorkNo))
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, nil, err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", c.userAgent)

	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, nil, HTTPStatusError{Operation: "dlsite dynamic", Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}

	body, err := readLimitedBody(response.Body, maxDLsiteJSONBytes)
	if err != nil {
		return nil, nil, err
	}
	var payload map[string]json.RawMessage
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, nil, err
	}
	raw, ok := payload[product.WorkNo]
	if !ok {
		return nil, nil, fmt.Errorf("dynamic metadata missing %s", product.WorkNo)
	}

	var dynamic struct {
		RateAverage2DP *float64 `json:"rate_average_2dp"`
		RateAverage    *float64 `json:"rate_average"`
	}
	if err := json.Unmarshal(raw, &dynamic); err != nil {
		return nil, nil, err
	}
	rating := dynamic.RateAverage2DP
	if rating == nil {
		rating = dynamic.RateAverage
	}
	return raw, rating, nil
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
	for _, value := range values {
		value = strings.ToLower(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		languages = append(languages, value)
	}
	if len(languages) == 0 {
		return []string{""}
	}
	return languages
}

func candidateMakerSites(makerID string) []string {
	switch {
	case strings.HasPrefix(makerID, "VG"):
		return []string{"pro", "maniax"}
	default:
		return []string{"maniax", "pro"}
	}
}

var (
	titlePattern          = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	workLinkPattern       = regexp.MustCompile(`(?is)<a\b[^>]*\bhref=["'][^"']*/work/=/product_id/((?:RJ|BJ|VJ)[0-9]{5,8})\.html[^"']*["'][^>]*>`)
	rankingWorkPattern    = regexp.MustCompile(`(?is)<(?:dl|li|div)\b[^>]*\bclass=["'][^"']*\bwork_1col\b[^"']*["'][^>]*>.*?<a\b[^>]*\bhref=["'][^"']*/work/=/product_id/((?:RJ|BJ|VJ)[0-9]{5,8})\.html[^"']*["']`)
	seriesLinkPattern     = regexp.MustCompile(`(?is)<a\b[^>]*\bhref=["']([^"']*/fsr/=/title_id/(SRI[0-9]+)/[^"']*)["'][^>]*>(.*?)</a>`)
	pageTotalPattern      = regexp.MustCompile(`(?is)class=["'][^"']*\bpage_total\b[^"']*["'][^>]*>(.*?)</div>`)
	numberTextPattern     = regexp.MustCompile(`[0-9][0-9,]*`)
	pagePathPattern       = regexp.MustCompile(`(?i)/page/([0-9]+)/maker_id/`)
	defaultMakerLanguages = []string{"JPN", "ENG", "CHI_HANS", "CHI_HANT", "KO_KR", "SPA", "GER", "FRE", "IND", "ITA", "POR", "SWE", "THA", "VIE", "OTL", "NM"}
)

func parseRankingWorkCodes(rawHTML string) []string {
	codes := make([]string, 0, 100)
	seen := map[string]bool{}
	for _, match := range rankingWorkPattern.FindAllStringSubmatch(rawHTML, -1) {
		if len(match) < 2 {
			continue
		}
		code := strings.ToUpper(strings.TrimSpace(match[1]))
		if code == "" || seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
	}
	return codes
}

func parseMakerName(rawHTML string) string {
	match := titlePattern.FindStringSubmatch(rawHTML)
	if len(match) < 2 {
		return ""
	}
	title := html.UnescapeString(stripTags(match[1]))
	for _, separator := range []string{"|", "｜", " - ", " / "} {
		if index := strings.Index(title, separator); index > 0 {
			title = title[:index]
		}
	}
	for _, suffix := range []string{"サークルプロフィール", "Circle Profile"} {
		title = strings.TrimSuffix(strings.TrimSpace(title), suffix)
	}
	title = strings.TrimSpace(strings.Join(strings.Fields(title), " "))
	return title
}

func parseWorkCodes(rawHTML string) []string {
	searchSpace := makerWorkListSearchSpace(rawHTML)
	matches := workLinkPattern.FindAllStringSubmatch(searchSpace, -1)
	seen := map[string]bool{}
	codes := []string{}
	for _, match := range matches {
		if len(match) < 2 {
			continue
		}
		code := strings.ToUpper(strings.TrimSpace(match[1]))
		if seen[code] {
			continue
		}
		seen[code] = true
		codes = append(codes, code)
	}
	return codes
}

func parseMakerSeries(rawHTML string) []MakerSeries {
	searchSpace := rawHTML
	if start := strings.Index(rawHTML, `class="prof_work_series"`); start >= 0 {
		searchSpace = rawHTML[start:]
		if end := strings.Index(searchSpace, `</td>`); end > 0 {
			searchSpace = searchSpace[:end]
		}
	}
	matches := seriesLinkPattern.FindAllStringSubmatch(searchSpace, -1)
	seen := map[string]bool{}
	series := []MakerSeries{}
	for _, match := range matches {
		if len(match) < 4 {
			continue
		}
		titleID := strings.ToUpper(strings.TrimSpace(match[2]))
		if titleID == "" || seen[titleID] {
			continue
		}
		seen[titleID] = true
		label := strings.TrimSpace(strings.Join(strings.Fields(html.UnescapeString(stripTags(match[3]))), " "))
		name := cleanSeriesName(label)
		series = append(series, MakerSeries{
			TitleID:   titleID,
			Name:      name,
			URL:       normalizeDLsiteURL(match[1]),
			WorkCount: parseSeriesWorkCount(label),
		})
	}
	return series
}

func cleanSeriesName(label string) string {
	name := strings.TrimSpace(label)
	if index := strings.LastIndex(name, "（"); index > 0 {
		name = strings.TrimSpace(name[:index])
	} else if index := strings.LastIndex(name, "("); index > 0 {
		name = strings.TrimSpace(name[:index])
	}
	name = strings.TrimSuffix(strings.TrimSpace(name), "シリーズ")
	name = strings.Trim(name, "「」\"'")
	return strings.TrimSpace(name)
}

func parseSeriesWorkCount(label string) int {
	matches := numberTextPattern.FindAllString(label, -1)
	if len(matches) == 0 {
		return 0
	}
	value, _ := strconv.Atoi(strings.ReplaceAll(matches[len(matches)-1], ",", ""))
	return value
}

func makerWorkListSearchSpace(rawHTML string) string {
	start := strings.Index(rawHTML, `id="search_result_list"`)
	if start < 0 {
		start = strings.Index(rawHTML, `class="n_worklist"`)
	}
	if start < 0 {
		return rawHTML
	}
	searchSpace := rawHTML[start:]
	end := len(searchSpace)
	for _, marker := range []string{
		`id="work_related"`,
		`class="work_related"`,
		`class="recommend"`,
		`id="ranking"`,
		`class="page_navi"`,
		`id="footer"`,
	} {
		if index := strings.Index(searchSpace, marker); index > 0 && index < end {
			end = index
		}
	}
	return searchSpace[:end]
}

func normalizeDLsiteURL(raw string) string {
	raw = strings.TrimSpace(html.UnescapeString(raw))
	if strings.HasPrefix(raw, "//") {
		return "https:" + raw
	}
	if strings.HasPrefix(raw, "/") {
		return "https://www.dlsite.com" + raw
	}
	return raw
}

func (c *Client) fetchMakerSeriesCatalogs(ctx context.Context, series []MakerSeries, languages []string) []MakerSeries {
	for index := range series {
		catalog, err := c.fetchMakerSeriesCatalog(ctx, series[index], languages)
		if err == nil {
			series[index].WorkCodes = catalog
		}
	}
	return series
}

func (c *Client) fetchMakerSeriesCatalog(ctx context.Context, series MakerSeries, languages []string) ([]string, error) {
	endpoint := series.URL
	if endpoint == "" {
		return nil, fmt.Errorf("empty series URL")
	}
	endpoint += makerLanguageOptionsPath(languages)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "text/html")
	request.Header.Set("User-Agent", c.userAgent)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, HTTPStatusError{Operation: "dlsite series " + series.TitleID, Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}
	return parseWorkCodes(string(body)), nil
}

func makerProfileURLs(baseURL string, site string, makerID string, page int, languages []string) []string {
	optionsPath := makerLanguageOptionsPath(languages)
	endpoint := fmt.Sprintf("%s/%s/circle/profile/=/maker_id/%s.html%s", strings.TrimRight(baseURL, "/"), site, url.PathEscape(makerID), optionsPath)
	if page <= 1 {
		return []string{endpoint}
	}
	return []string{
		fmt.Sprintf("%s/%s/circle/profile/=/page/%d/maker_id/%s.html%s", strings.TrimRight(baseURL, "/"), site, page, url.PathEscape(makerID), optionsPath),
	}
}

func normalizeMakerCatalogLanguages(values []string) []string {
	if len(values) == 0 {
		return append([]string{}, defaultMakerLanguages...)
	}
	seen := map[string]bool{}
	languages := []string{}
	for _, value := range values {
		value = strings.ToUpper(strings.TrimSpace(value))
		if value == "" || seen[value] {
			continue
		}
		seen[value] = true
		languages = append(languages, value)
	}
	if len(languages) == 0 {
		return append([]string{}, defaultMakerLanguages...)
	}
	return languages
}

func makerLanguageOptionsPath(languages []string) string {
	languages = normalizeMakerCatalogLanguages(languages)
	var builder strings.Builder
	for index, language := range languages {
		builder.WriteString("/options[")
		builder.WriteString(strconv.Itoa(index))
		builder.WriteString("]/")
		builder.WriteString(url.PathEscape(language))
	}
	return builder.String()
}

func normalizeCodeSet(codes map[string]bool) map[string]bool {
	result := map[string]bool{}
	for code, enabled := range codes {
		if !enabled {
			continue
		}
		code = strings.ToUpper(strings.TrimSpace(code))
		if code != "" {
			result[code] = true
		}
	}
	return result
}

func codesBeforeFirstKnown(codes []string, known map[string]bool) ([]string, bool) {
	if len(known) == 0 {
		return codes, false
	}
	for index, code := range codes {
		if known[strings.ToUpper(strings.TrimSpace(code))] {
			return codes[:index], true
		}
	}
	return codes, false
}

func parsePageTotal(rawHTML string) int {
	match := pageTotalPattern.FindStringSubmatch(rawHTML)
	if len(match) < 2 {
		return 0
	}
	text := html.UnescapeString(stripTags(match[1]))
	value := strings.ReplaceAll(numberTextPattern.FindString(text), ",", "")
	if value == "" {
		return 0
	}
	total, _ := strconv.Atoi(value)
	return total
}

func parsePageNoMax(rawHTML string) int {
	maxPage := 0
	for _, match := range pagePathPattern.FindAllStringSubmatch(rawHTML, -1) {
		if len(match) < 2 {
			continue
		}
		page, _ := strconv.Atoi(match[1])
		if page > maxPage {
			maxPage = page
		}
	}
	return maxPage
}

func pagesFromTotal(total int, perPage int) int {
	if total <= 0 || perPage <= 0 {
		return 0
	}
	return (total + perPage - 1) / perPage
}

func stripTags(value string) string {
	var builder strings.Builder
	inTag := false
	for _, char := range value {
		switch char {
		case '<':
			inTag = true
		case '>':
			inTag = false
		default:
			if !inTag {
				builder.WriteRune(char)
			}
		}
	}
	return builder.String()
}
