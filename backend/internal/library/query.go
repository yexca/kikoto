package library

import (
	"context"
	"database/sql"
	"fmt"
	"strings"

	"github.com/yexca/kikoto/backend/internal/contentpolicy"
)

type Store struct {
	db *sql.DB
}

func NewStore(db *sql.DB) *Store {
	return &Store{db: db}
}

type ListOptions struct {
	UserID                  int64
	Page                    int
	PageSize                int
	Scope                   string
	Status                  string
	Query                   string
	Sort                    string
	Direction               string
	RandomSeed              int64
	IncludeRecommendation   bool
	RecommendationSessionID string
	DemoOnly                bool
}

type RawPage struct {
	Works    []RawWork
	Page     int
	PageSize int
	Total    int
}

type MatchingListOptions struct {
	UserID     int64
	Page       int
	PageSize   int
	Sort       string
	Direction  string
	RandomSeed int64
	ListID     int64
	DemoOnly   bool
}

type RawWork struct {
	ID                     int64
	PrimaryCode            string
	Title                  string
	AgeRating              string
	Rating                 *float64
	Sales                  *int64
	RegularPrice           *int64
	CurrentPrice           *int64
	PriceCurrency          string
	PermanentlyFree        *bool
	CreatedAt              string
	TrackCount             int64
	AvailableLocations     int64
	AvailableLocationTypes string
	SourcePresence         string
	Snapshot               string
	PartyLink              string
	ListeningStatus        string
	Favorite               bool
	RecommendScore         int
}

