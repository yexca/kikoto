package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/yexca/kikoto/backend/internal/contentpolicy"
	"strings"
	"time"
)

func (s *Server) countVoiceCatalogWorks(ctx context.Context, personID int64) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = ?", personID).Scan(&count)
	return count, err
}

type voiceCatalogRefreshOutcome struct {
	status            string
	remoteStatus      string
	remoteScope       bool
	metadataScope     bool
	catalogComplete   bool
	sourceStatuses    []voiceCatalogSourceStatus
	sourceJSON        string
	pagesFetched      int
	catalogWorks      int
	metadata          voiceCatalogMetadataResult
	metadataProcessed int
	remoteError       string
	metadataError     string
	lastError         string
	summary           map[string]any
}

func prepareVoiceCatalogRefreshOutcome(
	payload voiceCatalogRefreshPayload,
	previous voiceCatalogRefreshState,
	status string,
	remoteStatus string,
	catalogComplete bool,
	sourceStatuses []voiceCatalogSourceStatus,
	pagesFetched int,
	catalogWorks int,
	metadata voiceCatalogMetadataResult,
) (voiceCatalogRefreshOutcome, error) {
	remoteScope := voiceCatalogRefreshIncludesRemote(payload.Scope)
	if !remoteScope {
		sourceStatuses = append([]voiceCatalogSourceStatus{}, previous.Sources...)
		catalogComplete = previous.Complete
		pagesFetched = previous.PagesFetched
		catalogWorks = previous.CatalogWorks
	}
	sourceJSON, err := json.Marshal(sourceStatuses)
	if err != nil {
		return voiceCatalogRefreshOutcome{}, err
	}
	remoteError := ""
	switch remoteStatus {
	case "failed":
		remoteError = "Remote source catalog refresh failed."
	case "partial":
		remoteError = "Some remote sources could not be refreshed."
	}
	metadataError := ""
	if metadata.Failed > 0 {
		metadataError = "Some known-work metadata could not be refreshed."
	}
	lastError := remoteError
	if lastError == "" {
		lastError = metadataError
	}
	metadataProcessed := metadata.Synced + metadata.Skipped + metadata.Failed
	return voiceCatalogRefreshOutcome{
		status:            status,
		remoteStatus:      remoteStatus,
		remoteScope:       remoteScope,
		metadataScope:     voiceCatalogRefreshIncludesMetadata(payload.Scope),
		catalogComplete:   catalogComplete,
		sourceStatuses:    sourceStatuses,
		sourceJSON:        string(sourceJSON),
		pagesFetched:      pagesFetched,
		catalogWorks:      catalogWorks,
		metadata:          metadata,
		metadataProcessed: metadataProcessed,
		remoteError:       remoteError,
		metadataError:     metadataError,
		lastError:         lastError,
		summary: map[string]any{
			"person_id": payload.PersonID, "generation": payload.Generation, "queries": payload.Queries,
			"status": status, "scope": payload.Scope, "mode": payload.Mode, "source_ids": payload.SourceIDs,
			"sources": sourceStatuses, "pages_fetched": pagesFetched, "catalog_works": catalogWorks,
			"metadata_targeted": metadata.Targeted, "metadata_synced": metadata.Synced,
			"metadata_skipped": metadata.Skipped, "metadata_failed": metadata.Failed,
			"metadata_processed": metadataProcessed,
		},
	}, nil
}

