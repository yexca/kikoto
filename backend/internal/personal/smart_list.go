package personal

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// A smart favorite list holds the works that match its tag rule, plus the
// works its owner adds by hand (favorite_list_item), minus the rule matches
// its owner removes (favorite_list_smart_exclusion). Rule matches are computed
// on read and never set user_work_state.favorite; only the hand-added works
// are favorites.
const (
	SmartTagMetadata = "metadata"
	SmartTagUser     = "user"

	MaxSmartRuleIncludes = 16
	MaxSmartRuleExcludes = 16
	MaxSmartListsPerUser = 30
)

// Tag states of a rule condition. A hidden or missing tag matches no work.
const (
	SmartTagActive  = "active"
	SmartTagMerged  = "merged"
	SmartTagHidden  = "hidden"
	SmartTagMissing = "missing"
)

type SmartRuleTag struct {
	Kind string `json:"kind"`
	ID   int64  `json:"id"`
}

type SmartRule struct {
	IncludeMatch string         `json:"includeMatch"`
	Include      []SmartRuleTag `json:"include"`
	Exclude      []SmartRuleTag `json:"exclude"`
}

// SmartRuleError names why a rule was refused, so the editor can point at the
// condition. TagID is set when one tag caused the refusal.
type SmartRuleError struct {
	Reason string
	TagID  int64
}

func (e SmartRuleError) Error() string { return "invalid smart list rule: " + e.Reason }

// Querier is the read surface shared by *sql.DB and *sql.Tx.
type Querier interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// NormalizeSmartRule checks the rule's shape: known kinds, bounded sizes, at
// least one included tag, and no tag both included and excluded.
func NormalizeSmartRule(rule SmartRule) (SmartRule, error) {
	match := strings.ToLower(strings.TrimSpace(rule.IncludeMatch))
	if match == "" {
		match = "all"
	}
	if match != "all" && match != "any" {
		return SmartRule{}, SmartRuleError{Reason: "include_match"}
	}
	seen := map[SmartRuleTag]string{}
	normalize := func(tags []SmartRuleTag, mode string) ([]SmartRuleTag, error) {
		result := make([]SmartRuleTag, 0, len(tags))
		for _, tag := range tags {
			tag.Kind = strings.ToLower(strings.TrimSpace(tag.Kind))
			if (tag.Kind != SmartTagMetadata && tag.Kind != SmartTagUser) || tag.ID <= 0 {
				return nil, SmartRuleError{Reason: "tag", TagID: tag.ID}
			}
			if previous, ok := seen[tag]; ok {
				if previous != mode {
					return nil, SmartRuleError{Reason: "overlap", TagID: tag.ID}
				}
				continue
			}
			seen[tag] = mode
			result = append(result, tag)
		}
		return result, nil
	}
	include, err := normalize(rule.Include, "include")
	if err != nil {
		return SmartRule{}, err
	}
	exclude, err := normalize(rule.Exclude, "exclude")
	if err != nil {
		return SmartRule{}, err
	}
	if len(include) == 0 {
		return SmartRule{}, SmartRuleError{Reason: "include_required"}
	}
	if len(include) > MaxSmartRuleIncludes || len(exclude) > MaxSmartRuleExcludes {
		return SmartRule{}, SmartRuleError{Reason: "too_many_tags"}
	}
	return SmartRule{IncludeMatch: match, Include: include, Exclude: exclude}, nil
}

// ValidateSmartRuleTags refuses a tag the user cannot use: another account's
// personal tag, or a metadata tag that does not exist or resolves to a hidden
// tag. allowed lists conditions the stored rule already holds, so editing a
// list keeps a condition whose tag was hidden or deleted after it was added.
func ValidateSmartRuleTags(ctx context.Context, q Querier, userID int64, rule SmartRule, allowed map[SmartRuleTag]bool) error {
	for _, tag := range append(append([]SmartRuleTag{}, rule.Include...), rule.Exclude...) {
		if allowed[tag] {
			continue
		}
		var ok bool
		var err error
		if tag.Kind == SmartTagUser {
			err = q.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM user_tag WHERE id = ? AND user_id = ?)", tag.ID, userID).Scan(&ok)
		} else {
			err = q.QueryRowContext(ctx, `SELECT EXISTS(
				SELECT 1 FROM metadata_tag_resolution AS resolution
				INNER JOIN metadata_tag AS concept ON concept.tag_id = resolution.resolved_tag_id
				WHERE resolution.source_tag_id = ? AND concept.hidden = 0
			)`, tag.ID).Scan(&ok)
		}
		if err != nil {
			return err
		}
		if !ok {
			return SmartRuleError{Reason: "tag", TagID: tag.ID}
		}
	}
	return nil
}

