package httpapi

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/library"
)

type favoriteWorksResponse struct {
	Works        []libraryWorkSummary `json:"works"`
	Page         int                  `json:"page"`
	PageSize     int                  `json:"pageSize"`
	Total        int                  `json:"total"`
	ShelfTotal   int                  `json:"shelfTotal"`
	ListCounts   map[int64]int        `json:"listCounts"`
	StatusCounts map[string]int       `json:"statusCounts"`
	// NewCounts holds the smart lists that have new works.
	NewCounts map[int64]int `json:"newCounts"`
	// NewWorkIDs names the works of this page that are new in the smart list.
	NewWorkIDs []int64 `json:"newWorkIds"`
}

func (s *Server) listFavoriteWorks(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	query, err := parseFavoriteWorksQuery(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	queryText := strings.TrimSpace(r.URL.Query().Get("q"))
	s.libraryStore.PrepareSearch(r.Context(), queryText)
	scope, err := s.loadFavoriteListScope(r.Context(), s.db, user.ID, query.ListID)
	if err != nil {
		writeError(w, err)
		return
	}
	where, args := favoriteWorksWhere(
		strings.TrimSpace(r.URL.Query().Get("status")),
		strings.TrimSpace(r.URL.Query().Get("availability")),
		queryText,
		user.ID,
		scope,
		query.SourceIDs,
	)
	if query.NewOnly && scope.Kind == "smart" {
		newWhere, newArgs := smartListNewWhere(scope.ID, scope.Match)
		where = "(" + where + ") AND " + newWhere
		args = append(args, newArgs...)
	}
	where = s.demoWorkWhere(where, "work")
	total, favoriteTotal, err := s.favoriteWorksCounts(r.Context(), user.ID, where, args)
	if err != nil {
		writeError(w, err)
		return
	}
	rawWorks, err := s.libraryStore.ListMatchingSorted(r.Context(), where, args, library.MatchingListOptions{
		UserID: user.ID, Page: query.Page, PageSize: query.PageSize, Sort: query.Sort, Direction: query.Direction, RandomSeed: query.RandomSeed, ListID: query.ListID,
		TitleLanguages: s.titleSortLanguages(r.Context(), query.Sort),
	})
	if err != nil {
		writeError(w, err)
		return
	}
	works, err := s.scanLibraryWorkRows(r.Context(), user.ID, rawWorks, true)
	if err != nil {
		writeError(w, err)
		return
	}
	listCounts, newCounts, err := s.loadFavoriteListCounts(r.Context(), user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	statusCounts, err := s.loadFavoriteStatusCounts(r.Context(), user.ID, scope)
	if err != nil {
		writeError(w, err)
		return
	}
	pageWorkIDs := make([]int64, len(works))
	for index, work := range works {
		pageWorkIDs[index] = work.ID
	}
	newWorkIDs, err := s.smartListNewWorkIDs(r.Context(), scope, pageWorkIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, favoriteWorksResponse{
		Works: works, Page: query.Page, PageSize: query.PageSize, Total: total, ShelfTotal: favoriteTotal, ListCounts: listCounts, StatusCounts: statusCounts,
		NewCounts: newCounts, NewWorkIDs: newWorkIDs,
	})
}

func parseFavoriteWorksQuery(r *http.Request) (favoriteWorksQuery, error) {
	query := favoriteWorksQuery{Page: queryInt(r, "page", 1), PageSize: queryInt(r, "pageSize", 24), Sort: strings.ToLower(strings.TrimSpace(r.URL.Query().Get("sort"))), Direction: strings.ToLower(strings.TrimSpace(r.URL.Query().Get("direction"))), RandomSeed: int64(queryInt(r, "seed", 1))}
	if query.Page < 1 {
		query.Page = 1
	}
	if query.PageSize < 1 || query.PageSize > 100 {
		query.PageSize = 24
	}
	if query.Sort == "" {
		query.Sort = "added"
	}
	if query.Direction != "asc" {
		query.Direction = "desc"
	}
	if raw := strings.TrimSpace(r.URL.Query().Get("listId")); raw != "" && raw != "all" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			return favoriteWorksQuery{}, errors.New("invalid favorite list id")
		}
		query.ListID = parsed
	}
	sourceIDs, err := favoriteSourceIDs(r)
	if err != nil {
		return favoriteWorksQuery{}, err
	}
	query.SourceIDs = sourceIDs
	query.NewOnly = r.URL.Query().Get("new") == "true"
	return query, nil
}

