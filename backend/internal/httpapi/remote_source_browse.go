package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/yexca/kikoto/backend/internal/agerating"
	"github.com/yexca/kikoto/backend/internal/dlsite"
	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type remoteWorksResponse struct {
	SourceID                  int64               `json:"sourceId"`
	Works                     []remoteWorkSummary `json:"works"`
	Page                      int                 `json:"page"`
	PageSize                  int                 `json:"pageSize"`
	Total                     int                 `json:"total"`
	Status                    string              `json:"status"`
	Error                     *remoteWorksError   `json:"error,omitempty"`
	Sort                      string              `json:"sort"`
	Direction                 string              `json:"direction"`
	SortApplied               bool                `json:"sortApplied"`
	RecommendationUnavailable bool                `json:"recommendationUnavailable,omitempty"`
}

type remoteWorksError struct {
	Code      string `json:"code"`
	Message   string `json:"message"`
	URL       string `json:"url,omitempty"`
	Retryable bool   `json:"retryable"`
}

const (
	remoteSourceDisabledMessage    = "Remote source is disabled. Enable it in source settings before browsing."
	remoteSourceUnavailableMessage = "Remote source service is unavailable. Check the configured endpoint and try again."
)

type remoteWorkSummary struct {
	RemoteID        string            `json:"remoteId"`
	PrimaryCode     string            `json:"primaryCode"`
	RemoteCode      string            `json:"remoteCode"`
	Title           string            `json:"title"`
	ReleaseDate     string            `json:"releaseDate"`
	UpdatedAt       string            `json:"updatedAt"`
	CoverURL        string            `json:"coverUrl"`
	Circle          string            `json:"circle"`
	CircleRef       *remoteEntityRef  `json:"circleRef,omitempty"`
	AgeRating       string            `json:"ageRating"`
	Rating          *float64          `json:"rating"`
	RatingCount     *int64            `json:"ratingCount"`
	Sales           *int64            `json:"sales"`
	HasLyrics       bool              `json:"hasLyrics,omitempty"`
	Price           *int64            `json:"price"`
	Tags            []string          `json:"tags"`
	VoiceActors     []string          `json:"voiceActors"`
	VoiceRefs       []remoteEntityRef `json:"voiceRefs"`
	ImportStatus    string            `json:"importStatus"`
	RemotePlayable  bool              `json:"remotePlayable"`
	WorkID          *int64            `json:"workId"`
	Favorite        bool              `json:"favorite"`
	ListeningStatus string            `json:"listeningStatus"`
	RecommendScore  int               `json:"recommendScore"`
	DurationSeconds *int64            `json:"-"`
	SearchUserTags  []string          `json:"-"`
	// Editions lists every edition of the card's work family that the upstream
	// returned, the presented one included.
	Editions []remoteWorkEdition `json:"editions"`
}

// remoteWorkEdition is one upstream entry folded into a remote card.
type remoteWorkEdition struct {
	RemoteID   string `json:"remoteId"`
	RemoteCode string `json:"remoteCode"`
	Title      string `json:"title"`
	Language   string `json:"language"`
	Label      string `json:"label"`
	Origin     bool   `json:"origin"`
}

func (s *Server) listRemoteSourceWorks(w http.ResponseWriter, r *http.Request) {
	if s.cfg.IsDemo() {
		sessionID := strings.TrimSpace(r.URL.Query().Get("recommendationSession"))
		if sessionID != "" && !recommendationSessionIDPattern.MatchString(sessionID) {
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid recommendation session", false)
			return
		}
	}
	userID := optionalUserID(r.Context())
	id, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid source id"})
		return
	}
	source, err := s.loadRemoteSourceForUse(r.Context(), id)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "source not found"})
			return
		}
		writeError(w, err)
		return
	}
	if !isKikoeruSourceType(source.SourceType) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "source is not a supported kikoeru source"})
		return
	}
	diagnosticURL := remoteSourceDiagnosticURL(r.Context(), source.Endpoint)
	if !source.Enabled {
		s.writeRemoteWorksDisabled(w, id, r, diagnosticURL)
		return
	}
	request := newRemoteSourceWorksRequest(r, source.SourceType, s.remoteSourceLanguages(r.Context(), source))
	if err := s.serveRemoteSourceWorksPage(w, r, userID, source, diagnosticURL, request); err != nil {
		writeError(w, err)
	}
}

