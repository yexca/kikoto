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
	// Items holds the same works in rank order with the title and circle the
	// ranking page shows; either text may be empty.
	Items []RankingItem `json:"items"`
}

// RankingItem is one ranked work as the ranking page lists it.
type RankingItem struct {
	Code  string `json:"code"`
	Title string `json:"title"`
	Maker string `json:"maker"`
}

type rankingQuery struct {
	period        string
	releaseWindow string
	year          int
}

func (c *Client) FetchVoiceRanking(ctx context.Context, options RankingOptions) (RankingResult, error) {
	query, err := normalizeRankingQuery(options)
	if err != nil {
		return RankingResult{}, err
	}
	items, err := c.fetchRankingItems(ctx, query)
	if err != nil {
		return RankingResult{}, err
	}
	if len(items) == 0 {
		return RankingResult{}, fmt.Errorf("DLsite ranking returned no voice works")
	}
	codes := make([]string, 0, len(items))
	for _, item := range items {
		codes = append(codes, item.Code)
	}
	return RankingResult{Period: query.period, ReleaseWindow: query.releaseWindow, Year: query.year, WorkCodes: codes, Items: items}, nil
}

func normalizeRankingQuery(options RankingOptions) (rankingQuery, error) {
	query := rankingQuery{
		period:        strings.ToLower(strings.TrimSpace(options.Period)),
		releaseWindow: strings.ToLower(strings.TrimSpace(options.ReleaseWindow)),
		year:          options.Year,
	}
	switch query.period {
	case "day", "week", "month", "year":
	default:
		return rankingQuery{}, fmt.Errorf("unsupported DLsite ranking period %q", options.Period)
	}
	if query.period == "year" {
		query.releaseWindow = ""
		currentYear := time.Now().UTC().Year()
		if query.year < 2000 || query.year > currentYear {
			return rankingQuery{}, fmt.Errorf("DLsite ranking year must be between 2000 and %d", currentYear)
		}
		return query, nil
	}
	if query.releaseWindow != "" && query.releaseWindow != "30d" {
		return rankingQuery{}, fmt.Errorf("unsupported DLsite ranking release window %q", options.ReleaseWindow)
	}
	if query.year != 0 {
		return rankingQuery{}, fmt.Errorf("DLsite ranking year is only valid for annual rankings")
	}
	return query, nil
}

func (c *Client) fetchRankingItems(ctx context.Context, query rankingQuery) ([]RankingItem, error) {
	params := url.Values{"category": []string{"voice"}}
	if query.releaseWindow != "" {
		params.Set("date", query.releaseWindow)
	}
	if query.period == "year" {
		params.Set("year", strconv.Itoa(query.year))
	}
	endpoint := fmt.Sprintf("%s/maniax/ranking/%s?%s", c.endpoints.webURL(), query.period, params.Encode())
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Accept", "text/html")
	request.Header.Set("Accept-Language", "ja,en;q=0.8")
	request.Header.Set("User-Agent", c.userAgent)
	response, err := c.httpClient.Do(request)
	if err != nil {
		return nil, err
	}
	defer func() { _ = response.Body.Close() }()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, HTTPStatusError{Operation: "dlsite ranking", Status: response.Status, StatusCode: response.StatusCode, RetryAfter: response.Header.Get("Retry-After")}
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024))
	if err != nil {
		return nil, err
	}
	return parseRankingItems(string(body)), nil
}
