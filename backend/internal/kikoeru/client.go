package kikoeru

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/outbound"
	"github.com/yexca/kikoto/backend/internal/workcode"
)

type Client struct {
	baseURL          string
	httpClient       *http.Client
	compatibility    string
	acceptLanguage   string
	maxResponseBytes int64
}

// StatusError reports a non-2xx response without exposing its body.
type StatusError struct{ Code int }

func (err StatusError) Error() string { return fmt.Sprintf("remote source returned HTTP %d", err.Code) }

// IsNotFound reports whether the source answered that a resource is missing.
func IsNotFound(err error) bool {
	var status StatusError
	return errors.As(err, &status) && status.Code == http.StatusNotFound
}

// ErrWorkNotFound reports that the source listed its works and none carries
// the requested code. A listing that could not be read is not this error.
var ErrWorkNotFound = errors.New("remote source has no matching work")

// ErrResponseTooLarge reports a response body above the client's bound.
var ErrResponseTooLarge = errors.New("remote source response is too large")

type clientPolicyErrorTransport struct {
	err error
}

const CompatibilityNumber178 = "number178"
const maxKikoeruJSONBytes int64 = 32 << 20

type Work struct {
	ID                    int64                  `json:"id"`
	Title                 string                 `json:"title"`
	Name                  string                 `json:"name"`
	SourceID              string                 `json:"source_id"`
	SourceType            string                 `json:"source_type"`
	SourceURL             string                 `json:"source_url"`
	Release               string                 `json:"release"`
	AgeCategoryString     string                 `json:"age_category_string"`
	NSFW                  bool                   `json:"nsfw"`
	Duration              *float64               `json:"duration"`
	MainCoverURL          string                 `json:"mainCoverUrl"`
	SamCoverURL           string                 `json:"samCoverUrl"`
	ThumbnailCoverURL     string                 `json:"thumbnailCoverUrl"`
	Circle                *Circle                `json:"circle"`
	Tags                  []Tag                  `json:"tags"`
	VAs                   []VA                   `json:"vas"`
	RateAverage2DP        *float64               `json:"rate_average_2dp"`
	ReviewCount           *int64                 `json:"review_count"`
	DLCount               *int64                 `json:"dl_count"`
	Price                 *int64                 `json:"price"`
	OriginalWorkNumber    string                 `json:"original_workno"`
	OriginalWorkID        int64                  `json:"original_work_id"`
	LanguageEditions      LanguageEditionList    `json:"language_editions"`
	OtherLanguageEditions []OtherLanguageEdition `json:"other_language_editions_in_db"`
}

type LanguageEdition struct {
	WorkNo       string `json:"workno"`
	Language     string `json:"lang"`
	Label        string `json:"label"`
	DisplayOrder int    `json:"display_order"`
}

// OtherLanguageEdition is a sibling edition confirmed to exist in the
// compatible source's own database. LanguageEditions only describes the
// provider family and is not an availability signal.
type OtherLanguageEdition struct {
	ID         int64  `json:"id"`
	Language   string `json:"lang"`
	Title      string `json:"title"`
	SourceID   string `json:"source_id"`
	IsOriginal bool   `json:"is_original"`
	SourceType string `json:"source_type"`
}

// LanguageEditionList accepts the array used by the Kikoeru API contract and
// numeric-keyed objects emitted when an upstream serializes a sparse array.
type LanguageEditionList []LanguageEdition

func (editions *LanguageEditionList) UnmarshalJSON(data []byte) error {
	data = bytes.TrimSpace(data)
	if bytes.Equal(data, []byte("null")) {
		*editions = nil
		return nil
	}
	if len(data) == 0 {
		return fmt.Errorf("language_editions is empty JSON")
	}
	switch data[0] {
	case '[':
		decoded, err := decodeLanguageEditionArray(data)
		if err != nil {
			return err
		}
		*editions = decoded
		return nil
	case '{':
		decoded, err := decodeLanguageEditionObject(data)
		if err != nil {
			return err
		}
		*editions = decoded
		return nil
	default:
		return fmt.Errorf("language_editions must be an array, numeric-keyed object, or null")
	}
}