func (s *Server) favoriteWorksCounts(ctx context.Context, userID int64, where string, args []any) (int, int, error) {
	countQuery := "SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE " + where
	countArgs := append([]any{userID}, args...)
	var total int
	if err := s.db.QueryRowContext(ctx, countQuery, countArgs...).Scan(&total); err != nil {
		return 0, 0, err
	}
	favoriteWhere, favoriteArgs := favoriteWorksWhere("all", "all", "", userID, favoriteShelfScope(userID), nil)
	favoriteWhere = s.demoWorkWhere(favoriteWhere, "work")
	favoriteCountQuery := "SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE " + favoriteWhere
	favoriteCountArgs := append([]any{userID}, favoriteArgs...)
	var favoriteTotal int
	if err := s.db.QueryRowContext(ctx, favoriteCountQuery, favoriteCountArgs...).Scan(&favoriteTotal); err != nil {
		return 0, 0, err
	}
	return total, favoriteTotal, nil
}

func favoriteWorksWhere(status string, availability string, queryText string, userID int64, scope favoriteListScope, sourceIDs []int64) (string, []any) {
	clauses := []string{scope.Where}
	args := append([]any{}, scope.Args...)
	if status != "" && status != "all" {
		clauses = append(clauses, "COALESCE(user_work_state.listening_status, 'none') = ?")
		args = append(args, status)
	}
	if sourceWhere, sourceArgs := favoriteSourceWhere(sourceIDs); sourceWhere != "" {
		clauses = append(clauses, sourceWhere)
		args = append(args, sourceArgs...)
	}
	if badgeWhere := library.AvailabilityBadgeWhere(strings.ToLower(strings.TrimSpace(availability))); badgeWhere != "" {
		clauses = append(clauses, badgeWhere)
	}
	searchWhere, searchArgs := librarySearchWhere(queryText, userID)
	if searchWhere != "" {
		clauses = append(clauses, searchWhere)
		args = append(args, searchArgs...)
	}
	clauses = append(clauses, `NOT EXISTS (
		SELECT 1
		FROM work_edition AS edition
		INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
		WHERE edition.work_id = work.id
			AND logical.canonical_work_id IS NOT NULL
			AND logical.canonical_work_id <> work.id
			AND edition.is_canonical = 0
	)`)
	return strings.Join(clauses, " AND "), args
}

func favoriteSourceIDs(r *http.Request) ([]int64, error) {
	const maxFavoriteSourceFilters = 50
	values := r.URL.Query()["sourceId"]
	if len(values) > maxFavoriteSourceFilters {
		return nil, errors.New("too many source ids")
	}
	result := make([]int64, 0, len(values))
	seen := map[int64]bool{}
	for _, raw := range values {
		value, err := strconv.ParseInt(strings.TrimSpace(raw), 10, 64)
		if err != nil || value <= 0 {
			return nil, errors.New("invalid source id")
		}
		if seen[value] {
			continue
		}
		seen[value] = true
		result = append(result, value)
	}
	return result, nil
}

