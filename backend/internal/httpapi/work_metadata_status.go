package httpapi

import (
	"context"
	"database/sql"
	"strings"
)

const (
	workMetadataSyncStatusNotSynced = "not_synced"
	workMetadataSyncStatusAvailable = "available"
	workMetadataSyncStatusNotFound  = "not_found"
	// DLsite reported the work as not found and remote sources filled it.
	workMetadataSyncStatusRemoteFallback = "remote_fallback"
)

type workMetadataSyncStatus struct {
	Status    string `json:"status"`
	CheckedAt string `json:"checkedAt"`
	// Source names the remote source that filled the work, when one did.
	Source string `json:"source,omitempty"`
	// Fields lists the remote source of each normalized value while the work
	// has no DLsite metadata.
	Fields []workMetadataFieldSource `json:"fields"`
}

// workMetadataFieldSource names the remote source of one normalized value.
type workMetadataFieldSource struct {
	Field  string `json:"field"`
	Source string `json:"source"`
}

// loadWorkMetadataFieldSources lists remote provenance in a stable field order.
// Rows exist only while the work has no DLsite metadata.
func (s *Server) loadWorkMetadataFieldSources(ctx context.Context, workID int64) ([]workMetadataFieldSource, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT source.field_name, provider.display_name
		FROM work_metadata_field_source AS source
		JOIN metadata_provider AS provider ON provider.id = source.provider_id
		WHERE source.work_id = ?
		ORDER BY CASE source.field_name WHEN 'title' THEN 0 WHEN 'circle' THEN 1 WHEN 'release_date' THEN 2
			WHEN 'tags' THEN 3 WHEN 'cover' THEN 4 WHEN 'age_rating' THEN 5 ELSE 6 END`, workID)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	result := []workMetadataFieldSource{}
	for rows.Next() {
		var item workMetadataFieldSource
		if err := rows.Scan(&item.Field, &item.Source); err != nil {
			return nil, err
		}
		result = append(result, item)
	}
	return result, rows.Err()
}

// loadWorkMetadataSyncStatus projects the provider state needed by the detail
// page without making the page infer whether a metadata request has happened.
// A stored snapshot or localized variant proves that metadata is available;
// not_found is only exposed when no metadata was stored for this work family.
func (s *Server) loadWorkMetadataSyncStatus(
	ctx context.Context,
	workID int64,
	metadataView workMetadataPresentation,
	snapshotFetchedAt sql.NullString,
	fieldSources []workMetadataFieldSource,
) (workMetadataSyncStatus, error) {
	var providerStatus string
	var providerCheckedAt string
	if err := s.db.QueryRowContext(ctx, `
		SELECT
			COALESCE((
				SELECT state.status
				FROM work_metadata_provider_state AS state
				INNER JOIN metadata_provider AS provider ON provider.id = state.provider_id
				WHERE state.work_id = ? AND provider.code = 'dlsite'
				LIMIT 1
			), ''),
			COALESCE((
				SELECT state.checked_at
				FROM work_metadata_provider_state AS state
				INNER JOIN metadata_provider AS provider ON provider.id = state.provider_id
				WHERE state.work_id = ? AND provider.code = 'dlsite'
				LIMIT 1
			), '')
	`, workID, workID).Scan(&providerStatus, &providerCheckedAt); err != nil {
		return workMetadataSyncStatus{}, err
	}

	status := workMetadataSyncStatusNotSynced
	hasStoredEdition := false
	for _, variant := range metadataView.Variants {
		if !variant.PresentationOnly {
			hasStoredEdition = true
			break
		}
	}
	if snapshotFetchedAt.Valid || hasStoredEdition {
		status = workMetadataSyncStatusAvailable
	} else if strings.EqualFold(strings.TrimSpace(providerStatus), workMetadataSyncStatusNotFound) {
		status = workMetadataSyncStatusNotFound
	}
	source := ""
	if status == workMetadataSyncStatusNotFound && len(fieldSources) > 0 {
		status, source = workMetadataSyncStatusRemoteFallback, fieldSources[0].Source
	}
	checkedAt := strings.TrimSpace(providerCheckedAt)
	if checkedAt == "" && snapshotFetchedAt.Valid {
		checkedAt = strings.TrimSpace(snapshotFetchedAt.String)
	}
	return workMetadataSyncStatus{Status: status, CheckedAt: checkedAt, Source: source, Fields: fieldSources}, nil
}