func decodeLanguageEditionArray(data []byte) (LanguageEditionList, error) {
	var decoded []LanguageEdition
	if err := json.Unmarshal(data, &decoded); err != nil {
		return nil, fmt.Errorf("decode language_editions array: %w", err)
	}
	return LanguageEditionList(decoded), nil
}

type indexedLanguageEdition struct {
	index   uint64
	key     string
	edition LanguageEdition
}

func decodeLanguageEditionObject(data []byte) (LanguageEditionList, error) {
	var values map[string]json.RawMessage
	if err := json.Unmarshal(data, &values); err != nil {
		return nil, fmt.Errorf("decode language_editions object: %w", err)
	}
	indexed := make([]indexedLanguageEdition, 0, len(values))
	for key, raw := range values {
		index, err := parseLanguageEditionIndex(key)
		if err != nil {
			return nil, err
		}
		var edition LanguageEdition
		if err := json.Unmarshal(raw, &edition); err != nil {
			return nil, fmt.Errorf("decode language_editions object value: %w", err)
		}
		indexed = append(indexed, indexedLanguageEdition{index: index, key: key, edition: edition})
	}
	sort.Slice(indexed, func(left int, right int) bool {
		if indexed[left].index != indexed[right].index {
			return indexed[left].index < indexed[right].index
		}
		return indexed[left].key < indexed[right].key
	})
	decoded := make(LanguageEditionList, len(indexed))
	for index, value := range indexed {
		decoded[index] = value.edition
	}
	return decoded, nil
}

func parseLanguageEditionIndex(key string) (uint64, error) {
	if key == "" || strings.IndexFunc(key, func(value rune) bool { return value < '0' || value > '9' }) >= 0 {
		return 0, fmt.Errorf("language_editions object contains a non-numeric key")
	}
	index, err := strconv.ParseUint(key, 10, 64)
	if err != nil {
		return 0, fmt.Errorf("language_editions object contains an invalid numeric key")
	}
	return index, nil
}

type Circle struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type Tag struct {
	ID   int64                   `json:"id"`
	Name string                  `json:"name"`
	I18n map[string]LocalizedTag `json:"i18n"`
}

type LocalizedTag struct {
	Name string `json:"name"`
}

type VA struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WorksPage struct {
	Works       []Work     `json:"works"`
	Pagination  Pagination `json:"pagination"`
	SortApplied bool       `json:"-"`
}

type Pagination struct {
	CurrentPage int `json:"currentPage"`
	Page        int `json:"page"`
	PageSize    int `json:"pageSize"`
	Total       int `json:"total"`
	TotalCount  int `json:"totalCount"`
	Count       int `json:"count"`
}

type Track struct {
	Type                string  `json:"type"`
	Title               string  `json:"title"`
	Hash                string  `json:"hash"`
	MediaStreamURL      string  `json:"mediaStreamUrl"`
	MediaDownloadURL    string  `json:"mediaDownloadUrl"`
	StreamLowQualityURL string  `json:"streamLowQualityUrl"`
	Duration            float64 `json:"duration"`
	Size                int64   `json:"size"`
	Children            []Track `json:"children"`
}

func NewClient(baseURL string, httpClient *http.Client) *Client {
	if httpClient == nil {
		policy, err := outbound.NewPolicy([]outbound.Destination{{URL: baseURL, AllowPrivate: true}}, outbound.Options{})
		if err != nil {
			httpClient = &http.Client{Transport: clientPolicyErrorTransport{err: err}, Timeout: 20 * time.Second}
		} else {
			httpClient = policy.Client(nil, 20*time.Second)
		}
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), httpClient: httpClient}
}

func (transport clientPolicyErrorTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, transport.err
}

func NewNumber178Client(baseURL string, httpClient *http.Client) *Client {
	client := NewClient(baseURL, httpClient)
	client.compatibility = CompatibilityNumber178
	return client
}

// WithMaxResponseBytes lowers the buffered JSON bound for this client, for
// example for a metadata lookup that needs only one work.
func (c *Client) WithMaxResponseBytes(limit int64) *Client {
	if limit > 0 && limit < maxKikoeruJSONBytes {
		c.maxResponseBytes = limit
	}
	return c
}

// WithAcceptLanguage sets the Accept-Language header value sent to the
// compatible source, such as "zh-CN, ja-JP;q=0.9". The upstream may ignore it
// or return mixed-language metadata.
func (c *Client) WithAcceptLanguage(value string) *Client {
	c.acceptLanguage = strings.TrimSpace(value)
	return c
}

