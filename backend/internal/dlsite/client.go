package dlsite

import (
	"context"
	"encoding/json"
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
)

type Client struct {
	httpClient *http.Client
	baseURL    string
	userAgent  string
}

type Product struct {
	WorkNo            string               `json:"workno"`
	ProductID         string               `json:"product_id"`
	SiteID            string               `json:"site_id"`
	SiteIDTouch       string               `json:"site_id_touch"`
	MakerID           string               `json:"maker_id"`
	MakerName         string               `json:"maker_name"`
	ProductName       string               `json:"product_name"`
	WorkName          string               `json:"work_name"`
	WorkNameKana      string               `json:"work_name_kana"`
	Intro             string               `json:"intro"`
	IntroShort        string               `json:"intro_s"`
	RegistDate        string               `json:"regist_date"`
	AgeCategoryString string               `json:"age_category_string"`
	WorkType          string               `json:"work_type"`
	WorkTypeString    string               `json:"work_type_string"`
	ImageMain         Image                `json:"image_main"`
	ImageThumb        Image                `json:"image_thum"`
	ImageThumbMini    Image                `json:"image_thum_mini"`
	Genres            []Genre              `json:"genres"`
	Creators          map[string][]Creator `json:"creaters"`
	TranslationInfo   TranslationInfo      `json:"translation_info"`
	Raw               json.RawMessage      `json:"-"`
	ProductRaw        json.RawMessage      `json:"-"`
	DynamicRaw        json.RawMessage      `json:"-"`
	RateAverage2DP    *float64             `json:"-"`
	Language          string               `json:"-"`
}

type TranslationInfo struct {
	OriginalWorkNo string `json:"original_workno"`
	ParentWorkNo   string `json:"parent_workno"`
	Lang           string `json:"lang"`
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

type MakerProfile struct {
	MakerID      string   `json:"maker_id"`
	MakerName    string   `json:"maker_name"`
	SiteID       string   `json:"site_id"`
	URL          string   `json:"url"`
	WorkCodes    []string `json:"work_codes"`
	RawHTML      string   `json:"raw_html"`
	PagesFetched int      `json:"pages_fetched"`
	ReachedEnd   bool     `json:"reached_end"`
	TotalWorks   int      `json:"total_works"`
}

type MakerCatalogOptions struct {
	Mode           string
	MaxPages       int
	KnownWorkCodes map[string]bool
	Delay          time.Duration
}

func NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{
		httpClient: httpClient,
		baseURL:    "https://www.dlsite.com",
		userAgent:  "Kikoto-dev/0.1",
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

	if err := os.MkdirAll(filepath.Join(cacheRoot, "cover"), 0o755); err != nil {
		return "", err
	}

	parsedURL, err := url.Parse(coverURL)
	if err != nil {
		return "", err
	}
	extension := filepath.Ext(parsedURL.Path)
	if extension == "" || len(extension) > 6 {
		extension = ".jpg"
	}
	relativePath := filepath.ToSlash(filepath.Join("cover", strings.ToUpper(product.WorkNo)+extension))
	targetPath := filepath.Join(cacheRoot, filepath.FromSlash(relativePath))

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
		return "", fmt.Errorf("cover download returned %s", response.Status)
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
		return Product{}, fmt.Errorf("dlsite %s returned %s", site, response.Status)
	}

	body, err := io.ReadAll(response.Body)
	if err != nil {
		return Product{}, err
	}

	var raws []json.RawMessage
	if err := json.Unmarshal(body, &raws); err != nil {
		return Product{}, err
	}
	if len(raws) == 0 {
		return Product{}, fmt.Errorf("dlsite %s returned no product for %s", site, workno)
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
		profile, err := c.fetchMakerProfilePageCandidates(ctx, site, makerID, page)
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
	return firstProfile, nil
}

func (c *Client) fetchMakerProfilePageCandidates(ctx context.Context, site string, makerID string, page int) (MakerProfile, error) {
	var lastErr error
	for _, endpoint := range makerProfileURLs(c.baseURL, site, makerID, page) {
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
		return MakerProfile{}, fmt.Errorf("dlsite maker %s returned %s", site, response.Status)
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
		return nil, nil, fmt.Errorf("dlsite dynamic returned %s", response.Status)
	}

	body, err := io.ReadAll(response.Body)
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
	titlePattern      = regexp.MustCompile(`(?is)<title[^>]*>(.*?)</title>`)
	workLinkPattern   = regexp.MustCompile(`(?is)<a\b[^>]*\bhref=["'][^"']*/work/=/product_id/((?:RJ|BJ|VJ)[0-9]{5,8})\.html[^"']*["'][^>]*>`)
	pageTotalPattern  = regexp.MustCompile(`(?is)class=["'][^"']*\bpage_total\b[^"']*["'][^>]*>(.*?)</div>`)
	numberTextPattern = regexp.MustCompile(`[0-9][0-9,]*`)
	pagePathPattern   = regexp.MustCompile(`(?i)/page/([0-9]+)/maker_id/`)
)

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
	title = strings.TrimSpace(strings.Join(strings.Fields(title), " "))
	return title
}

func parseWorkCodes(rawHTML string) []string {
	matches := workLinkPattern.FindAllStringSubmatch(rawHTML, -1)
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

func makerProfileURLs(baseURL string, site string, makerID string, page int) []string {
	endpoint := fmt.Sprintf("%s/%s/circle/profile/=/maker_id/%s.html", strings.TrimRight(baseURL, "/"), site, url.PathEscape(makerID))
	if page <= 1 {
		return []string{endpoint}
	}
	return []string{
		fmt.Sprintf("%s/%s/circle/profile/=/page/%d/maker_id/%s.html", strings.TrimRight(baseURL, "/"), site, page, url.PathEscape(makerID)),
	}
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
