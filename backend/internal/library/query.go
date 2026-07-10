package library

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

type ListOptions struct {
	UserID    int64
	Page      int
	PageSize  int
	Scope     string
	Status    string
	Query     string
	Sort      string
	Direction string
}

type RawPage struct {
	Works    []RawWork
	Page     int
	PageSize int
	Total    int
}

type RawWork struct {
	ID                     int64
	PrimaryCode            string
	Title                  string
	CreatedAt              string
	TrackCount             int64
	AvailableLocations     int64
	AvailableLocationTypes string
	SourcePresence         string
	Snapshot               string
	PartyLink              string
	ListeningStatus        string
	Favorite               bool
}

func (s *Store) ListAll(ctx context.Context, userID int64) ([]RawWork, error) {
	rows, err := s.db.QueryContext(ctx, listBaseSelectSQL("1 = 1", false)+" ORDER BY work.created_at DESC", userID)
	if err != nil {
		return nil, err
	}
	return ScanRows(rows)
}

func (s *Store) ListPage(ctx context.Context, options ListOptions) (RawPage, error) {
	if options.Page < 1 {
		options.Page = 1
	}
	if options.PageSize < 1 || options.PageSize > 100 {
		options.PageSize = 24
	}
	where, args := listWhere(options.Scope, options.Status, options.Query)
	countArgs := append([]any{options.UserID}, args...)
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE "+where, countArgs...).Scan(&total); err != nil {
		return RawPage{}, err
	}
	queryArgs := append([]any{options.UserID}, args...)
	queryArgs = append(queryArgs, options.PageSize, (options.Page-1)*options.PageSize)
	rows, err := s.db.QueryContext(ctx, listSelectSQL(where, options.Sort, options.Direction)+" LIMIT ? OFFSET ?", queryArgs...)
	if err != nil {
		return RawPage{}, err
	}
	works, err := ScanRows(rows)
	if err != nil {
		return RawPage{}, err
	}
	return RawPage{Works: works, Page: options.Page, PageSize: options.PageSize, Total: total}, nil
}

// ListMatching materializes the common Library projection for a predicate
// owned by an adjacent feature, such as a user's favorite shelf.
func (s *Store) ListMatching(ctx context.Context, userID int64, where string, args []any, page int, pageSize int) ([]RawWork, error) {
	queryArgs := append([]any{userID}, args...)
	queryArgs = append(queryArgs, pageSize, (page-1)*pageSize)
	rows, err := s.db.QueryContext(ctx, listSelectSQL(where, "recent", "desc")+" LIMIT ? OFFSET ?", queryArgs...)
	if err != nil {
		return nil, err
	}
	return ScanRows(rows)
}

