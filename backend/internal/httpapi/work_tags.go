package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
)

const maxWorkUserTags = 50

type workUserTag struct {
	ID    int64  `json:"id"`
	Name  string `json:"name"`
	Color string `json:"color"`
}

func (s *Server) setWorkUserTags(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "tags:write")
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
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	if len(payload.Tags) > maxWorkUserTags {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "too many work tags"})
		return
	}
	tags, err := s.replaceWorkUserTags(r.Context(), user.ID, workID, payload.Tags)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"workId": workID, "userTags": tags})
}

func (s *Server) replaceWorkUserTags(ctx context.Context, userID int64, workID int64, rawTags []string) ([]workUserTag, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_work_tag WHERE user_id = ? AND work_id = ?", userID, workID); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, raw := range rawTags {
		name := strings.TrimSpace(raw)
		key := strings.ToLower(name)
		if name == "" || seen[key] {
			continue
		}
		seen[key] = true
		runes := []rune(name)
		if len(runes) > 40 {
			name = string(runes[:40])
		}
		var tagID int64
		err := tx.QueryRowContext(ctx, `
			SELECT id
			FROM user_tag
			WHERE user_id = ? AND LOWER(name) = LOWER(?)
			ORDER BY id ASC
			LIMIT 1
		`, userID, name).Scan(&tagID)
		if errors.Is(err, sql.ErrNoRows) {
			result, insertErr := tx.ExecContext(ctx, "INSERT INTO user_tag (user_id, name) VALUES (?, ?)", userID, name)
			if insertErr != nil {
				return nil, insertErr
			}
			tagID, err = result.LastInsertId()
		}
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_work_tag (user_id, work_id, user_tag_id)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, work_id, user_tag_id) DO NOTHING
		`, userID, workID, tagID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.loadWorkUserTags(ctx, userID, workID)
}

func (s *Server) addWorkUserTag(ctx context.Context, userID int64, workIDs []int64, rawTag string) (int, error) {
	name := strings.TrimSpace(rawTag)
	if userID <= 0 || name == "" {
		return 0, nil
	}
	runes := []rune(name)
	if len(runes) > 40 {
		name = string(runes[:40])
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer func() { _ = tx.Rollback() }()
	var tagID int64
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM user_tag
		WHERE user_id = ? AND LOWER(name) = LOWER(?)
		ORDER BY id ASC LIMIT 1
	`, userID, name).Scan(&tagID)
	if errors.Is(err, sql.ErrNoRows) {
		result, insertErr := tx.ExecContext(ctx, "INSERT INTO user_tag (user_id, name) VALUES (?, ?)", userID, name)
		if insertErr != nil {
			return 0, insertErr
		}
		tagID, err = result.LastInsertId()
	}
	if err != nil {
		return 0, err
	}
	added := 0
	seen := map[int64]bool{}
	for _, workID := range workIDs {
		if workID <= 0 || seen[workID] {
			continue
		}
		seen[workID] = true
		result, err := tx.ExecContext(ctx, `
			INSERT INTO user_work_tag (user_id, work_id, user_tag_id)
			SELECT ?, id, ? FROM work WHERE id = ?
			ON CONFLICT(user_id, work_id, user_tag_id) DO NOTHING
		`, userID, tagID, workID)
		if err != nil {
			return 0, err
		}
		if rows, err := result.RowsAffected(); err == nil {
			added += int(rows)
		}
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return added, nil
}

func (s *Server) loadWorkUserTags(ctx context.Context, userID int64, workID int64) ([]workUserTag, error) {
	tagsByWork, err := s.loadWorkUserTagsBatch(ctx, userID, []int64{workID})
	if err != nil {
		return nil, err
	}
	return tagsByWork[workID], nil
}

func (s *Server) loadWorkUserTagsBatch(ctx context.Context, userID int64, workIDs []int64) (map[int64][]workUserTag, error) {
	result := make(map[int64][]workUserTag, len(workIDs))
	unique := make([]int64, 0, len(workIDs))
	seen := map[int64]bool{}
	for _, workID := range workIDs {
		if workID <= 0 || seen[workID] {
			continue
		}
		seen[workID] = true
		unique = append(unique, workID)
		result[workID] = []workUserTag{}
	}
	if userID <= 0 || len(unique) == 0 {
		return result, nil
	}
	placeholders := make([]string, len(unique))
	args := make([]any, 0, len(unique)+1)
	args = append(args, userID)
	for index, workID := range unique {
		placeholders[index] = "?"
		args = append(args, workID)
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT assignment.work_id, tag.id, tag.name, tag.color
		FROM user_work_tag AS assignment
		INNER JOIN user_tag AS tag ON tag.id = assignment.user_tag_id
		WHERE assignment.user_id = ?
			AND assignment.work_id IN (`+strings.Join(placeholders, ",")+`)
		ORDER BY assignment.work_id ASC, LOWER(tag.name) ASC, tag.id ASC
	`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var workID int64
		var tag workUserTag
		if err := rows.Scan(&workID, &tag.ID, &tag.Name, &tag.Color); err != nil {
			return nil, err
		}
		result[workID] = append(result[workID], tag)
	}
	return result, rows.Err()
}
