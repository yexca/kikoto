package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

var (
	dlsiteMakerIDPattern     = regexp.MustCompile(`(?i)^[RBV]G[0-9]{5,8}$`)
	dlsiteProductCodePattern = regexp.MustCompile(`(?i)^(RJ|BJ|VJ)[0-9]{5,8}$`)
)

type circleSummary struct {
	ID              int64              `json:"id"`
	ExternalID      string             `json:"externalId"`
	DisplayName     string             `json:"displayName"`
	Aliases         []string           `json:"aliases"`
	Rating          *int               `json:"rating"`
	Note            string             `json:"note"`
	Favorite        bool               `json:"favorite"`
	UserTags        []voiceUserTag     `json:"userTags"`
	LocalWorks      int                `json:"localWorks"`
	PlayableWorks   int                `json:"playableWorks"`
	RemoteWorks     int                `json:"remoteWorks"`
	MissingWorks    int                `json:"missingWorks"`
	CatalogWorks    int                `json:"catalogWorks"`
	LastSyncedAt    *string            `json:"lastSyncedAt"`
	SyncState       string             `json:"syncState"`
	SyncReason      string             `json:"syncReason"`
	SourceSummaries []circleSourceStat `json:"sourceSummaries"`
	LatestWork      *creatorLatestWork `json:"latestWork"`
	Cover           *creatorCover      `json:"cover"`
	lastAttemptAt   *string
	// coverWork is the user's chosen cover work before its cover is resolved.
	coverWork *creatorLatestWork
}

type circleSummaryPage struct {
	Circles        []circleSummary `json:"circles"`
	Page           int             `json:"page"`
	PageSize       int             `json:"pageSize"`
	Total          int             `json:"total"`
	CatalogWorks   int             `json:"catalogWorks"`
	AvailableWorks int             `json:"availableWorks"`
}

type circleSourceStat struct {
	Key         string `json:"key"`
	SourceID    *int64 `json:"sourceId"`
	DisplayName string `json:"displayName"`
	Status      string `json:"status"`
	Count       int    `json:"count"`
}

type circleDetail struct {
	circleSummary
	AvailableWorks int                 `json:"availableWorks"`
	Works          []circleCatalogWork `json:"works"`
	WorksMeta      circleWorksMeta     `json:"worksMeta"`
	Series         []circleSeries      `json:"series"`
	// Refresh is the newest catalog sync run for this circle, so the page can follow
	// a queued refresh across reloads and link it in Activity.
	Refresh *creatorRefreshRun `json:"refresh"`
}

type circleWorksMeta struct {
	Page      int  `json:"page"`
	PageSize  int  `json:"pageSize"`
	Loaded    int  `json:"loaded"`
	Total     int  `json:"total"`
	HasMore   bool `json:"hasMore"`
	Truncated bool `json:"truncated"`
}

type circleWorksQuery struct {
	Page         int
	PageSize     int
	Query        string
	Availability string
	Series       string
	// Sort is release, code, title, rating, or sales; empty sorts by release.
	Sort string
	// Direction is asc or desc; empty sorts descending.
	Direction string
	Legacy    bool
}

func parseCircleWorksQuery(r *http.Request) circleWorksQuery {
	legacy := r.URL.Query().Get("page") == "" && r.URL.Query().Get("pageSize") == "" &&
		r.URL.Query().Get("q") == "" && r.URL.Query().Get("availability") == "" && r.URL.Query().Get("series") == ""
	pageSize := queryInt(r, "pageSize", 24)
	if pageSize < 1 || pageSize > 100 {
		pageSize = 24
	}
	page := queryInt(r, "page", 1)
	if page < 1 {
		page = 1
	}
	availability := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("availability")))
	switch availability {
	case "", "all", "available", "unavailable", "local", "remote":
	default:
		availability = "all"
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 200 {
		query = query[:200]
	}
	series := strings.TrimSpace(r.URL.Query().Get("series"))
	if len(series) > 128 {
		series = series[:128]
	}
	sortKey, direction := normalizeCircleWorksSort(r.URL.Query().Get("sort"), r.URL.Query().Get("direction"))
	return circleWorksQuery{
		Page:         page,
		PageSize:     pageSize,
		Query:        query,
		Availability: availability,
		Series:       series,
		Sort:         sortKey,
		Direction:    direction,
		Legacy:       legacy,
	}
}

