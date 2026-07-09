package httpapi

import (
	"context"
	"database/sql"
	"net/http"
	"strconv"
	"strings"
)

const metadataSuggestionDefaultLimit = 20
const metadataSuggestionMaxLimit = 50

type metadataSuggestionResponse[T any] struct {
	Items     []T  `json:"items"`
	Truncated bool `json:"truncated"`
}

type circleSuggestion struct {
	PartyID    int64  `json:"partyId"`
	Name       string `json:"name"`
	ExternalID string `json:"externalId"`
}

type voiceSuggestion struct {
	PersonID int64  `json:"personId"`
	Name     string `json:"name"`
}

type seriesSuggestion struct {
	SeriesID         int64  `json:"seriesId"`
	Name             string `json:"name"`
	TitleID          string `json:"titleId"`
	CircleExternalID string `json:"circleExternalId"`
	CircleName       string `json:"circleName"`
}

func (s *Server) suggestCircles(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	q, limit, ok := metadataSuggestionQuery(w, r)
	if !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT party.id, party.display_name, COALESCE(external.external_id, '')
		FROM party
		LEFT JOIN party_external_id AS external ON external.party_id = party.id
			AND external.is_primary = 1
		WHERE party.party_type = 'circle'
			AND (
				LOWER(party.display_name) LIKE ?
				OR LOWER(COALESCE(external.external_id, '')) LIKE ?
			)
		ORDER BY party.display_name ASC, party.id ASC
		LIMIT ?
	`, q, q, limit+1)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	items := []circleSuggestion{}
	for rows.Next() {
		var item circleSuggestion
		if err := rows.Scan(&item.PartyID, &item.Name, &item.ExternalID); err != nil {
			writeError(w, err)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeSuggestionResponse(w, items, limit)
}

func (s *Server) suggestVoices(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	q, limit, ok := metadataSuggestionQuery(w, r)
	if !ok {
		return
	}
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT person.id, person.display_name
		FROM person
		LEFT JOIN person_alias AS alias ON alias.person_id = person.id
		WHERE LOWER(person.display_name) LIKE ?
			OR LOWER(COALESCE(alias.alias, '')) LIKE ?
		GROUP BY person.id
		ORDER BY person.display_name ASC, person.id ASC
		LIMIT ?
	`, q, q, limit+1)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	items := []voiceSuggestion{}
	for rows.Next() {
		var item voiceSuggestion
		if err := rows.Scan(&item.PersonID, &item.Name); err != nil {
			writeError(w, err)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeSuggestionResponse(w, items, limit)
}

func (s *Server) suggestSeries(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	q, limit, ok := metadataSuggestionQuery(w, r)
	if !ok {
		return
	}
	circleID := strings.ToUpper(strings.TrimSpace(r.URL.Query().Get("circleId")))
	args := []any{q, q}
	where := `WHERE (LOWER(series.name) LIKE ? OR LOWER(series.title_id) LIKE ?)`
	if circleID != "" {
		where += ` AND EXISTS (
			SELECT 1
			FROM party_external_id AS filter_external
			WHERE filter_external.party_id = party.id
				AND UPPER(filter_external.external_id) = ?
		)`
		args = append(args, circleID)
	}
	args = append(args, limit+1)
	rows, err := s.db.QueryContext(r.Context(), `
		SELECT series.id, series.name, series.title_id, party.display_name, COALESCE(external.external_id, '')
		FROM party_series AS series
		INNER JOIN party ON party.id = series.party_id
		LEFT JOIN party_external_id AS external ON external.party_id = party.id
			AND external.is_primary = 1
		`+where+`
		ORDER BY series.name ASC, series.id ASC
		LIMIT ?
	`, args...)
	if err != nil {
		writeError(w, err)
		return
	}
	defer rows.Close()
	items := []seriesSuggestion{}
	for rows.Next() {
		var item seriesSuggestion
		if err := rows.Scan(&item.SeriesID, &item.Name, &item.TitleID, &item.CircleName, &item.CircleExternalID); err != nil {
			writeError(w, err)
			return
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		writeError(w, err)
		return
	}
	writeSuggestionResponse(w, items, limit)
}

func metadataSuggestionQuery(w http.ResponseWriter, r *http.Request) (string, int, bool) {
	raw := strings.TrimSpace(r.URL.Query().Get("q"))
	if len([]rune(raw)) < 2 {
		writeJSON(w, http.StatusOK, metadataSuggestionResponse[any]{Items: []any{}, Truncated: false})
		return "", 0, false
	}
	limit := metadataSuggestionDefaultLimit
	if rawLimit := strings.TrimSpace(r.URL.Query().Get("limit")); rawLimit != "" {
		if parsed, err := strconv.Atoi(rawLimit); err == nil && parsed > 0 {
			limit = parsed
		}
	}
	if limit > metadataSuggestionMaxLimit {
		limit = metadataSuggestionMaxLimit
	}
	return "%" + strings.ToLower(raw) + "%", limit, true
}

func writeSuggestionResponse[T any](w http.ResponseWriter, items []T, limit int) {
	truncated := len(items) > limit
	if truncated {
		items = items[:limit]
	}
	writeJSON(w, http.StatusOK, metadataSuggestionResponse[T]{Items: items, Truncated: truncated})
}

func partyIDForExternalID(ctx context.Context, tx *sql.Tx, externalID string) (int64, bool, error) {
	externalID = strings.ToUpper(strings.TrimSpace(externalID))
	if externalID == "" {
		return 0, false, nil
	}
	var partyID int64
	err := tx.QueryRowContext(ctx, `
		SELECT party_id
		FROM party_external_id
		WHERE UPPER(external_id) = ?
		ORDER BY is_primary DESC, id ASC
		LIMIT 1
	`, externalID).Scan(&partyID)
	if err != nil {
		if err == sql.ErrNoRows {
			return 0, false, nil
		}
		return 0, false, err
	}
	return partyID, true, nil
}

func personIDExists(ctx context.Context, tx *sql.Tx, personID int64) (bool, error) {
	if personID <= 0 {
		return false, nil
	}
	var exists int
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM person WHERE id = ?)", personID).Scan(&exists); err != nil {
		return false, err
	}
	return exists != 0, nil
}

func seriesIDForTitle(ctx context.Context, tx *sql.Tx, titleID string, circleExternalID string) (int64, bool, error) {
	titleID = strings.TrimSpace(titleID)
	if titleID == "" {
		return 0, false, nil
	}
	args := []any{titleID}
	where := "WHERE series.title_id = ?"
	if strings.TrimSpace(circleExternalID) != "" {
		where += ` AND EXISTS (
			SELECT 1
			FROM party_external_id AS external
			WHERE external.party_id = series.party_id
				AND UPPER(external.external_id) = ?
		)`
		args = append(args, strings.ToUpper(strings.TrimSpace(circleExternalID)))
	}
	var seriesID int64
	err := tx.QueryRowContext(ctx, `
		SELECT series.id
		FROM party_series AS series
		`+where+`
		ORDER BY series.last_seen_at DESC, series.id DESC
		LIMIT 1
	`, args...).Scan(&seriesID)
	if err != nil {
		if err == sql.ErrNoRows {
			return 0, false, nil
		}
		return 0, false, err
	}
	return seriesID, true, nil
}
