package httpapi

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

func (s *Server) listRecentlyPlayedWorks(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	limit := queryInt(r, "limit", 10)
	if limit < 1 {
		limit = 1
	}
	if limit > 20 {
		limit = 20
	}
	works, err := s.recentlyPlayedWorks(r.Context(), user.ID, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"works": works})
}

func (s *Server) recentlyPlayedWorks(ctx context.Context, userID int64, limit int) ([]libraryWorkSummary, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT media_item.work_id, MAX(progress.last_played_at) AS latest_played_at
		FROM user_media_progress AS progress
		INNER JOIN media_item ON media_item.id = progress.media_item_id
		WHERE progress.user_id = ?
			AND progress.last_played_at IS NOT NULL
			AND media_item.kind = 'audio'
		GROUP BY media_item.work_id
		ORDER BY latest_played_at DESC, media_item.work_id DESC
		LIMIT ?
	`, userID, limit)
	if err != nil {
		return nil, err
	}
	workIDs := make([]int64, 0, limit)
	for rows.Next() {
		var workID int64
		var lastPlayedAt string
		if err := rows.Scan(&workID, &lastPlayedAt); err != nil {
			_ = rows.Close()
			return nil, err
		}
		workIDs = append(workIDs, workID)
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(workIDs) == 0 {
		return []libraryWorkSummary{}, nil
	}

	args := make([]any, len(workIDs))
	for index, workID := range workIDs {
		args[index] = workID
	}
	where := fmt.Sprintf("work.id IN (%s)", strings.TrimSuffix(strings.Repeat("?,", len(workIDs)), ","))
	rawWorks, err := s.libraryStore.ListMatching(ctx, userID, where, args, 1, len(workIDs))
	if err != nil {
		return nil, err
	}
	works, err := s.scanLibraryWorkRows(ctx, userID, rawWorks, false)
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]libraryWorkSummary, len(works))
	for _, work := range works {
		byID[work.ID] = work
	}
	ordered := make([]libraryWorkSummary, 0, len(works))
	for _, workID := range workIDs {
		if work, ok := byID[workID]; ok {
			ordered = append(ordered, work)
		}
	}
	return ordered, nil
}
