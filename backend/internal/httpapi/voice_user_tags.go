package httpapi

import (
	"context"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
	"strings"
)

func (s *Server) replaceVoiceUserTags(ctx context.Context, userID int64, personID int64, rawTags []string) ([]voiceUserTag, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_person_tag_assignment WHERE user_id = ? AND person_id = ?", userID, personID); err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	for _, raw := range rawTags {
		name := clampUserTagName(raw)
		if name == "" || seen[strings.ToLower(name)] {
			continue
		}
		seen[strings.ToLower(name)] = true
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_person_tag (user_id, name)
			VALUES (?, ?)
			ON CONFLICT(user_id, name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
		`, userID, name); err != nil {
			return nil, err
		}
		tagID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM user_person_tag WHERE user_id = ? AND name = ?", userID, name)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_person_tag_assignment (user_id, person_id, user_person_tag_id)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, person_id, user_person_tag_id) DO NOTHING
		`, userID, personID, tagID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.loadVoiceUserTags(ctx, userID, personID)
}

func (s *Server) loadVoiceUserTags(ctx context.Context, userID int64, personID int64) ([]voiceUserTag, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT tag.id, tag.name, tag.color
		FROM user_person_tag_assignment AS assignment
		INNER JOIN user_person_tag AS tag ON tag.id = assignment.user_person_tag_id
		WHERE assignment.user_id = ?
			AND assignment.person_id = ?
		ORDER BY tag.name ASC
	`, userID, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	tags := []voiceUserTag{}
	for rows.Next() {
		var tag voiceUserTag
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}