func (s *Store) ListAll(ctx context.Context, userID int64, demoOnly bool) ([]RawWork, error) {
	where := "1 = 1"
	if demoOnly {
		where += " AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	rows, err := s.db.QueryContext(ctx, listBaseSelectSQL(where, false)+" ORDER BY work.created_at DESC", userID)
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
	where, args := listWhere(options.Scope, options.Status, options.Query, options.UserID, options.DemoOnly)
	countArgs := append([]any{options.UserID}, args...)
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM work LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ? WHERE "+where, countArgs...).Scan(&total); err != nil {
		return RawPage{}, err
	}
	includeRecommendation := options.IncludeRecommendation || strings.EqualFold(strings.TrimSpace(options.Sort), "recommend")
	config := DefaultRecommendationConfig()
	recommendationGenerationID := int64(0)
	if includeRecommendation {
		switch {
		case options.UserID <= 0:
			config = s.LoadRecommendationConfig(ctx)
			recommendationGenerationID = anonymousRecommendationGenerationID
		case strings.TrimSpace(options.RecommendationSessionID) != "":
			snapshot, err := s.PrepareRecommendationSession(ctx, options.UserID, options.RecommendationSessionID)
			if err != nil {
				return RawPage{}, err
			}
			config = snapshot.Config
			recommendationGenerationID = snapshot.GenerationID
		default:
			// Older clients without a recommendation session retain the dynamic
			// path until they are upgraded.
			config = s.LoadRecommendationConfig(ctx)
		}
	}
	queryArgs := []any{}
	if includeRecommendation && recommendationGenerationID == 0 {
		queryArgs = append(queryArgs, recommendationUserArgs(options.UserID)...)
	}
	queryArgs = append(queryArgs, options.UserID)
	queryArgs = append(queryArgs, args...)
	queryArgs = append(queryArgs, options.PageSize, (options.Page-1)*options.PageSize)
	rows, err := s.db.QueryContext(ctx, listSelectSQLWithRecommendationGeneration(
		where, options.Sort, options.Direction, options.RandomSeed, config, includeRecommendation, recommendationGenerationID,
	)+" LIMIT ? OFFSET ?", queryArgs...)
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
func (s *Store) ListMatching(ctx context.Context, userID int64, where string, args []any, page int, pageSize int, demoOnly bool) ([]RawWork, error) {
	return s.ListMatchingSorted(ctx, where, args, MatchingListOptions{
		UserID: userID, Page: page, PageSize: pageSize, Sort: "recent", Direction: "desc", DemoOnly: demoOnly,
	})
}

func (s *Store) ListMatchingSorted(ctx context.Context, where string, args []any, options MatchingListOptions) ([]RawWork, error) {
	if options.Page < 1 {
		options.Page = 1
	}
	if options.PageSize < 1 || options.PageSize > 100 {
		options.PageSize = 24
	}
	if options.DemoOnly {
		where = "(" + where + ") AND " + contentpolicy.DemoEligibleWorkSQL("work")
	}
	selectSQL, prefixArgs := matchingListSelectSQL(where, options)
	queryArgs := append(prefixArgs, options.UserID)
	queryArgs = append(queryArgs, args...)
	queryArgs = append(queryArgs, options.PageSize, (options.Page-1)*options.PageSize)
	rows, err := s.db.QueryContext(ctx, selectSQL+" LIMIT ? OFFSET ?", queryArgs...)
	if err != nil {
		return nil, err
	}
	return ScanRows(rows)
}

func matchingListSelectSQL(where string, options MatchingListOptions) (string, []any) {
	sortKey := strings.ToLower(strings.TrimSpace(options.Sort))
	_, direction := normalizeSort("recent", options.Direction)
	outerProjection := `SELECT id, primary_code, title, age_rating, rating_average, sales_count, regular_price, current_price, price_currency, is_permanently_free, created_at, track_count, available_locations, available_location_types, source_presence, snapshot_json, party_link, listening_status, favorite, recommend_score FROM (`
	switch sortKey {
	case "activity":
		expression := `MAX(
			COALESCE(user_work_state.updated_at, ''),
			COALESCE((
				SELECT MAX(shelf_list_item.created_at)
				FROM favorite_list_item AS shelf_list_item
				INNER JOIN favorite_list AS shelf_list ON shelf_list.id = shelf_list_item.list_id
				WHERE shelf_list.user_id = ?
					AND shelf_list.kind = 'user'
					AND shelf_list_item.work_id = work.id
			), ''),
			work.created_at
		)`
		query := outerProjection + listBaseSelectSQLWithExtra(where, false, ", "+expression+" AS matching_sort_value") + `) AS library_rows ORDER BY matching_sort_value ` + direction + `, id ` + direction
		return query, []any{options.UserID}
	case "added":
		expression := `MAX(
			CASE WHEN COALESCE(user_work_state.listening_status, 'none') <> 'none'
				THEN COALESCE(user_work_state.updated_at, '')
				ELSE ''
			END,
			COALESCE((
				SELECT MAX(shelf_list_item.created_at)
				FROM favorite_list_item AS shelf_list_item
				INNER JOIN favorite_list AS shelf_list ON shelf_list.id = shelf_list_item.list_id
				WHERE shelf_list.user_id = ?
					AND shelf_list.kind = 'user'
					AND shelf_list_item.work_id = work.id
			), '')
		)`
		prefixArgs := []any{options.UserID}
		if options.ListID > 0 {
			expression = `CASE WHEN EXISTS (
				SELECT 1
				FROM favorite_list AS selected_list
				WHERE selected_list.id = ?
					AND selected_list.user_id = ?
					AND selected_list.kind = 'marked'
			) THEN user_work_state.updated_at ELSE (
				SELECT MAX(shelf_list_item.created_at)
				FROM favorite_list_item AS shelf_list_item
				INNER JOIN favorite_list AS shelf_list ON shelf_list.id = shelf_list_item.list_id
				WHERE shelf_list.user_id = ?
					AND shelf_list.id = ?
					AND shelf_list.kind = 'user'
					AND shelf_list_item.work_id = work.id
			) END`
			prefixArgs = []any{options.ListID, options.UserID, options.UserID, options.ListID}
		}
		query := outerProjection + listBaseSelectSQLWithExtra(where, false, ", "+expression+" AS matching_sort_value") + `) AS library_rows ORDER BY matching_sort_value IS NULL ASC, matching_sort_value ` + direction + `, id ` + direction
		return query, prefixArgs
	case "release", "code", "title", "rating", "sales", "random", "recent":
		return listSelectSQL(where, sortKey, direction, options.RandomSeed, DefaultRecommendationConfig(), false), nil
	default:
		options.Sort = "activity"
		return matchingListSelectSQL(where, options)
	}
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
		var rating sql.NullFloat64
		var sales, regularPrice, currentPrice sql.NullInt64
		var permanentlyFree sql.NullBool
		var favorite int
		if err := rows.Scan(
			&item.ID,
			&item.PrimaryCode,
			&item.Title,
			&item.AgeRating,
			&rating,
			&sales,
			&regularPrice,
			&currentPrice,
			&item.PriceCurrency,
			&permanentlyFree,
			&item.CreatedAt,
			&item.TrackCount,
			&item.AvailableLocations,
			&availableLocationTypes,
			&sourcePresence,
			&snapshot,
			&partyLink,
			&item.ListeningStatus,
			&favorite,
			&item.RecommendScore,
		); err != nil {
			return nil, err
		}
		item.AvailableLocationTypes = availableLocationTypes.String
		if rating.Valid {
			item.Rating = &rating.Float64
		}
		if sales.Valid {
			item.Sales = &sales.Int64
		}
		if regularPrice.Valid {
			item.RegularPrice = &regularPrice.Int64
		}
		if currentPrice.Valid {
			item.CurrentPrice = &currentPrice.Int64
		}
		if permanentlyFree.Valid {
			item.PermanentlyFree = &permanentlyFree.Bool
		}
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

func listOrderBy(sortKey string, direction string, randomSeed int64, config RecommendationConfig) string {
	sortKey, direction = normalizeSort(sortKey, direction)
	switch sortKey {
	case "recommend":
		return recommendationExplorationOrderBy("id", direction, randomSeed, config.JitterAmplitude, config.ExplorationAmplitude)
	case "random":
		return seededOrderBy("work.id", randomSeed)
	case "release":
		return "work.release_date IS NULL ASC, work.release_date " + direction + ", work.created_at " + direction + ", work.id " + direction
	case "code":
		return "work.primary_code " + direction + ", work.id " + direction
	case "title":
		return "work.title COLLATE NOCASE " + direction + ", work.id " + direction
	case "rating":
		return "work.rating_average IS NULL ASC, work.rating_average " + direction + ", work.created_at " + direction + ", work.id " + direction
	case "sales":
		return "work.sales_count IS NULL ASC, work.sales_count " + direction + ", work.created_at " + direction + ", work.id " + direction
	default:
		return "work.created_at " + direction + ", work.id " + direction
	}
}

func seededOrderBy(idExpression string, randomSeed int64) string {
	hash := seededHashExpression(idExpression, randomSeed)
	return fmt.Sprintf("%s ASC, %s ASC", hash, idExpression)
}

func seededHashExpression(idExpression string, randomSeed int64) string {
	multiplier, offset := recommendationSeededHashParameters(randomSeed)
	return fmt.Sprintf("(((%s %% %d) * %d + %d) %% %d)", idExpression, recommendationHashModulus, multiplier, offset, recommendationHashModulus)
}

func recommendationOrderBy(idExpression string, direction string, randomSeed int64, amplitude int) string {
	hash := seededHashExpression(idExpression, randomSeed)
	if amplitude <= 0 {
		return "recommend_score " + direction + ", " + seededOrderBy(idExpression, randomSeed)
	}
	return fmt.Sprintf("(recommend_score + (((%s / 2147483647.0) * 2.0 - 1.0) * %d)) %s, %s ASC, %s ASC", hash, amplitude, direction, hash, idExpression)
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
	case "recent", "release", "code", "title", "rating", "sales", "random", "recommend":
	default:
		sortKey = "recent"
	}
	if direction != "ASC" && direction != "DESC" {
		direction = "DESC"
	}
	return sortKey, direction
}

func listWhere(scope string, status string, queryText string, userID int64, demoOnly bool) (string, []any) {
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
	if searchWhere, searchArgs := SearchWhereForUser(queryText, userID); searchWhere != "" {
		clauses = append(clauses, searchWhere)
		args = append(args, searchArgs...)
	}
	clauses = append(clauses, canonicalVisibleWhereClause())
	if demoOnly {
		clauses = append(clauses, contentpolicy.DemoEligibleWorkSQL("work"))
	}
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
		WHERE (scope_presence.work_id = work.id OR scope_presence.work_id IN (
			SELECT sibling.work_id FROM work_edition AS current_edition
			INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id
			WHERE current_edition.work_id = work.id
		))
		AND scope_presence.availability = 'available'
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
	return SearchWhereForUser(queryText, 0)
}

func SearchWhereForUser(queryText string, userID int64) (string, []any) {
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
			exactCode := strings.ToUpper(needle)
			clauses = append(clauses, familyCodeClause())
			args = append(args, exactCode, exactCode, exactCode, exactCode)
		case "circle":
			clauses = append(clauses, `(`+familyCircleLikeClause()+` OR `+manualOverrideFieldLikeClause("circle")+`)`)
			args = append(args, like, like, like)
		case "voice_actor":
			clauses = append(clauses, `(`+familyVoiceActorLikeClause()+` OR `+manualOverrideFieldLikeClause("voice_actors")+`)`)
			args = append(args, like, like)
		case "tag":
			clauses = append(clauses, normalizedTagLikeClause(false))
			args = append(args, like)
		case "exclude_tag":
			clauses = append(clauses, normalizedTagLikeClause(true))
			args = append(args, like)
		case "user_tag":
			clauses = append(clauses, userTagLikeClause(false))
			args = append(args, userID, like)
		case "exclude_user_tag":
			clauses = append(clauses, userTagLikeClause(true))
			args = append(args, userID, like)
		case "rating_min":
			clauses = append(clauses, familyNumericClause("rating_average", ">=", NumericClauseValue(needle)))
		case "sales_min":
			clauses = append(clauses, familyNumericClause("sales_count", ">=", NumericClauseValue(needle)))
		case "duration_min":
			clauses = append(clauses, familyDurationClause(">=", NumericClauseValue(needle)))
		case "duration_max":
			clauses = append(clauses, familyDurationClause("<=", NumericClauseValue(needle)))
		case "age":
			clauses = append(clauses, familyWorkColumnLikeClause("age_rating"))
			args = append(args, like, like)
		case "language":
			clauses = append(clauses, familyEditionLanguageLikeClause())
			args = append(args, like, like, like, like)
		case "shelf":
			clauses = append(clauses, userShelfClause(strings.EqualFold(needle, "false")))
			args = append(args, userID)
		default:
			personalTag := ""
			if userID > 0 {
				personalTag = " OR " + userTagLikeClause(false)
			}
			clauses = append(clauses, `(`+familyWorkTextLikeClause()+` OR `+familyCircleLikeClause()+` OR `+familyVoiceActorLikeClause()+` OR `+normalizedTagLikeClause(false)+` OR `+manualOverrideAnyLikeClause("title", "circle", "series", "voice_actors")+personalTag+`)`)
			args = append(args, like, like, like, like, like, like, like, like, like, like)
			if userID > 0 {
				args = append(args, userID, like)
			}
		}
	}
	if len(clauses) == 0 {
		return "", nil
	}
	return "(" + strings.Join(clauses, " AND ") + ")", args
}