type remoteSourceWorksRequest struct {
	Page                      int
	PageSize                  int
	Query                     string
	Seed                      string
	Plan                      remoteSourceQueryPlan
	Sort                      string
	UpstreamOrder             string
	Direction                 string
	Languages                 []string
	IncludeRecommendation     bool
	RecommendationUnavailable bool
}

func newRemoteSourceWorksRequest(r *http.Request, sourceType string, languages []string) remoteSourceWorksRequest {
	page := queryInt(r, "page", 1)
	pageSize := queryInt(r, "pageSize", 24)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 24
	}
	query := r.URL.Query().Get("q")
	sortName, upstreamOrder := remoteSourceSort(r.URL.Query().Get("sort"))
	return remoteSourceWorksRequest{
		Page: page, PageSize: pageSize, Query: query, Seed: r.URL.Query().Get("seed"),
		Plan: planRemoteSourceQuery(query, sourceType), Sort: sortName, UpstreamOrder: upstreamOrder,
		Direction: remoteSortDirection(r.URL.Query().Get("direction")), Languages: languages,
		IncludeRecommendation: r.URL.Query().Get("recommendBadges") == "true" && !strings.EqualFold(r.URL.Query().Get("sort"), "recommend"),
	}
}

func (s *Server) writeRemoteWorksDisabled(w http.ResponseWriter, sourceID int64, r *http.Request, diagnosticURL string) {
	sortName, _ := remoteSourceSort(r.URL.Query().Get("sort"))
	writeJSON(w, http.StatusOK, remoteWorksResponse{
		SourceID: sourceID, Works: []remoteWorkSummary{}, Page: queryInt(r, "page", 1), PageSize: queryInt(r, "pageSize", 24),
		Status: "disabled", Error: &remoteWorksError{Code: "disabled", Message: remoteSourceDisabledMessage, URL: diagnosticURL, Retryable: false},
		Sort: sortName, Direction: remoteSortDirection(r.URL.Query().Get("direction")),
	})
}

func (s *Server) serveRemoteSourceWorksPage(w http.ResponseWriter, r *http.Request, userID int64, source remoteSourceForUse, diagnosticURL string, request remoteSourceWorksRequest) error {
	ctx := r.Context()
	client := s.kikoeruClientForSource(ctx, source)
	if len(request.Plan.PostFilterClauses) > 0 {
		works, total, sortApplied, err := s.remotePostFilteredPageUsing(ctx, userID, source.ID, request.Plan, request.Page, request.PageSize, request.Languages, s.remoteBrowsePageLoader(ctx, userID, source, request, client))
		if err == nil && request.IncludeRecommendation {
			request.RecommendationUnavailable = s.scoreRemoteWorkSummaries(r, userID, works) != nil
		}
		return s.writeRemoteSourceWorksResult(w, ctx, source, diagnosticURL, request, works, total, sortApplied, err)
	}
	remotePage, err := client.ListWorksSortedSeeded(ctx, request.Page, request.PageSize, request.Plan.PushdownQuery, request.UpstreamOrder, request.Direction, request.Seed)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		s.writeRemoteWorksUnavailable(w, source, request.Page, request.PageSize, request.Sort, request.Direction, diagnosticURL, err)
		return nil
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	works, err := s.remoteWorkSummariesWithLanguages(ctx, userID, source.ID, remotePage.Works, request.Languages, request.Plan.FocusCodes)
	if err != nil {
		return err
	}
	if request.IncludeRecommendation {
		if err := s.scoreRemoteWorkSummaries(r, userID, works); err != nil {
			request.RecommendationUnavailable = true
		}
	}
	works = s.presentRemoteWorkSummaries(ctx, source.ID, works)
	writeJSON(w, http.StatusOK, remoteWorksResponse{SourceID: source.ID, Works: works, Page: request.Page, PageSize: request.PageSize, Total: remoteFoldedPageTotal(remotePage, request.Page, request.PageSize, len(works)), Status: "ok", Sort: request.Sort, Direction: request.Direction, SortApplied: remotePage.SortApplied, RecommendationUnavailable: request.RecommendationUnavailable})
	return nil
}

