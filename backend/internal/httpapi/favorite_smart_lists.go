package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"github.com/yexca/kikoto/backend/internal/library"
	"github.com/yexca/kikoto/backend/internal/metadatatags"
	"github.com/yexca/kikoto/backend/internal/personal"
)

// maxSmartListWorkIDs bounds the work ids one smart list hands to play-all and
// queue actions; a rule can match a large part of the library.
const maxSmartListWorkIDs = 2000

// favoriteListScope is the membership predicate of one Favorites shelf: the
// whole shelf (ID 0), the marked list, a user list, or a smart list.
type favoriteListScope struct {
	ID    int64
	Kind  string
	Where string
	Args  []any
	// Match is the compiled rule of a smart list.
	Match personal.SmartMatch
}

// favoriteShelfScope is every work the user marked or put in one of their
// own lists. Smart list rule matches are not favorites and stay out of it.
func favoriteShelfScope(userID int64) favoriteListScope {
	return favoriteListScope{Where: `(
		COALESCE(user_work_state.listening_status, 'none') <> 'none'
		OR EXISTS (
			SELECT 1
			FROM favorite_list_item AS favorite_item
			INNER JOIN favorite_list AS favorite_list ON favorite_list.id = favorite_item.list_id
			WHERE favorite_item.work_id = work.id
				AND favorite_list.user_id = ?
				AND favorite_list.kind IN ` + library.ManualFavoriteListKindsSQL + `
		)
	)`, Args: []any{userID}}
}

func (s *Server) loadFavoriteListScope(ctx context.Context, q personal.Querier, userID, listID int64) (favoriteListScope, error) {
	if listID <= 0 {
		return favoriteShelfScope(userID), nil
	}
	scope := favoriteListScope{ID: listID}
	err := q.QueryRowContext(ctx, "SELECT kind FROM favorite_list WHERE id = ? AND user_id = ?", listID, userID).Scan(&scope.Kind)
	if errors.Is(err, sql.ErrNoRows) {
		scope.Where = "0"
		return scope, nil
	}
	if err != nil {
		return scope, err
	}
	switch scope.Kind {
	case "marked":
		scope.Where = "COALESCE(user_work_state.listening_status, 'none') <> 'none'"
	case "smart":
		rules, err := personal.LoadSmartRules(ctx, q, []int64{listID})
		if err != nil {
			return scope, err
		}
		if scope.Match, err = personal.CompileSmartRule(ctx, q, userID, rules[listID]); err != nil {
			return scope, err
		}
		scope.Where, scope.Args = smartListMemberWhere(listID, scope.Match)
	default:
		scope.Where = "EXISTS (SELECT 1 FROM favorite_list_item AS selected_item WHERE selected_item.list_id = ? AND selected_item.work_id = work.id)"
		scope.Args = []any{listID}
	}
	return scope, nil
}

// smartListMemberWhere is a smart list's membership: the works added by hand,
// and the rule matches that were not removed by hand.
func smartListMemberWhere(listID int64, match personal.SmartMatch) (string, []any) {
	args := append([]any{listID}, match.Args...)
	args = append(args, listID)
	return `(
		EXISTS (SELECT 1 FROM favorite_list_item AS smart_item WHERE smart_item.list_id = ? AND smart_item.work_id = work.id)
		OR (` + match.Where + ` AND NOT EXISTS (
			SELECT 1 FROM favorite_list_smart_exclusion AS smart_exclusion
			WHERE smart_exclusion.list_id = ? AND smart_exclusion.work_id = work.id
		))
	)`, args
}

// smartListNewWhere selects the rule matches the owner has not seen yet. A
// work added by hand is never new: the owner put it there.
func smartListNewWhere(listID int64, match personal.SmartMatch) (string, []any) {
	args := append([]any{}, match.Args...)
	args = append(args, listID, listID, listID)
	return `(` + match.Where + `
		AND NOT EXISTS (SELECT 1 FROM favorite_list_smart_exclusion AS smart_exclusion WHERE smart_exclusion.list_id = ? AND smart_exclusion.work_id = work.id)
		AND NOT EXISTS (SELECT 1 FROM favorite_list_item AS smart_item WHERE smart_item.list_id = ? AND smart_item.work_id = work.id)
		AND NOT EXISTS (SELECT 1 FROM favorite_list_smart_seen AS smart_seen WHERE smart_seen.list_id = ? AND smart_seen.work_id = work.id)
	)`, args
}