func familyCodeClause() string {
	return `(UPPER(work.primary_code) = ? OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
		WHERE search_current_edition.work_id = work.id AND UPPER(search_sibling_edition.primary_code) = ?
	) OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_code_alias AS search_alias ON search_alias.logical_work_id = search_current_edition.logical_work_id
		WHERE search_current_edition.work_id = work.id AND UPPER(search_alias.primary_code) = ?
	) OR EXISTS (
		SELECT 1
		FROM work_external_id AS search_external_id
		WHERE search_external_id.work_id = work.id
			AND search_external_id.id_type IN ('workno', 'product_id')
			AND UPPER(search_external_id.external_id) = ?
	))`
}

func familyWorkTextLikeClause() string {
	return `(LOWER(work.primary_code) LIKE ? OR LOWER(work.title) LIKE ? OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
		INNER JOIN work AS search_sibling_work ON search_sibling_work.id = search_sibling_edition.work_id
		WHERE search_current_edition.work_id = work.id
			AND (LOWER(search_sibling_work.primary_code) LIKE ? OR LOWER(search_sibling_work.title) LIKE ?)
	) OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_code_alias AS search_alias ON search_alias.logical_work_id = search_current_edition.logical_work_id
		WHERE search_current_edition.work_id = work.id
			AND LOWER(search_alias.primary_code) LIKE ?
	))`
}