// normalizeCircleWorksSort keeps the catalog orders a circle offers and falls
// back to newest release first.
func normalizeCircleWorksSort(sortKey, direction string) (string, string) {
	sortKey = strings.ToLower(strings.TrimSpace(sortKey))
	switch sortKey {
	case "release", "code", "title", "rating", "sales":
	default:
		sortKey = "release"
	}
	if strings.EqualFold(strings.TrimSpace(direction), "asc") {
		return sortKey, "asc"
	}
	return sortKey, "desc"
}

// circleWorksOrderBy orders the logical catalog candidates. Works without a
// rating or sales count stay last in either direction, and the code breaks
// ties so paging is stable.
func circleWorksOrderBy(sortKey, direction string) string {
	sortKey, direction = normalizeCircleWorksSort(sortKey, direction)
	dir := "DESC"
	if direction == "asc" {
		dir = "ASC"
	}
	code := "candidates.logical_code " + dir
	switch sortKey {
	case "code":
		return code
	case "title":
		return "candidates.sort_title COLLATE NOCASE " + dir + ", " + code
	case "rating":
		return "candidates.rating IS NULL ASC, candidates.rating " + dir + ", " + code
	case "sales":
		return "candidates.sales IS NULL ASC, candidates.sales " + dir + ", " + code
	default:
		return "candidates.release_date " + dir + ", " + code
	}
}

type circleSeries struct {
	TitleID       string   `json:"titleId"`
	Name          string   `json:"name"`
	URL           string   `json:"url"`
	DeclaredWorks int      `json:"declaredWorks"`
	Works         int      `json:"works"`
	LocalWorks    int      `json:"localWorks"`
	RemoteWorks   int      `json:"remoteWorks"`
	MissingWorks  int      `json:"missingWorks"`
	WorkCodes     []string `json:"workCodes"`
}

type circleCatalogWork struct {
	WorkID           *int64              `json:"workId"`
	PrimaryCode      string              `json:"primaryCode"`
	RemoteCode       string              `json:"remoteCode"`
	Title            string              `json:"title"`
	ReleaseDate      *string             `json:"releaseDate"`
	UpdatedAt        string              `json:"updatedAt"`
	CoverURL         string              `json:"coverUrl"`
	DLsiteURL        string              `json:"dlsiteUrl"`
	Circle           string              `json:"circle"`
	CircleExternalID string              `json:"circleExternalId"`
	AgeRating        string              `json:"ageRating"`
	Tags             []string            `json:"tags"`
	UserTags         []workUserTag       `json:"userTags"`
	VoiceActors      []string            `json:"voiceActors"`
	VoiceCredits     []voiceCredit       `json:"voiceCredits"`
	Rating           *float64            `json:"rating"`
	RatingCount      *int64              `json:"ratingCount"`
	Sales            *int64              `json:"sales"`
	HasLyrics        bool                `json:"hasLyrics,omitempty"`
	RegularPrice     *int64              `json:"regularPrice"`
	Price            *int64              `json:"price"`
	PriceCurrency    string              `json:"priceCurrency"`
	PermanentlyFree  *bool               `json:"permanentlyFree"`
	Series           string              `json:"series"`
	SeriesTitleID    string              `json:"seriesTitleId"`
	CatalogStatus    string              `json:"catalogStatus"`
	DLsiteAvailable  bool                `json:"dlsiteAvailable"`
	ListeningMark    string              `json:"listeningMark"`
	Favorite         bool                `json:"favorite"`
	Local            bool                `json:"local"`
	Remote           bool                `json:"remote"`
	SourceTags       []circleSourceStat  `json:"sourceTags"`
	Progress         workProgressSummary `json:"progress"`
}