// ScanRows owns rows and closes it after fully materializing the common
// Library projection. This allows callers to perform follow-up enrichment even
// when SQLite is configured with a single connection.
func ScanRows(rows *sql.Rows) ([]RawWork, error) {
	defer rows.Close()
	works := []RawWork{}
	for rows.Next() {
		var item RawWork
		var availableLocationTypes, sourcePresence, snapshot, partyLink sql.NullString
		var favorite int
		if err := rows.Scan(
			&item.ID,
			&item.PrimaryCode,
			&item.Title,
			&item.CreatedAt,
			&item.TrackCount,
			&item.AvailableLocations,
			&availableLocationTypes,
			&sourcePresence,
			&snapshot,
			&partyLink,
			&item.ListeningStatus,
			&favorite,
		); err != nil {
			return nil, err
		}
		item.AvailableLocationTypes = availableLocationTypes.String
		item.SourcePresence = sourcePresence.String
		item.Snapshot = snapshot.String
		item.PartyLink = partyLink.String
		item.Favorite = favorite != 0
		works = append(works, item)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	return works, nil
}

func listOrderBy(sortKey string, direction string) (string, bool) {
	sortKey, direction = normalizeSort(sortKey, direction)
	switch sortKey {
	case "release":
		return "work.release_date IS NULL ASC, work.release_date " + direction + ", work.created_at " + direction + ", work.id " + direction, false
	case "code":
		return "work.primary_code " + direction + ", work.id " + direction, false
	case "title":
		return "work.title COLLATE NOCASE " + direction + ", work.id " + direction, false
	case "rating":
		return "latest_dlsite_rating IS NULL ASC, latest_dlsite_rating " + direction + ", created_at " + direction + ", id " + direction, true
	case "sales":
		return "latest_dlsite_sales IS NULL ASC, latest_dlsite_sales " + direction + ", created_at " + direction + ", id " + direction, true
	default:
		return "work.created_at " + direction + ", work.id " + direction, false
	}
}

func normalizeSort(sortKey string, direction string) (string, string) {
	sortKey = strings.ToLower(strings.TrimSpace(sortKey))
	direction = strings.ToUpper(strings.TrimSpace(direction))
	switch sortKey {
	case "release_desc":
		sortKey, direction = "release", "DESC"
	case "release_asc":
		sortKey, direction = "release", "ASC"
	case "code_asc":
		sortKey, direction = "code", "ASC"
	case "title_asc":
		sortKey, direction = "title", "ASC"
	case "rating_desc":
		sortKey, direction = "rating", "DESC"
	case "sales_desc":
		sortKey, direction = "sales", "DESC"
	}
	switch sortKey {
	case "recent", "release", "code", "title", "rating", "sales":
	default:
		sortKey = "recent"
	}
	if direction != "ASC" && direction != "DESC" {
		direction = "DESC"
	}
	return sortKey, direction
}

func listWhere(scope string, status string, queryText string) (string, []any) {
	clauses := []string{"1 = 1"}
	args := []any{}
	switch scope {
	case "local":
		clauses = append(clauses, `EXISTS (
			SELECT 1 FROM work_source_presence AS scope_presence
			WHERE (scope_presence.work_id = work.id OR scope_presence.work_id IN (
				SELECT sibling.work_id FROM work_edition AS current_edition
				INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
				WHERE current_edition.work_id = work.id
			)) AND scope_presence.presence_type = 'local' AND scope_presence.availability = 'available'
		)`)
	case "tracked":
		clauses = append(clauses, `EXISTS (SELECT 1 FROM work_source_presence AS scope_presence WHERE scope_presence.work_id = work.id AND scope_presence.presence_type = 'tracked' AND scope_presence.availability = 'available')`)
	case "remote":
		clauses = append(clauses,
			`EXISTS (SELECT 1 FROM work_source_presence AS scope_presence WHERE scope_presence.work_id = work.id AND scope_presence.presence_type = 'source' AND scope_presence.availability = 'available')`,
			`NOT EXISTS (SELECT 1 FROM work_source_presence AS scope_presence WHERE scope_presence.work_id = work.id AND scope_presence.presence_type = 'tracked' AND scope_presence.availability = 'available')`,
			`NOT EXISTS (
				SELECT 1 FROM work_source_presence AS scope_presence
				WHERE (scope_presence.work_id = work.id OR scope_presence.work_id IN (
					SELECT sibling.work_id FROM work_edition AS current_edition
					INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
					WHERE current_edition.work_id = work.id
				)) AND scope_presence.presence_type = 'local' AND scope_presence.availability = 'available'
			)`,
		)
	case "no_source":
		clauses = append(clauses, noSourceWhereClause())
	}
	if status != "" && status != "all" {
		clauses = append(clauses, "COALESCE(user_work_state.listening_status, 'none') = ?")
		args = append(args, status)
	}
	if searchWhere, searchArgs := SearchWhere(queryText); searchWhere != "" {
		clauses = append(clauses, searchWhere)
		args = append(args, searchArgs...)
	}
	clauses = append(clauses, canonicalVisibleWhereClause())
	return strings.Join(clauses, " AND "), args
}

func canonicalVisibleWhereClause() string {
	return `(
		NOT EXISTS (SELECT 1 FROM work_edition AS edition WHERE edition.work_id = work.id)
		OR EXISTS (
			SELECT 1 FROM work_edition AS edition
			INNER JOIN logical_work AS logical ON logical.id = edition.logical_work_id
			WHERE edition.work_id = work.id
				AND (edition.is_canonical = 1 OR logical.canonical_work_id IS NULL OR logical.canonical_work_id = work.id)
		)
	)`
}

func noSourceWhereClause() string {
	return `NOT EXISTS (
		SELECT 1 FROM work_source_presence AS scope_presence
		WHERE scope_presence.work_id = work.id OR scope_presence.work_id IN (
			SELECT sibling.work_id FROM work_edition AS current_edition
			INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
			WHERE current_edition.work_id = work.id
		)
	) AND NOT EXISTS (
		SELECT 1 FROM media_file_location AS scope_location
		INNER JOIN media_item AS scope_item ON scope_item.id = scope_location.media_item_id
		WHERE (scope_item.work_id = work.id OR scope_item.work_id IN (
			SELECT sibling.work_id FROM work_edition AS current_edition
			INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
			WHERE current_edition.work_id = work.id
		)) AND scope_location.availability = 'available'
	)`
}

func SearchWhere(queryText string) (string, []any) {
	clauses := []string{}
	args := []any{}
	for _, clause := range ParseSearchClauses(queryText) {
		needle := strings.TrimSpace(clause.Value)
		if needle == "" {
			continue
		}
		like := "%" + strings.ToLower(needle) + "%"
		switch clause.Kind {
		case "code":
			clauses = append(clauses, "LOWER(work.primary_code) LIKE ?")
			args = append(args, like)
		case "circle":
			clauses = append(clauses, `(EXISTS (
				SELECT 1 FROM work_party AS search_relation
				INNER JOIN party AS search_party ON search_party.id = search_relation.party_id
				LEFT JOIN party_external_id AS search_external ON search_external.party_id = search_party.id
				WHERE search_relation.work_id = work.id AND search_relation.role = 'circle'
					AND (LOWER(search_party.display_name) LIKE ? OR LOWER(COALESCE(search_external.external_id, '')) LIKE ?)
			) OR `+manualOverrideFieldLikeClause("circle")+`)`)
			args = append(args, like, like, like)
		case "voice_actor":
			clauses = append(clauses, `(EXISTS (
				SELECT 1 FROM work_credit AS search_credit
				INNER JOIN person AS search_person ON search_person.id = search_credit.person_id
				WHERE search_credit.work_id = work.id AND search_credit.role = 'voice_actor' AND LOWER(search_person.display_name) LIKE ?
			) OR `+manualOverrideFieldLikeClause("voice_actors")+`)`)
			args = append(args, like, like)
		case "tag":
			clauses = append(clauses, normalizedTagLikeClause(false))
			args = append(args, like)
		case "exclude_tag":
			clauses = append(clauses, normalizedTagLikeClause(true))
			args = append(args, like)
		case "rating_min":
			clauses = append(clauses, latestSnapshotNumericClause("rating", ">=", NumericClauseValue(needle)))
		case "sales_min":
			clauses = append(clauses, latestSnapshotNumericClause("sales", ">=", NumericClauseValue(needle)))
		default:
			clauses = append(clauses, `(LOWER(work.primary_code) LIKE ? OR LOWER(work.title) LIKE ? OR `+normalizedTagLikeClause(false)+` OR `+latestSnapshotLikeClause()+` OR `+manualOverrideAnyLikeClause("title", "circle", "series", "voice_actors")+`)`)
			args = append(args, like, like, like, like, like)
		}
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return "(" + strings.Join(clauses, " AND ") + ")", args
}

func manualOverrideFieldLikeClause(field string) string {
	return `EXISTS (SELECT 1 FROM work_manual_override AS search_override WHERE search_override.work_id = work.id AND search_override.field_name = '` + field + `' AND LOWER(search_override.value_json) LIKE ?)`
}

func normalizedTagLikeClause(negated bool) string {
	prefix := "EXISTS"
	if negated {
		prefix = "NOT EXISTS"
	}
	return prefix + ` (SELECT 1 FROM work_tag AS search_work_tag INNER JOIN tag AS search_tag ON search_tag.id = search_work_tag.tag_id WHERE search_work_tag.work_id = work.id AND search_tag.namespace = 'dlsite' AND LOWER(search_tag.display_name) LIKE ?)`
}

func manualOverrideAnyLikeClause(fields ...string) string {
	quoted := make([]string, 0, len(fields))
	for _, field := range fields {
		quoted = append(quoted, "'"+field+"'")
	}
	return `EXISTS (SELECT 1 FROM work_manual_override AS search_override WHERE search_override.work_id = work.id AND search_override.field_name IN (` + strings.Join(quoted, ",") + `) AND LOWER(search_override.value_json) LIKE ?)`
}

func latestSnapshotLikeClause() string {
	return `(LOWER(COALESCE((SELECT snapshot_json FROM metadata_snapshot AS search_snapshot INNER JOIN metadata_provider AS search_provider ON search_provider.id = search_snapshot.provider_id WHERE search_snapshot.work_id = work.id AND search_provider.code = 'dlsite' ORDER BY search_snapshot.fetched_at DESC, search_snapshot.id DESC LIMIT 1), '')) LIKE ?)`
}

func latestSnapshotNumericClause(kind string, operator string, value float64) string {
	if operator != ">=" && operator != "<=" {
		operator = ">="
	}
	path, fallback := "$.product.rate_average_2dp", "$.product.rate_average_2dp"
	if kind == "sales" {
		path, fallback = "$.dynamic.dl_count", "$.product.sales_count"
	}
	return fmt.Sprintf(`COALESCE((SELECT CAST(COALESCE(json_extract(search_snapshot.snapshot_json, '%s'), json_extract(search_snapshot.snapshot_json, '%s')) AS REAL) FROM metadata_snapshot AS search_snapshot INNER JOIN metadata_provider AS search_provider ON search_provider.id = search_snapshot.provider_id WHERE search_snapshot.work_id = work.id AND search_provider.code = 'dlsite' ORDER BY search_snapshot.fetched_at DESC, search_snapshot.id DESC LIMIT 1), 0) %s %g`, path, fallback, operator, value)
}

func listSelectSQL(where string, sortKey string, direction string) string {
	orderBy, needsMetadataSort := listOrderBy(sortKey, direction)
	if needsMetadataSort {
		return `SELECT id, primary_code, title, created_at, track_count, available_locations, available_location_types, source_presence, snapshot_json, party_link, listening_status, favorite FROM (` + listBaseSelectSQL(where, true) + `) AS library_rows ORDER BY ` + orderBy
	}
	return listBaseSelectSQL(where, false) + " ORDER BY " + orderBy
}

func listBaseSelectSQL(where string, includeMetadataSortColumns bool) string {
	metadataSortColumns := ""
	if includeMetadataSortColumns {
		metadataSortColumns = `,
			(SELECT json_extract(snapshot_json, '$.product.rate_average_2dp') FROM metadata_snapshot INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id WHERE metadata_snapshot.work_id = work.id AND metadata_provider.code = 'dlsite' ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC LIMIT 1) AS latest_dlsite_rating,
			(SELECT COALESCE(json_extract(snapshot_json, '$.dynamic.dl_count'), json_extract(snapshot_json, '$.product.dl_count'), json_extract(snapshot_json, '$.product.sales_count')) FROM metadata_snapshot INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id WHERE metadata_snapshot.work_id = work.id AND metadata_provider.code = 'dlsite' ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC LIMIT 1) AS latest_dlsite_sales`
	}
	return `SELECT
		work.id, work.primary_code, work.title, work.created_at,
		(SELECT COUNT(*) FROM media_item WHERE media_item.work_id = work.id AND media_item.kind = 'audio') AS track_count,
		(SELECT COUNT(*) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND media_item.kind = 'audio' AND media_file_location.availability = 'available') AS available_locations,
		(SELECT GROUP_CONCAT(DISTINCT media_file_location.location_type) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND media_file_location.availability = 'available') AS available_location_types,
		(SELECT GROUP_CONCAT(DISTINCT presence.presence_type || '|' || presence.availability || '|' || presence.file_source_id || '|' || COALESCE(source.code, '') || '|' || COALESCE(source.display_name, '') || '|' || COALESCE(presence.remote_id, '') || '|' || COALESCE(presence.source_url, '') || '|' || COALESCE(presence.remote_code, '')) FROM work_source_presence AS presence LEFT JOIN file_source AS source ON source.id = presence.file_source_id WHERE presence.work_id = work.id OR presence.work_id IN (SELECT sibling.work_id FROM work_edition AS current_edition INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id WHERE current_edition.work_id = work.id)) AS source_presence,
		(SELECT snapshot_json FROM metadata_snapshot INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id WHERE metadata_snapshot.work_id = work.id AND metadata_provider.code = 'dlsite' ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC LIMIT 1) AS snapshot_json,
		(SELECT party.display_name || '|' || external.external_id FROM work_party AS relation INNER JOIN party ON party.id = relation.party_id LEFT JOIN party_external_id AS external ON external.party_id = party.id AND external.is_primary = 1 WHERE relation.work_id = work.id AND relation.role = 'circle' ORDER BY relation.updated_at DESC LIMIT 1) AS party_link,
		COALESCE(user_work_state.listening_status, 'none') AS listening_status,
		COALESCE(user_work_state.favorite, 0) AS favorite` + metadataSortColumns + `
	FROM work
	LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?
	WHERE ` + where
}