func familyCircleLikeClause() string {
	return `EXISTS (
		SELECT 1
		FROM work_party AS search_relation
		INNER JOIN party AS search_party ON search_party.id = search_relation.party_id
		LEFT JOIN party_external_id AS search_external ON search_external.party_id = search_party.id
		WHERE search_relation.role = 'circle'
			AND (
				search_relation.work_id = work.id
				OR search_relation.work_id IN (
					SELECT search_sibling_edition.work_id
					FROM work_edition AS search_current_edition
					INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
					WHERE search_current_edition.work_id = work.id
				)
			)
			AND (LOWER(search_party.display_name) LIKE ? OR LOWER(COALESCE(search_external.external_id, '')) LIKE ?)
	)`
}

func familyVoiceActorLikeClause() string {
	return `EXISTS (
		SELECT 1
		FROM work_credit AS search_credit
		INNER JOIN person AS search_person ON search_person.id = search_credit.person_id
		WHERE search_credit.role = 'voice_actor'
			AND (
				search_credit.work_id = work.id
				OR search_credit.work_id IN (
					SELECT search_sibling_edition.work_id
					FROM work_edition AS search_current_edition
					INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
					WHERE search_current_edition.work_id = work.id
				)
			)
			AND LOWER(search_person.display_name) LIKE ?
	)`
}

