package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/personal"
)

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
	// MemberOrder is the list's one-based place among the user and smart lists
	// that hold the work, in the order a work card names them. It is set only
	// on such a list in a work's answer.
	MemberOrder int `json:"memberOrder,omitempty"`
	// Rule is set on smart lists.
	Rule *personal.SmartRuleView `json:"rule,omitempty"`
}

var errInvalidFavoriteListID = errors.New("invalid favorite list id")

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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", false)
		return
	}
	name := strings.TrimSpace(payload.Name)
	if name == "" {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "name is required", false)
		return
	}
	description := strings.TrimSpace(payload.Description)
	icon, ok := personal.NormalizeFavoriteListIcon(payload.Icon)
	if !ok {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid favorite list icon", false)
		return
	}
	kind := strings.TrimSpace(payload.Kind)
	if kind == "" {
		kind = "user"
	}
	if kind != "user" && kind != "smart" {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid favorite list kind", false)
		return
	}
	if (kind == "smart") != (payload.Rule != nil) {
		writeAPIErrorDetails(w, http.StatusBadRequest, "invalid_smart_rule", "a smart list needs a rule and only a smart list has one", false, map[string]any{"reason": "rule"})
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
			writeAPIErrorDetails(w, http.StatusConflict, "smart_list_limit", "too many smart lists", false, map[string]any{"limit": personal.MaxSmartListsPerUser})
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
			writeAPIError(w, http.StatusConflict, "conflict", "favorite list already exists", false)
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid favorite list id", false)
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid JSON body", false)
		return
	}
	current, err := s.loadFavoriteList(r.Context(), user.ID, listID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "favorite list not found", false)
			return
		}
		writeError(w, err)
		return
	}
	if current.Kind == "marked" {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "system marked list cannot be edited", false)
		return
	}
	if payload.Rule != nil && current.Kind != "smart" {
		writeAPIErrorDetails(w, http.StatusBadRequest, "invalid_smart_rule", "only a smart list has a rule", false, map[string]any{"reason": "rule"})
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "name is required", false)
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
			writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid favorite list icon", false)
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
			writeAPIError(w, http.StatusConflict, "conflict", "favorite list already exists", false)
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid favorite list id", false)
		return
	}
	var kind string
	if err := s.db.QueryRowContext(r.Context(), "SELECT kind FROM favorite_list WHERE id = ? AND user_id = ?", listID, user.ID).Scan(&kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "favorite list not found", false)
			return
		}
		writeError(w, err)
		return
	}
	if kind == "marked" {
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "system marked list cannot be deleted", false)
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
		writeAPIError(w, http.StatusNotFound, "not_found", "favorite list not found", false)
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
		writeAPIError(w, http.StatusBadRequest, "invalid_request", "invalid favorite list id", false)
		return
	}
	var kind string
	if err := s.db.QueryRowContext(r.Context(), "SELECT kind FROM favorite_list WHERE id = ? AND user_id = ?", listID, user.ID).Scan(&kind); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeAPIError(w, http.StatusNotFound, "not_found", "favorite list not found", false)
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
	defer func() { _ = rows.Close() }()
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
	defer func() { _ = rows.Close() }()
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
		members, err := s.loadWorkMemberListsBatch(ctx, userID, []int64{*workID})
		if err != nil {
			return nil, err
		}
		order := map[int64]int{}
		for index, list := range members[*workID] {
			order[list.ID] = index + 1
		}
		for index := range lists {
			lists[index].MemberOrder = order[lists[index].ID]
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
	defer func() { _ = rows.Close() }()
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
