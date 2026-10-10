package httpapi

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

func (s *Server) persistVoiceCatalogSource(ctx context.Context, personID int64, generation int64, result voiceCatalogSourceResult, fullSnapshot bool) ([]int64, error) {
	if !result.Complete {
		return []int64{}, nil
	}
	providerID, err := s.metadataProviderID(ctx, "kikoeru_source_"+result.Source.Code, result.Source.DisplayName)
	if err != nil {
		return nil, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	knownWorkIDs := map[int64]bool{}
	for _, candidate := range result.Candidates {
		if err := persistVoiceCatalogCandidate(ctx, tx, personID, generation, providerID, result.Source.ID, candidate); err != nil {
			return nil, err
		}
		if candidate.WorkID > 0 {
			knownWorkIDs[candidate.WorkID] = true
		}
	}
	if fullSnapshot {
		if err := markStaleVoiceCatalogSourceSnapshot(ctx, tx, personID, generation, providerID, result.Source.ID); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return sortedVoiceCatalogWorkIDs(knownWorkIDs), nil
}

func persistVoiceCatalogCandidate(ctx context.Context, tx *sql.Tx, personID, generation, providerID, sourceID int64, candidate voiceCatalogCandidate) error {
	catalogItemID, err := upsertVoiceCatalogItem(ctx, tx, personID, generation, candidate)
	if err != nil {
		return err
	}
	if err := upsertVoiceCatalogSourceRow(ctx, tx, catalogItemID, providerID, generation, candidate); err != nil {
		return err
	}
	if candidate.WorkID <= 0 {
		return nil
	}
	return upsertWorkSourcePresence(ctx, tx, workSourcePresence{
		WorkID: candidate.WorkID, FileSourceID: sourceID, PresenceType: sourcePresenceTypeRemoteSource,
		RemoteID: candidate.Projection.RemoteID, RemoteCode: candidate.RemoteCode,
		SourceURL: candidate.Projection.SourceURL, Availability: "available",
		RawJSON: mustJSON(map[string]any{"source": "voice_catalog", "primary_code": candidate.CanonicalCode, "remote_code": candidate.RemoteCode}),
	})
}

func upsertVoiceCatalogItem(ctx context.Context, tx *sql.Tx, personID, generation int64, candidate voiceCatalogCandidate) (int64, error) {
	tagsJSON, err := json.Marshal(candidate.Projection.Tags)
	if err != nil {
		return 0, err
	}
	voiceActorsJSON, err := json.Marshal(candidate.Projection.VoiceActors)
	if err != nil {
		return 0, err
	}
	var workID any
	if candidate.WorkID > 0 {
		workID = candidate.WorkID
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_item (
			person_id, primary_code, work_id, title, release_date, cover_url, source_url,
			circle, age_rating, rating_average, rating_count, sales_count, current_price,
			tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
			last_seen_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'catalog', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(person_id, primary_code) DO UPDATE SET
			work_id = COALESCE(excluded.work_id, voice_catalog_item.work_id),
			title = CASE WHEN excluded.title <> '' THEN excluded.title ELSE voice_catalog_item.title END,
			release_date = COALESCE(excluded.release_date, voice_catalog_item.release_date),
			cover_url = CASE WHEN excluded.cover_url <> '' THEN excluded.cover_url ELSE voice_catalog_item.cover_url END,
			source_url = CASE WHEN excluded.source_url <> '' THEN excluded.source_url ELSE voice_catalog_item.source_url END,
			circle = CASE WHEN excluded.circle <> '' THEN excluded.circle ELSE voice_catalog_item.circle END,
			age_rating = CASE WHEN excluded.age_rating <> '' THEN excluded.age_rating ELSE voice_catalog_item.age_rating END,
			rating_average = COALESCE(excluded.rating_average, voice_catalog_item.rating_average),
			rating_count = COALESCE(excluded.rating_count, voice_catalog_item.rating_count),
			sales_count = COALESCE(excluded.sales_count, voice_catalog_item.sales_count),
			current_price = COALESCE(excluded.current_price, voice_catalog_item.current_price),
			tags_json = CASE WHEN excluded.tags_json <> '[]' THEN excluded.tags_json ELSE voice_catalog_item.tags_json END,
			voice_actors_json = CASE WHEN excluded.voice_actors_json <> '[]' THEN excluded.voice_actors_json ELSE voice_catalog_item.voice_actors_json END,
			raw_json = excluded.raw_json,
			catalog_status = 'catalog',
			snapshot_generation = excluded.snapshot_generation,
			last_seen_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
	`, personID, candidate.CanonicalCode, workID, firstNonEmpty(candidate.Projection.Title, candidate.CanonicalCode),
		nullableCatalogText(candidate.Projection.ReleaseDate), candidate.Projection.CoverURL, candidate.Projection.SourceURL,
		candidate.Projection.Circle, candidate.Projection.AgeRating, candidate.Projection.Rating,
		candidate.Projection.RatingCount, candidate.Projection.Sales, candidate.Projection.Price,
		string(tagsJSON), string(voiceActorsJSON), candidate.RawJSON, generation); err != nil {
		return 0, err
	}
	var catalogItemID int64
	err = tx.QueryRowContext(ctx, `
		SELECT id FROM voice_catalog_item WHERE person_id = ? AND primary_code = ?
	`, personID, candidate.CanonicalCode).Scan(&catalogItemID)
	return catalogItemID, err
}

func upsertVoiceCatalogSourceRow(ctx context.Context, tx *sql.Tx, catalogItemID, providerID, generation int64, candidate voiceCatalogCandidate) error {
	_, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_source (
			catalog_item_id, provider_id, remote_id, remote_code, source_url,
			availability, raw_json, snapshot_generation, last_seen_at, last_checked_at, updated_at
		)
		VALUES (?, ?, ?, ?, ?, 'available', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
		ON CONFLICT(catalog_item_id, provider_id, remote_code) DO UPDATE SET
			remote_id = excluded.remote_id,
			source_url = excluded.source_url,
			availability = 'available',
			raw_json = excluded.raw_json,
			snapshot_generation = excluded.snapshot_generation,
			last_seen_at = CURRENT_TIMESTAMP,
			last_checked_at = CURRENT_TIMESTAMP,
			updated_at = CURRENT_TIMESTAMP
	`, catalogItemID, providerID, candidate.Projection.RemoteID, candidate.RemoteCode,
		candidate.Projection.SourceURL, candidate.RawJSON, generation)
	return err
}

func markStaleVoiceCatalogSourceSnapshot(ctx context.Context, tx *sql.Tx, personID, generation, providerID, sourceID int64) error {
	if _, err := tx.ExecContext(ctx, `
		UPDATE voice_catalog_source
		SET availability = 'not_found', last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE provider_id = ?
			AND snapshot_generation <> ?
			AND availability = 'available'
			AND catalog_item_id IN (SELECT id FROM voice_catalog_item WHERE person_id = ?)
	`, providerID, generation, personID); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE work_source_presence
		SET availability = 'missing', last_checked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
		WHERE file_source_id = ?
			AND presence_type = ?
			AND availability = 'available'
			AND json_extract(raw_json, '$.source') = 'voice_catalog'
			AND EXISTS (
				SELECT 1
				FROM voice_catalog_source AS catalog_source
				INNER JOIN voice_catalog_item AS catalog_item ON catalog_item.id = catalog_source.catalog_item_id
				WHERE catalog_item.person_id = ?
					AND catalog_item.work_id = work_source_presence.work_id
					AND catalog_source.provider_id = ?
					AND UPPER(catalog_source.remote_code) = UPPER(work_source_presence.remote_code)
					AND catalog_source.availability = 'not_found'
			)
	`, sourceID, sourcePresenceTypeRemoteSource, personID, providerID)
	return err
}

func sortedVoiceCatalogWorkIDs(known map[int64]bool) []int64 {
	workIDs := make([]int64, 0, len(known))
	for workID := range known {
		workIDs = append(workIDs, workID)
	}
	sort.Slice(workIDs, func(left int, right int) bool { return workIDs[left] < workIDs[right] })
	return workIDs
}

func loadVoiceCatalogPersonSnapshot(ctx context.Context, tx *sql.Tx, personID int64) (voiceCatalogPersonSnapshot, error) {
	snapshot := voiceCatalogPersonSnapshot{Items: []voiceCatalogItemSnapshot{}}
	rows, err := tx.QueryContext(ctx, `
		SELECT id, primary_code, work_id, title, release_date, cover_url, source_url,
			circle, age_rating, rating_average, rating_count, sales_count, current_price,
			tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
			last_seen_at, created_at, updated_at
		FROM voice_catalog_item
		WHERE person_id = ?
		ORDER BY primary_code, id
	`, personID)
	if err != nil {
		return snapshot, err
	}
	type itemWithID struct {
		id   int64
		item voiceCatalogItemSnapshot
	}
	items := []itemWithID{}
	for rows.Next() {
		var row itemWithID
		var workID, ratingCount, salesCount, currentPrice sql.NullInt64
		var releaseDate sql.NullString
		var ratingAverage sql.NullFloat64
		if err := rows.Scan(
			&row.id, &row.item.PrimaryCode, &workID, &row.item.Title, &releaseDate,
			&row.item.CoverURL, &row.item.SourceURL, &row.item.Circle, &row.item.AgeRating,
			&ratingAverage, &ratingCount, &salesCount, &currentPrice, &row.item.TagsJSON,
			&row.item.VoiceActorsJSON, &row.item.RawJSON, &row.item.CatalogStatus,
			&row.item.SnapshotGeneration, &row.item.LastSeenAt, &row.item.CreatedAt, &row.item.UpdatedAt,
		); err != nil {
			_ = rows.Close()
			return snapshot, err
		}
		row.item.WorkID = voiceCatalogInt64Pointer(workID)
		row.item.ReleaseDate = voiceCatalogStringPointer(releaseDate)
		row.item.RatingAverage = voiceCatalogFloat64Pointer(ratingAverage)
		row.item.RatingCount = voiceCatalogInt64Pointer(ratingCount)
		row.item.SalesCount = voiceCatalogInt64Pointer(salesCount)
		row.item.CurrentPrice = voiceCatalogInt64Pointer(currentPrice)
		row.item.Sources = []voiceCatalogSourceSnapshot{}
		items = append(items, row)
	}
	if err := rows.Err(); err != nil {
		_ = rows.Close()
		return snapshot, err
	}
	if err := rows.Close(); err != nil {
		return snapshot, err
	}
	for _, row := range items {
		sourceRows, err := tx.QueryContext(ctx, `
			SELECT provider_id, remote_id, remote_code, source_url, availability,
				raw_json, snapshot_generation, last_seen_at, last_checked_at, created_at, updated_at
			FROM voice_catalog_source
			WHERE catalog_item_id = ?
			ORDER BY provider_id, remote_code, id
		`, row.id)
		if err != nil {
			return snapshot, err
		}
		for sourceRows.Next() {
			var source voiceCatalogSourceSnapshot
			if err := sourceRows.Scan(
				&source.ProviderID, &source.RemoteID, &source.RemoteCode, &source.SourceURL,
				&source.Availability, &source.RawJSON, &source.SnapshotGeneration, &source.LastSeenAt,
				&source.LastCheckedAt, &source.CreatedAt, &source.UpdatedAt,
			); err != nil {
				_ = sourceRows.Close()
				return snapshot, err
			}
			row.item.Sources = append(row.item.Sources, source)
		}
		if err := sourceRows.Err(); err != nil {
			_ = sourceRows.Close()
			return snapshot, err
		}
		if err := sourceRows.Close(); err != nil {
			return snapshot, err
		}
		snapshot.Items = append(snapshot.Items, row.item)
	}

	var refresh voiceCatalogRefreshStateSnapshot
	var lastSuccess, lastAttempt sql.NullString
	var lastRunID sql.NullInt64
	var complete int
	err = tx.QueryRowContext(ctx, `
		SELECT generation, query_json, source_status_json, last_success_at, last_attempt_at,
			last_status, last_run_id, last_error, complete, pages_fetched, catalog_works,
			metadata_queued, updated_at
		FROM voice_catalog_refresh_state
		WHERE person_id = ?
	`, personID).Scan(
		&refresh.Generation, &refresh.QueryJSON, &refresh.SourceStatusJSON, &lastSuccess,
		&lastAttempt, &refresh.LastStatus, &lastRunID, &refresh.LastError, &complete,
		&refresh.PagesFetched, &refresh.CatalogWorks, &refresh.MetadataQueued, &refresh.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return snapshot, nil
	}
	if err != nil {
		return snapshot, err
	}
	refresh.LastSuccessAt = voiceCatalogStringPointer(lastSuccess)
	refresh.LastAttemptAt = voiceCatalogStringPointer(lastAttempt)
	refresh.LastRunID = voiceCatalogInt64Pointer(lastRunID)
	refresh.Complete = complete != 0
	snapshot.Refresh = &refresh
	return snapshot, nil
}

func mergeVoiceCatalogPeople(ctx context.Context, tx *sql.Tx, targetID int64, sourceID int64) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_item (
			person_id, primary_code, work_id, title, release_date, cover_url, source_url,
			circle, age_rating, rating_average, rating_count, sales_count, current_price,
			tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
			last_seen_at, created_at, updated_at
		)
		SELECT ?, primary_code, work_id, title, release_date, cover_url, source_url,
			circle, age_rating, rating_average, rating_count, sales_count, current_price,
			tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
			last_seen_at, created_at, updated_at
		FROM voice_catalog_item
		WHERE person_id = ?
		ON CONFLICT(person_id, primary_code) DO UPDATE SET
			work_id = COALESCE(voice_catalog_item.work_id, excluded.work_id),
			title = COALESCE(NULLIF(voice_catalog_item.title, ''), excluded.title),
			release_date = COALESCE(voice_catalog_item.release_date, excluded.release_date),
			cover_url = COALESCE(NULLIF(voice_catalog_item.cover_url, ''), excluded.cover_url),
			source_url = COALESCE(NULLIF(voice_catalog_item.source_url, ''), excluded.source_url),
			circle = COALESCE(NULLIF(voice_catalog_item.circle, ''), excluded.circle),
			age_rating = COALESCE(NULLIF(voice_catalog_item.age_rating, ''), excluded.age_rating),
			rating_average = COALESCE(voice_catalog_item.rating_average, excluded.rating_average),
			rating_count = COALESCE(voice_catalog_item.rating_count, excluded.rating_count),
			sales_count = COALESCE(voice_catalog_item.sales_count, excluded.sales_count),
			current_price = COALESCE(voice_catalog_item.current_price, excluded.current_price),
			tags_json = CASE WHEN voice_catalog_item.tags_json = '[]' THEN excluded.tags_json ELSE voice_catalog_item.tags_json END,
			voice_actors_json = CASE WHEN voice_catalog_item.voice_actors_json = '[]' THEN excluded.voice_actors_json ELSE voice_catalog_item.voice_actors_json END,
			raw_json = CASE WHEN voice_catalog_item.raw_json = '{}' THEN excluded.raw_json ELSE voice_catalog_item.raw_json END,
			snapshot_generation = MAX(voice_catalog_item.snapshot_generation, excluded.snapshot_generation),
			last_seen_at = MAX(voice_catalog_item.last_seen_at, excluded.last_seen_at),
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_source (
			catalog_item_id, provider_id, remote_id, remote_code, source_url, availability,
			raw_json, snapshot_generation, last_seen_at, last_checked_at, created_at, updated_at
		)
		SELECT target_item.id, source.provider_id, source.remote_id, source.remote_code,
			source.source_url, source.availability, source.raw_json, source.snapshot_generation,
			source.last_seen_at, source.last_checked_at, source.created_at, source.updated_at
		FROM voice_catalog_source AS source
		INNER JOIN voice_catalog_item AS source_item ON source_item.id = source.catalog_item_id
		INNER JOIN voice_catalog_item AS target_item
			ON target_item.person_id = ? AND target_item.primary_code = source_item.primary_code
		WHERE source_item.person_id = ?
		ON CONFLICT(catalog_item_id, provider_id, remote_code) DO UPDATE SET
			remote_id = COALESCE(NULLIF(voice_catalog_source.remote_id, ''), excluded.remote_id),
			source_url = COALESCE(NULLIF(voice_catalog_source.source_url, ''), excluded.source_url),
			availability = CASE
				WHEN voice_catalog_source.availability = 'available' OR excluded.availability = 'available' THEN 'available'
				WHEN excluded.last_checked_at > voice_catalog_source.last_checked_at THEN excluded.availability
				ELSE voice_catalog_source.availability
			END,
			raw_json = CASE WHEN voice_catalog_source.raw_json = '{}' THEN excluded.raw_json ELSE voice_catalog_source.raw_json END,
			snapshot_generation = MAX(voice_catalog_source.snapshot_generation, excluded.snapshot_generation),
			last_seen_at = MAX(voice_catalog_source.last_seen_at, excluded.last_seen_at),
			last_checked_at = MAX(voice_catalog_source.last_checked_at, excluded.last_checked_at),
			updated_at = CURRENT_TIMESTAMP
	`, targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_refresh_state WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_item WHERE person_id = ?", sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE voice_catalog_refresh_state
		SET query_json = '[]', source_status_json = '[]', last_success_at = NULL,
			last_attempt_at = NULL, last_status = 'stale', last_run_id = NULL,
			last_error = '', complete = 0, pages_fetched = 0,
			catalog_works = (SELECT COUNT(*) FROM voice_catalog_item WHERE person_id = ?),
			metadata_queued = 0, updated_at = CURRENT_TIMESTAMP
		WHERE person_id = ?
	`, targetID, targetID); err != nil {
		return err
	}
	return nil
}

func restoreVoiceCatalogMergeSnapshot(
	ctx context.Context,
	tx *sql.Tx,
	targetID int64,
	sourceID int64,
	targetSnapshot voiceCatalogPersonSnapshot,
	sourceSnapshot voiceCatalogPersonSnapshot,
) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_refresh_state WHERE person_id IN (?, ?)", targetID, sourceID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM voice_catalog_item WHERE person_id IN (?, ?)", targetID, sourceID); err != nil {
		return err
	}
	if err := restoreVoiceCatalogPersonSnapshot(ctx, tx, targetID, targetSnapshot); err != nil {
		return err
	}
	return restoreVoiceCatalogPersonSnapshot(ctx, tx, sourceID, sourceSnapshot)
}

func restoreVoiceCatalogPersonSnapshot(ctx context.Context, tx *sql.Tx, personID int64, snapshot voiceCatalogPersonSnapshot) error {
	for _, item := range snapshot.Items {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO voice_catalog_item (
				person_id, primary_code, work_id, title, release_date, cover_url, source_url,
				circle, age_rating, rating_average, rating_count, sales_count, current_price,
				tags_json, voice_actors_json, raw_json, catalog_status, snapshot_generation,
				last_seen_at, created_at, updated_at
			)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, personID, item.PrimaryCode, item.WorkID, item.Title, item.ReleaseDate, item.CoverURL,
			item.SourceURL, item.Circle, item.AgeRating, item.RatingAverage, item.RatingCount,
			item.SalesCount, item.CurrentPrice, item.TagsJSON, item.VoiceActorsJSON, item.RawJSON,
			item.CatalogStatus, item.SnapshotGeneration, item.LastSeenAt, item.CreatedAt, item.UpdatedAt)
		if err != nil {
			return err
		}
		catalogItemID, err := result.LastInsertId()
		if err != nil {
			return err
		}
		for _, source := range item.Sources {
			if _, err := tx.ExecContext(ctx, `
				INSERT INTO voice_catalog_source (
					catalog_item_id, provider_id, remote_id, remote_code, source_url,
					availability, raw_json, snapshot_generation, last_seen_at, last_checked_at,
					created_at, updated_at
				)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
			`, catalogItemID, source.ProviderID, source.RemoteID, source.RemoteCode,
				source.SourceURL, source.Availability, source.RawJSON, source.SnapshotGeneration,
				source.LastSeenAt, source.LastCheckedAt, source.CreatedAt, source.UpdatedAt); err != nil {
				return err
			}
		}
	}
	if snapshot.Refresh == nil {
		return nil
	}
	refresh := snapshot.Refresh
	complete := 0
	if refresh.Complete {
		complete = 1
	}
	_, err := tx.ExecContext(ctx, `
		INSERT INTO voice_catalog_refresh_state (
			person_id, generation, query_json, source_status_json, last_success_at,
			last_attempt_at, last_status, last_run_id, last_error, complete, pages_fetched,
			catalog_works, metadata_queued, updated_at
		)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, personID, refresh.Generation, refresh.QueryJSON, refresh.SourceStatusJSON,
		refresh.LastSuccessAt, refresh.LastAttemptAt, refresh.LastStatus, refresh.LastRunID,
		refresh.LastError, complete, refresh.PagesFetched, refresh.CatalogWorks,
		refresh.MetadataQueued, refresh.UpdatedAt)
	return err
}

func voiceCatalogStringPointer(value sql.NullString) *string {
	if !value.Valid {
		return nil
	}
	return &value.String
}

func voiceCatalogInt64Pointer(value sql.NullInt64) *int64 {
	if !value.Valid {
		return nil
	}
	return &value.Int64
}

func voiceCatalogFloat64Pointer(value sql.NullFloat64) *float64 {
	if !value.Valid {
		return nil
	}
	return &value.Float64
}

func nullableCatalogText(value string) any {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}
	return value
}
