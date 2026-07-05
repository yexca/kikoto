package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
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

func (s *Server) updateWorkUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
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
		ORDER BY item.added_at DESC, item.work_id DESC
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