func familyWorkColumnLikeClause(column string) string {
	if column != "age_rating" {
		column = "title"
	}
	return `(LOWER(work.` + column + `) LIKE ? OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
		INNER JOIN work AS search_sibling_work ON search_sibling_work.id = search_sibling_edition.work_id
		WHERE search_current_edition.work_id = work.id AND LOWER(search_sibling_work.` + column + `) LIKE ?
	))`
}

func familyEditionLanguageLikeClause() string {
	return `(EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		WHERE search_current_edition.work_id = work.id
			AND (LOWER(search_current_edition.metadata_language) LIKE ? OR LOWER(search_current_edition.edition_label) LIKE ?)
	) OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
		WHERE search_current_edition.work_id = work.id
			AND (LOWER(search_sibling_edition.metadata_language) LIKE ? OR LOWER(search_sibling_edition.edition_label) LIKE ?)
	))`
}

func familyDurationClause(operator string, value float64) string {
	if operator != ">=" && operator != "<=" {
		operator = ">="
	}
	return fmt.Sprintf(`(work.duration_seconds IS NOT NULL AND work.duration_seconds %s %g OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
		INNER JOIN work AS search_sibling_work ON search_sibling_work.id = search_sibling_edition.work_id
		WHERE search_current_edition.work_id = work.id
			AND search_sibling_work.duration_seconds IS NOT NULL
			AND search_sibling_work.duration_seconds %s %g
	))`, operator, value, operator, value)
}

func manualOverrideFieldLikeClause(field string) string {
	return `EXISTS (SELECT 1 FROM work_manual_override AS search_override WHERE search_override.work_id = work.id AND search_override.field_name = '` + field + `' AND LOWER(search_override.value_json) LIKE ?)`
}

func normalizedTagLikeClause(negated bool) string {
	prefix := "EXISTS"
	if negated {
		prefix = "NOT EXISTS"
	}
	return prefix + ` (
		SELECT 1
		FROM work_tag AS search_work_tag
		INNER JOIN tag AS search_tag ON search_tag.id = search_work_tag.tag_id
		WHERE search_tag.namespace = 'dlsite'
			AND (
				search_work_tag.work_id = work.id
				OR search_work_tag.work_id IN (
					SELECT search_sibling_edition.work_id
					FROM work_edition AS search_current_edition
					INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
					WHERE search_current_edition.work_id = work.id
				)
			)
			AND LOWER(search_tag.display_name) LIKE ?
	)`
}