// remoteFoldedPageTotal counts the folded cards when the first page holds the
// whole upstream result. Otherwise it keeps the upstream entry count, because
// folding on pages not loaded is unknown and a smaller total would hide pages.
func remoteFoldedPageTotal(page kikoeru.WorksPage, pageNumber, pageSize, cards int) int {
	total := remotePageTotal(page)
	if pageNumber != 1 {
		return total
	}
	if total > 0 {
		if total <= len(page.Works) {
			return cards
		}
		return total
	}
	if len(page.Works) < pageSize {
		return cards
	}
	return total
}

func (s *Server) writeRemoteSourceWorksResult(w http.ResponseWriter, ctx context.Context, source remoteSourceForUse, diagnosticURL string, request remoteSourceWorksRequest, works []remoteWorkSummary, total int, sortApplied bool, err error) error {
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		s.writeRemoteWorksUnavailable(w, source, request.Page, request.PageSize, request.Sort, request.Direction, diagnosticURL, err)
		return nil
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	works = s.presentRemoteWorkSummaries(ctx, source.ID, works)
	writeJSON(w, http.StatusOK, remoteWorksResponse{SourceID: source.ID, Works: works, Page: request.Page, PageSize: request.PageSize, Total: total, Status: "ok", Sort: request.Sort, Direction: request.Direction, SortApplied: sortApplied, RecommendationUnavailable: request.RecommendationUnavailable})
	return nil
}

// presentRemoteWorkSummaries applies the address visibility rule to a page
// of remote works. It copies the page, because summaries can be shared with
// the browse cache that serves every viewer.
func (s *Server) presentRemoteWorkSummaries(ctx context.Context, sourceID int64, works []remoteWorkSummary) []remoteWorkSummary {
	if !s.remoteAddressesHidden(ctx) {
		return works
	}
	presented := append([]remoteWorkSummary(nil), works...)
	for index := range presented {
		presented[index].CoverURL = s.remoteImageProxyURL(sourceID, presented[index].CoverURL)
	}
	return presented
}

func remotePageTotal(page kikoeru.WorksPage) int {
	if page.Pagination.TotalCount > 0 {
		return page.Pagination.TotalCount
	}
	if page.Pagination.Total > 0 {
		return page.Pagination.Total
	}
	return page.Pagination.Count
}

func (s *Server) writeRemoteWorksUnavailable(
	w http.ResponseWriter,
	source remoteSourceForUse,
	page int,
	pageSize int,
	sortName string,
	direction string,
	diagnosticURL string,
	err error,
) {
	// Keep the upstream detail in protected logs while returning a stable,
	// source-local status that the library can render without exposing it.
	slog.Error("remote source works request failed", "source_id", source.ID, "error", err)
	writeJSON(w, http.StatusOK, remoteWorksResponse{
		SourceID: source.ID,
		Works:    []remoteWorkSummary{},
		Page:     page,
		PageSize: pageSize,
		Total:    0,
		Status:   "unavailable",
		Error: &remoteWorksError{
			Code:      "unavailable",
			Message:   remoteSourceUnavailableMessage,
			URL:       diagnosticURL,
			Retryable: true,
		},
		Sort:      sortName,
		Direction: direction,
	})
}

func (s *Server) remotePostFilteredPage(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	plan remoteSourceQueryPlan,
	order string,
	direction string,
	seed string,
	page int,
	pageSize int,
	language string,
) ([]remoteWorkSummary, int, bool, error) {
	return s.remotePostFilteredPageWithLanguages(ctx, userID, sourceID, client, plan, order, direction, seed, page, pageSize, []string{language})
}

func (s *Server) remotePostFilteredPageWithLanguages(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	plan remoteSourceQueryPlan,
	order string,
	direction string,
	seed string,
	page int,
	pageSize int,
	languages []string,
) ([]remoteWorkSummary, int, bool, error) {
	return s.remotePostFilteredPageUsing(ctx, userID, sourceID, plan, page, pageSize, languages, func(upstreamPage int) (kikoeru.WorksPage, error) {
		return client.ListWorksSortedSeeded(ctx, upstreamPage, 100, plan.PushdownQuery, order, direction, seed)
	})
}