// circleCatalogProjection keeps catalog discovery attached to the party that
// owns the canonical edition of a known logical work. The physical catalog
// row remains under its source party so translator identity and raw provider
// provenance are preserved. Unknown or metadata-only codes fall back to the
// physical party because there is no safe ownership relationship to infer.
// The owner is party_catalog_item.owner_party_id, which triggers maintain from
// the party_catalog_owner_resolution view.
const circleCatalogProjection = `(
	SELECT
		catalog.id,
		catalog.owner_party_id AS party_id,
		catalog.party_id AS source_party_id,
		catalog.provider_id,
		catalog.primary_code,
		catalog.title,
		catalog.release_date,
		catalog.url,
		catalog.catalog_status,
		catalog.dlsite_available,
		catalog.raw_json,
		catalog.last_seen_at
	FROM party_catalog_item AS catalog
)`

// circlePartyVisibilityPredicate is built only with trusted SQL aliases from
// this file. The catalog evidence clause covers translation editions whose
// work_party relation is not materialized; unknown or incomplete editions
// deliberately remain visible.
func circlePartyVisibilityPredicate(partyRef string) string {
	return fmt.Sprintf(`(
		EXISTS (
			SELECT 1
			FROM work_party AS owned_relation
			WHERE owned_relation.party_id = %[1]s
				AND owned_relation.role = 'circle'
		)
		OR (
			NOT EXISTS (
				SELECT 1
				FROM work_party AS translation_relation
				WHERE translation_relation.party_id = %[1]s
					AND translation_relation.role IN ('translator_circle', 'official_translation_brand')
			)
			AND NOT EXISTS (
				SELECT 1
				FROM party_catalog_item AS catalog
				INNER JOIN work AS catalog_work
					ON UPPER(catalog_work.primary_code) = UPPER(catalog.primary_code)
				INNER JOIN work_edition AS edition ON edition.work_id = catalog_work.id
				INNER JOIN party_external_id AS external
					ON external.party_id = %[1]s
				INNER JOIN metadata_provider AS external_provider
					ON external_provider.id = external.provider_id
					AND external_provider.code = 'dlsite'
				WHERE catalog.party_id = %[1]s
					AND external.id_type = 'maker_id'
					AND UPPER(external.external_id) = UPPER(edition.maker_id)
					AND edition.is_canonical = 0
					AND (
						edition.translation_kind IN ('third_party', 'official')
						OR (
							edition.origin_maker_id <> ''
							AND UPPER(edition.origin_maker_id) <> UPPER(edition.maker_id)
						)
					)
			)
		)
	)`, partyRef)
}

func (s *Server) listCircles(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	pageSize := queryInt(r, "pageSize", 24)
	page, err := s.circleSummaryPage(
		r.Context(), userID,
		strings.TrimSpace(r.URL.Query().Get("q")),
		strings.TrimSpace(r.URL.Query().Get("filter")),
		queryInt(r, "page", 1), pageSize,
	)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, page)
}

func (s *Server) getCircle(w http.ResponseWriter, r *http.Request) {
	userID := optionalUserID(r.Context())
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	detail, err := s.loadCircleDetailWithWorksQuery(r.Context(), userID, externalID, parseCircleWorksQuery(r))
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			writeCircleLookupError(w, err)
		} else if errors.Is(err, errCircleNotVisible) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "circle not found"})
		} else {
			writeError(w, err)
		}
		return
	}
	writeJSON(w, http.StatusOK, detail)
}

type circleUserStatePatch struct {
	Rating   *int    `json:"rating"`
	Note     *string `json:"note"`
	Favorite *bool   `json:"favorite"`
	// CoverPrimaryCode names the work whose cover the circle shows; an empty
	// code restores the latest work's cover.
	CoverPrimaryCode *string `json:"coverPrimaryCode"`
}

