package httpapi

import (
	"net/url"
	"strings"
)

// appUpdateEndpoints holds the built-in public release endpoints. It is kept
// as a value on Server so update checks do not depend on runtime configuration.
type appUpdateEndpoints struct {
	tagsURL     string
	releasesURL string
}

func defaultAppUpdateEndpoints() appUpdateEndpoints {
	return appUpdateEndpoints{
		tagsURL:     "https://api.github.com/repos/yexca/kikoto/tags?per_page=100",
		releasesURL: "https://github.com/yexca/kikoto/releases",
	}
}

func (e appUpdateEndpoints) releaseURL(tag string) string {
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return ""
	}
	return strings.TrimRight(e.releasesURL, "/") + "/tag/" + url.PathEscape(tag)
}