func (s *Server) remotePostFilteredPageUsing(ctx context.Context, userID, sourceID int64, plan remoteSourceQueryPlan, page, pageSize int, languages []string, loadPage func(int) (kikoeru.WorksPage, error)) ([]remoteWorkSummary, int, bool, error) {
	const upstreamPageSize = 100
	const maxUpstreamPages = 100
	filtered := []remoteWorkSummary{}
	families := map[string]int{}
	preference := remoteEditionPreference{codes: plan.FocusCodes, languages: languages}
	sortApplied := true
	for upstreamPage := 1; upstreamPage <= maxUpstreamPages; upstreamPage++ {
		result, err := loadPage(upstreamPage)
		if err != nil {
			return nil, 0, false, err
		}
		sortApplied = sortApplied && result.SortApplied
		summaries, err := s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, result.Works, languages, plan.FocusCodes)
		if err != nil {
			return nil, 0, false, err
		}
		// A family split across upstream pages still shows as one card.
		for _, work := range filterRemoteWorkSummaries(summaries, plan.PostFilterClauses) {
			key := remoteWorkFamilyKey(work)
			if index, ok := families[key]; ok {
				filtered[index] = mergeRemoteWorkFamily(filtered[index], work, preference)
				continue
			}
			families[key] = len(filtered)
			filtered = append(filtered, work)
		}
		upstreamTotal := firstPositiveInt(result.Pagination.TotalCount, result.Pagination.Total, result.Pagination.Count)
		if len(result.Works) == 0 || len(result.Works) < upstreamPageSize || (upstreamTotal > 0 && upstreamPage*upstreamPageSize >= upstreamTotal) {
			break
		}
		if upstreamPage == maxUpstreamPages {
			return nil, 0, false, fmt.Errorf("remote filtered query exceeded %d upstream works", maxUpstreamPages*upstreamPageSize)
		}
	}
	total := len(filtered)
	start := (page - 1) * pageSize
	if start >= total {
		return []remoteWorkSummary{}, total, sortApplied, nil
	}
	end := min(start+pageSize, total)
	return filtered[start:end], total, sortApplied, nil
}

func firstPositiveInt(values ...int) int {
	for _, value := range values {
		if value > 0 {
			return value
		}
	}
	return 0
}

func remoteSourceSort(value string) (string, string) {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "code":
		return "code", "id"
	case "random":
		return "random", "random"
	case "release":
		return "release", "release"
	case "rating":
		return "rating", "rate_average_2dp"
	case "sales":
		return "sales", "dl_count"
	default:
		return "recent", "create_date"
	}
}

func remoteSortDirection(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), "asc") {
		return "asc"
	}
	return "desc"
}

type remoteSourceQueryPlan struct {
	PushdownQuery     string
	PushdownClause    *listSearchClause
	PostFilterClauses []listSearchClause
	// FocusCodes are the work codes the query names; a folded card presents
	// the edition the user searched for.
	FocusCodes []string
}

func planRemoteSourceQuery(query string, sourceType string) remoteSourceQueryPlan {
	clauses := parseListSearchClauses(query)
	if len(clauses) == 0 {
		return remoteSourceQueryPlan{}
	}
	plan := planRemoteSourceClauses(clauses, sourceType)
	for _, clause := range clauses {
		if clause.Kind == "code" {
			plan.FocusCodes = append(plan.FocusCodes, clause.Value)
		}
	}
	return plan
}

