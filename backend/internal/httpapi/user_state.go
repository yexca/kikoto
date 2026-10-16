package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/personal"
)

type workUserStateResponse struct {
	WorkID          int64  `json:"workId"`
	ListeningStatus string `json:"listeningStatus"`
	Favorite        bool   `json:"favorite"`
}

type favoriteListResponse struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Icon        string `json:"icon"`
	SortOrder   int64  `json:"sortOrder"`
	Kind        string `json:"kind"`
	Selected    bool   `json:"selected,omitempty"`
	// MatchedByRule marks a smart list that shows the work through its rule
	// rather than because the work was added by hand.
	MatchedByRule bool `json:"matchedByRule,omitempty"`
	// Rule is set on smart lists.
	Rule *personal.SmartRuleView `json:"rule,omitempty"`
}

var errInvalidFavoriteListID = errors.New("invalid favorite list id")

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

func (s *Server) updateWorkUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM work WHERE id = ?", workID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}

	var payload struct {
		ListeningStatus *string `json:"listeningStatus"`
		Favorite        *bool   `json:"favorite"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if payload.Favorite != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "use favorite lists to change list membership"})
		return
	}
	var currentStatus string
	var currentFavorite int
	if err := s.db.QueryRowContext(r.Context(), `
		SELECT COALESCE(listening_status, 'none'), COALESCE(favorite, 0)
		FROM user_work_state
		WHERE user_id = ? AND work_id = ?
	`, user.ID, workID).Scan(&currentStatus, &currentFavorite); err != nil && !errors.Is(err, sql.ErrNoRows) {
		writeError(w, err)
		return
	}
	status := strings.TrimSpace(currentStatus)
	if payload.ListeningStatus != nil {
		status = strings.TrimSpace(*payload.ListeningStatus)
	}
	if status == "" {
		status = "none"
	}
	if !validListeningStatus(status) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid listening status"})
		return
	}
	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			listening_status = excluded.listening_status,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, workID, status, currentFavorite); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, workUserStateResponse{WorkID: workID, ListeningStatus: status, Favorite: currentFavorite != 0})
}

func (s *Server) listFavoriteLists(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	lists, err := s.loadFavoriteLists(r.Context(), user.ID, nil)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lists)
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

type favoriteWorksQuery struct {
	Page       int
	PageSize   int
	ListID     int64
	Sort       string
	Direction  string
	RandomSeed int64
	SourceIDs  []int64
	// NewOnly narrows a smart list to its new works.
	NewOnly bool
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
	defer rows.Close()
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
	defer rows.Close()
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

func (s *Server) createFavoriteList(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	var payload struct {
		Name        string              `json:"name"`
		Description string              `json:"description"`
		Icon        string              `json:"icon"`
		Kind        string              `json:"kind"`
		Rule        *personal.SmartRule `json:"rule"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	description := strings.TrimSpace(payload.Description)
	icon, ok := personal.NormalizeFavoriteListIcon(payload.Icon)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list icon"})
		return
	}
	kind := strings.TrimSpace(payload.Kind)
	if kind == "" {
		kind = "user"
	}
	if kind != "user" && kind != "smart" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list kind"})
		return
	}
	if (kind == "smart") != (payload.Rule != nil) {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "a smart list needs a rule and only a smart list has one", "code": "invalid_smart_rule", "reason": "rule"})
		return
	}
	var rule personal.SmartRule
	if payload.Rule != nil {
		var err error
		if rule, err = personal.NormalizeSmartRule(*payload.Rule); err == nil {
			err = personal.ValidateSmartRuleTags(r.Context(), s.db, user.ID, rule, nil)
		}
		if err != nil {
			if !writeSmartRuleError(w, err) {
				writeError(w, err)
			}
			return
		}
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if kind == "smart" {
		var smartCount int
		if err := tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM favorite_list WHERE user_id = ? AND kind = 'smart'", user.ID).Scan(&smartCount); err != nil {
			writeError(w, err)
			return
		}
		if smartCount >= personal.MaxSmartListsPerUser {
			writeJSON(w, http.StatusConflict, map[string]any{"error": "too many smart lists", "code": "smart_list_limit", "limit": personal.MaxSmartListsPerUser})
			return
		}
	}
	var sortOrder int64
	if err := tx.QueryRowContext(r.Context(), "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM favorite_list WHERE user_id = ?", user.ID).Scan(&sortOrder); err != nil {
		writeError(w, err)
		return
	}
	result, err := tx.ExecContext(r.Context(), `
		INSERT INTO favorite_list (user_id, name, description, icon, sort_order, kind)
		VALUES (?, ?, ?, ?, ?, ?)
	`, user.ID, name, description, icon, sortOrder, kind)
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "favorite list already exists"})
			return
		}
		writeError(w, err)
		return
	}
	listID, err := result.LastInsertId()
	if err != nil {
		writeError(w, err)
		return
	}
	if kind == "smart" {
		if err := s.saveSmartRuleTx(r.Context(), tx, user.ID, listID, rule); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	item, err := s.loadFavoriteList(r.Context(), user.ID, listID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, item)
}

