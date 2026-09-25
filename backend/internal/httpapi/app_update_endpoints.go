package httpapi

import (
	"net/url"
	"strings"
)

// appUpdateEndpoints holds the built-in public release endpoints. It is kept
// as a value on Server so update checks do not depend on runtime configuration.
type appUpdateEndpoints struct {
	releasesAPIURL string
	releasesURL    string
}

func defaultAppUpdateEndpoints() appUpdateEndpoints {
	return appUpdateEndpoints{
		// Only published releases count: a pushed tag or a draft release whose
		// image and APK are still being published must not be offered yet.
		// Release bodies are included, so keep the page within appUpdateMaxBody.
		releasesAPIURL: "https://api.github.com/repos/yexca/kikoto/releases?per_page=20",
		releasesURL:    "https://github.com/yexca/kikoto/releases",
	}
}

func (e appUpdateEndpoints) releaseURL(tag string) string {
	tag = strings.TrimSpace(tag)
	if tag == "" {
		return ""
	}
	return strings.TrimRight(e.releasesURL, "/") + "/tag/" + url.PathEscape(tag)
}