type circleUserStateValues struct {
	rating   any
	note     string
	favorite int
	cover    string
}

func (s *Server) updateCircleUserState(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "favorites:write")
	if !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	payload, err := decodeCircleUserStatePatch(r)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		return
	}
	partyID, err := s.findCircle(r.Context(), externalID)
	if err != nil {
		writeCircleLookupError(w, err)
		return
	}
	if payload.CoverPrimaryCode != nil && *payload.CoverPrimaryCode != "" {
		usable, err := s.circleCoverWorkUsable(r.Context(), partyID, *payload.CoverPrimaryCode)
		if err != nil {
			writeError(w, err)
			return
		}
		if !usable {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": errCreatorCoverUnavailable.Error()})
			return
		}
	}
	current, err := s.loadCircleUserState(r.Context(), user.ID, partyID)
	if err != nil {
		writeError(w, err)
		return
	}
	values := mergeCircleUserState(current, payload)
	if err := s.saveCircleUserState(r.Context(), user.ID, partyID, values); err != nil {
		writeError(w, err)
		return
	}
	summary, err := s.loadCircleSummary(r.Context(), user.ID, partyID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, summary)
}

func decodeCircleUserStatePatch(r *http.Request) (circleUserStatePatch, error) {
	var payload circleUserStatePatch
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		return circleUserStatePatch{}, errors.New("invalid json")
	}
	if payload.Rating != nil && (*payload.Rating < 0 || *payload.Rating > 5) {
		return circleUserStatePatch{}, errors.New("rating must be between 0 and 5")
	}
	if payload.CoverPrimaryCode != nil {
		code, err := normalizeCreatorCoverCode(*payload.CoverPrimaryCode)
		if err != nil {
			return circleUserStatePatch{}, err
		}
		payload.CoverPrimaryCode = &code
	}
	return payload, nil
}

func (s *Server) loadCircleUserState(ctx context.Context, userID, partyID int64) (circleUserStateValues, error) {
	var rating sql.NullInt64
	values := circleUserStateValues{}
	err := s.db.QueryRowContext(ctx, `
		SELECT rating, COALESCE(note, ''), COALESCE(favorite, 0), cover_primary_code
		FROM user_party_state
		WHERE user_id = ? AND party_id = ?
	`, userID, partyID).Scan(&rating, &values.note, &values.favorite, &values.cover)
	if errors.Is(err, sql.ErrNoRows) {
		return values, nil
	}
	if err != nil {
		return circleUserStateValues{}, err
	}
	if rating.Valid {
		values.rating = int(rating.Int64)
	}
	return values, nil
}

func mergeCircleUserState(current circleUserStateValues, patch circleUserStatePatch) circleUserStateValues {
	if patch.Rating != nil {
		current.rating = nil
		if *patch.Rating > 0 {
			current.rating = *patch.Rating
		}
	}
	if patch.Note != nil {
		current.note = strings.TrimSpace(*patch.Note)
	}
	if patch.Favorite != nil {
		current.favorite = 0
		if *patch.Favorite {
			current.favorite = 1
		}
	}
	if patch.CoverPrimaryCode != nil {
		current.cover = *patch.CoverPrimaryCode
	}
	return current
}

