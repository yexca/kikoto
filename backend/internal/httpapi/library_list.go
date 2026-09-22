package httpapi

import (
	"context"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/library"
)

func (s *Server) listWorks(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	pagedRequest := r.URL.Query().Has("page") || r.URL.Query().Has("pageSize") || r.URL.Query().Has("q") || r.URL.Query().Has("scope") || r.URL.Query().Has("status")
	if pagedRequest {
		s.listWorksPageFast(w, r, userID)
		return
	}
	rawWorks, err := s.libraryStore.ListAll(r.Context(), userID, s.cfg.IsDemo())
	if err != nil {
		writeError(w, err)
		return
	}
	works, err := s.scanLibraryWorkRows(r.Context(), userID, rawWorks, false)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, works)
}

func (s *Server) scanLibraryWorkRows(ctx context.Context, userID int64, rows []library.RawWork, canonicalFiltered bool, includeRecommendation ...bool) ([]libraryWorkSummary, error) {
	works := make([]libraryWorkSummary, 0, len(rows))
	for _, row := range rows {
		item := libraryWorkSummary{
			ID: row.ID, PrimaryCode: row.PrimaryCode, Title: row.Title, CreatedAt: row.CreatedAt,
			AgeRating: row.AgeRating,
			Rating:    row.Rating, Sales: row.Sales, RegularPrice: row.RegularPrice, Price: row.CurrentPrice,
			PriceCurrency: row.PriceCurrency, PermanentlyFree: row.PermanentlyFree,
			TrackCount: row.TrackCount, AvailableLocations: row.AvailableLocations,
			ListeningStatus: row.ListeningStatus, Favorite: row.Favorite, RecommendScore: row.RecommendScore,
		}
		item.SourcePresence = parseSourcePresenceSummary(row.SourcePresence)
		metadata := parseDLsiteSnapshot(row.Snapshot)
		item.RatingCount = metadata.RatingCount
		if !canonicalFiltered {
			if visible, err := s.workEditionVisibleInLibrary(ctx, item.ID); err != nil {
				return nil, err
			} else if !visible {
				continue
			}
		}
		if metadata.BaseCode != "" && s.workCodeExists(ctx, metadata.BaseCode) {
			continue
		}
		item.mediaWorkID = item.ID
		item.availableLocationTypes = row.AvailableLocationTypes
		for _, translation := range metadata.LanguageEditions {
			if !strings.EqualFold(translation.PrimaryCode, item.PrimaryCode) {
				item.fallbackEditionCodes = append(item.fallbackEditionCodes, translation.PrimaryCode)
			}
		}
		item.ReleaseDate = metadata.ReleaseDate
		item.UpdatedAt = item.CreatedAt
		item.CoverURL = s.coverURL(item.PrimaryCode)
		item.DLsiteURL = s.dlsiteURL(item.PrimaryCode)
		item.Circle = metadata.Circle
		item.CircleExternalID = metadata.CircleExternalID
		if name, externalID := parsePartyLink(row.PartyLink); name != "" {
			item.Circle = name
			item.CircleExternalID = externalID
		}
		item.Tags = metadata.Tags
		item.VoiceActors = metadata.VoiceActors
		item.Series = metadata.Series
		works = append(works, item)
	}
	projectedWorkIDs := make([]int64, 0, len(works))
	for _, item := range works {
		projectedWorkIDs = append(projectedWorkIDs, item.ID)
	}
	projectedTags, err := s.loadProjectedDLsiteTagsBatch(ctx, projectedWorkIDs)
	if err != nil {
		return nil, err
	}
	for index := range works {
		if tags, ok := projectedTags[works[index].ID]; ok {
			works[index].Tags = tags
		}
	}
	if err := s.enrichLibraryWorkSummaries(ctx, userID, works); err != nil {
		return nil, err
	}
	workIDs := make([]int64, 0, len(works))
	for _, work := range works {
		workIDs = append(workIDs, work.ID)
	}
	tagsByWork, err := s.loadWorkUserTagsBatch(ctx, userID, workIDs)
	if err != nil {
		return nil, err
	}
	for index := range works {
		works[index].UserTags = tagsByWork[works[index].ID]
	}
	return works, nil
}

func (s *Server) listWorksPageFast(w http.ResponseWriter, r *http.Request, userID int64) {
	recommendationSessionID := strings.TrimSpace(r.URL.Query().Get("recommendationSession"))
	if recommendationSessionID != "" && !recommendationSessionIDPattern.MatchString(recommendationSessionID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid recommendation session"})
		return
	}
	page, err := s.libraryStore.ListPage(r.Context(), library.ListOptions{
		UserID: userID, Page: queryInt(r, "page", 1), PageSize: queryInt(r, "pageSize", 24),
		Scope:  strings.ToLower(strings.TrimSpace(r.URL.Query().Get("scope"))),
		Status: strings.TrimSpace(r.URL.Query().Get("status")), Query: strings.TrimSpace(r.URL.Query().Get("q")),
		Sort: strings.TrimSpace(r.URL.Query().Get("sort")), Direction: strings.TrimSpace(r.URL.Query().Get("direction")),
		RandomSeed:              int64(queryInt(r, "seed", 1)),
		IncludeRecommendation:   strings.EqualFold(r.URL.Query().Get("recommendBadges"), "true"),
		RecommendationSessionID: recommendationSessionID,
		DemoOnly:                s.cfg.IsDemo(),
	})
	if err != nil {
		writeError(w, err)
		return
	}
	includeRecommendation := r.URL.Query().Get("recommendBadges") == "true" && !strings.EqualFold(r.URL.Query().Get("sort"), "recommend")
	works, err := s.scanLibraryWorkRows(r.Context(), userID, page.Works, true, includeRecommendation)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"works":    works,
		"page":     page.Page,
		"pageSize": page.PageSize,
		"total":    page.Total,
	})
}

