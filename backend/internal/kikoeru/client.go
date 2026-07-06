package kikoeru

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	baseURL       string
	httpClient    *http.Client
	compatibility string
}

const CompatibilityNumber178 = "number178"

type Work struct {
	ID                 int64    `json:"id"`
	Title              string   `json:"title"`
	Name               string   `json:"name"`
	SourceID           string   `json:"source_id"`
	SourceType         string   `json:"source_type"`
	SourceURL          string   `json:"source_url"`
	Release            string   `json:"release"`
	AgeCategoryString  string   `json:"age_category_string"`
	NSFW               bool     `json:"nsfw"`
	Duration           *float64 `json:"duration"`
	MainCoverURL       string   `json:"mainCoverUrl"`
	SamCoverURL        string   `json:"samCoverUrl"`
	ThumbnailCoverURL  string   `json:"thumbnailCoverUrl"`
	Circle             *Circle  `json:"circle"`
	Tags               []Tag    `json:"tags"`
	VAs                []VA     `json:"vas"`
	RateAverage2DP     *float64 `json:"rate_average_2dp"`
	ReviewCount        *int64   `json:"review_count"`
	DLCount            *int64   `json:"dl_count"`
	OriginalWorkNumber string   `json:"original_workno"`
	OriginalWorkID     int64    `json:"original_work_id"`
}

type Circle struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type Tag struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

type VA struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type WorksPage struct {
	Works      []Work     `json:"works"`
	Pagination Pagination `json:"pagination"`
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
		httpClient = &http.Client{Timeout: 20 * time.Second}
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), httpClient: httpClient}
}

func NewNumber178Client(baseURL string, httpClient *http.Client) *Client {
	client := NewClient(baseURL, httpClient)
	client.compatibility = CompatibilityNumber178
	return client
}

func (c *Client) Health(ctx context.Context) error {
	var value string
	return c.get(ctx, "/api/health", nil, &value)
}

func (c *Client) ListWorks(ctx context.Context, page int, pageSize int, keyword string) (WorksPage, error) {
	params := url.Values{}
	params.Set("page", strconv.Itoa(page))
	params.Set("pageSize", strconv.Itoa(pageSize))
	params.Set("order", "create_date")
	params.Set("sort", "desc")
	plainParams := cloneValues(params)
	plainParams.Del("order")
	plainParams.Del("sort")
	var result WorksPage
	keyword = strings.TrimSpace(keyword)
	path := "/api/works"
	if keyword != "" {
		path = "/api/search/" + url.PathEscape(keyword)
	}
	if err := c.get(ctx, path, params, &result); err != nil {
		if c.compatibility != CompatibilityNumber178 {
			return WorksPage{}, err
		}
		if keyword == "" {
			if fallbackErr := c.get(ctx, path, plainParams, &result); fallbackErr == nil {
				return result, nil
			}
		}
		if keyword == "" {
			return WorksPage{}, err
		}
		if fallbackErr := c.get(ctx, "/api/works", params, &result); fallbackErr != nil {
			if plainFallbackErr := c.get(ctx, "/api/works", plainParams, &result); plainFallbackErr != nil {
				return WorksPage{}, err
			}
		}
		result.Works = filterWorks(result.Works, keyword)
	}
	return result, nil
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
	if page, err := c.ListWorks(ctx, 1, 20, code); err == nil {
		for _, work := range page.Works {
			if WorkCode(work) == code {
				raw, _ := json.Marshal(work)
				return work, raw, nil
			}
		}
	}
	for pageNumber := 1; pageNumber <= 50; pageNumber++ {
		page, err := c.ListWorks(ctx, pageNumber, 100, "")
		if err != nil {
			break
		}
		for _, work := range page.Works {
			if WorkCode(work) == code {
				raw, _ := json.Marshal(work)
				return work, raw, nil
			}
		}
		if len(page.Works) == 0 || page.Pagination.TotalCount > 0 && page.Pagination.PageSize > 0 && pageNumber*page.Pagination.PageSize >= page.Pagination.TotalCount {
			break
		}
	}
	return Work{}, nil, fmt.Errorf("remote source returned no matching work for %s", code)
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
	req.Header.Set("User-Agent", "Kikoto/0.1 Kikoeru-compatible client")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("remote source returned HTTP %d", resp.StatusCode)
	}
	if value, ok := target.(*string); ok {
		bytes, err := io.ReadAll(resp.Body)
		if err != nil {
			return err
		}
		*value = string(bytes)
		return nil
	}
	return json.NewDecoder(resp.Body).Decode(target)
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
	req.Header.Set("User-Agent", "Kikoto/0.1 Kikoeru-compatible client")
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("remote source returned HTTP %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(target)
}

func cloneValues(values url.Values) url.Values {
	clone := url.Values{}
	for key, items := range values {
		clone[key] = append([]string(nil), items...)
	}
	return clone
}

func normalizeWorkCode(value string) string {
	code := strings.ToUpper(strings.TrimSpace(value))
	if code == "" {
		return ""
	}
	if matched, _ := regexp.MatchString(`^(RJ|BJ|VJ|CC)[0-9]{4,8}$`, code); matched {
		return code
	}
	return ""
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
