package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
)

type remoteWorksResponse struct {
	SourceID    int64               `json:"sourceId"`
	Works       []remoteWorkSummary `json:"works"`
	Page        int                 `json:"page"`
	PageSize    int                 `json:"pageSize"`
	Total       int                 `json:"total"`
	Status      string              `json:"status"`
	Error       *remoteWorksError   `json:"error,omitempty"`
	Sort        string              `json:"sort"`
	Direction   string              `json:"direction"`
	SortApplied bool                `json:"sortApplied"`
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
	HasNonOrigin    bool              `json:"hasAvailableNonOriginEdition,omitempty"`
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
}

func (s *Server) listRemoteSourceWorks(w http.ResponseWriter, r *http.Request) {
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
	request := newRemoteSourceWorksRequest(r, source.SourceType, remoteSourceRequestLanguages(source.Config.RequestLanguage))
	if err := s.serveRemoteSourceWorksPage(w, r, userID, source, diagnosticURL, request); err != nil {
		writeError(w, err)
	}
}

type remoteSourceWorksRequest struct {
	Page                  int
	PageSize              int
	Query                 string
	Seed                  string
	Plan                  remoteSourceQueryPlan
	Sort                  string
	UpstreamOrder         string
	Direction             string
	Languages             []string
	IncludeRecommendation bool
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
	client := s.kikoeruClientForSource(source)
	if s.cfg.IsDemo() {
		works, total, sortApplied, err := s.demoRemoteSourcePageWithLanguages(ctx, userID, source.ID, client, source.SourceType, request.Query, request.UpstreamOrder, request.Direction, request.Seed, request.Page, request.PageSize, request.Languages, request.IncludeRecommendation)
		return s.writeRemoteSourceWorksResult(w, ctx, source, diagnosticURL, request, works, total, sortApplied, err)
	}
	if len(request.Plan.PostFilterClauses) > 0 {
		works, total, sortApplied, err := s.remotePostFilteredPageWithLanguages(ctx, userID, source.ID, client, request.Plan, request.UpstreamOrder, request.Direction, request.Seed, request.Page, request.PageSize, request.Languages)
		return s.writeRemoteSourceWorksResult(w, ctx, source, diagnosticURL, request, works, total, sortApplied, err)
	}
	remotePage, err := client.ListWorksSortedSeeded(ctx, request.Page, request.PageSize, request.Plan.PushdownQuery, request.UpstreamOrder, request.Direction, request.Seed)
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		s.writeRemoteWorksUnavailable(w, source, request.Page, request.PageSize, request.Sort, request.Direction, diagnosticURL, err)
		return nil
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	works, err := s.remoteWorkSummariesWithLanguages(ctx, userID, source.ID, remotePage.Works, request.Languages, request.IncludeRecommendation)
	if err != nil {
		return err
	}
	writeJSON(w, http.StatusOK, remoteWorksResponse{SourceID: source.ID, Works: works, Page: request.Page, PageSize: request.PageSize, Total: remotePageTotal(remotePage), Status: "ok", Sort: request.Sort, Direction: request.Direction, SortApplied: remotePage.SortApplied})
	return nil
}

