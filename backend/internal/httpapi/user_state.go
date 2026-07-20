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
	SortOrder   int64  `json:"sortOrder"`
	Selected    bool   `json:"selected,omitempty"`
}

type favoriteWorksResponse struct {
	Works        []libraryWorkSummary `json:"works"`
	Page         int                  `json:"page"`
	PageSize     int                  `json:"pageSize"`
	Total        int                  `json:"total"`
	ShelfTotal   int                  `json:"shelfTotal"`
	ListCounts   map[int64]int        `json:"listCounts"`
	StatusCounts map[string]int       `json:"statusCounts"`
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
	favorite := currentFavorite != 0
	if payload.Favorite != nil {
		favorite = *payload.Favorite
	}
	favoriteValue := 0
	if favorite {
		favoriteValue = 1
	}

	if _, err := s.db.ExecContext(r.Context(), `
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			listening_status = excluded.listening_status,
			favorite = excluded.favorite,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, workID, status, favoriteValue); err != nil {
		writeError(w, err)
		return
	}
	if payload.Favorite != nil {
		if err := s.setDefaultFavoriteListMembership(r.Context(), user.ID, workID, favorite); err != nil {
			writeError(w, err)
			return
		}
	}

	writeJSON(w, http.StatusOK, workUserStateResponse{WorkID: workID, ListeningStatus: status, Favorite: favorite})
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
	page := queryInt(r, "page", 1)
	pageSize := queryInt(r, "pageSize", 24)
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 100 {
		pageSize = 24
	}
	listID := int64(0)
	if raw := strings.TrimSpace(r.URL.Query().Get("listId")); raw != "" && raw != "all" {
		parsed, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || parsed <= 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list id"})
			return
		}
		listID = parsed
	}
	where, args := favoriteWorksWhere(
		strings.TrimSpace(r.URL.Query().Get("status")),
		strings.TrimSpace(r.URL.Query().Get("availability")),
		strings.TrimSpace(r.URL.Query().Get("q")),
		user.ID,
		listID,
	)
	where = s.demoWorkWhere(where, "work")
	countQuery := "SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE " + where
	countArgs := append([]any{user.ID}, args...)
	var total int
	if err := s.db.QueryRowContext(r.Context(), countQuery, countArgs...).Scan(&total); err != nil {
		writeError(w, err)
		return
	}
	shelfWhere, shelfArgs := favoriteWorksWhere("all", "all", "", user.ID, 0)
	shelfWhere = s.demoWorkWhere(shelfWhere, "work")
	shelfCountQuery := "SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE " + shelfWhere
	shelfCountArgs := append([]any{user.ID}, shelfArgs...)
	var shelfTotal int
	if err := s.db.QueryRowContext(r.Context(), shelfCountQuery, shelfCountArgs...).Scan(&shelfTotal); err != nil {
		writeError(w, err)
		return
	}
	rawWorks, err := s.libraryStore.ListMatching(r.Context(), user.ID, where, args, page, pageSize, false)
	if err != nil {
		writeError(w, err)
		return
	}
	works, err := s.scanLibraryWorkRows(r.Context(), user.ID, rawWorks, true)
	if err != nil {
		writeError(w, err)
		return
	}
	listCounts, err := s.loadFavoriteListCounts(r.Context(), user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	statusCounts, err := s.loadFavoriteStatusCounts(r.Context(), user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, favoriteWorksResponse{
		Works: works, Page: page, PageSize: pageSize, Total: total, ShelfTotal: shelfTotal, ListCounts: listCounts, StatusCounts: statusCounts,
	})
}

func favoriteWorksWhere(status string, availability string, queryText string, userID int64, listID int64) (string, []any) {
	clauses := []string{`(
		COALESCE(user_work_state.favorite, 0) = 1
		OR COALESCE(user_work_state.listening_status, 'none') <> 'none'
		OR EXISTS (
			SELECT 1
			FROM user_media_progress AS shelf_progress
			INNER JOIN media_item AS shelf_item ON shelf_item.id = shelf_progress.media_item_id
			WHERE shelf_progress.user_id = ?
				AND shelf_item.work_id = work.id
		)
	)`}
	args := []any{userID}
	if listID > 0 {
		clauses = append(clauses, `EXISTS (
			SELECT 1
			FROM favorite_list_item AS selected_item
			INNER JOIN favorite_list AS selected_list ON selected_list.id = selected_item.list_id
			WHERE selected_item.work_id = work.id
				AND selected_list.user_id = ?
				AND selected_list.id = ?
		)`)
		args = append(args, userID, listID)
	}
	if status != "" && status != "all" {
		clauses = append(clauses, "COALESCE(user_work_state.listening_status, 'none') = ?")
		args = append(args, status)
	}
	switch strings.ToLower(strings.TrimSpace(availability)) {
	case "local":
		clauses = append(clauses, favoriteAvailabilityExists("'local'", false))
	case "cache":
		clauses = append(clauses, favoriteAvailabilityExists("'cache'", false))
	case "remote":
		clauses = append(clauses, favoriteAvailabilityExists("'remote_stream','remote_download'", false))
	case "missing":
		clauses = append(clauses, favoriteAvailabilityExists("'local','cache','remote_stream','remote_download'", true))
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

func favoriteAvailabilityExists(locationTypes string, negated bool) string {
	prefix := "EXISTS"
	if negated {
		prefix = "NOT EXISTS"
	}
	return prefix + ` (
		SELECT 1
		FROM media_file_location AS favorite_location
		INNER JOIN media_item AS favorite_item ON favorite_item.id = favorite_location.media_item_id
		WHERE favorite_item.work_id = work.id
			AND favorite_location.availability = 'available'
			AND favorite_location.location_type IN (` + locationTypes + `)
	)`
}

func (s *Server) loadFavoriteListCounts(ctx context.Context, userID int64) (map[int64]int, error) {
	countExpression := "COUNT(item.work_id)"
	workJoin := ""
	if s.cfg.DemoMode {
		countExpression = "COUNT(CASE WHEN " + contentpolicy.DemoEligibleWorkSQL("work") + " THEN item.work_id END)"
		workJoin = " LEFT JOIN work ON work.id = item.work_id"
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT list.id, `+countExpression+`
		FROM favorite_list AS list
		LEFT JOIN favorite_list_item AS item ON item.list_id = list.id
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

func (s *Server) loadFavoriteStatusCounts(ctx context.Context, userID int64) (map[string]int, error) {
	where, args := favoriteWorksWhere("all", "all", "", userID, 0)
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
		Name        string `json:"name"`
		Description string `json:"description"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "name is required"})
		return
	}
	description := strings.TrimSpace(payload.Description)
	var sortOrder int64
	if err := s.db.QueryRowContext(r.Context(), "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM favorite_list WHERE user_id = ?", user.ID).Scan(&sortOrder); err != nil {
		writeError(w, err)
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		INSERT INTO favorite_list (user_id, name, description, sort_order)
		VALUES (?, ?, ?, ?)
	`, user.ID, name, description, sortOrder)
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
		Name        *string `json:"name"`
		Description *string `json:"description"`
		SortOrder   *int64  `json:"sortOrder"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
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
	sortOrder := current.SortOrder
	if payload.SortOrder != nil {
		sortOrder = *payload.SortOrder
	}
	if _, err := s.db.ExecContext(r.Context(), `
		UPDATE favorite_list
		SET name = ?, description = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP
		WHERE id = ? AND user_id = ?
	`, name, description, sortOrder, listID, user.ID); err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "unique") {
			writeJSON(w, http.StatusConflict, map[string]string{"error": "favorite list already exists"})
			return
		}
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
	var listCount int
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM favorite_list WHERE user_id = ?", user.ID).Scan(&listCount); err != nil {
		writeError(w, err)
		return
	}
	if listCount <= 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "at least one favorite list is required"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), "DELETE FROM favorite_list WHERE id = ? AND user_id = ?", listID, user.ID)
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
	var exists int
	if err := s.db.QueryRowContext(r.Context(), "SELECT 1 FROM favorite_list WHERE id = ? AND user_id = ?", listID, user.ID).Scan(&exists); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "favorite list not found"})
			return
		}
		writeError(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT item.work_id
		FROM favorite_list_item AS item
		INNER JOIN favorite_list AS list ON list.id = item.list_id
		WHERE item.list_id = ? AND list.user_id = ?
		ORDER BY item.created_at DESC, item.work_id DESC
	`, listID, user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	workIDs := []int64{}
	for rows.Next() {
		var workID int64
		if err := rows.Scan(&workID); err != nil {
			writeError(w, err)
			return
		}
		if s.cfg.DemoMode {
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
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
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
	if err := s.reconcileFavoriteListMembership(r.Context(), user.ID, workID); err != nil {
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
	validRows, err := tx.QueryContext(r.Context(), "SELECT id FROM favorite_list WHERE user_id = ?", user.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	valid := map[int64]bool{}
	for validRows.Next() {
		var id int64
		if err := validRows.Scan(&id); err != nil {
			_ = validRows.Close()
			writeError(w, err)
			return
		}
		valid[id] = true
	}
	if err := validRows.Close(); err != nil {
		writeError(w, err)
		return
	}
	if err := validRows.Err(); err != nil {
		writeError(w, err)
		return
	}
	for id := range selected {
		if !valid[id] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list id"})
			return
		}
	}
	if _, err := tx.ExecContext(r.Context(), `
		DELETE FROM favorite_list_item
		WHERE work_id = ?
			AND list_id IN (SELECT id FROM favorite_list WHERE user_id = ?)
	`, workID, user.ID); err != nil {
		writeError(w, err)
		return
	}
	for id := range selected {
		if _, err := tx.ExecContext(r.Context(), `
			INSERT INTO favorite_list_item (list_id, work_id)
			VALUES (?, ?)
			ON CONFLICT(list_id, work_id) DO NOTHING
		`, id, workID); err != nil {
			writeError(w, err)
			return
		}
	}
	favorite := len(selected) > 0
	favoriteValue := 0
	if favorite {
		favoriteValue = 1
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
		VALUES (?, ?, 'none', ?)
		ON CONFLICT(user_id, work_id) DO UPDATE SET
			favorite = excluded.favorite,
			updated_at = CURRENT_TIMESTAMP
	`, user.ID, workID, favoriteValue); err != nil {
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

func (s *Server) requireWorkExists(ctx context.Context, workID int64) error {
	var exists int
	return s.db.QueryRowContext(ctx, "SELECT 1 FROM work WHERE id = ?", workID).Scan(&exists)
}

func (s *Server) loadFavoriteLists(ctx context.Context, userID int64, workID *int64) ([]favoriteListResponse, error) {
	if _, err := s.db.ExecContext(ctx, `
		INSERT OR IGNORE INTO favorite_list (user_id, name, sort_order)
		VALUES (?, 'Favorites', 0)
	`, userID); err != nil {
		return nil, err
	}
	args := []any{userID}
	selectedColumn := "0"
	if workID != nil {
		selectedColumn = `EXISTS (
			SELECT 1
			FROM favorite_list_item AS item
			WHERE item.list_id = favorite_list.id
				AND item.work_id = ?
		)`
		args = append([]any{*workID}, args...)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT id, name, description, sort_order, `+selectedColumn+`
		FROM favorite_list
		WHERE user_id = ?
		ORDER BY sort_order ASC, name ASC, id ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	lists := []favoriteListResponse{}
	for rows.Next() {
		var item favoriteListResponse
		var selected int
		if err := rows.Scan(&item.ID, &item.Name, &item.Description, &item.SortOrder, &selected); err != nil {
			return nil, err
		}
		item.Selected = selected != 0
		lists = append(lists, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return lists, nil
}

func (s *Server) loadFavoriteList(ctx context.Context, userID int64, listID int64) (favoriteListResponse, error) {
	var item favoriteListResponse
	var selected int
	err := s.db.QueryRowContext(ctx, `
		SELECT id, name, description, sort_order, 0
		FROM favorite_list
		WHERE id = ? AND user_id = ?
	`, listID, userID).Scan(&item.ID, &item.Name, &item.Description, &item.SortOrder, &selected)
	item.Selected = selected != 0
	return item, err
}

func (s *Server) reconcileFavoriteSummariesForUser(ctx context.Context, userID int64) error {
	rows, err := s.db.QueryContext(ctx, "SELECT work_id FROM user_work_state WHERE user_id = ? AND favorite = 1", userID)
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
		WHERE list.user_id = ? AND item.work_id = ?
	`, userID, workID).Scan(&count); err != nil {
		return err
	}
	favoriteValue := 0
	if count > 0 {
		favoriteValue = 1
	}
	_, err := s.db.ExecContext(ctx, `
		UPDATE user_work_state
		SET favorite = ?, updated_at = CURRENT_TIMESTAMP
		WHERE user_id = ? AND work_id = ?
	`, favoriteValue, userID, workID)
	return err
}

func (s *Server) setDefaultFavoriteListMembership(ctx context.Context, userID int64, workID int64, favorite bool) error {
	lists, err := s.loadFavoriteLists(ctx, userID, nil)
	if err != nil {
		return err
	}
	if len(lists) == 0 {
		return nil
	}
	defaultListID := lists[0].ID
	if favorite {
		_, err = s.db.ExecContext(ctx, `
			INSERT INTO favorite_list_item (list_id, work_id)
			VALUES (?, ?)
			ON CONFLICT(list_id, work_id) DO NOTHING
		`, defaultListID, workID)
		return err
	}
	_, err = s.db.ExecContext(ctx, `
		DELETE FROM favorite_list_item
		WHERE work_id = ?
			AND list_id IN (SELECT id FROM favorite_list WHERE user_id = ?)
	`, workID, userID)
	return err
}

func (s *Server) reconcileFavoriteListMembership(ctx context.Context, userID int64, workID int64) error {
	var favorite int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COALESCE(favorite, 0)
		FROM user_work_state
		WHERE user_id = ? AND work_id = ?
	`, userID, workID).Scan(&favorite); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil
		}
		return err
	}
	if favorite == 0 {
		return nil
	}
	var count int
	if err := s.db.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM favorite_list_item AS item
		INNER JOIN favorite_list AS list ON list.id = item.list_id
		WHERE list.user_id = ? AND item.work_id = ?
	`, userID, workID).Scan(&count); err != nil {
		return err
	}
	if count > 0 {
		return nil
	}
	return s.setDefaultFavoriteListMembership(ctx, userID, workID, true)
}

func validListeningStatus(status string) bool {
	switch status {
	case "none", "want_to_listen", "listening", "finished", "relisten", "paused":
		return true
	default:
		return false
	}
}