func planRemoteSourceClauses(clauses []listSearchClause, sourceType string) remoteSourceQueryPlan {
	if sourceType == sourceTypeKikoeruCompatible {
		plan := remoteSourceQueryPlan{}
		pushdown := make([]string, 0, len(clauses))
		for _, clause := range clauses {
			value := remoteSourcePushdownQuery(clause)
			if value == "" {
				plan.PostFilterClauses = append(plan.PostFilterClauses, clause)
				continue
			}
			if plan.PushdownClause == nil {
				copyClause := clause
				plan.PushdownClause = &copyClause
			}
			pushdown = append(pushdown, value)
		}
		plan.PushdownQuery = strings.Join(pushdown, " ")
		return plan
	}
	pushdownIndex := -1
	bestRank := 999
	for index, clause := range clauses {
		rank := remoteSourcePushdownRank(clause)
		if rank < bestRank {
			bestRank = rank
			pushdownIndex = index
		}
	}
	plan := remoteSourceQueryPlan{}
	for index, clause := range clauses {
		if index == pushdownIndex {
			pushdown := remoteSourcePushdownQuery(clause)
			if pushdown != "" {
				plan.PushdownQuery = pushdown
				copyClause := clause
				plan.PushdownClause = &copyClause
				continue
			}
		}
		plan.PostFilterClauses = append(plan.PostFilterClauses, clause)
	}
	return plan
}

func remoteSourcePushdownRank(clause listSearchClause) int {
	switch clause.Kind {
	case "language":
		return 0
	case "code":
		return 1
	case "circle", "voice_actor", "tag":
		return 2
	case "text":
		return 3
	case "rating_min", "sales_min", "duration_min", "duration_max", "age":
		return 4
	default:
		return 999
	}
}

func remoteSourcePushdownQuery(clause listSearchClause) string {
	switch clause.Kind {
	case "circle":
		return "$circle:" + clause.Value + "$"
	case "voice_actor":
		return "$va:" + clause.Value + "$"
	case "exclude_circle":
		return "$-circle:" + clause.Value + "$"
	case "exclude_voice_actor":
		return "$-va:" + clause.Value + "$"
	case "tag":
		return "$tag:" + clause.Value + "$"
	case "exclude_tag":
		return "$-tag:" + clause.Value + "$"
	case "rating_min":
		return "$rate:" + clause.Value + "$"
	case "sales_min":
		return "$sell:" + clause.Value + "$"
	case "duration_min":
		return "$duration:" + clause.Value + "$"
	case "duration_max":
		return "$-duration:" + clause.Value + "$"
	case "age":
		value := clause.Value
		if aliases := agerating.Aliases(value); len(aliases) > 0 {
			value = aliases[0]
		}
		return "$age:" + value + "$"
	case "language":
		return "$lang:" + clause.Value + "$"
	case "code", "text":
		return clause.Value
	default:
		return ""
	}
}

func filterRemoteWorkSummaries(works []remoteWorkSummary, clauses []listSearchClause) []remoteWorkSummary {
	result := make([]remoteWorkSummary, 0, len(works))
	for _, work := range works {
		if remoteWorkSummaryMatchesClauses(work, clauses) {
			result = append(result, work)
		}
	}
	return result
}

func remoteWorkSummaryMatchesClauses(work remoteWorkSummary, clauses []listSearchClause) bool {
	for _, clause := range clauses {
		if !remoteWorkSummaryMatchesClause(work, clause) {
			return false
		}
	}
	return true
}

func remoteWorkSummaryMatchesClause(work remoteWorkSummary, clause listSearchClause) bool {
	needle := strings.ToLower(strings.TrimSpace(clause.Value))
	if needle == "" {
		return true
	}
	switch clause.Kind {
	case "age":
		return agerating.Matches(work.AgeRating, needle)
	case "code", "circle":
		return remoteWorkSummaryMatchesTextClause(work, clause.Kind, needle)
	case "exclude_circle":
		return !remoteWorkSummaryMatchesTextClause(work, "circle", needle)
	case "tag", "exclude_tag", "voice_actor", "exclude_voice_actor", "user_tag", "exclude_user_tag":
		return remoteWorkSummaryMatchesTagClause(work, clause.Kind, needle)
	case "rating_min", "sales_min", "duration_min", "duration_max":
		return remoteWorkSummaryMatchesNumericClause(work, clause.Kind, needle)
	case "language":
		return false
	// A remote source summary carries no staff credits.
	case "staff", "author", "scenario", "illustration":
		return false
	case "exclude_staff", "exclude_author", "exclude_scenario", "exclude_illustration":
		return true
	default:
		return remoteWorkSummaryMatchesFreeText(work, needle)
	}
}

