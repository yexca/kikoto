package kikoeru

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
)

var (
	// ErrAccountUnauthorized means the server rejected the login or token.
	ErrAccountUnauthorized = errors.New("kikoeru account credentials were rejected")
	// ErrAccountUnsupported means the server does not offer the endpoint.
	ErrAccountUnsupported = errors.New("kikoeru account endpoint is not supported")
	// ErrAccountLimit means the account holds more data than an import accepts.
	ErrAccountLimit = errors.New("kikoeru account data exceeds import limits")
	// ErrAccountResponse means the server answered with something other than
	// the expected JSON document.
	ErrAccountResponse = errors.New("kikoeru account response is invalid")
)

const (
	// Forks that honor pageSize cap it at 100; others use their own page size
	// and report it in pagination, which the page loops follow.
	accountPageSize                = 100
	maxAccountPages                = 2000
	maxAccountResponseBytes  int64 = 8 << 20
	maxAccountPlaylistsTotal       = 1000
	systemPlaylistPrefix           = "__SYS_PLAYLIST_"
)

// AccountClient reads one user's own review and playlist data from a
// Kikoeru-compatible server. It never follows redirects: the login body and
// bearer token must reach only the origin the caller validated.
type AccountClient struct {
	baseURL    string
	httpClient *http.Client
	token      string
}

// AccountReview is one row of GET /api/review. Identity fields stay raw so the
// caller decides how a fork's id maps to a product code.
type AccountReview struct {
	ID         json.RawMessage
	WorkID     json.RawMessage
	SourceID   string
	Progress   string
	Rating     *int
	ReviewText string
}

// AccountPlaylist is one playlist the account owns. System is the lowercase
// suffix of a server-defined list, such as "liked"; it is empty for user lists.
type AccountPlaylist struct {
	ID          string
	Name        string
	Description string
	System      string
	WorksCount  int
}

// AccountWork is the identity of one work inside a playlist.
type AccountWork struct {
	ID       json.RawMessage
	SourceID string
}