func (c *Client) Health(ctx context.Context) error {
	var value string
	return c.get(ctx, "/api/health", nil, &value)
}

func (c *Client) ListWorks(ctx context.Context, page int, pageSize int, keyword string) (WorksPage, error) {
	return c.ListWorksSorted(ctx, page, pageSize, keyword, "create_date", "desc")
}

func (c *Client) ListWorksSorted(ctx context.Context, page int, pageSize int, keyword string, order string, direction string) (WorksPage, error) {
	return c.ListWorksSortedSeeded(ctx, page, pageSize, keyword, order, direction, "")
}

func (c *Client) ListWorksSortedSeeded(ctx context.Context, page int, pageSize int, keyword string, order string, direction string, seed string) (WorksPage, error) {
	return c.listWorksSortedSeeded(ctx, page, pageSize, keyword, order, direction, seed, true)
}

// SearchWorksSortedSeeded requires the upstream search endpoint to accept the
// query. It does not use compatibility fallbacks that fetch unfiltered works.
func (c *Client) SearchWorksSortedSeeded(ctx context.Context, page int, pageSize int, keyword string, order string, direction string, seed string) (WorksPage, error) {
	return c.listWorksSortedSeeded(ctx, page, pageSize, keyword, order, direction, seed, false)
}

type worksListRequest struct {
	path    string
	keyword string
	sorted  url.Values
	plain   url.Values
}

func (c *Client) listWorksSortedSeeded(ctx context.Context, page int, pageSize int, keyword string, order string, direction string, seed string, allowCompatibilityFallback bool) (WorksPage, error) {
	request := buildWorksListRequest(page, pageSize, keyword, order, direction, seed)
	var result WorksPage
	if err := c.get(ctx, request.path, request.sorted, &result); err != nil {
		return c.listWorksCompatibilityFallback(ctx, request, allowCompatibilityFallback, err)
	}
	result.SortApplied = true
	return result, nil
}

func buildWorksListRequest(page, pageSize int, keyword, order, direction, seed string) worksListRequest {
	params := url.Values{}
	params.Set("page", strconv.Itoa(page))
	params.Set("pageSize", strconv.Itoa(pageSize))
	order = strings.TrimSpace(order)
	if order == "" {
		order = "create_date"
	}
	direction = strings.ToLower(strings.TrimSpace(direction))
	if direction != "asc" && direction != "desc" {
		direction = "desc"
	}
	params.Set("order", order)
	params.Set("sort", direction)
	if seed = strings.TrimSpace(seed); seed != "" {
		params.Set("seed", seed)
	}
	plainParams := cloneValues(params)
	plainParams.Del("order")
	plainParams.Del("sort")
	plainParams.Del("seed")
	keyword = strings.TrimSpace(keyword)
	path := "/api/works"
	if keyword != "" {
		path = "/api/search/" + url.PathEscape(keyword)
		params.Set("includeTranslationWorks", "true")
	}
	return worksListRequest{path: path, keyword: keyword, sorted: params, plain: plainParams}
}

func (c *Client) listWorksCompatibilityFallback(ctx context.Context, request worksListRequest, allow bool, originalErr error) (WorksPage, error) {
	if !allow || c.compatibility != CompatibilityNumber178 {
		return WorksPage{}, originalErr
	}
	var result WorksPage
	if request.keyword == "" {
		if err := c.get(ctx, request.path, request.plain, &result); err != nil {
			return WorksPage{}, originalErr
		}
		result.SortApplied = false
		return result, nil
	}
	if err := c.get(ctx, "/api/works", request.sorted, &result); err != nil {
		if err := c.get(ctx, "/api/works", request.plain, &result); err != nil {
			return WorksPage{}, originalErr
		}
		result.SortApplied = false
	} else {
		result.SortApplied = true
	}
	result.Works = filterWorks(result.Works, request.keyword)
	return result, nil
}

func TagName(tag Tag, language string) string {
	return TagNameForLanguages(tag, []string{language})
}

