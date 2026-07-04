package kikoeru

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Client struct {
	baseURL    string
	httpClient *http.Client
}

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
	var result WorksPage
	path := "/api/works"
	if strings.TrimSpace(keyword) != "" {
		path = "/api/search/" + url.PathEscape(strings.TrimSpace(keyword))
	}
	if err := c.get(ctx, path, params, &result); err != nil {
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
	return tracks, raw, nil
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
