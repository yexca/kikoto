package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/circleidentity"
	"github.com/yexca/kikoto/backend/internal/contentpolicy"
)

func circleIdentityError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, circleidentity.ErrInvalid):
		writeAPIError(w, http.StatusBadRequest, "invalid_circle_identity", "invalid circle identity change", false)
	case errors.Is(err, circleidentity.ErrConflict):
		writeAPIError(w, http.StatusConflict, "circle_merge_changed", "circle data changed; review the latest merge and edits before undoing", false)
	case errors.Is(err, sql.ErrNoRows):
		writeAPIError(w, http.StatusNotFound, "circle_not_found", "circle not found", false)
	default:
		writeError(w, err)
	}
}
func (s *Server) listMetadataCircles(w http.ResponseWriter, r *http.Request) {
	if !s.requireMetadataEntryRead(w, r) {
		return
	}
	page := max(1, queryInt(r, "page", 1))
	size := max(1, min(100, queryInt(r, "pageSize", 25)))
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	where := `party_type IN ('circle','brand','maker') AND (?='' OR INSTR(LOWER(display_name),LOWER(?))>0
 OR EXISTS(SELECT 1 FROM party_alias WHERE party_id=party.id AND INSTR(LOWER(alias),LOWER(?))>0)
 OR EXISTS(SELECT 1 FROM party_external_id WHERE party_id=party.id AND INSTR(LOWER(external_id),LOWER(?))>0))`
	where += " AND " + circlePartyVisibilityPredicate("party.id")
	if s.cfg.IsDemo() {
		where += ` AND (EXISTS(SELECT 1 FROM work_party AS relation JOIN work AS demo_work ON demo_work.id=relation.work_id WHERE relation.party_id=party.id AND relation.role='circle' AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `)
 OR EXISTS(SELECT 1 FROM ` + circleCatalogProjection + ` AS catalog JOIN work AS demo_work ON UPPER(demo_work.primary_code)=UPPER(catalog.primary_code) WHERE catalog.party_id=party.id AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `))`
	}
	args := []any{query, query, query, query}
	result := struct {
		Circles  []metadataCircleEntry `json:"circles"`
		Total    int                   `json:"total"`
		Page     int                   `json:"page"`
		PageSize int                   `json:"pageSize"`
	}{Circles: []metadataCircleEntry{}, Page: page, PageSize: size}
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM party WHERE "+where, args...).Scan(&result.Total); err != nil {
		writeError(w, err)
		return
	}
	args = append(args, size, (page-1)*size)
	// Circles are organized by DLsite maker id, like tags by id, so the list
	// reads the same whatever names anyone authored. Maker ids share a
	// two-letter prefix and grow in digits, so length orders them numerically.
	// Circles known only from a remote source have no code and follow by id.
	rows, err := s.db.QueryContext(r.Context(), `SELECT id FROM (SELECT id,`+circleidentity.CodeSQL("party.id")+` AS code FROM party WHERE `+where+`)
 ORDER BY code IS NULL,SUBSTR(code,1,2),LENGTH(code),code,id LIMIT ? OFFSET ?`, args...)
	if err != nil {
		writeError(w, err)
		return
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			writeError(w, err)
			return
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		writeError(w, err)
		return
	}
	if closeErr != nil {
		writeError(w, closeErr)
		return
	}
	latest, err := s.loadCircleLatestWorks(r.Context(), ids)
	if err != nil {
		writeError(w, err)
		return
	}
	for _, id := range ids {
		item, err := s.loadMetadataCircleForRead(r.Context(), id)
		if err != nil {
			writeError(w, err)
			return
		}
		entry := metadataCircleEntry{Circle: item}
		if work := latest[id]; work != nil {
			entry.CoverURL = s.coverURL(work.PrimaryCode)
		}
		result.Circles = append(result.Circles, entry)
	}
	writeJSON(w, http.StatusOK, result)
}

// metadataCircleEntry is one Metadata circle row: the identity plus the cover
// of its latest known work, the same picture the Circles browse page shows.
type metadataCircleEntry struct {
	circleidentity.Circle
	CoverURL string `json:"coverUrl"`
}