func (s *Server) writeRemoteSourceWorksResult(w http.ResponseWriter, ctx context.Context, source remoteSourceForUse, diagnosticURL string, request remoteSourceWorksRequest, works []remoteWorkSummary, total int, sortApplied bool, err error) error {
	if err != nil {
		_ = s.updateSourceHealth(ctx, source.ID, "unavailable")
		s.writeRemoteWorksUnavailable(w, source, request.Page, request.PageSize, request.Sort, request.Direction, diagnosticURL, err)
		return nil
	}
	_ = s.updateSourceHealth(ctx, source.ID, "healthy")
	writeJSON(w, http.StatusOK, remoteWorksResponse{SourceID: source.ID, Works: works, Page: request.Page, PageSize: request.PageSize, Total: total, Status: "ok", Sort: request.Sort, Direction: request.Direction, SortApplied: sortApplied})
	return nil
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

func (s *Server) demoRemoteSourcePage(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	sourceType string,
	query string,
	upstreamOrder string,
	direction string,
	seed string,
	page int,
	pageSize int,
	language string,
	includeRecommendation bool,
) ([]remoteWorkSummary, int, bool, error) {
	return s.demoRemoteSourcePageWithLanguages(ctx, userID, sourceID, client, sourceType, query, upstreamOrder, direction, seed, page, pageSize, []string{language}, includeRecommendation)
}

func (s *Server) demoRemoteSourcePageWithLanguages(
	ctx context.Context,
	userID int64,
	sourceID int64,
	client *kikoeru.Client,
	sourceType string,
	query string,
	upstreamOrder string,
	direction string,
	seed string,
	page int,
	pageSize int,
	languages []string,
	includeRecommendation bool,
) ([]remoteWorkSummary, int, bool, error) {
	plan := demoRemoteSourceQueryPlan(query, sourceType)
	if len(plan.PostFilterClauses) > 0 {
		return s.remotePostFilteredPageWithLanguages(ctx, userID, sourceID, client, plan, upstreamOrder, direction, seed, page, pageSize, languages, includeRecommendation)
	}
	remotePage, err := client.SearchWorksSortedSeeded(ctx, page, pageSize, plan.PushdownQuery, upstreamOrder, direction, seed)
	if err != nil {
		return nil, 0, false, err
	}
	works, err := s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, remotePage.Works, languages, includeRecommendation)
	if err != nil {
		return nil, 0, false, err
	}
	return works, firstPositiveInt(remotePage.Pagination.TotalCount, remotePage.Pagination.Total, remotePage.Pagination.Count), remotePage.SortApplied, nil
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
	includeRecommendation ...bool,
) ([]remoteWorkSummary, int, bool, error) {
	return s.remotePostFilteredPageWithLanguages(ctx, userID, sourceID, client, plan, order, direction, seed, page, pageSize, []string{language}, includeRecommendation...)
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
	includeRecommendation ...bool,
) ([]remoteWorkSummary, int, bool, error) {
	const upstreamPageSize = 100
	const maxUpstreamPages = 100
	filtered := []remoteWorkSummary{}
	seen := map[string]bool{}
	sortApplied := true
	for upstreamPage := 1; upstreamPage <= maxUpstreamPages; upstreamPage++ {
		var result kikoeru.WorksPage
		var err error
		if s.cfg.IsDemo() {
			result, err = client.SearchWorksSortedSeeded(ctx, upstreamPage, upstreamPageSize, plan.PushdownQuery, order, direction, seed)
		} else {
			result, err = client.ListWorksSortedSeeded(ctx, upstreamPage, upstreamPageSize, plan.PushdownQuery, order, direction, seed)
		}
		if err != nil {
			return nil, 0, false, err
		}
		sortApplied = sortApplied && result.SortApplied
		summaries, err := s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, result.Works, languages, includeRecommendation...)
		if err != nil {
			return nil, 0, false, err
		}
		for _, work := range filterRemoteWorkSummaries(summaries, plan.PostFilterClauses) {
			key := strings.ToUpper(strings.TrimSpace(work.PrimaryCode)) + ":" + work.RemoteID
			if seen[key] {
				continue
			}
			seen[key] = true
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
}

func planRemoteSourceQuery(query string, sourceType string) remoteSourceQueryPlan {
	clauses := parseListSearchClauses(query)
	if len(clauses) == 0 {
		return remoteSourceQueryPlan{}
	}
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
		return "$age:" + clause.Value + "$"
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
	case "code", "circle", "age":
		return remoteWorkSummaryMatchesTextClause(work, clause.Kind, needle)
	case "tag", "exclude_tag", "voice_actor", "user_tag", "exclude_user_tag":
		return remoteWorkSummaryMatchesTagClause(work, clause.Kind, needle)
	case "rating_min", "sales_min", "duration_min", "duration_max":
		return remoteWorkSummaryMatchesNumericClause(work, clause.Kind, needle)
	case "language":
		return false
	default:
		return remoteWorkSummaryMatchesFreeText(work, needle)
	}
}

