package httpapi

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/yexca/kikoto/backend/internal/kikoeru"
	"github.com/yexca/kikoto/backend/internal/sqlutil"
)

type remoteWorkFallbackPolicy struct {
	AttachCircleFallback     bool
	UpdateNormalizedMetadata bool
}

func loadRemoteWorkFallbackPolicy(ctx context.Context, tx *sql.Tx, code string) (remoteWorkFallbackPolicy, error) {
	var workID int64
	err := tx.QueryRowContext(ctx, `
		SELECT id
		FROM work
		WHERE UPPER(primary_code) = UPPER(?)
	`, code).Scan(&workID)
	if errors.Is(err, sql.ErrNoRows) {
		return remoteWorkFallbackPolicy{
			AttachCircleFallback:     true,
			UpdateNormalizedMetadata: true,
		}, nil
	}
	if err != nil {
		return remoteWorkFallbackPolicy{}, err
	}
	var hasHigherPriorityMetadata, hasAuthoritativeParty, hasManualCircleOverride int
	if err := tx.QueryRowContext(ctx, `
		SELECT
			EXISTS (
				SELECT 1
				FROM metadata_snapshot AS snapshot
				INNER JOIN metadata_provider AS provider ON provider.id = snapshot.provider_id
				WHERE snapshot.work_id = ?
					AND provider.code NOT GLOB 'kikoeru_source_*'
				UNION ALL
				SELECT 1
				FROM work_edition AS edition
				INNER JOIN metadata_provider AS provider ON provider.id = edition.provider_id
				WHERE edition.work_id = ? AND provider.code = 'dlsite'
			),
			EXISTS (
				SELECT 1
				FROM work_party
				WHERE work_id = ?
					AND role IN ('circle', 'translator_circle', 'official_translation_brand')
					AND source NOT IN ('remote_source', 'circle_refresh', 'remote_source_catalog')
				UNION ALL
				SELECT 1
				FROM work_edition
				WHERE work_id = ? AND maker_id <> ''
			),
			EXISTS (
				SELECT 1
				FROM work_manual_override
				WHERE work_id = ? AND field_name = 'circle'
				UNION ALL
				SELECT 1
				FROM work_party
				WHERE work_id = ? AND role = 'circle' AND source = 'manual_override'
			)
	`, workID, workID, workID, workID, workID, workID).Scan(
		&hasHigherPriorityMetadata,
		&hasAuthoritativeParty,
		&hasManualCircleOverride,
	); err != nil {
		return remoteWorkFallbackPolicy{}, err
	}
	return remoteWorkFallbackPolicy{
		AttachCircleFallback:     hasHigherPriorityMetadata == 0 && hasAuthoritativeParty == 0 && hasManualCircleOverride == 0,
		UpdateNormalizedMetadata: hasHigherPriorityMetadata == 0,
	}, nil
}

func upsertRemoteWork(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, remoteWork kikoeru.Work, rawWork json.RawMessage, allowCircleFallback bool) (int64, error) {
	code := normalizedRemoteWorkCode(remoteWork)
	if code == "" {
		code = strings.ToUpper(strings.TrimSpace(remoteWork.SourceID))
	}
	if code == "" {
		return 0, fmt.Errorf("remote work does not expose a stable work code")
	}
	policy, err := loadRemoteWorkFallbackPolicy(ctx, tx, code)
	if err != nil {
		return 0, err
	}
	title := firstNonEmpty(remoteWork.Title, remoteWork.Name, code)
	workID, err := upsertRemoteWorkBase(ctx, tx, code, title, remoteWork, policy)
	if err != nil {
		return 0, err
	}
	providerID, err := upsertRemoteWorkMetadata(ctx, tx, source, workID, code, remoteWork, rawWork)
	if err != nil {
		return 0, err
	}
	if err := syncVoiceCreditSnapshot(ctx, tx, voiceCreditSnapshotRow{
		WorkID: workID, ProviderID: sql.NullInt64{Int64: providerID, Valid: true}, Raw: string(rawWork),
	}); err != nil {
		return 0, err
	}
	if allowCircleFallback && policy.AttachCircleFallback {
		if err := attachRemoteWorkCircleFallback(ctx, tx, remoteWork, workID, providerID); err != nil {
			return 0, err
		}
	}
	return workID, nil
}