// markSmartListSeenTx records the current rule matches as seen and forgets
// works that no longer match, so the seen set stays as large as the list.
func markSmartListSeenTx(ctx context.Context, tx *sql.Tx, listID int64, match personal.SmartMatch) error {
	args := append([]any{listID}, match.Args...)
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO favorite_list_smart_seen (list_id, work_id)
		SELECT ?, work.id FROM work WHERE `+match.Where+`
		ON CONFLICT(list_id, work_id) DO NOTHING
	`, args...); err != nil {
		return err
	}
	args = append([]any{listID}, match.Args...)
	_, err := tx.ExecContext(ctx, `
		DELETE FROM favorite_list_smart_seen
		WHERE list_id = ? AND work_id NOT IN (SELECT work.id FROM work WHERE `+match.Where+`)
	`, args...)
	return err
}

// saveSmartRuleTx stores a list's rule and records its current matches as
// seen, so a rule its owner just wrote shows no new works.
func (s *Server) saveSmartRuleTx(ctx context.Context, tx *sql.Tx, userID, listID int64, rule personal.SmartRule) error {
	if err := personal.SaveSmartRuleTx(ctx, tx, listID, rule); err != nil {
		return err
	}
	match, err := personal.CompileSmartRule(ctx, tx, userID, rule)
	if err != nil {
		return err
	}
	return markSmartListSeenTx(ctx, tx, listID, match)
}

// editableFavoriteList is a list a user can add works to and remove works
// from: a user list or a smart list.
type editableFavoriteList struct {
	ID    int64
	Kind  string
	Match personal.SmartMatch
}

func loadEditableFavoriteLists(ctx context.Context, q personal.Querier, userID int64) (map[int64]editableFavoriteList, error) {
	rows, err := q.QueryContext(ctx, "SELECT id, kind FROM favorite_list WHERE user_id = ? AND kind IN "+library.ManualFavoriteListKindsSQL, userID)
	if err != nil {
		return nil, err
	}
	lists := map[int64]editableFavoriteList{}
	smartIDs := []int64{}
	for rows.Next() {
		var list editableFavoriteList
		if err := rows.Scan(&list.ID, &list.Kind); err != nil {
			_ = rows.Close()
			return nil, err
		}
		lists[list.ID] = list
		if list.Kind == "smart" {
			smartIDs = append(smartIDs, list.ID)
		}
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	rules, err := personal.LoadSmartRules(ctx, q, smartIDs)
	if err != nil {
		return nil, err
	}
	for _, id := range smartIDs {
		list := lists[id]
		if list.Match, err = personal.CompileSmartRule(ctx, q, userID, rules[id]); err != nil {
			return nil, err
		}
		lists[id] = list
	}
	return lists, nil
}

func smartRuleMatchesWork(ctx context.Context, q personal.Querier, match personal.SmartMatch, workID int64) (bool, error) {
	var matches bool
	args := append([]any{workID}, match.Args...)
	err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM work WHERE work.id = ? AND "+match.Where+")", args...).Scan(&matches)
	return matches, err
}

// favoriteListContainsWork reports whether the work is in the list as the
// list shows it.
func favoriteListContainsWork(ctx context.Context, q personal.Querier, list editableFavoriteList, workID int64) (bool, error) {
	var contains bool
	if list.Kind != "smart" {
		err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM favorite_list_item WHERE list_id = ? AND work_id = ?)", list.ID, workID).Scan(&contains)
		return contains, err
	}
	where, args := smartListMemberWhere(list.ID, list.Match)
	err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM work WHERE work.id = ? AND "+where+")", append([]any{workID}, args...)...).Scan(&contains)
	return contains, err
}

// addWorkToFavoriteListTx puts a work in a list. In a smart list, a rule match
// the owner removed earlier returns without becoming a favorite, and any
// other work is added by hand.
func addWorkToFavoriteListTx(ctx context.Context, tx *sql.Tx, list editableFavoriteList, workID int64) error {
	if list.Kind == "smart" {
		if _, err := tx.ExecContext(ctx, "DELETE FROM favorite_list_smart_exclusion WHERE list_id = ? AND work_id = ?", list.ID, workID); err != nil {
			return err
		}
		matches, err := smartRuleMatchesWork(ctx, tx, list.Match, workID)
		if err != nil {
			return err
		}
		if matches {
			_, err = tx.ExecContext(ctx, "INSERT INTO favorite_list_smart_seen (list_id, work_id) VALUES (?, ?) ON CONFLICT DO NOTHING", list.ID, workID)
			return err
		}
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO favorite_list_item (list_id, work_id) VALUES (?, ?) ON CONFLICT(list_id, work_id) DO NOTHING", list.ID, workID)
	return err
}

// removeWorkFromFavoriteListTx takes a work out of a list. In a smart list, a
// rule match stays out through an exclusion.
func removeWorkFromFavoriteListTx(ctx context.Context, tx *sql.Tx, list editableFavoriteList, workID int64) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM favorite_list_item WHERE list_id = ? AND work_id = ?", list.ID, workID); err != nil {
		return err
	}
	if list.Kind != "smart" {
		return nil
	}
	matches, err := smartRuleMatchesWork(ctx, tx, list.Match, workID)
	if err != nil || !matches {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO favorite_list_smart_exclusion (list_id, work_id) VALUES (?, ?) ON CONFLICT DO NOTHING", list.ID, workID)
	return err
}

// refreshWorkFavoriteFlagTx keeps user_work_state.favorite equal to whether the
// work was put in any of the user's lists by hand.
func refreshWorkFavoriteFlagTx(ctx context.Context, tx *sql.Tx, userID, workID int64) (bool, error) {
	var favorite bool
	if err := tx.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM favorite_list_item AS item
			INNER JOIN favorite_list AS list ON list.id = item.list_id
			WHERE list.user_id = ? AND list.kind IN `+library.ManualFavoriteListKindsSQL+` AND item.work_id = ?
		)
	`, userID, workID).Scan(&favorite); err != nil {
		return false, err
	}
	return favorite, syncWorkFavoriteFlag(ctx, tx, userID, workID, favorite)
}