func remoteWorkSummaryMatchesTextClause(work remoteWorkSummary, kind, needle string) bool {
	switch kind {
	case "code":
		return stringSliceContainsSubstringFold(remoteWorkSummaryCodes(work), needle)
	case "circle":
		return strings.Contains(strings.ToLower(work.Circle), needle)
	default:
		return strings.Contains(strings.ToLower(work.AgeRating), needle)
	}
}

func remoteWorkSummaryMatchesTagClause(work remoteWorkSummary, kind, needle string) bool {
	var values []string
	switch kind {
	case "tag", "exclude_tag":
		values = work.Tags
	case "voice_actor", "exclude_voice_actor":
		values = work.VoiceActors
	default:
		values = work.SearchUserTags
	}
	matched := stringSliceContainsSubstringFold(values, needle)
	if kind == "exclude_tag" || kind == "exclude_voice_actor" || kind == "exclude_user_tag" {
		return !matched
	}
	return matched
}

func remoteWorkSummaryMatchesNumericClause(work remoteWorkSummary, kind, needle string) bool {
	threshold := numericListClauseValue(needle)
	switch kind {
	case "rating_min":
		return work.Rating != nil && *work.Rating >= threshold
	case "sales_min":
		return work.Sales != nil && float64(*work.Sales) >= threshold
	case "duration_min":
		return work.DurationSeconds != nil && float64(*work.DurationSeconds) >= threshold
	default:
		return work.DurationSeconds != nil && float64(*work.DurationSeconds) <= threshold
	}
}

func remoteWorkSummaryMatchesFreeText(work remoteWorkSummary, needle string) bool {
	if stringSliceContainsSubstringFold(remoteWorkSummaryCodes(work), needle) {
		return true
	}
	for _, edition := range work.Editions {
		if strings.Contains(strings.ToLower(edition.Title), needle) {
			return true
		}
	}
	return stringSliceContainsSubstringFold([]string{work.Title, work.Circle, work.ReleaseDate, work.AgeRating}, needle) ||
		stringSliceContainsSubstringFold(work.Tags, needle) || stringSliceContainsSubstringFold(work.VoiceActors, needle) ||
		stringSliceContainsSubstringFold(work.SearchUserTags, needle)
}

// remoteWorkSummaryCodes are the codes and ids a card answers to: its family
// code and every folded edition's.
func remoteWorkSummaryCodes(work remoteWorkSummary) []string {
	codes := []string{work.PrimaryCode, work.RemoteCode, work.RemoteID}
	for _, edition := range work.Editions {
		codes = append(codes, edition.RemoteCode, edition.RemoteID)
	}
	return codes
}

func (s *Server) remoteWorkSummaries(ctx context.Context, userID int64, sourceID int64, works []kikoeru.Work, language string) ([]remoteWorkSummary, error) {
	return s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, works, []string{language}, nil)
}

// remoteWorkSummariesWithLanguages folds upstream entries whose codes belong
// to one locally known work family into one card. Only persisted family
// relationships fold entries; a family the library does not know keeps one
// card per upstream entry.
func (s *Server) remoteWorkSummariesWithLanguages(ctx context.Context, userID int64, sourceID int64, works []kikoeru.Work, languages []string, focusCodes []string) ([]remoteWorkSummary, error) {
	result := make([]remoteWorkSummary, 0, len(works))
	seen := map[string]int{}
	projector := newRemoteCatalogProjectorWithLanguages(languages)
	preference := remoteEditionPreference{codes: focusCodes, languages: languages}
	for _, work := range works {
		item, err := s.buildRemoteWorkSummary(ctx, userID, sourceID, projector, work)
		if err != nil {
			return nil, err
		}
		key := remoteWorkFamilyKey(item)
		if index, ok := seen[key]; ok {
			result[index] = mergeRemoteWorkFamily(result[index], item, preference)
			continue
		}
		seen[key] = len(result)
		result = append(result, item)
	}
	return s.enrichRemoteWorkSummaries(ctx, userID, result)
}