func upsertRemoteWorkBase(ctx context.Context, tx *sql.Tx, code, title string, remoteWork kikoeru.Work, policy remoteWorkFallbackPolicy) (int64, error) {
	releaseDate := normalizeDate(remoteWork.Release)
	var duration any
	if remoteWork.Duration != nil && *remoteWork.Duration > 0 {
		duration = int64(*remoteWork.Duration)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work (primary_code, work_type, title, description, release_date, age_rating, duration_seconds)
		VALUES (?, 'audio', ?, ?, ?, ?, ?)
		ON CONFLICT(primary_code) DO UPDATE SET
			title = CASE
				WHEN TRIM(work.title) = '' OR UPPER(TRIM(work.title)) = UPPER(TRIM(work.primary_code)) THEN excluded.title
				WHEN ?
					AND TRIM(excluded.title) <> ''
					AND UPPER(TRIM(excluded.title)) <> UPPER(TRIM(work.primary_code)) THEN excluded.title
				ELSE work.title
			END,
			release_date = CASE
				WHEN ? THEN COALESCE(excluded.release_date, work.release_date)
				ELSE COALESCE(work.release_date, excluded.release_date)
			END,
			age_rating = CASE
				WHEN ? THEN COALESCE(NULLIF(excluded.age_rating, ''), work.age_rating)
				ELSE COALESCE(NULLIF(work.age_rating, ''), excluded.age_rating)
			END,
			duration_seconds = CASE
				WHEN ? THEN COALESCE(excluded.duration_seconds, work.duration_seconds)
				ELSE COALESCE(work.duration_seconds, excluded.duration_seconds)
			END,
			updated_at = CURRENT_TIMESTAMP
	`, code, title, "", releaseDate, remoteWork.AgeCategoryString, duration,
		policy.UpdateNormalizedMetadata, policy.UpdateNormalizedMetadata,
		policy.UpdateNormalizedMetadata, policy.UpdateNormalizedMetadata); err != nil {
		return 0, err
	}
	return sqlutil.SelectID(ctx, tx, "SELECT id FROM work WHERE primary_code = ?", code)
}

func upsertRemoteWorkMetadata(ctx context.Context, tx *sql.Tx, source remoteSourceForUse, workID int64, code string, remoteWork kikoeru.Work, rawWork json.RawMessage) (int64, error) {
	providerCode := "kikoeru_source_" + source.Code
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO metadata_provider (code, display_name)
		VALUES (?, ?)
		ON CONFLICT(code) DO UPDATE SET display_name = excluded.display_name
	`, providerCode, source.DisplayName); err != nil {
		return 0, err
	}
	providerID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM metadata_provider WHERE code = ?", providerCode)
	if err != nil {
		return 0, err
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO work_external_id (work_id, provider_id, id_type, external_id, url, is_primary)
		VALUES (?, ?, 'work_code', ?, ?, 1)
		ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
			work_id = excluded.work_id,
			url = excluded.url,
			is_primary = excluded.is_primary
	`, workID, providerID, code, remoteWork.SourceURL); err != nil {
		return 0, err
	}
	if remoteWork.ID > 0 {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO work_external_id (work_id, provider_id, id_type, external_id, url, is_primary)
			VALUES (?, ?, 'remote_work_id', ?, ?, 0)
			ON CONFLICT(provider_id, id_type, external_id) DO UPDATE SET
				work_id = excluded.work_id,
				url = excluded.url
		`, workID, providerID, strconv.FormatInt(remoteWork.ID, 10), remoteWork.SourceURL); err != nil {
			return 0, err
		}
	}
	if err := upsertRemoteMetadataSnapshot(ctx, tx, workID, providerID, code, rawWork); err != nil {
		return 0, err
	}
	return providerID, nil
}

