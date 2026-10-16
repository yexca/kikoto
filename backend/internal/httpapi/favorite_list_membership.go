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
	if err := rows.Close(); err != nil {
		writeError(w, err)
		return
	}
	smartCounts, err := s.smartListMembershipCounts(r.Context(), user.ID, workIDs)
	if err != nil {
		writeError(w, err)
		return
	}
	summary.Lists = append(summary.Lists, smartCounts...)
	writeJSON(w, http.StatusOK, summary)
}

// smartListMembershipCounts counts how many of the works each smart list shows.
func (s *Server) smartListMembershipCounts(ctx context.Context, userID int64, workIDs []int64) ([]favoriteListMembershipCount, error) {
	lists, err := loadEditableFavoriteLists(ctx, s.db, userID)
	if err != nil {
		return nil, err
	}
	result := []favoriteListMembershipCount{}
	for _, list := range lists {
		if list.Kind != "smart" {
			continue
		}
		where, args := smartListMemberWhere(list.ID, list.Match)
		item := favoriteListMembershipCount{ListID: list.ID}
		if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM work WHERE work.id IN ("+sqlPlaceholders(len(workIDs))+") AND "+where, append(int64Args(workIDs), args...)...).Scan(&item.Count); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, nil
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
	lists, err := loadEditableFavoriteLists(ctx, tx, userID)
	if err != nil {
		return err
	}
	for _, changes := range []map[int64]bool{add, remove} {
		for id := range changes {
			if _, ok := lists[id]; !ok {
				return errInvalidFavoriteListID
			}
		}
	}
	for _, workID := range workIDs {
		var exists int
		if err := tx.QueryRowContext(ctx, "SELECT 1 FROM work WHERE id = ?", workID).Scan(&exists); err != nil {
			return err
		}
		for _, changes := range []struct {
			ids map[int64]bool
			add bool
		}{{add, true}, {remove, false}} {
			for id := range changes.ids {
				list := lists[id]
				contains, err := favoriteListContainsWork(ctx, tx, list, workID)
				if err != nil {
					return err
				}
				switch {
				case changes.add && !contains:
					err = addWorkToFavoriteListTx(ctx, tx, list, workID)
				case !changes.add && contains:
					err = removeWorkFromFavoriteListTx(ctx, tx, list, workID)
				}
				if err != nil {
					return err
				}
			}
		}
		if _, err := refreshWorkFavoriteFlagTx(ctx, tx, userID, workID); err != nil {
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