func remoteWorkFamilyKey(work remoteWorkSummary) string {
	if code := strings.ToUpper(strings.TrimSpace(work.PrimaryCode)); code != "" {
		return code
	}
	return "remote:" + work.RemoteID
}

func (s *Server) buildRemoteWorkSummary(ctx context.Context, userID, sourceID int64, projector remoteCatalogProjector, work kikoeru.Work) (remoteWorkSummary, error) {
	projected := projector.project(sourceID, work)
	code := projected.RemoteCode
	displayCode := code
	ref, err := s.canonicalWorkForCode(ctx, code)
	if err != nil {
		return remoteWorkSummary{}, err
	}
	if ref.Code != "" {
		displayCode = ref.Code
	}
	var workID *int64
	var favorite bool
	listeningStatus := "none"
	if ref.Known && ref.WorkID > 0 {
		workID = &ref.WorkID
		var favoriteInt int
		if err := s.db.QueryRowContext(ctx, `
			SELECT COALESCE(favorite, 0), COALESCE(listening_status, 'none')
			FROM user_work_state
			WHERE user_id = ? AND work_id = ?
		`, userID, *workID).Scan(&favoriteInt, &listeningStatus); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return remoteWorkSummary{}, err
		} else if err == nil {
			favorite = favoriteInt != 0
		}
	}
	recommendScore := 0
	status := "remote_only"
	if workID != nil {
		status = "synced"
	}
	return remoteWorkSummary{
		RemoteID: projected.RemoteID, PrimaryCode: displayCode, RemoteCode: code,
		Title: firstNonEmpty(projected.Title, displayCode), ReleaseDate: projected.ReleaseDate,
		UpdatedAt: projected.ReleaseDate, CoverURL: projected.CoverURL, Circle: projected.Circle,
		CircleRef: projected.CircleRef, AgeRating: projected.AgeRating, Rating: projected.Rating,
		RatingCount: projected.RatingCount, Sales: projected.Sales, Price: projected.Price,
		Tags: projected.Tags, VoiceActors: projected.VoiceActors, VoiceRefs: projected.VoiceRefs,
		ImportStatus: status, RemotePlayable: true, WorkID: workID, Favorite: favorite,
		ListeningStatus: listeningStatus, RecommendScore: recommendScore, DurationSeconds: projected.DurationSeconds,
		Editions: []remoteWorkEdition{remoteWorkOwnEdition(work, projected)},
	}, nil
}

// remoteWorkOwnEdition describes the edition one upstream entry is, from the
// entry's own family declaration.
func remoteWorkOwnEdition(work kikoeru.Work, projected remoteCatalogWorkProjection) remoteWorkEdition {
	code := projected.RemoteCode
	var declared kikoeru.LanguageEdition
	for _, edition := range work.LanguageEditions {
		if code != "" && strings.EqualFold(strings.TrimSpace(edition.WorkNo), code) {
			declared = edition
			break
		}
	}
	origin := false
	if original := strings.TrimSpace(work.OriginalWorkNumber); original != "" {
		origin = strings.EqualFold(original, code)
	} else if order := earliestRemoteLanguageEditionOrder(work.LanguageEditions); order > 0 {
		origin = declared.DisplayOrder == order
	}
	language := strings.TrimSpace(declared.Language)
	if normalized := dlsite.NormalizeMetadataLanguage(language); normalized != "" {
		language = normalized
	}
	return remoteWorkEdition{
		RemoteID: projected.RemoteID, RemoteCode: code, Title: projected.Title,
		Language: language, Label: strings.TrimSpace(declared.Label), Origin: origin,
	}
}

// remoteEditionPreference decides which folded edition a card presents: the
// edition the query names, then the viewer's metadata languages in order,
// then the family's canonical code. Ties keep the earlier upstream entry.
type remoteEditionPreference struct {
	codes     []string
	languages []string
}