func (s *Server) saveCircleUserState(ctx context.Context, userID, partyID int64, values circleUserStateValues) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO user_party_state (user_id, party_id, rating, note, favorite, cover_primary_code, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(user_id, party_id) DO UPDATE SET
			rating = excluded.rating,
			note = excluded.note,
			favorite = excluded.favorite,
			cover_primary_code = excluded.cover_primary_code,
			updated_at = CURRENT_TIMESTAMP
	`, userID, partyID, values.rating, values.note, values.favorite, values.cover)
	return err
}

func (s *Server) setCircleUserTags(w http.ResponseWriter, r *http.Request) {
	user, ok := s.requirePermission(w, r, "tags:write")
	if !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	var payload struct {
		Tags []string `json:"tags"`
	}
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	partyID, err := s.findCircle(r.Context(), externalID)
	if err != nil {
		writeCircleLookupError(w, err)
		return
	}
	tags, err := s.replaceCircleUserTags(r.Context(), user.ID, partyID, payload.Tags)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"externalId": externalID, "userTags": tags})
}

// refreshCircle queues the circle catalog sync workflow without a tag, so a detail
// refresh and a Workflows run share one pipeline.
func (s *Server) refreshCircle(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requirePermission(w, r, "metadata:sync")
	if !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	// A detail refresh targets a known circle; an unknown maker id is added by
	// the circle catalog sync workflow from the Workflows page.
	partyID, err := s.findCircle(r.Context(), externalID)
	if err != nil {
		writeCircleLookupError(w, err)
		return
	}
	visible, err := s.circlePartyVisible(r.Context(), partyID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !visible {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "circle not found"})
		return
	}
	var request creatorRefreshRequest
	if r.Body != nil {
		_ = json.NewDecoder(r.Body).Decode(&request)
	}
	request = request.normalized()
	inputs := presetWorkflowInputs{CircleID: externalID, CatalogRefresh: request.CatalogRefresh, Metadata: request.MetadataRefresh != "off"}
	if request.SourceCheck {
		sourceIDs, err := s.compatibleRemoteSourceIDs(r.Context())
		if err != nil {
			writeError(w, err)
			return
		}
		inputs.CheckSourceIDs = sourceIDs
	}
	run, err := s.queueCreatorRefresh(r.Context(), actor, "circle_catalog_sync", inputs, func(ctx context.Context) (creatorRefreshRun, bool, error) {
		return s.latestCircleCatalogSyncRun(ctx, externalID, true)
	})
	if !s.writeCreatorRefreshError(w, err) {
		return
	}
	writeJSON(w, http.StatusAccepted, run)
}

func (s *Server) deleteCircleCatalogWork(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.requirePermission(w, r, "metadata:sync"); !ok {
		return
	}
	externalID := normalizeMakerID(r.PathValue("externalId"))
	if !dlsiteMakerIDPattern.MatchString(externalID) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid circle external id"})
		return
	}
	code := strings.ToUpper(strings.TrimSpace(r.PathValue("code")))
	if !dlsiteProductCodePattern.MatchString(code) {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid work code"})
		return
	}
	providerID, err := s.metadataProviderID(r.Context(), "dlsite", "DLsite")
	if err != nil {
		writeError(w, err)
		return
	}
	partyID, err := s.findCircle(r.Context(), externalID)
	if err != nil {
		writeCircleLookupError(w, err)
		return
	}
	visible, err := s.circlePartyVisible(r.Context(), partyID)
	if err != nil {
		writeError(w, err)
		return
	}
	if !visible {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "circle not found"})
		return
	}
	result, err := s.db.ExecContext(r.Context(), `
		DELETE FROM party_catalog_item
		WHERE provider_id = ?
			AND id IN (
				SELECT projected.id
				FROM `+circleCatalogProjection+` AS projected
				LEFT JOIN work AS catalog_work ON UPPER(catalog_work.primary_code) = UPPER(projected.primary_code)
				LEFT JOIN work_edition AS catalog_edition ON catalog_edition.work_id = catalog_work.id
				LEFT JOIN logical_work AS catalog_logical ON catalog_logical.id = catalog_edition.logical_work_id
				WHERE projected.party_id = ?
					AND UPPER(COALESCE(catalog_logical.canonical_code, projected.primary_code)) = ?
			)
	`, providerID, partyID, code)
	if err != nil {
		writeError(w, err)
		return
	}
	deleted, _ := result.RowsAffected()
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "deleted": deleted})
}

// writeCircleLookupError keeps unknown circles distinct from database errors
// so the UI can offer an explicit metadata fetch.
func writeCircleLookupError(w http.ResponseWriter, err error) {
	if errors.Is(err, sql.ErrNoRows) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "circle not found", "code": "circle_not_in_database"})
		return
	}
	writeError(w, err)
}

func (s *Server) replaceCircleUserTags(ctx context.Context, userID int64, partyID int64, rawTags []string) ([]voiceUserTag, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.ExecContext(ctx, "DELETE FROM user_party_tag_assignment WHERE user_id = ? AND party_id = ?", userID, partyID); err != nil {
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
			INSERT INTO user_party_tag (user_id, name)
			VALUES (?, ?)
			ON CONFLICT(user_id, name) DO UPDATE SET updated_at = CURRENT_TIMESTAMP
		`, userID, name); err != nil {
			return nil, err
		}
		tagID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM user_party_tag WHERE user_id = ? AND name = ?", userID, name)
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO user_party_tag_assignment (user_id, party_id, user_party_tag_id)
			VALUES (?, ?, ?)
			ON CONFLICT(user_id, party_id, user_party_tag_id) DO NOTHING
		`, userID, partyID, tagID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return s.loadCircleUserTags(ctx, userID, partyID)
}

func (s *Server) loadCircleUserTags(ctx context.Context, userID int64, partyID int64) ([]voiceUserTag, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT tag.id, tag.name, tag.color
		FROM user_party_tag_assignment AS assignment
		INNER JOIN user_party_tag AS tag ON tag.id = assignment.user_party_tag_id
		WHERE assignment.user_id = ?
			AND assignment.party_id = ?
		ORDER BY tag.name ASC
	`, userID, partyID)
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