// loadSmartListCounts counts each smart list the way its shelf shows it, and
// the new works among them.
func (s *Server) loadSmartListCounts(ctx context.Context, userID int64) (map[int64]int, map[int64]int, error) {
	lists, err := loadEditableFavoriteLists(ctx, s.db, userID)
	if err != nil {
		return nil, nil, err
	}
	counts, newCounts := map[int64]int{}, map[int64]int{}
	for _, list := range lists {
		if list.Kind != "smart" {
			continue
		}
		scope := favoriteListScope{ID: list.ID, Kind: list.Kind, Match: list.Match}
		scope.Where, scope.Args = smartListMemberWhere(list.ID, list.Match)
		where, args := favoriteWorksWhere("all", "all", "", userID, scope, nil)
		where = s.demoWorkWhere(where, "work")
		newWhere, newArgs := smartListNewWhere(list.ID, list.Match)
		queryArgs := append(append([]any{}, newArgs...), userID)
		queryArgs = append(queryArgs, args...)
		var count, fresh int
		if err := s.db.QueryRowContext(ctx, `
			SELECT COUNT(*), COALESCE(SUM(CASE WHEN `+newWhere+` THEN 1 ELSE 0 END), 0)
			FROM work
			LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
			WHERE `+where, queryArgs...).Scan(&count, &fresh); err != nil {
			return nil, nil, err
		}
		counts[list.ID] = count
		if fresh > 0 {
			newCounts[list.ID] = fresh
		}
	}
	return counts, newCounts, nil
}