func upsertRemoteMetadataSnapshot(ctx context.Context, tx *sql.Tx, workID, providerID int64, externalID string, raw json.RawMessage) error {
	if len(raw) == 0 {
		raw = json.RawMessage(`{}`)
	}
	digest := sha256.Sum256(raw)
	hash := hex.EncodeToString(digest[:])
	const variantKey = "remote"
	var existingID int64
	var existingHash, existingRaw string
	err := tx.QueryRowContext(ctx, `
		SELECT id, content_hash, snapshot_json
		FROM metadata_snapshot
		WHERE work_id = ? AND provider_id = ? AND external_id = ?
		ORDER BY fetched_at DESC, id DESC
		LIMIT 1
	`, workID, providerID, externalID).Scan(&existingID, &existingHash, &existingRaw)
	if err == nil && (strings.TrimSpace(existingHash) == hash || (strings.TrimSpace(existingHash) == "" && existingRaw == string(raw))) {
		_, err = tx.ExecContext(ctx, `
			UPDATE metadata_snapshot
			SET fetched_at = CURRENT_TIMESTAMP, snapshot_json = ?, variant_key = ?, content_hash = ?
			WHERE id = ?
		`, string(raw), variantKey, hash, existingID)
		if err != nil {
			return err
		}
	} else {
		if !errors.Is(err, sql.ErrNoRows) && err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO metadata_snapshot (
				work_id, provider_id, external_id, snapshot_json,
				variant_key, content_hash
			)
			VALUES (?, ?, ?, ?, ?, ?)
		`, workID, providerID, externalID, string(raw), variantKey, hash); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, `
		DELETE FROM metadata_snapshot
		WHERE id IN (
			SELECT id FROM metadata_snapshot
			WHERE work_id = ? AND provider_id = ? AND external_id = ?
			ORDER BY fetched_at DESC, id DESC
			LIMIT -1 OFFSET 2
		)
	`, workID, providerID, externalID)
	return err
}

func attachRemoteWorkCircleFallback(ctx context.Context, tx *sql.Tx, remoteWork kikoeru.Work, workID, providerID int64) error {
	if remoteWork.Circle == nil || strings.TrimSpace(remoteWork.Circle.Name) == "" {
		return nil
	}
	var partyID int64
	err := tx.QueryRowContext(ctx, `
		SELECT id
		FROM party
		WHERE party_type IN ('circle', 'brand', 'maker')
			AND LOWER(display_name) = LOWER(?)
		ORDER BY id ASC
		LIMIT 1
	`, strings.TrimSpace(remoteWork.Circle.Name)).Scan(&partyID)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO work_party (work_id, party_id, role, provider_id, source, updated_at)
		VALUES (?, ?, 'circle', ?, ?, CURRENT_TIMESTAMP)
		ON CONFLICT(work_id, party_id, role) DO UPDATE SET
			provider_id = excluded.provider_id,
			source = excluded.source,
			updated_at = CURRENT_TIMESTAMP
	`, workID, partyID, providerID, "remote_source")
	return err
}

func syncRemoteTrackTree(ctx context.Context, tx *sql.Tx, fileSourceID int64, workID int64, workCode string, tracks []kikoeru.Track) (int, int, error) {
	state := remoteTrackSyncState{}
	walk := func(parentID *int64, basePath string, nodes []kikoeru.Track) error {
		for index, node := range nodes {
			if err := syncRemoteTrackNode(ctx, tx, fileSourceID, workID, workCode, parentID, basePath, index, node, &state); err != nil {
				return err
			}
		}
		return nil
	}
	if err := walk(nil, "", tracks); err != nil {
		return 0, 0, err
	}
	return state.mediaItems, state.locations, nil
}

type remoteTrackSyncState struct {
	mediaItems int
	locations  int
}

func syncRemoteTrackNode(ctx context.Context, tx *sql.Tx, fileSourceID, workID int64, workCode string, parentID *int64, basePath string, index int, node kikoeru.Track, state *remoteTrackSyncState) error {
	title := strings.TrimSpace(node.Title)
	if title == "" {
		title = fmt.Sprintf("Track %d", index+1)
	}
	path := joinRemotePath(basePath, title)
	kind := remoteTrackKindForPath(node.Type, path)
	fingerprint := fmt.Sprintf("remote:%d:%s:%s", fileSourceID, workCode, path)
	var parent any
	if parentID != nil {
		parent = *parentID
	}
	duration := nullableSeconds(node.Duration)
	hasAudio := remoteMediaHasAudio(kind)
	var size any
	if node.Size > 0 {
		size = node.Size
	}
	if err := upsertRemoteMediaItem(ctx, tx, workID, parent, kind, title, index, duration, hasAudio, size, fingerprint); err != nil {
		return err
	}
	itemID, err := sqlutil.SelectID(ctx, tx, "SELECT id FROM media_item WHERE fingerprint = ?", fingerprint)
	if err != nil {
		return err
	}
	state.mediaItems++
	if len(node.Children) > 0 || kind == "folder" {
		childID := itemID
		return syncRemoteTrackChildren(ctx, tx, fileSourceID, workID, workCode, &childID, path, node.Children, state)
	}
	return upsertRemoteTrackLocation(ctx, tx, fileSourceID, itemID, path, node, duration, size, state)
}