func (preference remoteEditionPreference) rank(work remoteWorkSummary) [3]int {
	edition := presentedRemoteWorkEdition(work)
	focus := 1
	for _, code := range preference.codes {
		if edition.RemoteCode != "" && strings.EqualFold(strings.TrimSpace(code), edition.RemoteCode) {
			focus = 0
			break
		}
	}
	language := len(preference.languages)
	for index, token := range preference.languages {
		if remoteEditionHasLanguage(edition, token) {
			language = index
			break
		}
	}
	canonical := 1
	if edition.RemoteCode != "" && strings.EqualFold(edition.RemoteCode, work.PrimaryCode) {
		canonical = 0
	}
	return [3]int{focus, language, canonical}
}

func (preference remoteEditionPreference) prefers(candidate, current remoteWorkSummary) bool {
	left, right := preference.rank(candidate), preference.rank(current)
	for index := range left {
		if left[index] != right[index] {
			return left[index] < right[index]
		}
	}
	return false
}

func remoteEditionHasLanguage(edition remoteWorkEdition, token string) bool {
	token = strings.TrimSpace(token)
	if token == dlsite.OriginMetadataLanguage {
		return edition.Origin
	}
	normalized := dlsite.NormalizeMetadataLanguage(token)
	return normalized != "" && normalized == edition.Language
}

// presentedRemoteWorkEdition is the folded edition whose title, cover, and
// actions a card shows.
func presentedRemoteWorkEdition(work remoteWorkSummary) remoteWorkEdition {
	for _, edition := range work.Editions {
		if edition.RemoteID == work.RemoteID && strings.EqualFold(edition.RemoteCode, work.RemoteCode) {
			return edition
		}
	}
	return remoteWorkEdition{RemoteID: work.RemoteID, RemoteCode: work.RemoteCode, Title: work.Title}
}

// mergeRemoteWorkFamily folds two cards of one work family. The preferred
// card's edition supplies every presented field, so a card never mixes one
// edition's code with another's title, cover, or price.
func mergeRemoteWorkFamily(existing, item remoteWorkSummary, preference remoteEditionPreference) remoteWorkSummary {
	merged, other := existing, item
	if preference.prefers(item, existing) {
		merged, other = item, existing
	}
	merged.Editions = mergeRemoteWorkEditions(existing.Editions, item.Editions)
	merged.RemotePlayable = merged.RemotePlayable || other.RemotePlayable
	merged.Favorite = merged.Favorite || other.Favorite
	if merged.ListeningStatus == "none" {
		merged.ListeningStatus = other.ListeningStatus
	}
	if merged.WorkID == nil {
		merged.WorkID, merged.ImportStatus = other.WorkID, other.ImportStatus
	}
	return merged
}

// mergeRemoteWorkEditions keeps each upstream entry once, the origin edition
// first and the rest in upstream order.
func mergeRemoteWorkEditions(left, right []remoteWorkEdition) []remoteWorkEdition {
	result := make([]remoteWorkEdition, 0, len(left)+len(right))
	seen := map[string]bool{}
	for _, edition := range append(append([]remoteWorkEdition(nil), left...), right...) {
		key := strings.ToUpper(edition.RemoteCode) + ":" + edition.RemoteID
		if seen[key] {
			continue
		}
		seen[key] = true
		result = append(result, edition)
	}
	sort.SliceStable(result, func(i, j int) bool { return result[i].Origin && !result[j].Origin })
	return result
}

func (s *Server) enrichRemoteWorkSummaries(ctx context.Context, userID int64, result []remoteWorkSummary) ([]remoteWorkSummary, error) {
	workIDs := make([]int64, 0, len(result))
	for _, item := range result {
		if item.WorkID != nil {
			workIDs = append(workIDs, *item.WorkID)
		}
	}
	userTagsByWork, err := s.loadWorkUserTagsBatch(ctx, userID, workIDs)
	if err != nil {
		return nil, err
	}
	worksWithLyrics, err := s.loadWorksWithLyrics(ctx, workIDs)
	if err != nil {
		return nil, err
	}
	for index := range result {
		if result[index].WorkID == nil {
			result[index].SearchUserTags = []string{}
			continue
		}
		for _, tag := range userTagsByWork[*result[index].WorkID] {
			result[index].SearchUserTags = append(result[index].SearchUserTags, tag.Name)
		}
		result[index].HasLyrics = worksWithLyrics[*result[index].WorkID]
	}
	return result, nil
}
