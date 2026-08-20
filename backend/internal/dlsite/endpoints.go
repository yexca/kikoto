package dlsite

import (
	"fmt"
	"html"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

const (
	defaultDLsiteWebBaseURL   = "https://www.dlsite.com"
	defaultDLsiteImageBaseURL = "https://img.dlsite.jp"
)

// Endpoints defines the built-in public destinations for DLsite metadata.
// Its fields are intentionally private so callers share immutable endpoint
// values rather than treating provider origins as runtime configuration.
type Endpoints struct {
	webBaseURL   string
	imageBaseURL string
}

// DefaultEndpoints returns the built-in public DLsite destinations.
func DefaultEndpoints() Endpoints {
	return Endpoints{
		webBaseURL:   defaultDLsiteWebBaseURL,
		imageBaseURL: defaultDLsiteImageBaseURL,
	}
}

// NewClient creates a client constrained to these endpoint origins when the
// caller does not supply an HTTP client.
func (e Endpoints) NewClient(httpClient *http.Client) *Client {
	if httpClient == nil {
		policy, err := outbound.NewPolicy([]outbound.Destination{
			{URL: e.webBaseURL},
			{URL: e.imageBaseURL},
		}, outbound.Options{})
		if err != nil {
			panic("invalid built-in metadata destination policy")
		}
		httpClient = policy.Client(nil, 20*time.Second)
	}
	return &Client{
		httpClient: httpClient,
		endpoints:  e,
		userAgent:  buildinfo.UserAgent(),
	}
}

// WorkURL returns the public work page for a primary code.
func (e Endpoints) WorkURL(primaryCode string) string {
	code := strings.ToUpper(strings.TrimSpace(primaryCode))
	if code == "" {
		return ""
	}
	return e.workURL(siteForWorkCode(code), code)
}

// ProductURL returns the public work page that corresponds to a product
// snapshot. A source-provided site is retained when available.
func (e Endpoints) ProductURL(product Product) string {
	code := strings.TrimSpace(product.WorkNo)
	if code == "" {
		return ""
	}
	site := strings.TrimSpace(product.SiteID)
	if site == "" {
		site = siteForWorkCode(code)
	}
	return e.workURL(site, code)
}

// MakerURL returns the public maker profile page for a DLsite external ID.
func (e Endpoints) MakerURL(externalID string) string {
	id := strings.TrimSpace(externalID)
	if id == "" {
		return ""
	}
	site := "maniax"
	if strings.HasPrefix(strings.ToUpper(id), "VG") {
		site = "pro"
	}
	return fmt.Sprintf("%s/%s/circle/profile/=/maker_id/%s.html", e.webURL(), url.PathEscape(site), url.PathEscape(id))
}

// ResolveURL makes root-relative and protocol-relative links from a DLsite
// page absolute while preserving fully qualified and other provider values.
func (e Endpoints) ResolveURL(raw string) string {
	raw = strings.TrimSpace(html.UnescapeString(raw))
	if strings.HasPrefix(raw, "//") {
		base, err := url.Parse(e.webBaseURL)
		if err != nil || base.Scheme == "" {
			return raw
		}
		return base.Scheme + ":" + raw
	}
	if strings.HasPrefix(raw, "/") {
		return e.webURL() + raw
	}
	return raw
}

func (e Endpoints) workURL(site string, code string) string {
	return fmt.Sprintf("%s/%s/work/=/product_id/%s.html", e.webURL(), url.PathEscape(strings.TrimSpace(site)), url.PathEscape(code))
}

func (e Endpoints) webURL() string {
	return strings.TrimRight(e.webBaseURL, "/")
}

func siteForWorkCode(code string) string {
	if strings.HasPrefix(strings.ToUpper(strings.TrimSpace(code)), "VJ") {
		return "pro"
	}
	return "maniax"
}