func (s *Server) loadCircleUserTagsBatch(ctx context.Context, userID int64, partyIDs []int64) (map[int64][]voiceUserTag, error) {
	result := map[int64][]voiceUserTag{}
	if len(partyIDs) == 0 {
		return result, nil
	}
	err := s.queryInt64Batches(ctx, `
		SELECT assignment.party_id, tag.id, tag.name, tag.color
		FROM user_party_tag_assignment AS assignment
		INNER JOIN user_party_tag AS tag ON tag.id = assignment.user_party_tag_id
		WHERE assignment.user_id = ? AND assignment.party_id IN (%s)
		ORDER BY assignment.party_id, tag.name, tag.id
	`, partyIDs, []any{userID}, func(rows *sql.Rows) error {
		var partyID int64
		var tag voiceUserTag
		if err := rows.Scan(&partyID, &tag.ID, &tag.Name, &tag.Color); err != nil {
			return err
		}
		result[partyID] = append(result[partyID], tag)
		return nil
	})
	return result, err
}

func (s *Server) metadataProviderID(ctx context.Context, code string, displayName string) (int64, error) {
	if _, err := s.db.ExecContext(ctx, `
		INSERT INTO metadata_provider (code, display_name)
		VALUES (?, ?)
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name
	`, code, displayName); err != nil {
		return 0, err
	}
	var id int64
	if err := s.db.QueryRowContext(ctx, "SELECT id FROM metadata_provider WHERE code = ?", code).Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func lastInsertID(tx *sql.Tx) (int64, error) {
	var id int64
	if err := tx.QueryRow("SELECT last_insert_rowid()").Scan(&id); err != nil {
		return 0, err
	}
	return id, nil
}

func normalizeMakerID(value string) string {
	return strings.ToUpper(strings.TrimSpace(value))
}

func nullableIntPointer(value sql.NullInt64) *int {
	if !value.Valid {
		return nil
	}
	next := int(value.Int64)
	return &next
}

func nullableStringValue(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func (s *Server) dlsiteMakerURL(externalID string) string {
	return s.dlsiteEndpoints.MakerURL(externalID)
}