func librarySearchWhere(queryText string, userID ...int64) (string, []any) {
	if len(userID) > 0 {
		return library.SearchWhereForUser(queryText, userID[0])
	}
	return library.SearchWhere(queryText)
}

func (s *Server) seriesTitleIDForWork(ctx context.Context, code string) string {
	code = strings.TrimSpace(code)
	if code == "" {
		return ""
	}
	var titleID string
	if err := s.db.QueryRowContext(ctx, `
		SELECT series.title_id
		FROM party_series_work AS series_work
		INNER JOIN party_series AS series ON series.id = series_work.series_id
		WHERE UPPER(series_work.primary_code) = UPPER(?)
		ORDER BY series.last_seen_at DESC, series.id DESC
		LIMIT 1
	`, code).Scan(&titleID); err != nil {
		return ""
	}
	return titleID
}

type libraryWorkSummary struct {
	ID                     int64                `json:"id"`
	PrimaryCode            string               `json:"primaryCode"`
	Title                  string               `json:"title"`
	AgeRating              string               `json:"ageRating"`
	CreatedAt              string               `json:"createdAt"`
	UpdatedAt              string               `json:"updatedAt"`
	ReleaseDate            *string              `json:"releaseDate"`
	CoverURL               string               `json:"coverUrl"`
	DLsiteURL              string               `json:"dlsiteUrl"`
	Circle                 string               `json:"circle"`
	CircleExternalID       string               `json:"circleExternalId"`
	Rating                 *float64             `json:"rating"`
	RatingCount            *int64               `json:"ratingCount"`
	Sales                  *int64               `json:"sales"`
	HasNonOrigin           bool                 `json:"hasAvailableNonOriginEdition,omitempty"`
	RegularPrice           *int64               `json:"regularPrice"`
	Price                  *int64               `json:"price"`
	PriceCurrency          string               `json:"priceCurrency"`
	PermanentlyFree        *bool                `json:"permanentlyFree"`
	Tags                   []string             `json:"tags"`
	UserTags               []workUserTag        `json:"userTags"`
	VoiceActors            []string             `json:"voiceActors"`
	VoiceCredits           []voiceCredit        `json:"voiceCredits"`
	Series                 string               `json:"series"`
	SeriesTitleID          string               `json:"seriesTitleId"`
	TrackCount             int64                `json:"trackCount"`
	AvailableLocations     int64                `json:"availableLocations"`
	Availability           []string             `json:"availability"`
	SourcePresence         []sourcePresenceItem `json:"sourcePresence"`
	Progress               workProgressSummary  `json:"progress"`
	ListeningStatus        string               `json:"listeningStatus"`
	Favorite               bool                 `json:"favorite"`
	RecommendScore         int                  `json:"recommendScore"`
	mediaWorkID            int64
	availableLocationTypes string
	fallbackEditionCodes   []string
}

type listSearchClause = library.SearchClause

func parseListSearchClauses(query string) []listSearchClause {
	return library.ParseSearchClauses(query)
}

func stringSliceContainsSubstringFold(values []string, needle string) bool {
	for _, value := range values {
		if strings.Contains(strings.ToLower(value), needle) {
			return true
		}
	}
	return false
}

func numericListClauseValue(value string) float64 {
	return library.NumericClauseValue(value)
}

func availabilityBadges(rawTypes string) []string {
	if strings.TrimSpace(rawTypes) == "" {
		return []string{"missing"}
	}
	seen := map[string]bool{}
	badges := []string{}
	for _, item := range strings.Split(rawTypes, ",") {
		switch strings.TrimSpace(item) {
		case "local":
			if !seen["local"] {
				seen["local"] = true
				badges = append(badges, "local")
			}
		case "cache":
			if !seen["cache"] {
				seen["cache"] = true
				badges = append(badges, "cache")
			}
		case "remote_stream", "remote_download":
			if !seen["remote"] {
				seen["remote"] = true
				badges = append(badges, "remote")
			}
		}
	}
	if len(badges) == 0 {
		return []string{"missing"}
	}
	return badges
}

func availabilityBadgesWithPresence(rawTypes string, presence []sourcePresenceItem) []string {
	badges := availabilityBadges(rawTypes)
	hasLocalPresence := false
	for _, item := range presence {
		if item.Type == "local" && item.Availability == "available" {
			hasLocalPresence = true
			break
		}
	}
	if !hasLocalPresence {
		return badges
	}
	filtered := make([]string, 0, len(badges)+1)
	hasLocalBadge := false
	for _, badge := range badges {
		if badge == "missing" {
			continue
		}
		if badge == "local" {
			hasLocalBadge = true
		}
		filtered = append(filtered, badge)
	}
	if !hasLocalBadge {
		filtered = append([]string{"local"}, filtered...)
	}
	if len(filtered) == 0 {
		return []string{"local"}
	}
	return filtered
}