func TagNameForLanguages(tag Tag, languages []string) string {
	for _, language := range languages {
		language = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(language), "_", "-"))
		if localized, ok := tag.I18n[language]; ok && strings.TrimSpace(localized.Name) != "" {
			return strings.TrimSpace(localized.Name)
		}
		for candidate, localized := range tag.I18n {
			candidate = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(candidate), "_", "-"))
			if candidate == language && strings.TrimSpace(localized.Name) != "" {
				return strings.TrimSpace(localized.Name)
			}
		}
	}
	return strings.TrimSpace(tag.Name)
}

func (c *Client) PopularWorks(ctx context.Context, page int, pageSize int) (WorksPage, error) {
	if page <= 0 {
		page = 1
	}
	if pageSize <= 0 {
		pageSize = 100
	}
	var result WorksPage
	if err := c.postJSON(ctx, "/api/recommender/popular", map[string]int{"page": page, "pageSize": pageSize}, &result); err != nil {
		return WorksPage{}, err
	}
	return result, nil
}

func (c *Client) WorkInfo(ctx context.Context, code string) (Work, json.RawMessage, error) {
	var raw json.RawMessage
	if err := c.get(ctx, "/api/workInfo/"+url.PathEscape(strings.TrimSpace(code)), nil, &raw); err != nil {
		return Work{}, nil, err
	}
	var work Work
	if err := json.Unmarshal(raw, &work); err != nil {
		return Work{}, nil, err
	}
	return work, raw, nil
}

func (c *Client) Tracks(ctx context.Context, id int64) ([]Track, json.RawMessage, error) {
	var raw json.RawMessage
	params := url.Values{}
	params.Set("v", "2")
	if err := c.get(ctx, fmt.Sprintf("/api/tracks/%d", id), params, &raw); err != nil {
		return nil, nil, err
	}
	var tracks []Track
	if err := json.Unmarshal(raw, &tracks); err != nil {
		return nil, nil, err
	}
	c.normalizeTrackURLs(tracks)
	return tracks, raw, nil
}

func (c *Client) FindWorkByCode(ctx context.Context, code string) (Work, json.RawMessage, error) {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return Work{}, nil, fmt.Errorf("work code is required")
	}
	work, raw, found, searchErr := c.findWorkBySearch(ctx, code)
	if found {
		return work, raw, nil
	}
	work, raw, found, pagesErr := c.findWorkByPages(ctx, code)
	if found {
		return work, raw, nil
	}
	if searchErr != nil || pagesErr != nil {
		return Work{}, nil, fmt.Errorf("remote source could not be searched for %s: %w", code, errors.Join(searchErr, pagesErr))
	}
	return Work{}, nil, fmt.Errorf("%w for %s", ErrWorkNotFound, code)
}

func (c *Client) findWorkBySearch(ctx context.Context, code string) (Work, json.RawMessage, bool, error) {
	page, err := c.ListWorks(ctx, 1, 20, code)
	if err != nil {
		return Work{}, nil, false, err
	}
	work, raw, found := findWorkInPage(page.Works, code)
	return work, raw, found, nil
}

func (c *Client) findWorkByPages(ctx context.Context, code string) (Work, json.RawMessage, bool, error) {
	for pageNumber := 1; pageNumber <= 50; pageNumber++ {
		page, err := c.ListWorks(ctx, pageNumber, 100, "")
		if err != nil {
			return Work{}, nil, false, err
		}
		if work, raw, found := findWorkInPage(page.Works, code); found {
			return work, raw, true, nil
		}
		if workPageComplete(page, pageNumber) {
			break
		}
	}
	return Work{}, nil, false, nil
}

func findWorkInPage(works []Work, code string) (Work, json.RawMessage, bool) {
	for _, work := range works {
		if WorkCode(work) == code {
			raw, _ := json.Marshal(work)
			return work, raw, true
		}
	}
	return Work{}, nil, false
}

func workPageComplete(page WorksPage, pageNumber int) bool {
	return len(page.Works) == 0 || page.Pagination.TotalCount > 0 && page.Pagination.PageSize > 0 && pageNumber*page.Pagination.PageSize >= page.Pagination.TotalCount
}

func WorkCode(work Work) string {
	for _, candidate := range []string{work.SourceID, work.OriginalWorkNumber} {
		code := normalizeWorkCode(candidate)
		if code != "" {
			return code
		}
	}
	if work.OriginalWorkID > 0 {
		return fmt.Sprintf("RJ%08d", work.OriginalWorkID)
	}
	return ""
}