// smartListNewWorkIDs returns which of the given works are new in the list.
func (s *Server) smartListNewWorkIDs(ctx context.Context, scope favoriteListScope, workIDs []int64) ([]int64, error) {
	result := []int64{}
	if scope.Kind != "smart" || len(workIDs) == 0 {
		return result, nil
	}
	where, args := smartListNewWhere(scope.ID, scope.Match)
	queryArgs := append(int64Args(workIDs), args...)
	rows, err := s.db.QueryContext(ctx, "SELECT work.id FROM work WHERE work.id IN ("+sqlPlaceholders(len(workIDs))+") AND "+where, queryArgs...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result = append(result, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, err
	}
	return result, rows.Close()
}

// attachSmartRuleViews names the rules of the smart lists among lists in the
// viewer's metadata language.
func (s *Server) attachSmartRuleViews(ctx context.Context, userID int64, lists []favoriteListResponse) error {
	smartIDs := []int64{}
	for _, list := range lists {
		if list.Kind == "smart" {
			smartIDs = append(smartIDs, list.ID)
		}
	}
	if len(smartIDs) == 0 {
		return nil
	}
	rules, err := personal.LoadSmartRules(ctx, s.db, smartIDs)
	if err != nil {
		return err
	}
	names := map[int64]string{}
	if languages := s.viewerTagLanguages(ctx); languages != nil {
		all := make([]personal.SmartRule, 0, len(rules))
		for _, rule := range rules {
			all = append(all, rule)
		}
		ids, err := personal.SmartRuleMetadataTagIDs(ctx, s.db, all)
		if err != nil {
			return err
		}
		if names, err = metadatatags.LocalizedNames(ctx, s.db, ids, languages); err != nil {
			return err
		}
	}
	for index := range lists {
		if lists[index].Kind != "smart" {
			continue
		}
		view, err := personal.DescribeSmartRule(ctx, s.db, userID, rules[lists[index].ID], names)
		if err != nil {
			return err
		}
		lists[index].Rule = &view
	}
	return nil
}

func writeSmartRuleError(w http.ResponseWriter, err error) bool {
	var ruleErr personal.SmartRuleError
	if !errors.As(err, &ruleErr) {
		return false
	}
	body := map[string]any{"error": "invalid smart list rule", "code": "invalid_smart_rule", "reason": ruleErr.Reason}
	if ruleErr.TagID > 0 {
		body["tagId"] = ruleErr.TagID
	}
	writeJSON(w, http.StatusBadRequest, body)
	return true
}

// existingSmartRuleTags lists the conditions the user's stored rule holds; a
// list of another account holds none.
func existingSmartRuleTags(ctx context.Context, q personal.Querier, userID, listID int64) (map[personal.SmartRuleTag]bool, error) {
	allowed := map[personal.SmartRuleTag]bool{}
	var owned bool
	if err := q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM favorite_list WHERE id = ? AND user_id = ? AND kind = 'smart')", listID, userID).Scan(&owned); err != nil || !owned {
		return allowed, err
	}
	rules, err := personal.LoadSmartRules(ctx, q, []int64{listID})
	if err != nil {
		return nil, err
	}
	for _, tag := range append(append([]personal.SmartRuleTag{}, rules[listID].Include...), rules[listID].Exclude...) {
		allowed[tag] = true
	}
	return allowed, nil
}