func (s *Server) updateFavoriteList(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	listID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list id"})
		return
	}
	var payload struct {
		Name        *string             `json:"name"`
		Description *string             `json:"description"`
		Icon        *string             `json:"icon"`
		SortOrder   *int64              `json:"sortOrder"`
		Rule        *personal.SmartRule `json:"rule"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	current, err := s.loadFavoriteList(r.Context(), user.ID, listID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "favorite list not found"})
			return
		}
		writeError(w, err)
		return
	}
	if current.Kind == "marked" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "system marked list cannot be edited"})
		return
	}
	if payload.Rule != nil && current.Kind != "smart" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "only a smart list has a rule", "code": "invalid_smart_rule", "reason": "rule"})
		return
	}
	var rule personal.SmartRule
	if payload.Rule != nil {
		allowed, err := existingSmartRuleTags(r.Context(), s.db, user.ID, listID)
		if err != nil {
			writeError(w, err)
			return
		}
		if rule, err = personal.NormalizeSmartRule(*payload.Rule); err == nil {
			err = personal.ValidateSmartRuleTags(r.Context(), s.db, user.ID, rule, allowed)
		}
		if err != nil {
			if !writeSmartRuleError(w, err) {
				writeError(w, err)
			}
			return
		}
	}
	name := current.Name
	if payload.Name != nil {
		name = strings.TrimSpace(*payload.Name)
	}
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	description := current.Description
	if payload.Description != nil {
		description = strings.TrimSpace(*payload.Description)
	}
	icon := current.Icon
	if payload.Icon != nil {
		var ok bool
		if icon, ok = personal.NormalizeFavoriteListIcon(*payload.Icon); !ok {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list icon"})
			return
		}
	}
	sortOrder := current.SortOrder
	if payload.SortOrder != nil {
		sortOrder = *payload.SortOrder
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(r.Context(), `
		UPDATE favorite_list
		SET name = ?, description = ?, icon = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND user_id = ?
	`, name, description, icon, sortOrder, listID, user.ID); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "favorite list already exists"})
			return
		}
		writeError(w, err)
		return
	}
	if payload.Rule != nil {
		if err := s.saveSmartRuleTx(r.Context(), tx, user.ID, listID, rule); err != nil {
			writeError(w, err)
			return
		}
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	item, err := s.loadFavoriteList(r.Context(), user.ID, listID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

func (s *Server) deleteFavoriteList(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	listID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list id"})
		return
	}
	var kind string
	if err := s.db.QueryRowContext(r.Context(), "SELECT kind FROM favorite_list WHERE id = ? AND user_id = ?", listID, user.ID).Scan(&kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "favorite list not found"})
			return
		}
		writeError(w, err)
		return
	}
	if kind == "marked" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "system marked list cannot be deleted"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM favorite_list WHERE id = ? AND user_id = ? AND kind IN "+library.ManualFavoriteListKindsSQL, listID, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	deleted, err := result.RowsAffected()
	if err != nil {
		writeError(w, err)
		return
	}
	if deleted == 0 {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "favorite list not found"})
		return
	}
	if err := s.reconcileFavoriteSummariesForUser(r.Context(), user.ID); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

func (s *Server) listFavoriteListWorkIDs(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	listID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list id"})
		return
	}
	var kind string
	if err := s.db.QueryRowContext(r.Context(), "SELECT kind FROM favorite_list WHERE id = ? AND user_id = ?", listID, user.ID).Scan(&kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "favorite list not found"})
			return
		}
		writeError(w, err)
		return
	}
	if kind == "smart" {
		scope, err := s.loadFavoriteListScope(r.Context(), s.db, user.ID, listID)
		if err != nil {
			writeError(w, err)
			return
		}
		workIDs, truncated, err := s.listSmartListWorkIDs(r.Context(), user.ID, scope)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"listId": listID, "workIds": workIDs, "truncated": truncated})
		return
	}
	query := `
		SELECT item.work_id
		FROM favorite_list_item AS item
		INNER JOIN favorite_list AS list ON list.id = item.list_id
		WHERE item.list_id = ? AND list.user_id = ? AND list.kind = 'user'
		ORDER BY item.created_at DESC, item.work_id DESC
	`
	args := []any{listID, user.ID}
	if kind == "marked" {
		query = `
			SELECT state.work_id
			FROM user_work_state AS state
			WHERE state.user_id = ? AND state.listening_status <> 'none'
			ORDER BY state.updated_at DESC, state.work_id DESC
		`
		args = []any{user.ID}
	}
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	listedWorkIDs := []int64{}
	for rows.Next() {
		var workID int64
		if err := rows.Scan(&workID); err != nil {
			writeError(w, err)
			return
		}
		listedWorkIDs = append(listedWorkIDs, workID)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	// Release the cursor's pooled connection before demo eligibility queries.
	if err := rows.Close(); err != nil {
		writeError(w, err)
		return
	}
	workIDs := make([]int64, 0, len(listedWorkIDs))
	for _, workID := range listedWorkIDs {
		if s.cfg.IsDemo() {
			eligible, err := s.demoWorkEligible(r.Context(), workID)
			if err != nil {
				writeError(w, err)
				return
			}
			if !eligible {
				continue
			}
		}
		workIDs = append(workIDs, workID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"listId": listID, "workIds": workIDs})
}

func (s *Server) getWorkFavoriteLists(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if err := s.requireWorkExists(r.Context(), workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	lists, err := s.loadFavoriteLists(r.Context(), user.ID, &workID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, lists)
}

func (s *Server) setWorkFavoriteLists(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	workID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work id"})
		return
	}
	if err := s.requireWorkExists(r.Context(), workID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
			return
		}
		writeError(w, err)
		return
	}
	var payload struct {
		ListIDs []int64 `json:"listIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	selected := map[int64]bool{}
	for _, id := range payload.ListIDs {
		if id > 0 {
			selected[id] = true
		}
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := applyWorkFavoriteListSelection(r.Context(), tx, user.ID, workID, selected); err != nil {
		if errors.Is(err, errInvalidFavoriteListID) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		writeError(w, err)
		return
	}
	favorite, err := refreshWorkFavoriteFlagTx(r.Context(), tx, user.ID, workID)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	lists, err := s.loadFavoriteLists(r.Context(), user.ID, &workID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workId": workID, "favorite": favorite, "lists": lists})
}

// applyWorkFavoriteListSelection makes the work belong to exactly the selected
// user and smart lists. The caller refreshes the favorite flag.
func applyWorkFavoriteListSelection(ctx context.Context, tx *sql.Tx, userID, workID int64, selected map[int64]bool) error {
	lists, err := loadEditableFavoriteLists(ctx, tx, userID)
	if err != nil {
		return err
	}
	for id := range selected {
		if _, ok := lists[id]; !ok {
			return errInvalidFavoriteListID
		}
	}
	for _, list := range lists {
		contains, err := favoriteListContainsWork(ctx, tx, list, workID)
		if err != nil {
			return err
		}
		switch {
		case selected[list.ID] && !contains:
			err = addWorkToFavoriteListTx(ctx, tx, list, workID)
		case !selected[list.ID] && contains:
			err = removeWorkFromFavoriteListTx(ctx, tx, list, workID)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// syncWorkFavoriteFlag sets user_work_state.favorite to the given value.
func syncWorkFavoriteFlag(ctx context.Context, tx *sql.Tx, userID, workID int64, favorite bool) error {
	var err error
	if favorite {
		_, err = tx.ExecContext(ctx, `
			INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
			VALUES (?, ?, 'none', 1)
			ON CONFLICT(user_id, work_id) DO UPDATE SET favorite = excluded.favorite
			WHERE user_work_state.favorite <> excluded.favorite
		`, userID, workID)
	} else {
		_, err = tx.ExecContext(ctx, `
			UPDATE user_work_state
			SET favorite = 0
			WHERE user_id = ? AND work_id = ? AND favorite <> 0
		`, userID, workID)
	}
	return err
}

func (s *Server) requireWorkExists(ctx context.Context, workID int64) error {
	var exists int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM work WHERE id = ?", workID).Scan(&exists)
}

func (s *Server) loadFavoriteLists(ctx context.Context, userID int64, workID *int64) ([]favoriteListResponse, error) {
	if err := s.ensureMarkedFavoriteList(ctx, userID); err != nil {
		return nil, err
	}
	args := []any{userID}
	selectedColumn := "0"
	if workID != nil {
		selectedColumn = `CASE WHEN favorite_list.kind = 'marked' THEN EXISTS (
			SELECT 1
			FROM user_work_state AS marked_state
			WHERE marked_state.user_id = favorite_list.user_id
				AND marked_state.work_id = ?
				AND marked_state.listening_status <> 'none'
		) ELSE EXISTS (
			SELECT 1
			FROM favorite_list_item AS item
			WHERE item.list_id = favorite_list.id
				AND item.work_id = ?
		) END`
		args = append([]any{*workID, *workID}, args...)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id,
			CASE WHEN kind = 'marked' THEN 'Marked' ELSE name END,
			description,
			CASE WHEN kind = 'marked' THEN '' ELSE icon END,
			sort_order,
			kind,
			`+selectedColumn+`
		FROM favorite_list
		WHERE user_id = ?
		ORDER BY CASE WHEN kind = 'marked' THEN 0 ELSE 1 END, sort_order ASC, name ASC, id ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lists := []favoriteListResponse{}
	for rows.Next() {
		var item favoriteListResponse
		var selected int
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.Icon, &item.SortOrder, &item.Kind, &selected); err != nil {
			return nil, err
		}
		item.Selected = selected != 0
		lists = append(lists, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if workID != nil {
		if err := s.markSmartListSelection(ctx, userID, *workID, lists); err != nil {
			return nil, err
		}
	}
	if err := s.attachSmartRuleViews(ctx, userID, lists); err != nil {
		return nil, err
	}
	return lists, nil
}

// markSmartListSelection reports a smart list as selected when it shows the
// work, whether by its rule or because the work was added by hand. On entry,
// Selected says whether the work was added by hand.
func (s *Server) markSmartListSelection(ctx context.Context, userID, workID int64, lists []favoriteListResponse) error {
	editable, err := loadEditableFavoriteLists(ctx, s.db, userID)
	if err != nil {
		return err
	}
	for index := range lists {
		list, ok := editable[lists[index].ID]
		if !ok || list.Kind != "smart" {
			continue
		}
		handAdded := lists[index].Selected
		if lists[index].Selected, err = favoriteListContainsWork(ctx, s.db, list, workID); err != nil {
			return err
		}
		lists[index].MatchedByRule = lists[index].Selected && !handAdded
	}
	return nil
}

func (s *Server) loadFavoriteList(ctx context.Context, userID int64, listID int64) (favoriteListResponse, error) {
	var item favoriteListResponse
	var selected int
	err := s.db.QueryRowContext(ctx, `
		SELECT id, CASE WHEN kind = 'marked' THEN 'Marked' ELSE name END, description,
			CASE WHEN kind = 'marked' THEN '' ELSE icon END, sort_order, kind, 0
		FROM favorite_list
		WHERE id = ? AND user_id = ?
	`, listID, userID).Scan(&item.ID, &item.Name, &item.Description, &item.Icon, &item.SortOrder, &item.Kind, &selected)
	item.Selected = selected != 0
	if err != nil || item.Kind != "smart" {
		return item, err
	}
	lists := []favoriteListResponse{item}
	err = s.attachSmartRuleViews(ctx, userID, lists)
	return lists[0], err
}

func (s *Server) reconcileFavoriteSummariesForUser(ctx context.Context, userID int64) error {
	rows, err := s.db.QueryContext(ctx, "SELECT work_id FROM user_work_state WHERE user_id = ?", userID)
	if err != nil {
		return err
	}
	defer rows.Close()
	workIDs := []int64{}
	for rows.Next() {
		var workID int64
		if err := rows.Scan(&workID); err != nil {
			return err
		}
		workIDs = append(workIDs, workID)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, workID := range workIDs {
		if err := s.reconcileFavoriteSummary(ctx, userID, workID); err != nil {
			return err
		}
	}
	return nil
}

func (s *Server) reconcileFavoriteSummary(ctx context.Context, userID int64, workID int64) error {
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM favorite_list_item AS item
		INNER JOIN favorite_list AS list ON list.id = item.list_id
		WHERE list.user_id = ? AND list.kind IN `+library.ManualFavoriteListKindsSQL+` AND item.work_id = ?
	`, userID, workID).Scan(&count); err != nil {
		return err
	}
	favoriteValue := 0
	if count > 0 {
		favoriteValue = 1
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE user_work_state
		SET favorite = ?
		WHERE user_id = ? AND work_id = ? AND favorite <> ?
	`, favoriteValue, userID, workID, favoriteValue)
	return err
}

func (s *Server) ensureMarkedFavoriteList(ctx context.Context, userID int64) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO favorite_list (user_id, name, sort_order, kind)
		VALUES (?, '', -1, 'marked')
	`, userID)
	return err
}

func validListeningStatus(status string) bool {
	switch status {
	case "none", "want_to_listen", "listening", "finished", "relisten", "paused":
		return true
	default:
		return false
	}
}