func upsertRemoteMediaItem(ctx context.Context, tx *sql.Tx, workID int64, parent any, kind, title string, index int, duration, hasAudio, size any, fingerprint string) error {
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO media_item (work_id, parent_id, kind, title, track_no, duration_seconds, has_audio, size_bytes, fingerprint)
		SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
		WHERE NOT EXISTS (SELECT 1 FROM media_item WHERE fingerprint = ?)
	`, workID, parent, kind, title, index+1, duration, hasAudio, size, fingerprint, fingerprint); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, `
		UPDATE media_item
		SET parent_id = ?, kind = ?, title = ?, track_no = ?, duration_seconds = ?,
			has_audio = COALESCE(?, has_audio), size_bytes = ?
		WHERE fingerprint = ?
	`, parent, kind, title, index+1, duration, hasAudio, size, fingerprint)
	return err
}

func syncRemoteTrackChildren(ctx context.Context, tx *sql.Tx, fileSourceID, workID int64, workCode string, parentID *int64, path string, children []kikoeru.Track, state *remoteTrackSyncState) error {
	for index, child := range children {
		if err := syncRemoteTrackNode(ctx, tx, fileSourceID, workID, workCode, parentID, path, index, child, state); err != nil {
			return err
		}
	}
	return nil
}

func upsertRemoteTrackLocation(ctx context.Context, tx *sql.Tx, fileSourceID, itemID int64, path string, node kikoeru.Track, duration, size any, state *remoteTrackSyncState) error {
	streamURL := firstNonEmpty(node.MediaStreamURL, node.StreamLowQualityURL)
	downloadURL := node.MediaDownloadURL
	if streamURL == "" && downloadURL == "" {
		return nil
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO media_file_location (media_item_id, file_source_id, location_type, path, stream_url, download_url, remote_hash, size_bytes, duration_seconds, availability, last_checked_at)
		SELECT ?, ?, 'remote_stream', ?, ?, ?, ?, ?, ?, 'available', CURRENT_TIMESTAMP
		WHERE NOT EXISTS (
			SELECT 1 FROM media_file_location
			WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'remote_stream' AND path = ?
		)
	`, itemID, fileSourceID, path, streamURL, downloadURL, node.Hash, size, duration, itemID, fileSourceID, path); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE media_file_location
		SET stream_url = ?, download_url = ?, remote_hash = ?, size_bytes = ?, duration_seconds = ?,
			availability = 'available', last_checked_at = CURRENT_TIMESTAMP
		WHERE media_item_id = ? AND file_source_id = ? AND location_type = 'remote_stream' AND path = ?
	`, streamURL, downloadURL, node.Hash, size, duration, itemID, fileSourceID, path); err != nil {
		return err
	}
	state.locations++
	return nil
}

func normalizedRemoteWorkCode(work kikoeru.Work) string {
	return kikoeru.WorkCode(work)
}

func remoteCodeFromRawJSON(raw string) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	var payload struct {
		WorkNo        string `json:"workno"`
		WorkNoAlt     string `json:"work_no"`
		ProductID     string `json:"product_id"`
		SourceID      string `json:"source_id"`
		ProductIDAlt  string `json:"productId"`
		ProductIDText string `json:"productID"`
	}
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return ""
	}
	return firstNonEmpty(payload.WorkNo, payload.WorkNoAlt, payload.ProductID, payload.ProductIDAlt, payload.ProductIDText, payload.SourceID)
}

func remoteTrackKind(value string) string {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "folder":
		return "folder"
	case "audio":
		return "audio"
	case "text", "image", "video":
		return strings.ToLower(strings.TrimSpace(value))
	default:
		return "file"
	}
}

func remoteTrackKindForPath(value string, path string) string {
	kind := remoteTrackKind(value)
	if kind != "file" {
		return kind
	}
	return mediaKindFromPath(path)
}

func remoteMediaHasAudio(kind string) any {
	if kind == "audio" {
		return true
	}
	return nil
}

func joinRemotePath(basePath string, name string) string {
	name = strings.ReplaceAll(strings.TrimSpace(name), "\\", "/")
	name = strings.Trim(name, "/")
	if basePath == "" {
		return name
	}
	return strings.Trim(basePath, "/") + "/" + name
}