func (s *Server) previewSmartRule(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "library:read")
	if !ok {
		return
	}
	var payload struct {
		ListID int64              `json:"listId"`
		Rule   personal.SmartRule `json:"rule"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<10)).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
		return
	}
	rule, err := personal.NormalizeSmartRule(payload.Rule)
	if err == nil {
		allowed := map[personal.SmartRuleTag]bool{}
		if payload.ListID > 0 {
			if allowed, err = existingSmartRuleTags(r.Context(), s.db, user.ID, payload.ListID); err != nil {
				writeError(w, err)
				return
			}
		}
		err = personal.ValidateSmartRuleTags(r.Context(), s.db, user.ID, rule, allowed)
	}
	if err != nil {
		if !writeSmartRuleError(w, err) {
			writeError(w, err)
		}
		return
	}
	match, err := personal.CompileSmartRule(r.Context(), s.db, user.ID, rule)
	if err != nil {
		writeError(w, err)
		return
	}
	scope := favoriteListScope{Kind: "smart", Where: match.Where, Args: match.Args, Match: match}
	where, args := favoriteWorksWhere("all", "all", "", user.ID, scope, nil)
	where = s.demoWorkWhere(where, "work")
	var total int
	if err := s.db.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE "+where, append([]any{user.ID}, args...)...).Scan(&total); err != nil {
		writeError(w, err)
		return
	}
	rawWorks, err := s.libraryStore.ListMatchingSorted(r.Context(), where, args, library.MatchingListOptions{UserID: user.ID, Page: 1, PageSize: 6, Sort: "recent", Direction: "desc"})
	if err != nil {
		writeError(w, err)
		return
	}
	works, err := s.scanLibraryWorkRows(r.Context(), user.ID, rawWorks, true)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"total": total, "works": works})
}

type smartRuleTagOption struct {
	ID        int64  `json:"id"`
	Name      string `json:"name"`
	WorkCount int    `json:"workCount"`
}

// listSmartRuleTags is the metadata tag vocabulary of the smart list editor.
// Unlike the Metadata management list it needs only library:read, and it
// offers only tags that resolve to a visible tag some work carries.
func (s *Server) listSmartRuleTags(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "library:read"); !ok {
		return
	}
	page := max(1, queryInt(r, "page", 1))
	size := max(1, min(50, queryInt(r, "pageSize", 20)))
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	workFilter := ""
	if s.cfg.IsDemo() {
		workFilter = " INNER JOIN work AS demo_work ON demo_work.id = link.work_id AND " + contentpolicy.DemoEligibleWorkSQL("demo_work")
	}
	candidates := `
		WITH candidate AS (
			SELECT DISTINCT resolution.resolved_tag_id AS tag_id
			FROM metadata_tag AS concept
			INNER JOIN tag ON tag.id = concept.tag_id
			INNER JOIN metadata_tag_resolution AS resolution ON resolution.source_tag_id = concept.tag_id
			INNER JOIN metadata_tag AS target ON target.tag_id = resolution.resolved_tag_id
			WHERE target.hidden = 0 AND (? = ''
				OR INSTR(LOWER(tag.display_name), LOWER(?)) > 0
				OR EXISTS (SELECT 1 FROM metadata_tag_name WHERE tag_id = concept.tag_id AND INSTR(LOWER(name), LOWER(?)) > 0)
				OR EXISTS (SELECT 1 FROM metadata_tag_provider_name WHERE tag_id = concept.tag_id AND INSTR(LOWER(name), LOWER(?)) > 0)
				OR EXISTS (SELECT 1 FROM metadata_tag_llm_name WHERE tag_id = concept.tag_id AND INSTR(LOWER(name), LOWER(?)) > 0)
				OR EXISTS (SELECT 1 FROM dlsite_genre_name WHERE genre_id = concept.dlsite_genre_id AND INSTR(LOWER(name), LOWER(?)) > 0))
		), counted AS (
			SELECT candidate.tag_id, (SELECT COUNT(DISTINCT link.work_id) FROM work_tag AS link` + workFilter + ` WHERE link.tag_id = candidate.tag_id) AS work_count
			FROM candidate
		)`
	args := []any{query, query, query, query, query, query}
	var total int
	if err := s.db.QueryRowContext(r.Context(), candidates+" SELECT COUNT(*) FROM counted WHERE work_count > 0", args...).Scan(&total); err != nil {
		writeError(w, err)
		return
	}
	rows, err := s.db.QueryContext(r.Context(), candidates+`
		SELECT counted.tag_id, tag.display_name, counted.work_count
		FROM counted INNER JOIN tag ON tag.id = counted.tag_id
		WHERE counted.work_count > 0
		ORDER BY counted.work_count DESC, LOWER(tag.display_name), counted.tag_id
		LIMIT ? OFFSET ?`, append(args, size, (page-1)*size)...)
	if err != nil {
		writeError(w, err)
		return
	}
	tags := []smartRuleTagOption{}
	for rows.Next() {
		var tag smartRuleTagOption
		if err := rows.Scan(&tag.ID, &tag.Name, &tag.WorkCount); err != nil {
			_ = rows.Close()
			writeError(w, err)
			return
		}
		tags = append(tags, tag)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		writeError(w, err)
		return
	}
	if err := rows.Close(); err != nil {
		writeError(w, err)
		return
	}
	if languages := s.viewerTagLanguages(r.Context()); languages != nil && len(tags) > 0 {
		ids := make([]int64, len(tags))
		for index, tag := range tags {
			ids[index] = tag.ID
		}
		names, err := metadatatags.LocalizedNames(r.Context(), s.db, ids, languages)
		if err != nil {
			writeError(w, err)
			return
		}
		for index := range tags {
			if name, ok := names[tags[index].ID]; ok {
				tags[index].Name = name
			}
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"tags": tags, "total": total, "page": page, "pageSize": size})
}

// loadOwnSmartList loads one of the user's smart lists for a write.
func (s *Server) loadOwnSmartList(ctx context.Context, q personal.Querier, w http.ResponseWriter, r *http.Request, userID int64) (editableFavoriteList, bool) {
	listID, err := parseInt64PathValue(r, "id")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid favorite list id"})
		return editableFavoriteList{}, false
	}
	scope, err := s.loadFavoriteListScope(ctx, q, userID, listID)
	if err != nil {
		writeError(w, err)
		return editableFavoriteList{}, false
	}
	switch scope.Kind {
	case "":
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "favorite list not found"})
		return editableFavoriteList{}, false
	case "smart":
		return editableFavoriteList{ID: listID, Kind: scope.Kind, Match: scope.Match}, true
	default:
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "favorite list is not a smart list", "code": "not_smart_list"})
		return editableFavoriteList{}, false
	}
}

// markFavoriteListSeen acknowledges every new work of a smart list.
func (s *Server) markFavoriteListSeen(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	list, ok := s.loadOwnSmartList(r.Context(), tx, w, r, user.ID)
	if !ok {
		return
	}
	if err := markSmartListSeenTx(r.Context(), tx, list.ID, list.Match); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"listId": list.ID, "newCount": 0})
}

// convertFavoriteList turns a smart list into a user list that holds exactly
// the works the smart list shows now. Every one of them becomes a favorite.
func (s *Server) convertFavoriteList(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	tx, err := s.db.BeginTx(r.Context(), nil)
	if err != nil {
		writeError(w, err)
		return
	}
	defer func() { _ = tx.Rollback() }()
	list, ok := s.loadOwnSmartList(r.Context(), tx, w, r, user.ID)
	if !ok {
		return
	}
	scope := favoriteListScope{ID: list.ID, Kind: list.Kind, Match: list.Match}
	scope.Where, scope.Args = smartListMemberWhere(list.ID, list.Match)
	where, args := favoriteWorksWhere("all", "all", "", user.ID, scope, nil)
	insertArgs := append([]any{list.ID, user.ID}, args...)
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO favorite_list_item (list_id, work_id)
		SELECT ?, work.id FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		WHERE `+where+`
		ON CONFLICT(list_id, work_id) DO NOTHING
	`, insertArgs...); err != nil {
		writeError(w, err)
		return
	}
	for _, statement := range []string{
		"DELETE FROM favorite_list_smart_tag WHERE list_id = ?",
		"DELETE FROM favorite_list_smart_rule WHERE list_id = ?",
		"DELETE FROM favorite_list_smart_exclusion WHERE list_id = ?",
		"DELETE FROM favorite_list_smart_seen WHERE list_id = ?",
	} {
		if _, err := tx.ExecContext(r.Context(), statement, list.ID); err != nil {
			writeError(w, err)
			return
		}
	}
	if _, err := tx.ExecContext(r.Context(), "UPDATE favorite_list SET kind = 'user', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?", list.ID, user.ID); err != nil {
		writeError(w, err)
		return
	}
	if _, err := tx.ExecContext(r.Context(), `
		INSERT INTO user_work_state (user_id, work_id, listening_status, favorite)
		SELECT ?, item.work_id, 'none', 1 FROM favorite_list_item AS item WHERE item.list_id = ?
		ON CONFLICT(user_id, work_id) DO UPDATE SET favorite = 1 WHERE user_work_state.favorite <> 1
	`, user.ID, list.ID); err != nil {
		writeError(w, err)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, err)
		return
	}
	item, err := s.loadFavoriteList(r.Context(), user.ID, list.ID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, item)
}

// listSmartListWorkIDs is the work-ids answer for a smart list, newest library
// works first and bounded by maxSmartListWorkIDs.
func (s *Server) listSmartListWorkIDs(ctx context.Context, userID int64, scope favoriteListScope) ([]int64, bool, error) {
	where, args := favoriteWorksWhere("all", "all", "", userID, scope, nil)
	where = s.demoWorkWhere(where, "work")
	queryArgs := append([]any{userID}, args...)
	queryArgs = append(queryArgs, maxSmartListWorkIDs+1)
	rows, err := s.db.QueryContext(ctx, `
		SELECT work.id FROM work
		LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
		WHERE `+where+`
		ORDER BY work.created_at DESC, work.id DESC
		LIMIT ?`, queryArgs...)
	if err != nil {
		return nil, false, err
	}
	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			_ = rows.Close()
			return nil, false, err
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return nil, false, err
	}
	if err := rows.Close(); err != nil {
		return nil, false, err
	}
	truncated := len(ids) > maxSmartListWorkIDs
	if truncated {
		ids = ids[:maxSmartListWorkIDs]
	}
	return ids, truncated, nil
}