func NewAccountClient(baseURL string, httpClient *http.Client) *AccountClient {
	client := &http.Client{}
	if httpClient != nil {
		*client = *httpClient
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	return &AccountClient{baseURL: strings.TrimRight(baseURL, "/"), httpClient: client}
}

// WithToken sets the bearer token sent with account requests.
func (c *AccountClient) WithToken(token string) *AccountClient {
	c.token = token
	return c
}

// Login exchanges a name and password for a bearer token and keeps it for
// later requests. The password is never stored.
func (c *AccountClient) Login(ctx context.Context, name, password string) error {
	var body struct {
		Token string `json:"token"`
	}
	payload, err := json.Marshal(map[string]string{"name": name, "password": password})
	if err != nil {
		return err
	}
	if err := c.do(ctx, http.MethodPost, "/api/auth/me", nil, payload, false, &body); err != nil {
		return err
	}
	token := strings.TrimSpace(body.Token)
	if token == "" {
		return ErrAccountUnauthorized
	}
	c.token = token
	return nil
}

// Reviews reads every review page for the signed-in account.
func (c *AccountClient) Reviews(ctx context.Context, maxItems int) ([]AccountReview, error) {
	type row struct {
		ID         json.RawMessage `json:"id"`
		WorkID     json.RawMessage `json:"work_id"`
		SourceID   json.RawMessage `json:"source_id"`
		Progress   *string         `json:"progress"`
		UserRating json.RawMessage `json:"userRating"`
		ReviewText *string         `json:"review_text"`
	}
	var reviews []AccountReview
	err := c.eachPage(ctx, "/api/review", url.Values{}, maxItems, func(data []byte) (int, Pagination, error) {
		var page struct {
			Works      []row      `json:"works"`
			Pagination Pagination `json:"pagination"`
		}
		if err := json.Unmarshal(data, &page); err != nil || page.Works == nil {
			return 0, Pagination{}, ErrAccountResponse
		}
		for _, item := range page.Works {
			review := AccountReview{ID: item.ID, WorkID: item.WorkID, SourceID: rawString(item.SourceID), Rating: rawRating(item.UserRating)}
			if item.Progress != nil {
				review.Progress = *item.Progress
			}
			if item.ReviewText != nil {
				review.ReviewText = *item.ReviewText
			}
			reviews = append(reviews, review)
		}
		return len(page.Works), page.Pagination, nil
	})
	return reviews, err
}

// Playlists lists the playlists the account owns. A server without playlist
// support returns ErrAccountUnsupported.
func (c *AccountClient) Playlists(ctx context.Context) ([]AccountPlaylist, error) {
	type row struct {
		ID          json.RawMessage `json:"id"`
		Name        string          `json:"name"`
		Description *string         `json:"description"`
		WorksCount  int             `json:"works_count"`
	}
	var playlists []AccountPlaylist
	err := c.eachPage(ctx, "/api/playlist/get-playlists", url.Values{"filterBy": {"owned"}}, maxAccountPlaylistsTotal, func(data []byte) (int, Pagination, error) {
		var page struct {
			Playlists  []row      `json:"playlists"`
			Pagination Pagination `json:"pagination"`
		}
		if err := json.Unmarshal(data, &page); err != nil || page.Playlists == nil {
			return 0, Pagination{}, ErrAccountUnsupported
		}
		for _, item := range page.Playlists {
			id := rawString(item.ID)
			if id == "" {
				return 0, Pagination{}, ErrAccountResponse
			}
			playlist := AccountPlaylist{ID: id, Name: item.Name, WorksCount: item.WorksCount}
			if item.Description != nil {
				playlist.Description = *item.Description
			}
			if strings.HasPrefix(item.Name, systemPlaylistPrefix) {
				playlist.System = strings.ToLower(strings.TrimPrefix(item.Name, systemPlaylistPrefix))
				playlist.Name = ""
			}
			playlists = append(playlists, playlist)
		}
		return len(page.Playlists), page.Pagination, nil
	})
	if errors.Is(err, ErrAccountUnauthorized) || errors.Is(err, ErrAccountResponse) {
		// The same token already read reviews, so a rejected or non-JSON
		// playlist answer means the server does not expose playlists.
		return nil, ErrAccountUnsupported
	}
	return playlists, err
}

// PlaylistWorks lists the works in one playlist, in playlist order.
func (c *AccountClient) PlaylistWorks(ctx context.Context, id string, maxItems int) ([]AccountWork, error) {
	type row struct {
		ID       json.RawMessage `json:"id"`
		SourceID json.RawMessage `json:"source_id"`
	}
	var works []AccountWork
	err := c.eachPage(ctx, "/api/playlist/get-playlist-works", url.Values{"id": {id}}, maxItems, func(data []byte) (int, Pagination, error) {
		var page struct {
			Works      []row      `json:"works"`
			Pagination Pagination `json:"pagination"`
		}
		if err := json.Unmarshal(data, &page); err != nil || page.Works == nil {
			return 0, Pagination{}, ErrAccountResponse
		}
		for _, item := range page.Works {
			works = append(works, AccountWork{ID: item.ID, SourceID: rawString(item.SourceID)})
		}
		return len(page.Works), page.Pagination, nil
	})
	return works, err
}

// eachPage walks a paginated endpoint. It follows the page size and total the
// server reports, because some forks ignore the requested page size.
func (c *AccountClient) eachPage(ctx context.Context, path string, params url.Values, maxItems int, read func([]byte) (int, Pagination, error)) error {
	seen := 0
	for page := 1; ; page++ {
		if page > maxAccountPages {
			return ErrAccountLimit
		}
		query := cloneValues(params)
		query.Set("page", strconv.Itoa(page))
		query.Set("pageSize", strconv.Itoa(accountPageSize))
		var data json.RawMessage
		if err := c.do(ctx, http.MethodGet, path, query, nil, true, &data); err != nil {
			return err
		}
		count, pagination, err := read(data)
		if err != nil {
			return err
		}
		seen += count
		if seen > maxItems {
			return ErrAccountLimit
		}
		total := pagination.TotalCount
		if total == 0 {
			total = pagination.Total
		}
		pageSize := pagination.PageSize
		if pageSize <= 0 {
			pageSize = accountPageSize
		}
		if total > maxItems {
			return ErrAccountLimit
		}
		if count == 0 || (total > 0 && seen >= total) || (total == 0 && count < pageSize) {
			return nil
		}
	}
}

func (c *AccountClient) do(ctx context.Context, method, path string, query url.Values, body []byte, authenticate bool, target any) error {
	if c.baseURL == "" {
		return fmt.Errorf("kikoeru account API URL is not configured")
	}
	endpoint := c.baseURL + path
	if len(query) > 0 {
		endpoint += "?" + query.Encode()
	}
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, endpoint, reader)
	if err != nil {
		return err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" Kikoeru-compatible client")
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if authenticate && c.token != "" {
		request.Header.Set("Authorization", "Bearer "+c.token)
	}
	response, err := c.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer func() { _ = response.Body.Close() }()
	switch {
	case response.StatusCode == http.StatusUnauthorized || response.StatusCode == http.StatusForbidden:
		return ErrAccountUnauthorized
	case response.StatusCode == http.StatusNotFound || response.StatusCode == http.StatusMethodNotAllowed:
		return ErrAccountUnsupported
	case response.StatusCode < 200 || response.StatusCode >= 300:
		return fmt.Errorf("kikoeru account request returned HTTP %d", response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, maxAccountResponseBytes+1))
	if err != nil {
		return err
	}
	if int64(len(data)) > maxAccountResponseBytes {
		return ErrAccountLimit
	}
	if raw, ok := target.(*json.RawMessage); ok {
		if !json.Valid(data) {
			return ErrAccountResponse
		}
		*raw = data
		return nil
	}
	if err := json.Unmarshal(data, target); err != nil {
		return ErrAccountResponse
	}
	return nil
}

// rawString reads a JSON string or number as text; other values are empty.
func rawString(raw json.RawMessage) string {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return strings.TrimSpace(text)
	}
	var number json.Number
	if json.Unmarshal(raw, &number) == nil {
		return number.String()
	}
	return ""
}

// rawRating reads a personal star rating; a fractional value is rounded.
func rawRating(raw json.RawMessage) *int {
	var value *float64
	if json.Unmarshal(raw, &value) != nil || value == nil || math.IsNaN(*value) || math.Abs(*value) > 1000 {
		return nil
	}
	rounded := int(math.Round(*value))
	return &rounded
}