func (s *Server) getMetadataCircle(w http.ResponseWriter, r *http.Request) {
	if !s.requireMetadataEntryRead(w, r) {
		return
	}
	id, err := parseInt64PathValue(r, "partyId")
	if err != nil {
		circleIdentityError(w, circleidentity.ErrInvalid)
		return
	}
	if err := s.metadataCircleVisible(r.Context(), id); err != nil {
		circleIdentityError(w, err)
		return
	}
	if strings.HasSuffix(r.URL.Path, "/merges") {
		if s.cfg.IsDemo() {
			writeJSON(w, http.StatusOK, []circleidentity.Review{})
			return
		}
		result, err := circleidentity.Reviews(r.Context(), s.db, id)
		if err != nil {
			circleIdentityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
		return
	}
	result, err := s.loadMetadataCircleForRead(r.Context(), id)
	if err != nil {
		circleIdentityError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}
func (s *Server) changeMetadataCircle(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:write"); !ok {
		return
	}
	id, err := parseInt64PathValue(r, "partyId")
	if err != nil {
		circleIdentityError(w, circleidentity.ErrInvalid)
		return
	}
	var payload struct {
		ManualName    string `json:"manualName"`
		Alias         string `json:"alias"`
		SourcePartyID int64  `json:"sourcePartyId"`
	}
	if r.Method != http.MethodDelete && !strings.HasSuffix(r.URL.Path, "/undo") {
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&payload); err != nil {
			circleIdentityError(w, circleidentity.ErrInvalid)
			return
		}
	}
	if strings.HasSuffix(r.URL.Path, "/merge") {
		mergeID, err := circleidentity.Merge(r.Context(), s.db, id, payload.SourcePartyID)
		if err != nil {
			circleIdentityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mergeId": mergeID})
		return
	}
	if strings.HasSuffix(r.URL.Path, "/undo") {
		mergeID, err := parseInt64PathValue(r, "mergeId")
		if err != nil {
			circleIdentityError(w, circleidentity.ErrInvalid)
			return
		}
		if err := circleidentity.Undo(r.Context(), s.db, id, mergeID); err != nil {
			circleIdentityError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	switch {
	case r.Method == http.MethodDelete:
		aliasID, parseErr := parseInt64PathValue(r, "aliasId")
		if parseErr != nil {
			circleIdentityError(w, circleidentity.ErrInvalid)
			return
		}
		var deleted sql.Result
		deleted, err = tx.ExecContext(r.Context(), "DELETE FROM party_alias WHERE id=? AND party_id=?", aliasID, id)
		if err == nil {
			if count, countErr := deleted.RowsAffected(); countErr != nil {
				err = countErr
			} else if count == 0 {
				err = notFoundError("circle alias not found")
			}
		}
	case strings.HasSuffix(r.URL.Path, "/aliases"):
		err = circleidentity.AddAliasTx(r.Context(), tx, id, payload.Alias)
	default:
		err = circleidentity.RenameTx(r.Context(), tx, id, payload.ManualName)
	}
	if err != nil {
		circleIdentityError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	result, err := circleidentity.Load(r.Context(), s.db, id)
	if err != nil {
		circleIdentityError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, result)
}

// Circle lists use one chosen provider identity per party after a merge, while
// all maker ids remain usable by direct links and future refreshes.
func (s *Server) loadCircleAliases(ctx context.Context, partyID int64) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT alias FROM party_alias WHERE party_id=? ORDER BY LOWER(alias),id", partyID)
	if err != nil {
		return nil, err
	}
	aliases := []string{}
	for rows.Next() {
		var alias string
		if err := rows.Scan(&alias); err != nil {
			_ = rows.Close()
			return nil, err
		}
		aliases = append(aliases, alias)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return nil, err
	}
	return aliases, closeErr
}

func (s *Server) loadCircleAliasesBatch(ctx context.Context) (map[int64][]string, error) {
	rows, err := s.db.QueryContext(ctx, "SELECT party_id,alias FROM party_alias ORDER BY party_id,LOWER(alias),id")
	if err != nil {
		return nil, err
	}
	result := map[int64][]string{}
	for rows.Next() {
		var id int64
		var alias string
		if err := rows.Scan(&id, &alias); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result[id] = append(result[id], alias)
	}
	err = rows.Err()
	closeErr := rows.Close()
	if err != nil {
		return nil, err
	}
	return result, closeErr
}