func persistVoiceCatalogRefreshOutcome(
	ctx context.Context,
	tx *sql.Tx,
	runID int64,
	payload voiceCatalogRefreshPayload,
	outcome voiceCatalogRefreshOutcome,
) error {
	complete := 0
	if outcome.catalogComplete {
		complete = 1
	}
	remoteSucceeded := 0
	if outcome.remoteScope && outcome.catalogComplete {
		remoteSucceeded = 1
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE voice_catalog_refresh_state
		SET source_status_json = ?,
			last_success_at = CASE WHEN ? = 1 THEN ? ELSE last_success_at END,
			last_attempt_at = CURRENT_TIMESTAMP,
			last_status = ?,
			last_run_id = ?,
			last_error = ?,
			complete = ?,
			pages_fetched = ?,
			catalog_works = ?,
			metadata_queued = ?,
			updated_at = CURRENT_TIMESTAMP
		WHERE person_id = ? AND generation = ?
	`, outcome.sourceJSON, remoteSucceeded, time.Now().UTC().Format(time.RFC3339), outcome.status, runID, outcome.lastError,
		complete, outcome.pagesFetched, outcome.catalogWorks, outcome.metadataProcessed, payload.PersonID, payload.Generation)
	return err
}

// loadVoiceCatalogMatches returns the persisted source catalog, including
// negative observations from a completed refresh. A source failure never
// removes its previous rows; the source status explains whether those rows are
// current or stale to the caller.
func (s *Server) loadVoiceCatalogMatches(ctx context.Context, personID int64) ([]voiceRemoteSourceSet, error) {
	state, err := s.currentVoiceCatalogRefreshState(ctx, personID)
	if err != nil {
		return nil, err
	}
	sources, err := s.loadRemoteSourcesForAvailability(ctx)
	if err != nil {
		return nil, err
	}
	sets, setIndexes := initialVoiceCatalogSourceSets(sources, state)
	sets, err = s.loadVoiceCatalogMatchRows(ctx, personID, sets, setIndexes)
	if err != nil {
		return nil, err
	}
	applyVoiceCatalogSourceState(sets, state)
	return sets, nil
}

func initialVoiceCatalogSourceSets(sources []remoteSourceForUse, state voiceCatalogRefreshState) ([]voiceRemoteSourceSet, map[int64]int) {
	sets := make([]voiceRemoteSourceSet, 0, len(sources))
	setIndexes := map[int64]int{}
	for _, source := range sources {
		status := voiceCatalogSourceSetStatus(source, state)
		setIndexes[source.ID] = len(sets)
		sets = append(sets, voiceRemoteSourceSet{
			SourceID: source.ID, SourceCode: source.Code, DisplayName: source.DisplayName,
			Status: status, Works: []voiceRemoteWork{},
		})
	}
	return sets, setIndexes
}

func (s *Server) loadVoiceCatalogMatchRows(ctx context.Context, personID int64, sets []voiceRemoteSourceSet, setIndexes map[int64]int) ([]voiceRemoteSourceSet, error) {
	demoWhere := ""
	if s.cfg.IsDemo() {
		demoWhere = `
			AND EXISTS (
				SELECT 1
				FROM work AS demo_work
				WHERE (demo_work.id = item.work_id OR UPPER(demo_work.primary_code) = UPPER(item.primary_code))
					AND ` + contentpolicy.DemoEligibleWorkSQL("demo_work") + `
			)
		`
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT
			item.primary_code, item.work_id, item.title, item.release_date, item.cover_url,
			item.source_url, item.circle, item.age_rating, item.rating_average,
			item.rating_count, item.sales_count, item.current_price, item.tags_json,
			item.voice_actors_json, file_source.id, catalog_source.remote_id, catalog_source.remote_code,
			catalog_source.source_url, catalog_source.availability, catalog_source.last_seen_at,
			file_source.code, file_source.display_name
		FROM voice_catalog_item AS item
		INNER JOIN voice_catalog_source AS catalog_source ON catalog_source.catalog_item_id = item.id
		INNER JOIN metadata_provider AS provider ON provider.id = catalog_source.provider_id
		INNER JOIN file_source ON provider.code = 'kikoeru_source_' || file_source.code
			AND file_source.source_type IN ('kikoeru_compatible', 'kikoeru_compatible_number178')
		WHERE item.person_id = ?
			`+demoWhere+`
		ORDER BY item.primary_code ASC, file_source.id ASC, catalog_source.remote_code ASC
	`, personID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	// Building a remote work may query canonical identity and availability, so
	// release the cursor's pooled connection before that enrichment.
	matchRows := []voiceCatalogMatchRow{}
	for rows.Next() {
		row, err := scanVoiceCatalogMatchRow(rows)
		if err != nil {
			return nil, err
		}
		matchRows = append(matchRows, row)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if err := rows.Close(); err != nil {
		return nil, err
	}
	workRefs := map[string]canonicalWorkRef{}
	availabilityBySource := map[string]sourceAvailabilityState{}
	for _, row := range matchRows {
		if !row.SourceID.Valid || row.SourceID.Int64 <= 0 {
			continue
		}
		index, ok := setIndexes[row.SourceID.Int64]
		if !ok {
			index = len(sets)
			setIndexes[row.SourceID.Int64] = index
			sets = append(sets, voiceRemoteSourceSet{
				SourceID: row.SourceID.Int64, SourceCode: row.SourceCode, DisplayName: row.SourceName,
				Status: "ok", Works: []voiceRemoteWork{},
			})
		}
		code := strings.ToUpper(strings.TrimSpace(row.PrimaryCode))
		if code == "" {
			continue
		}
		remoteWork, err := s.buildVoiceCatalogRemoteWork(ctx, row, code, sets[index].Status, workRefs, availabilityBySource)
		if err != nil {
			return nil, err
		}
		sets[index].Works = append(sets[index].Works, remoteWork)
	}
	return sets, nil
}

func applyVoiceCatalogSourceState(sets []voiceRemoteSourceSet, state voiceCatalogRefreshState) {
	for index := range sets {
		if sourceStatus, ok := voiceCatalogSourceStatusForID(state.Sources, sets[index].SourceID); ok {
			sets[index].Total = sourceStatus.Total
			sets[index].ElapsedMS = sourceStatus.ElapsedMS
			sets[index].Error = sourceStatus.Error
			if sets[index].Status == "pending" {
				sets[index].Status = sourceStatusToSetStatus(sourceStatus.Status)
			}
		}
		if sets[index].Total == 0 {
			sets[index].Total = distinctRemoteCatalogCodes(sets[index].Works)
		}
	}
}

type voiceCatalogMatchRow struct {
	PrimaryCode, Title, CoverURL, ItemSourceURL, Circle, AgeRating string
	TagsJSON, VoiceActorsJSON                                      string
	RemoteID, RemoteCode, SourceURL, Availability, LastSeen        string
	SourceCode, SourceName                                         string
	ItemWorkID, SourceID                                           sql.NullInt64
	ReleaseDate                                                    sql.NullString
	Rating, RatingCount, Sales, Price                              sql.NullFloat64
}

func scanVoiceCatalogMatchRow(rows *sql.Rows) (voiceCatalogMatchRow, error) {
	var row voiceCatalogMatchRow
	err := rows.Scan(
		&row.PrimaryCode, &row.ItemWorkID, &row.Title, &row.ReleaseDate, &row.CoverURL, &row.ItemSourceURL, &row.Circle,
		&row.AgeRating, &row.Rating, &row.RatingCount, &row.Sales, &row.Price, &row.TagsJSON, &row.VoiceActorsJSON,
		&row.SourceID, &row.RemoteID, &row.RemoteCode, &row.SourceURL, &row.Availability, &row.LastSeen, &row.SourceCode, &row.SourceName,
	)
	return row, err
}

func (s *Server) buildVoiceCatalogRemoteWork(ctx context.Context, row voiceCatalogMatchRow, code, sourceStatus string, workRefs map[string]canonicalWorkRef, availabilityBySource map[string]sourceAvailabilityState) (voiceRemoteWork, error) {
	workID := catalogWorkID(row.ItemWorkID)
	if workID == 0 {
		known, cached := workRefs[code]
		if !cached {
			var err error
			known, err = s.canonicalWorkForCode(ctx, code)
			if err != nil {
				return voiceRemoteWork{}, err
			}
			workRefs[code] = known
		}
		if known.WorkID > 0 {
			workID = known.WorkID
		}
	}
	tags := decodeVoiceCatalogStrings(row.TagsJSON)
	if workID > 0 {
		projected, ok, err := s.loadProjectedDLsiteTags(ctx, workID)
		if err != nil {
			return voiceRemoteWork{}, err
		}
		tags = presentProjectedTags(tags, projected, ok)
	}
	voiceActors := decodeVoiceCatalogStrings(row.VoiceActorsJSON)
	flags := sourceAvailabilityState{}
	if workID > 0 && row.SourceID.Int64 > 0 {
		availabilityKey := fmt.Sprintf("%d:%s", row.SourceID.Int64, code)
		var cached bool
		flags, cached = availabilityBySource[availabilityKey]
		if !cached {
			var err error
			flags, err = s.sourceAvailabilityFlags(ctx, row.SourceID.Int64, code)
			if err != nil {
				return voiceRemoteWork{}, err
			}
			availabilityBySource[availabilityKey] = flags
		}
	}
	status := voiceSourceAvailabilityStatus(row.Availability)
	status = voiceCatalogObservationStatus(status, sourceStatus)
	if status == "unknown" && strings.TrimSpace(row.LastSeen) != "" {
		status = "available"
	}
	return voiceRemoteWork{
		SourceID: row.SourceID.Int64, SourceCode: row.SourceCode, SourceName: row.SourceName,
		RemoteID: row.RemoteID, PrimaryCode: code, RemoteCode: strings.TrimSpace(row.RemoteCode),
		Title: firstNonEmpty(row.Title, code), ReleaseDate: voiceCatalogStringValue(row.ReleaseDate),
		UpdatedAt: voiceCatalogStringValue(row.ReleaseDate), CoverURL: s.visibleRemoteImageURL(ctx, row.SourceID.Int64, row.CoverURL),
		Circle: row.Circle, AgeRating: row.AgeRating, Rating: nullableFloat64FromNull(row.Rating),
		RatingCount: nullableInt64FromFloatNull(row.RatingCount), Sales: nullableInt64FromFloatNull(row.Sales),
		Price: nullableInt64FromFloatNull(row.Price), Tags: tags, VoiceActors: voiceActors,
		ImportStatus: remoteImportStatus(nullableWorkID(workID)), RemotePlayable: status == "available",
		WorkID: nullableWorkID(workID), HasLocal: flags.HasLocal, HasCache: flags.HasCache,
		HasRemote: flags.HasRemote || status == "available", Availability: status,
	}, nil
}

func decodeVoiceCatalogStrings(raw string) []string {
	var values []string
	_ = json.Unmarshal([]byte(raw), &values)
	if values == nil {
		return []string{}
	}
	return values
}

func voiceCatalogSourceSetStatus(source remoteSourceForUse, state voiceCatalogRefreshState) string {
	if !isKikoeruSourceType(source.SourceType) {
		return "unsupported"
	}
	if !source.Enabled {
		return "disabled"
	}
	if strings.TrimSpace(source.Endpoint.APIURL) == "" {
		return "misconfigured"
	}
	if state.Status == "queued" || state.Status == "running" {
		return "refreshing"
	}
	if status, ok := voiceCatalogSourceStatusForID(state.Sources, source.ID); ok {
		return sourceStatusToSetStatus(status.Status)
	}
	return "pending"
}

func sourceStatusToSetStatus(status string) string {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "ok", "succeeded", "catalog_synced":
		return "ok"
	case "disabled":
		return "disabled"
	case "unsupported":
		return "unsupported"
	case "pending", "queued", "running":
		return "refreshing"
	default:
		return status
	}
}

func voiceCatalogObservationStatus(availability string, sourceStatus string) string {
	switch strings.ToLower(strings.TrimSpace(sourceStatus)) {
	case "disabled":
		return "disabled"
	case "unsupported", "misconfigured":
		return "unavailable"
	default:
		return availability
	}
}

func voiceCatalogSourceStatusForID(statuses []voiceCatalogSourceStatus, sourceID int64) (voiceCatalogSourceStatus, bool) {
	for _, status := range statuses {
		if status.SourceID == sourceID {
			return status, true
		}
	}
	return voiceCatalogSourceStatus{}, false
}

func distinctRemoteCatalogCodes(works []voiceRemoteWork) int {
	seen := map[string]bool{}
	for _, work := range works {
		code := strings.ToUpper(strings.TrimSpace(work.PrimaryCode))
		if code != "" {
			seen[code] = true
		}
	}
	return len(seen)
}

func catalogWorkID(value sql.NullInt64) int64 {
	if value.Valid {
		return value.Int64
	}
	return 0
}

func nullableWorkID(value int64) *int64 {
	if value <= 0 {
		return nil
	}
	return &value
}

func nullableFloat64FromNull(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func nullableInt64FromFloatNull(value sql.NullFloat64) *int64 {
	if !value.Valid {
		return nil
	}
	converted := int64(value.Float64)
	return &converted
}
