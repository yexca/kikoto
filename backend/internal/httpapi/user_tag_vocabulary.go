package httpapi

import (
	"context"
	"net/http"
	"strings"
)

// maxUserTagVocabulary bounds the suggestion list returned to the tag editor.
const maxUserTagVocabulary = 500

type userTagVocabularyEntry struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	Color      string `json:"color"`
	UsageCount int    `json:"usageCount"`
}

// userTagVocabularyScopes maps each public scope to its tag and assignment
// tables. Works, circles, and voices keep separate per-user vocabularies.
var userTagVocabularyScopes = map[string]struct {
	tagTable        string
	assignmentTable string
	tagColumn       string
}{
	"work":   {tagTable: "user_tag", assignmentTable: "user_work_tag", tagColumn: "user_tag_id"},
	"circle": {tagTable: "user_party_tag", assignmentTable: "user_party_tag_assignment", tagColumn: "user_party_tag_id"},
	"voice":  {tagTable: "user_person_tag", assignmentTable: "user_person_tag_assignment", tagColumn: "user_person_tag_id"},
}

func (s *Server) listUserTagVocabulary(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	scope := strings.TrimSpace(r.URL.Query().Get("scope"))
	if _, known := userTagVocabularyScopes[scope]; !known {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid tag scope"})
		return
	}
	tags, err := s.loadUserTagVocabulary(r.Context(), user.ID, scope)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"scope": scope, "tags": tags})
}

// loadUserTagVocabulary returns the user's tags in one scope that are still
// assigned to at least one entity, most used first.
func (s *Server) loadUserTagVocabulary(ctx context.Context, userID int64, scope string) ([]userTagVocabularyEntry, error) {
	tables := userTagVocabularyScopes[scope]
	rows, err := s.db.QueryContext(ctx, `
		SELECT tag.id, tag.name, tag.color, COUNT(*) AS usage_count
		FROM `+tables.tagTable+` AS tag
		INNER JOIN `+tables.assignmentTable+` AS assignment
			ON assignment.`+tables.tagColumn+` = tag.id AND assignment.user_id = tag.user_id
		WHERE tag.user_id = ?
		GROUP BY tag.id
		ORDER BY usage_count DESC, LOWER(tag.name) ASC, tag.id ASC
		LIMIT ?
	`, userID, maxUserTagVocabulary)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	tags := []userTagVocabularyEntry{}
	for rows.Next() {
		var tag userTagVocabularyEntry
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.Color, &tag.UsageCount); err != nil {
			return nil, err
		}
		tags = append(tags, tag)
	}
	return tags, rows.Err()
}