func userTagLikeClause(negated bool) string {
	prefix := "EXISTS"
	if negated {
		prefix = "NOT EXISTS"
	}
	return prefix + ` (SELECT 1 FROM user_work_tag AS search_user_work_tag INNER JOIN user_tag AS search_user_tag ON search_user_tag.id = search_user_work_tag.user_tag_id WHERE search_user_work_tag.work_id = work.id AND search_user_work_tag.user_id = ? AND LOWER(search_user_tag.name) LIKE ?)`
}

func userShelfClause(negated bool) string {
	prefix := ""
	if negated {
		prefix = "NOT "
	}
	return prefix + `(COALESCE(user_work_state.listening_status, 'none') <> 'none'
		OR EXISTS (
			SELECT 1
			FROM favorite_list_item AS search_shelf_item
			INNER JOIN favorite_list AS search_shelf_list ON search_shelf_list.id = search_shelf_item.list_id
			WHERE search_shelf_list.user_id = ?
				AND search_shelf_list.kind = 'user'
				AND search_shelf_item.work_id = work.id
		))`
}

func manualOverrideAnyLikeClause(fields ...string) string {
	quoted := make([]string, 0, len(fields))
	for _, field := range fields {
		quoted = append(quoted, "'"+field+"'")
	}
	return `EXISTS (SELECT 1 FROM work_manual_override AS search_override WHERE search_override.work_id = work.id AND search_override.field_name IN (` + strings.Join(quoted, ",") + `) AND LOWER(search_override.value_json) LIKE ?)`
}

func familyNumericClause(column string, operator string, value float64) string {
	if operator != ">=" && operator != "<=" {
		operator = ">="
	}
	if column != "rating_average" && column != "sales_count" {
		column = "rating_average"
	}
	return fmt.Sprintf(`(work.%s IS NOT NULL AND work.%s %s %g OR EXISTS (
		SELECT 1
		FROM work_edition AS search_current_edition
		INNER JOIN work_edition AS search_sibling_edition ON search_sibling_edition.logical_work_id = search_current_edition.logical_work_id
		INNER JOIN work AS search_sibling_work ON search_sibling_work.id = search_sibling_edition.work_id
		WHERE search_current_edition.work_id = work.id
			AND search_sibling_work.%s IS NOT NULL
			AND search_sibling_work.%s %s %g
	))`, column, column, operator, value, column, column, operator, value)
}

const anonymousRecommendationGenerationID int64 = -1

func listSelectSQL(where string, sortKey string, direction string, randomSeed int64, config RecommendationConfig, includeRecommendation bool) string {
	return listSelectSQLWithRecommendationGeneration(where, sortKey, direction, randomSeed, config, includeRecommendation, 0)
}

func listSelectSQLWithRecommendationGeneration(
	where string,
	sortKey string,
	direction string,
	randomSeed int64,
	config RecommendationConfig,
	includeRecommendation bool,
	recommendationGenerationID int64,
) string {
	normalizedSort, _ := normalizeSort(sortKey, direction)
	orderBy := listOrderBy(sortKey, direction, randomSeed, config)
	if normalizedSort == "recommend" {
		recommendationLane := "COALESCE(user_work_state.listening_status, 'none')"
		if recommendationGenerationID > 0 {
			recommendationLane = "COALESCE(recommendation_snapshot.listening_status, 'none')"
		}
		baseSelect := listBaseSelectSQLWithConfigAndExtraAndGeneration(
			where,
			true,
			config,
			", "+recommendationLane+" AS recommendation_lane",
			recommendationGenerationID,
		)
		return recommendationListSelectSQL(baseSelect, direction, randomSeed, config)
	}
	return listBaseSelectSQLWithConfigAndExtraAndGeneration(
		where, includeRecommendation, config, "", recommendationGenerationID,
	) + " ORDER BY " + orderBy
}

func listBaseSelectSQL(where string, includeRecommendation bool) string {
	return listBaseSelectSQLWithConfigAndExtra(where, includeRecommendation, DefaultRecommendationConfig(), "")
}

func listBaseSelectSQLWithExtra(where string, includeRecommendation bool, extraSelect string) string {
	return listBaseSelectSQLWithConfigAndExtra(where, includeRecommendation, DefaultRecommendationConfig(), extraSelect)
}

