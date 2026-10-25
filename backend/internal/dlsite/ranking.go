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

// RankingOptions names one voice ranking: a period (day, week, month, year,
// or total), the 30-day release window of the day, week, and month rankings,
// the order (popularity, or "sale" for sales), and the year of an annual
// ranking.
type RankingOptions struct {
	Period        string
	ReleaseWindow string
	Sort          string
	Year          int
}

type RankingResult struct {
	Period        string   `json:"period"`
	ReleaseWindow string   `json:"releaseWindow"`
	Sort          string   `json:"sort"`
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

// japanZone is DLsite's clock: its daily and annual rankings turn over in
// Japan Standard Time, which has no daylight saving time.
var japanZone = time.FixedZone("JST", 9*60*60)

// InJapan returns t on DLsite's clock.
func InJapan(t time.Time) time.Time {
	return t.In(japanZone)
}

// CurrentRankingYear is the year of the annual ranking in progress at now.
func CurrentRankingYear(now time.Time) int {
	return InJapan(now).Year()
}

type rankingQuery struct {
	period        string
	releaseWindow string
	sort          string
	year          int
}

func (c *Client) FetchVoiceRanking(ctx context.Context, options RankingOptions) (RankingResult, error) {
	query, err := normalizeRankingQuery(options, time.Now())
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
	return RankingResult{Period: query.period, ReleaseWindow: query.releaseWindow, Sort: query.sort, Year: query.year, WorkCodes: codes, Items: items}, nil
}

func normalizeRankingQuery(options RankingOptions, now time.Time) (rankingQuery, error) {
	query := rankingQuery{
		period:        strings.ToLower(strings.TrimSpace(options.Period)),
		releaseWindow: strings.ToLower(strings.TrimSpace(options.ReleaseWindow)),
		sort:          strings.ToLower(strings.TrimSpace(options.Sort)),
		year:          options.Year,
	}
	switch query.period {
	case "day", "week", "month", "year", "total":
	default:
		return rankingQuery{}, fmt.Errorf("unsupported DLsite ranking period %q", options.Period)
	}
	if query.sort != "" && query.sort != "sale" {
		return rankingQuery{}, fmt.Errorf("unsupported DLsite ranking order %q", options.Sort)
	}
	// The annual and all-time rankings have no release window.
	if query.period == "total" {
		query.releaseWindow = ""
		if query.year != 0 {
			return rankingQuery{}, fmt.Errorf("DLsite ranking year is only valid for annual rankings")
		}
		return query, nil
	}
	if query.period == "year" {
		query.releaseWindow = ""
		currentYear := CurrentRankingYear(now)
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
	// sub=SOU keeps the voice and ASMR works and leaves out music.
	params := url.Values{"category": []string{"voice"}, "sub": []string{"SOU"}}
	if query.releaseWindow != "" {
		params.Set("date", query.releaseWindow)
	}
	if query.sort != "" {
		params.Set("sort", query.sort)
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
