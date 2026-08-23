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
)

type workMetadataSyncStatus struct {
	Status    string `json:"status"`
	CheckedAt string `json:"checkedAt"`
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
	if snapshotFetchedAt.Valid || len(metadataView.Variants) > 0 {
		status = workMetadataSyncStatusAvailable
	} else if strings.EqualFold(strings.TrimSpace(providerStatus), workMetadataSyncStatusNotFound) {
		status = workMetadataSyncStatusNotFound
	}
	checkedAt := strings.TrimSpace(providerCheckedAt)
	if checkedAt == "" && snapshotFetchedAt.Valid {
		checkedAt = strings.TrimSpace(snapshotFetchedAt.String)
	}
	return workMetadataSyncStatus{Status: status, CheckedAt: checkedAt}, nil
}