func listBaseSelectSQLWithConfig(where string, includeRecommendation bool, config RecommendationConfig) string {
	return listBaseSelectSQLWithConfigAndExtra(where, includeRecommendation, config, "")
}

func listBaseSelectSQLWithConfigAndExtra(where string, includeRecommendation bool, config RecommendationConfig, extraSelect string) string {
	return listBaseSelectSQLWithConfigAndExtraAndGeneration(where, includeRecommendation, config, extraSelect, 0)
}

func listBaseSelectSQLWithConfigAndExtraAndGeneration(
	where string,
	includeRecommendation bool,
	config RecommendationConfig,
	extraSelect string,
	recommendationGenerationID int64,
) string {
	recommendationSortColumn := ", 0 AS recommend_score"
	recommendationSnapshotJoin := ""
	if includeRecommendation {
		switch {
		case recommendationGenerationID > 0:
			recommendationSortColumn = fmt.Sprintf(", COALESCE(recommendation_snapshot.score, %d) AS recommend_score", config.AffinityBase)
			recommendationSnapshotJoin = fmt.Sprintf(`
	LEFT JOIN recommendation_snapshot ON recommendation_snapshot.work_id = work.id AND recommendation_snapshot.generation_id = %d`, recommendationGenerationID)
		case recommendationGenerationID < 0:
			recommendationSortColumn = fmt.Sprintf(", %d AS recommend_score", config.AffinityBase)
		default:
			recommendationSortColumn = `, ` + recommendationScoreExpression(config) + ` AS recommend_score`
		}
	}
	return `SELECT
		work.id, work.primary_code, work.title, work.age_rating,
		work.rating_average, work.sales_count, work.regular_price, work.current_price, work.price_currency, work.is_permanently_free,
		work.created_at,
		(SELECT COUNT(*) FROM media_item WHERE media_item.work_id = work.id AND (media_item.kind = 'audio' OR (media_item.kind = 'video' AND COALESCE(media_item.has_audio, 1) = 1))) AS track_count,
		(SELECT COUNT(*) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND (media_item.kind = 'audio' OR (media_item.kind = 'video' AND COALESCE(media_item.has_audio, 1) = 1)) AND media_file_location.availability = 'available') AS available_locations,
		(SELECT GROUP_CONCAT(DISTINCT media_file_location.location_type) FROM media_file_location INNER JOIN media_item ON media_item.id = media_file_location.media_item_id WHERE media_item.work_id = work.id AND media_file_location.availability = 'available') AS available_location_types,
		(SELECT GROUP_CONCAT(DISTINCT presence.presence_type || '|' || presence.availability || '|' || presence.file_source_id || '|' || COALESCE(source.code, '') || '|' || COALESCE(source.display_name, '') || '|' || COALESCE(presence.remote_id, '') || '|' || COALESCE(presence.source_url, '') || '|' || COALESCE(presence.remote_code, '') || '|' || COALESCE(presence.work_id, 0)) FROM work_source_presence AS presence LEFT JOIN file_source AS source ON source.id = presence.file_source_id WHERE presence.work_id = work.id OR presence.work_id IN (SELECT sibling.work_id FROM work_edition AS current_edition INNER JOIN work_edition AS sibling ON sibling.logical_work_id = current_edition.logical_work_id WHERE current_edition.work_id = work.id)) AS source_presence,
		(SELECT snapshot_json FROM metadata_snapshot INNER JOIN metadata_provider ON metadata_provider.id = metadata_snapshot.provider_id WHERE metadata_snapshot.work_id = work.id AND metadata_provider.code = 'dlsite' ORDER BY metadata_snapshot.fetched_at DESC, metadata_snapshot.id DESC LIMIT 1) AS snapshot_json,
		(SELECT display_name || '|' || external_id FROM work_primary_circle WHERE work_id = work.id) AS party_link,
		COALESCE(user_work_state.listening_status, 'none') AS listening_status,
		COALESCE(user_work_state.favorite, 0) AS favorite` + recommendationSortColumn + extraSelect + `
	FROM work
	LEFT JOIN user_work_state ON user_work_state.work_id = work.id AND user_work_state.user_id = ?` + recommendationSnapshotJoin + `
	WHERE ` + where
}
