package dlsite

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	httpClient *http.Client
	baseURL    string
	userAgent  string
}

type Product struct {
	WorkNo            string          `json:"workno"`
	ProductID         string          `json:"product_id"`
	SiteID            string          `json:"site_id"`
	SiteIDTouch       string          `json:"site_id_touch"`
	ProductName       string          `json:"product_name"`
	WorkName          string          `json:"work_name"`
	WorkNameKana      string          `json:"work_name_kana"`
	Intro             string          `json:"intro"`
	IntroShort        string          `json:"intro_s"`
	RegistDate        string          `json:"regist_date"`
	AgeCategoryString string          `json:"age_category_string"`
	WorkType          string          `json:"work_type"`
	WorkTypeString    string          `json:"work_type_string"`
	Raw               json.RawMessage `json:"-"`
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
	workno = strings.ToUpper(strings.TrimSpace(workno))
	if workno == "" {
		return Product{}, fmt.Errorf("empty workno")
	}

	var lastErr error
	for _, site := range candidateSites(workno) {
		product, err := c.fetchProductFromSite(ctx, site, workno)
		if err == nil {
			return product, nil
		}
		lastErr = err
	}

	if lastErr == nil {
		lastErr = fmt.Errorf("no candidate sites for %s", workno)
	}
	return Product{}, lastErr
}

func (c *Client) fetchProductFromSite(ctx context.Context, site string, workno string) (Product, error) {
	endpoint := fmt.Sprintf("%s/%s/api/=/product.json?workno=%s", strings.TrimRight(c.baseURL, "/"), site, url.QueryEscape(workno))
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
