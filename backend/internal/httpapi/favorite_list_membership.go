package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
)

// maxFavoriteMembershipBatchWorks bounds one bulk membership request. The
// Favorites selection covers at most one loaded page, so this is a safety cap
// rather than a user-visible limit.
const maxFavoriteMembershipBatchWorks = 500

var errInvalidFavoriteMembershipBatch = errors.New("invalid favorite list membership batch")

type favoriteListMembershipCount struct {
	ListID int64 `json:"listId"`
	Count  int   `json:"count"`
}

type favoriteListMembershipSummary struct {
	Total int                           `json:"total"`
	Lists []favoriteListMembershipCount `json:"lists"`
}

// summarizeFavoriteListMembership reports how many of the given works each of
// the user's own lists contains, so a bulk editor can show all/some/none states.
// It is a POST because the work selection can exceed a practical URL length.
func (s *Server) summarizeFavoriteListMembership(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	var payload struct {
		WorkIDs []int64 `json:"workIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	workIDs, err := normalizeFavoriteMembershipWorkIDs(payload.WorkIDs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	query, args := favoriteMembershipCountQuery(user.ID, workIDs)
	rows, err := s.db.QueryContext(r.Context(), query, args...)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = rows.Close() }()
	summary := favoriteListMembershipSummary{Total: len(workIDs), Lists: []favoriteListMembershipCount{}}
	for rows.Next() {
		var item favoriteListMembershipCount
		if err := rows.Scan(&item.ListID, &item.Count); err != nil {
			writeError(w, err)
			return
		}
		summary.Lists = append(summary.Lists, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func favoriteMembershipCountQuery(userID int64, workIDs []int64) (string, []any) {
	args := append(int64Args(workIDs), userID)
	return `
		SELECT list.id, COUNT(item.work_id)
		FROM favorite_list AS list
		LEFT JOIN favorite_list_item AS item
			ON item.list_id = list.id AND item.work_id IN (` + sqlPlaceholders(len(workIDs)) + `)
		WHERE list.user_id = ? AND list.kind = 'user'
		GROUP BY list.id
		ORDER BY list.sort_order, list.id
	`, args
}

// updateFavoriteListMembership adds and removes the given works to and from the
// named lists in one transaction. Lists that are named in neither set keep
// their current membership, unlike the per-work PUT which replaces it.
func (s *Server) updateFavoriteListMembership(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	var payload struct {
		WorkIDs       []int64 `json:"workIds"`
		AddListIDs    []int64 `json:"addListIds"`
		RemoveListIDs []int64 `json:"removeListIds"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	workIDs, err := normalizeFavoriteMembershipWorkIDs(payload.WorkIDs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	add, remove, err := normalizeFavoriteMembershipListChanges(payload.AddListIDs, payload.RemoveListIDs)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	if err := applyFavoriteListMembershipChanges(r.Context(), tx, user.ID, workIDs, add, remove); err != nil {
		switch {
		case errors.Is(err, errInvalidFavoriteListID):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		case errors.Is(err, sql.ErrNoRows):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "work not found"})
		default:
			writeError(w, err)
		}
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"updated": len(workIDs)})
}

func applyFavoriteListMembershipChanges(ctx context.Context, tx *sql.Tx, userID int64, workIDs []int64, add, remove map[int64]bool) error {
	valid, err := loadFavoriteListIDSet(ctx, tx, "SELECT id FROM favorite_list WHERE user_id = ? AND kind = 'user'", userID)
	if err != nil {
		return err
	}
	for _, changes := range []map[int64]bool{add, remove} {
		for id := range changes {
			if !valid[id] {
				return errInvalidFavoriteListID
			}
		}
	}
	for _, workID := range workIDs {
		var exists int
		if err := tx.QueryRowContext(ctx, "SELECT 1 FROM work WHERE id = ?", workID).Scan(&exists); err != nil {
			return err
		}
		current, err := loadFavoriteListIDSet(ctx, tx, `
			SELECT item.list_id
			FROM favorite_list_item AS item
			INNER JOIN favorite_list AS list ON list.id = item.list_id
			WHERE item.work_id = ? AND list.user_id = ? AND list.kind = 'user'
		`, workID, userID)
		if err != nil {
			return err
		}
		selected := make(map[int64]bool, len(current)+len(add))
		for id := range current {
			if !remove[id] {
				selected[id] = true
			}
		}
		for id := range add {
			selected[id] = true
		}
		if err := removeWorkFromUnselectedFavoriteLists(ctx, tx, workID, selected, current); err != nil {
			return err
		}
		if err := addWorkToSelectedFavoriteLists(ctx, tx, workID, selected, current); err != nil {
			return err
		}
		if err := syncWorkFavoriteFlag(ctx, tx, userID, workID, len(selected) > 0); err != nil {
			return err
		}
	}
	return nil
}

func normalizeFavoriteMembershipWorkIDs(ids []int64) ([]int64, error) {
	seen := make(map[int64]bool, len(ids))
	workIDs := make([]int64, 0, len(ids))
	for _, id := range ids {
		if id <= 0 {
			return nil, errInvalidFavoriteMembershipBatch
		}
		if seen[id] {
			continue
		}
		seen[id] = true
		workIDs = append(workIDs, id)
	}
	if len(workIDs) == 0 || len(workIDs) > maxFavoriteMembershipBatchWorks {
		return nil, errInvalidFavoriteMembershipBatch
	}
	return workIDs, nil
}

func normalizeFavoriteMembershipListChanges(addIDs, removeIDs []int64) (map[int64]bool, map[int64]bool, error) {
	add := map[int64]bool{}
	remove := map[int64]bool{}
	for _, id := range addIDs {
		if id <= 0 {
			return nil, nil, errInvalidFavoriteListID
		}
		add[id] = true
	}
	for _, id := range removeIDs {
		if id <= 0 || add[id] {
			return nil, nil, errInvalidFavoriteListID
		}
		remove[id] = true
	}
	if len(add) == 0 && len(remove) == 0 {
		return nil, nil, errInvalidFavoriteMembershipBatch
	}
	return add, remove, nil
}
