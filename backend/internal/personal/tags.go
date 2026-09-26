package personal

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"unicode"
	"unicode/utf8"
)

type tagScope struct{ tags, assignments, tagID, entityID string }

var tagScopes = map[string]tagScope{
	"work":   {"user_tag", "user_work_tag", "user_tag_id", "work_id"},
	"circle": {"user_party_tag", "user_party_tag_assignment", "user_party_tag_id", "party_id"},
	"voice":  {"user_person_tag", "user_person_tag_assignment", "user_person_tag_id", "person_id"},
}

type Tag struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Color      string `json:"color"`
	UsageCount int    `json:"usageCount"`
}

type TagPage struct {
	Scope    string `json:"scope"`
	Tags     []Tag  `json:"tags"`
	Total    int    `json:"total"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

func validTagName(name string) bool {
	return name != "" && utf8.RuneCountInString(name) <= 40 && strings.IndexFunc(name, unicode.IsControl) < 0
}

func (s Store) Tags(ctx context.Context, user int64, scope, query string, page, size int) (TagPage, error) {
	t, ok := tagScopes[scope]
	if !ok || utf8.RuneCountInString(query) > 200 {
		return TagPage{}, ErrInvalid
	}
	page, size = pageBounds(page, size)
	result := TagPage{Scope: scope, Tags: []Tag{}, Page: page, PageSize: size}
	where := ` WHERE tag.user_id = ? AND instr(LOWER(tag.name), LOWER(?)) > 0`
	if err := s.DB.QueryRowContext(ctx, `SELECT COUNT(*) FROM `+t.tags+` tag`+where, user, query).Scan(&result.Total); err != nil {
		return result, err
	}
	rows, err := s.DB.QueryContext(ctx, `SELECT tag.id, tag.name, tag.color, COUNT(a.`+t.tagID+`) FROM `+t.tags+` tag LEFT JOIN `+t.assignments+` a ON a.`+t.tagID+` = tag.id AND a.user_id = tag.user_id`+where+` GROUP BY tag.id ORDER BY LOWER(tag.name), tag.id LIMIT ? OFFSET ?`, user, query, size, (page-1)*size)
	if err != nil {
		return result, err
	}
	defer func() { _ = rows.Close() }()
	for rows.Next() {
		var tag Tag
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color, &tag.UsageCount); err != nil {
			return result, err
		}
		result.Tags = append(result.Tags, tag)
	}
	return result, rows.Err()
}

func loadTag(ctx context.Context, tx *sql.Tx, t tagScope, user, id int64) (Tag, error) {
	var tag Tag
	err := tx.QueryRowContext(ctx, `SELECT tag.id, tag.name, tag.color, (SELECT COUNT(*) FROM `+t.assignments+` a WHERE a.`+t.tagID+` = tag.id AND a.user_id = ?) FROM `+t.tags+` tag WHERE tag.id = ? AND tag.user_id = ?`, user, id, user).Scan(&tag.ID, &tag.Name, &tag.Color, &tag.UsageCount)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return tag, err
}

// ChangeTag performs rename, merge or delete atomically with ownership checks.
func (s Store) ChangeTag(ctx context.Context, user int64, scope string, id int64, action, name string, target int64) (Tag, error) {
	t, ok := tagScopes[scope]
	name = strings.TrimSpace(name)
	if !ok || id <= 0 || (action == "rename" && !validTagName(name)) || (action == "merge" && (target <= 0 || id == target)) {
		return Tag{}, ErrInvalid
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return Tag{}, err
	}
	defer func() { _ = tx.Rollback() }()
	tag, err := loadTag(ctx, tx, t, user, id)
	if err != nil {
		return Tag{}, err
	}
	switch action {
	case "rename":
		var other int64
		err = tx.QueryRowContext(ctx, `SELECT id FROM `+t.tags+` WHERE user_id = ? AND LOWER(name) = LOWER(?) AND id <> ? LIMIT 1`, user, name, id).Scan(&other)
		if err == nil {
			return Tag{}, ErrConflict
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return Tag{}, err
		}
		_, err = tx.ExecContext(ctx, `UPDATE `+t.tags+` SET name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?`, name, id, user)
		tag.Name = name
	case "merge":
		if _, err = loadTag(ctx, tx, t, user, target); err != nil {
			return Tag{}, err
		}
		_, err = tx.ExecContext(ctx, `INSERT INTO `+t.assignments+` (user_id, `+t.entityID+`, `+t.tagID+`) SELECT user_id, `+t.entityID+`, ? FROM `+t.assignments+` WHERE user_id = ? AND `+t.tagID+` = ? ON CONFLICT DO NOTHING`, target, user, id)
		if err != nil {
			return Tag{}, err
		}
		if _, err = tx.ExecContext(ctx, `DELETE FROM `+t.tags+` WHERE id = ? AND user_id = ?`, id, user); err != nil {
			return Tag{}, err
		}
		tag, err = loadTag(ctx, tx, t, user, target)
	case "delete":
		_, err = tx.ExecContext(ctx, `DELETE FROM `+t.tags+` WHERE id = ? AND user_id = ?`, id, user)
	default:
		return Tag{}, ErrInvalid
	}
	if err != nil {
		return Tag{}, err
	}
	return tag, tx.Commit()
}
