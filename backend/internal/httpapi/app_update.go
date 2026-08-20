package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/yexca/kikoto/backend/internal/buildinfo"
	"github.com/yexca/kikoto/backend/internal/outbound"
)

const (
	appUpdateCacheTTL = 6 * time.Hour
	appUpdateMaxBody  = 1 << 20
)

var stableReleaseTag = regexp.MustCompile(`^v(\d+)\.(\d+)\.(\d+)$`)

type appUpdateResponse struct {
	CurrentVersion  string `json:"currentVersion"`
	LatestVersion   string `json:"latestVersion"`
	UpdateAvailable bool   `json:"updateAvailable"`
	ReleaseURL      string `json:"releaseUrl"`
	CheckedAt       string `json:"checkedAt"`
}

type githubTag struct {
	Name string `json:"name"`
}

func (s *Server) getAppUpdate(w http.ResponseWriter, r *http.Request) {
	s.updateCheckMu.Lock()
	defer s.updateCheckMu.Unlock()
	if cached := s.updateCheck; cached != nil && time.Since(cached.checkedAt) < appUpdateCacheTTL {
		writeJSON(w, http.StatusOK, cached.result)
		return
	}

	result, err := s.fetchAppUpdate(context.WithoutCancel(r.Context()))
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{"error": "Update check unavailable", "code": "app_update_unavailable", "retryable": true})
		return
	}
	s.updateCheck = &updateCheckCache{checkedAt: time.Now(), result: result}
	writeJSON(w, http.StatusOK, result)
}

func (s *Server) fetchAppUpdate(ctx context.Context) (appUpdateResponse, error) {
	current := buildinfo.Version
	policy, err := outbound.NewPolicy([]outbound.Destination{{URL: s.appUpdateEndpoints.tagsURL}}, outbound.Options{})
	if err != nil {
		return appUpdateResponse{}, err
	}
	client := policy.Client(nil, 20*time.Second)
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	if s.updateHTTPClient != nil {
		client = s.updateHTTPClient
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, s.appUpdateEndpoints.tagsURL, nil)
	if err != nil {
		return appUpdateResponse{}, err
	}
	request.Header.Set("Accept", "application/vnd.github+json")
	request.Header.Set("User-Agent", buildinfo.UserAgent()+" update checker")
	response, err := client.Do(request)
	if err != nil {
		return appUpdateResponse{}, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return appUpdateResponse{}, fmt.Errorf("github returned status %d", response.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, appUpdateMaxBody+1))
	if err != nil {
		return appUpdateResponse{}, err
	}
	if len(body) > appUpdateMaxBody {
		return appUpdateResponse{}, fmt.Errorf("github response exceeds limit")
	}
	var tags []githubTag
	if err := json.Unmarshal(body, &tags); err != nil {
		return appUpdateResponse{}, err
	}
	latest := highestStableTag(tags)
	result := appUpdateResponse{CurrentVersion: current, LatestVersion: latest, UpdateAvailable: compareAppVersions(current, latest) < 0, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	if latest != "" {
		result.ReleaseURL = s.appUpdateEndpoints.releaseURL(latest)
	}
	return result, nil
}

func highestStableTag(tags []githubTag) string {
	stable := make([]string, 0, len(tags))
	for _, tag := range tags {
		if stableReleaseTag.MatchString(strings.TrimSpace(tag.Name)) {
			stable = append(stable, strings.TrimSpace(tag.Name))
		}
	}
	sort.SliceStable(stable, func(i, j int) bool { return compareAppVersions(stable[i], stable[j]) > 0 })
	if len(stable) == 0 {
		return ""
	}
	return stable[0]
}

func compareAppVersions(left, right string) int {
	parse := func(value string) [3]int {
		match := stableReleaseTag.FindStringSubmatch(strings.TrimSpace(value))
		var parts [3]int
		if len(match) != 4 {
			return parts
		}
		for i := 0; i < 3; i++ {
			parts[i], _ = strconv.Atoi(match[i+1])
		}
		return parts
	}
	a, b := parse(left), parse(right)
	for i := 0; i < 3; i++ {
		if a[i] != b[i] {
			if a[i] < b[i] {
				return -1
			}
			return 1
		}
	}
	return 0
}
