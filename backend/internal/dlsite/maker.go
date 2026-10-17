package dlsite

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

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
	// StopBelowCode ends paging after the first page listing a work code with
	// the same prefix and a lower number. Profile pages list newer works
	// first, so the codes around StopBelowCode have been seen by then.
	StopBelowCode string
	// SkipSeries leaves the maker's series catalogs unrequested.
	SkipSeries bool
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

func (c *Client) fetchMakerCatalogFromSite(ctx context.Context, site string, makerID string, options MakerCatalogOptions) (MakerProfile, error) {
	state := makerCatalogPageState{allCodes: []string{}, seenCodes: map[string]bool{}}
	knownCodes := normalizeCodeSet(options.KnownWorkCodes)
	mode := strings.ToLower(strings.TrimSpace(options.Mode))
	if mode == "" {
		mode = "incremental"
	}
	maxPages := options.MaxPages
	languages := normalizeMakerCatalogLanguages(options.Languages)
	for page := 1; page <= maxPages; page++ {
		if page > 1 && options.Delay > 0 {
			if err := waitMakerCatalogDelay(ctx, options.Delay); err != nil {
				return MakerProfile{}, err
			}
		}
		profile, err := c.fetchMakerProfilePageCandidates(ctx, site, makerID, page, languages)
		if err != nil {
			if page > 1 && len(state.allCodes) > 0 {
				state.reachedEnd = true
				break
			}
			return MakerProfile{}, err
		}
		if page == 1 {
			state.firstProfile = profile
			state.firstRaw = profile.RawHTML
			if mode == "full" {
				maxPages = makerCatalogPageLimit(profile, maxPages)
			}
		}
		state.pagesFetched++
		pageNew := state.appendPageCodes(profile.WorkCodes, knownCodes, mode)
		if len(profile.WorkCodes) == 0 || pageNew == 0 {
			state.reachedEnd = true
			break
		}
		if state.reachedEnd || pageListsCodeBelow(profile.WorkCodes, options.StopBelowCode) {
			break
		}
	}
	if state.pagesFetched == 0 {
		return MakerProfile{}, fmt.Errorf("dlsite maker returned no pages")
	}
	state.firstProfile.WorkCodes = state.allCodes
	state.firstProfile.RawHTML = state.firstRaw
	state.firstProfile.PagesFetched = state.pagesFetched
	state.firstProfile.ReachedEnd = state.reachedEnd
	if !options.SkipSeries {
		state.firstProfile.Series = c.fetchMakerSeriesCatalogs(ctx, state.firstProfile.Series, languages)
	}
	return state.firstProfile, nil
}

type makerCatalogPageState struct {
	allCodes     []string
	seenCodes    map[string]bool
	firstProfile MakerProfile
	firstRaw     string
	pagesFetched int
	reachedEnd   bool
}

func waitMakerCatalogDelay(ctx context.Context, delay time.Duration) error {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

func makerCatalogPageLimit(profile MakerProfile, currentLimit int) int {
	pageTotal := pagesFromTotal(profile.TotalWorks, 50)
	pageNoTotal := parsePageNoMax(profile.RawHTML)
	if pageNoTotal > pageTotal {
		pageTotal = pageNoTotal
	}
	if pageTotal > 0 && pageTotal < currentLimit {
		return pageTotal
	}
	return currentLimit
}

func (state *makerCatalogPageState) appendPageCodes(codes []string, knownCodes map[string]bool, mode string) int {
	pageCodes := codes
	if mode != "full" {
		if beforeKnown, foundKnown := codesBeforeFirstKnown(pageCodes, knownCodes); foundKnown {
			pageCodes = beforeKnown
			state.reachedEnd = true
		}
	}
	pageNew := 0
	for _, code := range pageCodes {
		if state.seenCodes[code] {
			continue
		}
		state.seenCodes[code] = true
		state.allCodes = append(state.allCodes, code)
		pageNew++
	}
	return pageNew
}

func (c *Client) fetchMakerProfilePageCandidates(ctx context.Context, site string, makerID string, page int, languages []string) (MakerProfile, error) {
	var lastErr error
	for _, endpoint := range makerProfileURLs(c.endpoints.webURL(), site, makerID, page, languages) {
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
	defer func() { _ = response.Body.Close() }()
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
		Series:       parseMakerSeries(rawHTML, c.endpoints),
		RawHTML:      rawHTML,
		PagesFetched: 1,
		TotalWorks:   parsePageTotal(rawHTML),
	}, nil
}

func candidateMakerSites(makerID string) []string {
	switch {
	case strings.HasPrefix(makerID, "VG"):
		return []string{"pro", "maniax"}
	default:
		return []string{"maniax", "pro"}
	}
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
	defer func() { _ = response.Body.Close() }()
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

func pageListsCodeBelow(codes []string, limit string) bool {
	limitPrefix, limitNumber, ok := SplitWorkCode(limit)
	if !ok {
		return false
	}
	for _, code := range codes {
		prefix, number, ok := SplitWorkCode(code)
		if ok && prefix == limitPrefix && number < limitNumber {
			return true
		}
	}
	return false
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

func pagesFromTotal(total int, perPage int) int {
	if total <= 0 || perPage <= 0 {
		return 0
	}
	return (total + perPage - 1) / perPage
}