func (c *Client) get(ctx context.Context, path string, params url.Values, target any) error {
	if c.baseURL == "" {
		return fmt.Errorf("remote source API URL is not configured")
	}
	endpoint := c.baseURL + path
	if len(params) > 0 {
		endpoint += "?" + params.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	if c.acceptLanguage != "" {
		req.Header.Set("Accept-Language", c.acceptLanguage)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return StatusError{Code: resp.StatusCode}
	}
	bytes, err := readLimitedJSONBody(resp.Body, c.responseLimit())
	if err != nil {
		return err
	}
	if value, ok := target.(*string); ok {
		*value = string(bytes)
		return nil
	}
	return json.Unmarshal(bytes, target)
}

func (c *Client) postJSON(ctx context.Context, path string, payload any, target any) error {
	if c.baseURL == "" {
		return fmt.Errorf("remote source API URL is not configured")
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.baseURL+path, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	if c.acceptLanguage != "" {
		req.Header.Set("Accept-Language", c.acceptLanguage)
	}
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return StatusError{Code: resp.StatusCode}
	}
	bytes, err := readLimitedJSONBody(resp.Body, c.responseLimit())
	if err != nil {
		return err
	}
	return json.Unmarshal(bytes, target)
}

func (c *Client) responseLimit() int64 {
	if c.maxResponseBytes > 0 {
		return c.maxResponseBytes
	}
	return maxKikoeruJSONBytes
}

func readLimitedJSONBody(body io.Reader, limit int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("%w: exceeds %d bytes", ErrResponseTooLarge, limit)
	}
	return data, nil
}

func cloneValues(values url.Values) url.Values {
	clone := url.Values{}
	for key, items := range values {
		clone[key] = append([]string(nil), items...)
	}
	return clone
}

func normalizeWorkCode(value string) string {
	return workcode.Normalize(value)
}

func (c *Client) normalizeTrackURLs(tracks []Track) {
	for index := range tracks {
		tracks[index].MediaStreamURL = c.absoluteURL(tracks[index].MediaStreamURL)
		tracks[index].MediaDownloadURL = c.absoluteURL(tracks[index].MediaDownloadURL)
		tracks[index].StreamLowQualityURL = c.absoluteURL(tracks[index].StreamLowQualityURL)
		c.normalizeTrackURLs(tracks[index].Children)
	}
}

func (c *Client) absoluteURL(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || strings.HasPrefix(value, "http://") || strings.HasPrefix(value, "https://") {
		return value
	}
	if strings.HasPrefix(value, "/") {
		return c.baseURL + value
	}
	return c.baseURL + "/" + value
}

func filterWorks(works []Work, keyword string) []Work {
	keyword = strings.TrimSpace(keyword)
	if keyword == "" {
		return works
	}
	if circleName, ok := circleKeyword(keyword); ok {
		return filterWorksByCircle(works, circleName)
	}
	needle := strings.ToLower(keyword)
	result := make([]Work, 0, len(works))
	for _, work := range works {
		values := []string{WorkCode(work), work.Title, work.Name, work.SourceID, work.OriginalWorkNumber}
		if work.Circle != nil {
			values = append(values, work.Circle.Name)
		}
		for _, value := range values {
			if strings.Contains(strings.ToLower(value), needle) {
				result = append(result, work)
				break
			}
		}
	}
	return result
}

func circleKeyword(keyword string) (string, bool) {
	keyword = strings.TrimSpace(keyword)
	if strings.HasPrefix(keyword, "$circle:") && strings.HasSuffix(keyword, "$") {
		value := strings.TrimSuffix(strings.TrimPrefix(keyword, "$circle:"), "$")
		return strings.TrimSpace(value), strings.TrimSpace(value) != ""
	}
	return "", false
}

func filterWorksByCircle(works []Work, circleName string) []Work {
	needle := strings.ToLower(strings.TrimSpace(circleName))
	result := make([]Work, 0, len(works))
	for _, work := range works {
		if work.Circle != nil && strings.Contains(strings.ToLower(work.Circle.Name), needle) {
			result = append(result, work)
		}
	}
	return result
}