func favoriteSourceWhere(sourceIDs []int64) (string, []any) {
	if len(sourceIDs) == 0 {
		return "", nil
	}
	placeholders := strings.TrimRight(strings.Repeat("?,", len(sourceIDs)), ",")
	args := make([]any, 0, len(sourceIDs)*2)
	for _, sourceID := range sourceIDs {
		args = append(args, sourceID)
	}
	for _, sourceID := range sourceIDs {
		args = append(args, sourceID)
	}
	return `(
		EXISTS (
			SELECT 1
			FROM work_source_presence AS favorite_source_presence
			WHERE favorite_source_presence.file_source_id IN (` + placeholders + `)
				AND favorite_source_presence.availability = 'available'
				AND (
					favorite_source_presence.work_id = work.id
					OR EXISTS (
						SELECT 1
						FROM work_edition AS favorite_current_edition
						INNER JOIN work_edition AS favorite_source_edition
							ON favorite_source_edition.logical_work_id = favorite_current_edition.logical_work_id
						WHERE favorite_current_edition.work_id = work.id
							AND favorite_source_edition.work_id = favorite_source_presence.work_id
					)
				)
		)
		OR EXISTS (
			SELECT 1
			FROM media_file_location AS favorite_source_location
			INNER JOIN media_item AS favorite_source_item ON favorite_source_item.id = favorite_source_location.media_item_id
			WHERE favorite_source_location.file_source_id IN (` + placeholders + `)
				AND favorite_source_location.availability = 'available'
				AND (
					favorite_source_item.work_id = work.id
					OR EXISTS (
						SELECT 1
						FROM work_edition AS favorite_current_edition
						INNER JOIN work_edition AS favorite_source_edition
							ON favorite_source_edition.logical_work_id = favorite_current_edition.logical_work_id
						WHERE favorite_current_edition.work_id = work.id
							AND favorite_source_edition.work_id = favorite_source_item.work_id
					)
				)
		)
	)`, args
}

// loadFavoriteListCounts counts every list of the user, and the new works of
// each smart list that has some.
func (s *Server) loadFavoriteListCounts(ctx context.Context, userID int64) (map[int64]int, map[int64]int, error) {
	counts, err := s.loadManualFavoriteListCounts(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	smartCounts, newCounts, err := s.loadSmartListCounts(ctx, userID)
	if err != nil {
		return nil, nil, err
	}
	for id, count := range smartCounts {
		counts[id] = count
	}
	return counts, newCounts, nil
}

func (s *Server) loadManualFavoriteListCounts(ctx context.Context, userID int64) (map[int64]int, error) {
	countExpression := "COUNT(CASE WHEN list.kind = 'marked' THEN marked_state.work_id ELSE item.work_id END)"
	workJoin := ""
	if s.cfg.IsDemo() {
		countExpression = "COUNT(CASE WHEN " + contentpolicy.DemoEligibleWorkSQL("work") + " THEN CASE WHEN list.kind = 'marked' THEN marked_state.work_id ELSE item.work_id END END)"
		workJoin = " LEFT JOIN work ON work.id = CASE WHEN list.kind = 'marked' THEN marked_state.work_id ELSE item.work_id END"
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT list.id, `+countExpression+`
		FROM favorite_list AS list
		LEFT JOIN favorite_list_item AS item ON item.list_id = list.id AND list.kind = 'user'
		LEFT JOIN user_work_state AS marked_state
			ON marked_state.user_id = list.user_id
			AND list.kind = 'marked'
			AND marked_state.listening_status <> 'none'
		`+workJoin+`
		WHERE list.user_id = ?
		GROUP BY list.id
	`, userID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	counts := map[int64]int{}
	for rows.Next() {
		var listID int64
		var count int
		if err := rows.Scan(&listID, &count); err != nil {
			return nil, err
		}
		counts[listID] = count
	}
	return counts, rows.Err()
}

func (s *Server) loadFavoriteStatusCounts(ctx context.Context, userID int64, scope favoriteListScope) (map[string]int, error) {
	where, args := favoriteWorksWhere("all", "all", "", userID, scope, nil)
	where = s.demoWorkWhere(where, "work")
	query := `
		SELECT COALESCE(user_work_state.listening_status, 'none'), COUNT(*)
		FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		WHERE ` + where + `
		GROUP BY COALESCE(user_work_state.listening_status, 'none')
	`
	queryArgs := append([]any{userID}, args...)
	rows, err := s.db.QueryContext(ctx, query, queryArgs...)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	counts := map[string]int{}
	for rows.Next() {
		var status string
		var count int
		if err := rows.Scan(&status, &count); err != nil {
			return nil, err
		}
		counts[status] = count
	}
	return counts, rows.Err()
}