func remoteWorkSummaryMatchesTextClause(work remoteWorkSummary, kind, needle string) bool {
	switch kind {
	case "code":
		return strings.Contains(strings.ToLower(work.PrimaryCode), needle) || strings.Contains(strings.ToLower(work.RemoteCode), needle) || strings.Contains(strings.ToLower(work.RemoteID), needle)
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
	case "voice_actor":
		values = work.VoiceActors
	default:
		values = work.SearchUserTags
	}
	matched := stringSliceContainsSubstringFold(values, needle)
	if kind == "exclude_tag" || kind == "exclude_user_tag" {
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
	return stringSliceContainsSubstringFold([]string{work.PrimaryCode, work.RemoteCode, work.RemoteID, work.Title, work.Circle, work.ReleaseDate, work.AgeRating}, needle) ||
		stringSliceContainsSubstringFold(work.Tags, needle) || stringSliceContainsSubstringFold(work.VoiceActors, needle) ||
		stringSliceContainsSubstringFold(work.SearchUserTags, needle)
}

func (s *Server) remoteWorkSummaries(ctx context.Context, userID int64, sourceID int64, works []kikoeru.Work, language string, includeRecommendation ...bool) ([]remoteWorkSummary, error) {
	return s.remoteWorkSummariesWithLanguages(ctx, userID, sourceID, works, []string{language}, includeRecommendation...)
}

func (s *Server) remoteWorkSummariesWithLanguages(ctx context.Context, userID int64, sourceID int64, works []kikoeru.Work, languages []string, includeRecommendation ...bool) ([]remoteWorkSummary, error) {
	result := make([]remoteWorkSummary, 0, len(works))
	seen := map[string]int{}
	projector := newRemoteCatalogProjectorWithLanguages(languages)
	for _, work := range works {
		item, err := s.buildRemoteWorkSummary(ctx, userID, sourceID, projector, work, includeRecommendation...)
		if err != nil {
			return nil, err
		}
		key := strings.ToUpper(strings.TrimSpace(item.PrimaryCode))
		if index, ok := seen[key]; ok {
			mergeRemoteWorkSummary(&result[index], item)
			continue
		}
		seen[key] = len(result)
		result = append(result, item)
	}
	return s.enrichRemoteWorkSummaries(ctx, userID, result)
}

func (s *Server) buildRemoteWorkSummary(ctx context.Context, userID, sourceID int64, projector remoteCatalogProjector, work kikoeru.Work, includeRecommendation ...bool) (remoteWorkSummary, error) {
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
	if workID != nil && len(includeRecommendation) > 0 && includeRecommendation[0] {
		recommendScore, err = s.workRecommendationScore(ctx, userID, *workID)
		if err != nil {
			return remoteWorkSummary{}, err
		}
	}
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
	}, nil
}

func mergeRemoteWorkSummary(existing *remoteWorkSummary, item remoteWorkSummary) {
	existing.RemotePlayable = existing.RemotePlayable || item.RemotePlayable
	existing.Favorite = existing.Favorite || item.Favorite
	if existing.ListeningStatus == "none" {
		existing.ListeningStatus = item.ListeningStatus
	}
	if existing.WorkID == nil {
		existing.WorkID, existing.ImportStatus = item.WorkID, item.ImportStatus
	}
	if existing.Price == nil {
		existing.Price = item.Price
	}
	if existing.RemoteCode == "" || strings.EqualFold(item.RemoteCode, item.PrimaryCode) {
		existing.RemoteCode, existing.RemoteID = item.RemoteCode, item.RemoteID
	}
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
	availableNonOriginEditions, err := s.loadAvailableNonOriginEditions(ctx, workIDs)
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
		result[index].HasNonOrigin = availableNonOriginEditions[*result[index].WorkID]
	}
	return result, nil
}