// SaveSmartRuleTx replaces a list's rule.
func SaveSmartRuleTx(ctx context.Context, tx *sql.Tx, listID int64, rule SmartRule) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO favorite_list_smart_rule (list_id, include_match) VALUES (?, ?)
		ON CONFLICT(list_id) DO UPDATE SET include_match = excluded.include_match, updated_at = CURRENT_TIMESTAMP
	`, listID, rule.IncludeMatch); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM favorite_list_smart_tag WHERE list_id = ?", listID); err != nil {
		return err
	}
	for mode, tags := range map[string][]SmartRuleTag{"include": rule.Include, "exclude": rule.Exclude} {
		for _, tag := range tags {
			if _, err := tx.ExecContext(ctx, "INSERT INTO favorite_list_smart_tag (list_id, tag_kind, tag_id, mode) VALUES (?, ?, ?, ?)", listID, tag.Kind, tag.ID, mode); err != nil {
				return err
			}
		}
	}
	return nil
}

// LoadSmartRules returns the rules of the given smart lists. A list without a
// stored rule gets an empty rule, which matches no work.
func LoadSmartRules(ctx context.Context, q Querier, listIDs []int64) (map[int64]SmartRule, error) {
	result := make(map[int64]SmartRule, len(listIDs))
	if len(listIDs) == 0 {
		return result, nil
	}
	args := make([]any, len(listIDs))
	for index, id := range listIDs {
		args[index] = id
		result[id] = SmartRule{IncludeMatch: "all", Include: []SmartRuleTag{}, Exclude: []SmartRuleTag{}}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(listIDs)), ",")
	rows, err := q.QueryContext(ctx, "SELECT list_id, include_match FROM favorite_list_smart_rule WHERE list_id IN ("+placeholders+")", args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var match string
		if err := rows.Scan(&id, &match); err != nil {
			_ = rows.Close()
			return nil, err
		}
		rule := result[id]
		rule.IncludeMatch = match
		result[id] = rule
	}
	if err := closeSmartRows(rows); err != nil {
		return nil, err
	}
	rows, err = q.QueryContext(ctx, "SELECT list_id, tag_kind, tag_id, mode FROM favorite_list_smart_tag WHERE list_id IN ("+placeholders+") ORDER BY list_id, mode, rowid", args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var tag SmartRuleTag
		var mode string
		if err := rows.Scan(&id, &tag.Kind, &tag.ID, &mode); err != nil {
			_ = rows.Close()
			return nil, err
		}
		rule := result[id]
		if mode == "exclude" {
			rule.Exclude = append(rule.Exclude, tag)
		} else {
			rule.Include = append(rule.Include, tag)
		}
		result[id] = rule
	}
	return result, closeSmartRows(rows)
}

// SmartMatch is a compiled rule: a predicate over the work table alias "work".
type SmartMatch struct {
	Where string
	Args  []any
}

// CompileSmartRule resolves metadata tag merges once and returns the rule as a
// predicate. A work matches when it, or another edition of the same logical
// work, carries the metadata tag; a personal tag matches the work itself.
func CompileSmartRule(ctx context.Context, q Querier, userID int64, rule SmartRule) (SmartMatch, error) {
	resolved, err := resolveSmartMetadataTags(ctx, q, rule)
	if err != nil {
		return SmartMatch{}, err
	}
	if len(rule.Include) == 0 {
		return SmartMatch{Where: "0"}, nil
	}
	metadataIDs := func(tags []SmartRuleTag) []int64 {
		ids := []int64{}
		for _, tag := range tags {
			if tag.Kind == SmartTagMetadata {
				if id, ok := resolved[tag.ID]; ok {
					ids = append(ids, id)
				}
			}
		}
		return ids
	}
	userIDs := func(tags []SmartRuleTag) []int64 {
		ids := []int64{}
		for _, tag := range tags {
			if tag.Kind == SmartTagUser {
				ids = append(ids, tag.ID)
			}
		}
		return ids
	}
	clauses := []string{}
	args := []any{}
	if rule.IncludeMatch == "any" {
		where, whereArgs := smartTagGroupWhere(userID, metadataIDs(rule.Include), userIDs(rule.Include))
		clauses = append(clauses, where)
		args = append(args, whereArgs...)
	} else {
		for _, tag := range rule.Include {
			var where string
			var whereArgs []any
			if tag.Kind == SmartTagUser {
				where, whereArgs = smartTagGroupWhere(userID, nil, []int64{tag.ID})
			} else if id, ok := resolved[tag.ID]; ok {
				where, whereArgs = smartTagGroupWhere(userID, []int64{id}, nil)
			} else {
				where = "0"
			}
			clauses = append(clauses, where)
			args = append(args, whereArgs...)
		}
	}
	if excludeMetadata, excludeUser := metadataIDs(rule.Exclude), userIDs(rule.Exclude); len(excludeMetadata)+len(excludeUser) > 0 {
		where, whereArgs := smartTagGroupWhere(userID, excludeMetadata, excludeUser)
		clauses = append(clauses, "NOT "+where)
		args = append(args, whereArgs...)
	}
	return SmartMatch{Where: "(" + strings.Join(clauses, " AND ") + ")", Args: args}, nil
}

// smartTagGroupWhere matches a work carrying any of the metadata or personal
// tags. Direct and edition-family links are separate indexed probes.
func smartTagGroupWhere(userID int64, metadataIDs, userTagIDs []int64) (string, []any) {
	parts := []string{}
	args := []any{}
	if len(metadataIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(metadataIDs)), ",")
		parts = append(parts, `EXISTS (
			SELECT 1 FROM work_tag AS smart_tag
			WHERE smart_tag.work_id = work.id AND smart_tag.tag_id IN (`+placeholders+`)
		)`, `EXISTS (
			SELECT 1 FROM work_edition AS smart_current_edition
			INNER JOIN work_edition AS smart_sibling_edition ON smart_sibling_edition.logical_work_id = smart_current_edition.logical_work_id
			INNER JOIN work_tag AS smart_sibling_tag ON smart_sibling_tag.work_id = smart_sibling_edition.work_id
			WHERE smart_current_edition.work_id = work.id AND smart_sibling_tag.tag_id IN (`+placeholders+`)
		)`)
		for range 2 {
			for _, id := range metadataIDs {
				args = append(args, id)
			}
		}
	}
	if len(userTagIDs) > 0 {
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(userTagIDs)), ",")
		parts = append(parts, `EXISTS (
			SELECT 1 FROM user_work_tag AS smart_user_tag
			WHERE smart_user_tag.user_id = ? AND smart_user_tag.work_id = work.id AND smart_user_tag.user_tag_id IN (`+placeholders+`)
		)`)
		args = append(args, userID)
		for _, id := range userTagIDs {
			args = append(args, id)
		}
	}
	if len(parts) == 0 {
		return "0", nil
	}
	return "(" + strings.Join(parts, " OR ") + ")", args
}

// resolveSmartMetadataTags maps each metadata tag of the rule to the tag its
// merges resolve to. Unknown ids are absent.
func resolveSmartMetadataTags(ctx context.Context, q Querier, rule SmartRule) (map[int64]int64, error) {
	ids := []any{}
	for _, tag := range append(append([]SmartRuleTag{}, rule.Include...), rule.Exclude...) {
		if tag.Kind == SmartTagMetadata {
			ids = append(ids, tag.ID)
		}
	}
	result := map[int64]int64{}
	if len(ids) == 0 {
		return result, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	rows, err := q.QueryContext(ctx, "SELECT source_tag_id, resolved_tag_id FROM metadata_tag_resolution WHERE source_tag_id IN ("+placeholders+")", ids...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var source, resolvedID int64
		if err := rows.Scan(&source, &resolvedID); err != nil {
			_ = rows.Close()
			return nil, err
		}
		result[source] = resolvedID
	}
	return result, closeSmartRows(rows)
}

// SmartRuleTagView is one rule condition as the editor shows it. ResolvedID is
// the metadata tag a merged tag now resolves to.
type SmartRuleTagView struct {
	Kind       string `json:"kind"`
	ID         int64  `json:"id"`
	ResolvedID int64  `json:"resolvedId,omitempty"`
	Name       string `json:"name"`
	State      string `json:"state"`
}

type SmartRuleView struct {
	IncludeMatch string             `json:"includeMatch"`
	Include      []SmartRuleTagView `json:"include"`
	Exclude      []SmartRuleTagView `json:"exclude"`
}

// DescribeSmartRule names each condition and reports its state. names maps a
// resolved metadata tag id to the viewer's name; tags without an entry keep
// their stored display name.
func DescribeSmartRule(ctx context.Context, q Querier, userID int64, rule SmartRule, names map[int64]string) (SmartRuleView, error) {
	view := SmartRuleView{IncludeMatch: rule.IncludeMatch, Include: []SmartRuleTagView{}, Exclude: []SmartRuleTagView{}}
	describe := func(tag SmartRuleTag) (SmartRuleTagView, error) {
		item := SmartRuleTagView{Kind: tag.Kind, ID: tag.ID, State: SmartTagMissing}
		if tag.Kind == SmartTagUser {
			err := q.QueryRowContext(ctx, "SELECT name FROM user_tag WHERE id = ? AND user_id = ?", tag.ID, userID).Scan(&item.Name)
			if err == nil {
				item.State = SmartTagActive
			} else if !errors.Is(err, sql.ErrNoRows) {
				return item, err
			}
			return item, nil
		}
		var hidden bool
		err := q.QueryRowContext(ctx, `
			SELECT resolution.resolved_tag_id, tag.display_name, concept.hidden
			FROM metadata_tag_resolution AS resolution
			INNER JOIN metadata_tag AS concept ON concept.tag_id = resolution.resolved_tag_id
			INNER JOIN tag ON tag.id = concept.tag_id
			WHERE resolution.source_tag_id = ?
		`, tag.ID).Scan(&item.ResolvedID, &item.Name, &hidden)
		if errors.Is(err, sql.ErrNoRows) {
			return item, nil
		}
		if err != nil {
			return item, err
		}
		if name, ok := names[item.ResolvedID]; ok {
			item.Name = name
		}
		switch {
		case hidden:
			item.State = SmartTagHidden
		case item.ResolvedID != tag.ID:
			item.State = SmartTagMerged
		default:
			item.State = SmartTagActive
		}
		return item, nil
	}
	for _, tag := range rule.Include {
		item, err := describe(tag)
		if err != nil {
			return view, err
		}
		view.Include = append(view.Include, item)
	}
	for _, tag := range rule.Exclude {
		item, err := describe(tag)
		if err != nil {
			return view, err
		}
		view.Exclude = append(view.Exclude, item)
	}
	return view, nil
}

// SmartRuleMetadataTagIDs lists the resolved metadata tag ids a rule names, so
// a caller can localize them in one batch.
func SmartRuleMetadataTagIDs(ctx context.Context, q Querier, rules []SmartRule) ([]int64, error) {
	combined := SmartRule{}
	for _, rule := range rules {
		combined.Include = append(combined.Include, rule.Include...)
		combined.Exclude = append(combined.Exclude, rule.Exclude...)
	}
	resolved, err := resolveSmartMetadataTags(ctx, q, combined)
	if err != nil {
		return nil, err
	}
	seen := map[int64]bool{}
	ids := []int64{}
	for _, id := range resolved {
		if !seen[id] {
			seen[id] = true
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func closeSmartRows(rows *sql.Rows) error {
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return err
	}
	return rows.Close()
}
